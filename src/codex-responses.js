"use strict";

const { classifyErrorType, createBridgeError, shouldFailoverAccount } = require("./errors");
const log = require("./logger");

const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/token";
const OPENAI_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_DEFAULT_BASE_URL = "https://chatgpt.com";
const CHATGPT_CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const DEFAULT_PROBE_MODELS = ["gpt-5.4"];

function parseJwtExp(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractClientIdFromToken(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return payload && payload.client_id ? String(payload.client_id) : null;
  } catch {
    return null;
  }
}

async function refreshOpenAIToken(refreshToken, clientId, fetchImpl) {
  const res = await fetchImpl(OPENAI_AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId || OPENAI_DEFAULT_CLIENT_ID
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI token refresh failed: ${res.status} ${text}`);
  }

  return res.json();
}

function stripTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildResponsesUrl(baseUrl) {
  const normalized = stripTrailingSlash(baseUrl || "https://api.openai.com/v1");
  const lower = normalized.toLowerCase();

  if (lower.endsWith("/responses")) {
    return normalized;
  }

  if (lower.endsWith("/v1")) {
    return normalized + "/responses";
  }

  return normalized + "/v1/responses";
}

function buildChatGptResponsesUrl(baseUrl) {
  const normalized = stripTrailingSlash(baseUrl || CHATGPT_DEFAULT_BASE_URL);
  const lower = normalized.toLowerCase();

  if (lower.endsWith(CHATGPT_CODEX_RESPONSES_PATH)) {
    return normalized;
  }

  if (lower.endsWith("/backend-api/codex")) {
    return normalized + "/responses";
  }

  if (lower.endsWith("/backend-api")) {
    return normalized + "/codex/responses";
  }

  if (lower.endsWith("/v1") || lower.includes("api.openai.com")) {
    return CHATGPT_DEFAULT_BASE_URL + CHATGPT_CODEX_RESPONSES_PATH;
  }

  return normalized + CHATGPT_CODEX_RESPONSES_PATH;
}

function buildModelsUrl(baseUrl) {
  const normalized = stripTrailingSlash(baseUrl || "https://api.openai.com/v1");
  const lower = normalized.toLowerCase();

  if (lower.endsWith("/models")) {
    return normalized;
  }

  if (lower.endsWith("/v1")) {
    return normalized + "/models";
  }

  return normalized + "/v1/models";
}

function createSseReader(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundaryIndex = buffer.indexOf("\n\n");
        if (boundaryIndex >= 0) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          const lines = rawEvent.split(/\r?\n/);
          let event = "message";
          const data = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }

            if (line.startsWith("data:")) {
              data.push(line.slice(5).trimStart());
            }
          }

          if (data.length === 0) {
            continue;
          }

          return {
            done: false,
            value: {
              event,
              data: data.join("\n")
            }
          };
        }

        const chunk = await reader.read();
        if (chunk.done) {
          if (!buffer.trim()) {
            return { done: true, value: null };
          }

          const rawEvent = buffer;
          buffer = "";
          const lines = rawEvent.split(/\r?\n/);
          let event = "message";
          const data = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
              continue;
            }

            if (line.startsWith("data:")) {
              data.push(line.slice(5).trimStart());
            }
          }

          return {
            done: false,
            value: {
              event,
              data: data.join("\n")
            }
          };
        }

        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // Ignore stream cancel failures.
      }
    }
  };
}

function upsertResponseOutputItem(items, item) {
  if (!item || typeof item !== "object") {
    return items;
  }

  const itemId = item.id || item.call_id;
  if (!itemId) {
    return items.concat([item]);
  }

  const next = items.slice();
  const index = next.findIndex((entry) => entry && (entry.id === itemId || entry.call_id === itemId));
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...item
    };
    return next;
  }

  next.push(item);
  return next;
}

function normalizeJsonStringObject(value) {
  if (!value || typeof value !== "string") {
    return value && typeof value === "object" ? value : {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolCallsFromResponsesOutput(output) {
  return (Array.isArray(output) ? output : [])
    .map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        !["tool_call", "function_call"].includes(item.type) ||
        !item.name
      ) {
        return null;
      }

      return {
        id: item.call_id || item.id || ("call_" + Math.random().toString(36).slice(2, 10)),
        name: String(item.name),
        input: normalizeJsonStringObject(item.arguments)
      };
    })
    .filter(Boolean);
}

function buildHeadersForCredential(bundle = {}, accept = "application/json") {
  const baseHeaders = {
    "content-type": "application/json",
    accept
  };
  const tokens = bundle.tokens && typeof bundle.tokens === "object"
    ? bundle.tokens
    : {};
  const nextHeaders = {
    ...(bundle.headers && typeof bundle.headers === "object" ? bundle.headers : {}),
    ...(bundle.additionalHeaders && typeof bundle.additionalHeaders === "object" ? bundle.additionalHeaders : {})
  };

  if (!nextHeaders.authorization) {
    if (bundle.authorization) {
      nextHeaders.authorization = String(bundle.authorization);
    } else if (bundle.accessToken) {
      nextHeaders.authorization = "Bearer " + String(bundle.accessToken);
    } else if (bundle.access_token) {
      nextHeaders.authorization = "Bearer " + String(bundle.access_token);
    } else if (tokens.access_token) {
      nextHeaders.authorization = "Bearer " + String(tokens.access_token);
    } else if (tokens.accessToken) {
      nextHeaders.authorization = "Bearer " + String(tokens.accessToken);
    } else if (bundle.OPENAI_API_KEY) {
      nextHeaders.authorization = "Bearer " + String(bundle.OPENAI_API_KEY);
    } else if (bundle.apiKey) {
      nextHeaders.authorization = "Bearer " + String(bundle.apiKey);
    } else if (bundle.token) {
      nextHeaders.authorization = "Bearer " + String(bundle.token);
    }
  }

  if (!nextHeaders.cookie && bundle.cookie) {
    nextHeaders.cookie = String(bundle.cookie);
  }

  if (!nextHeaders["openai-organization"] && bundle.organization) {
    nextHeaders["openai-organization"] = String(bundle.organization);
  }

  if (!nextHeaders["openai-project"] && bundle.project) {
    nextHeaders["openai-project"] = String(bundle.project);
  }

  if (!nextHeaders["chatgpt-account-id"]) {
    const accountId = bundle.chatGptAccountId ||
      bundle.chatgpt_account_id ||
      bundle.account_id ||
      bundle.accountId ||
      tokens.account_id ||
      tokens.accountId ||
      null;
    if (accountId) {
      nextHeaders["chatgpt-account-id"] = String(accountId);
    }
  }

  return {
    ...baseHeaders,
    ...nextHeaders
  };
}

function buildRequestError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.type = classifyErrorType(status, error);
  if (details) {
    error.details = details;
  }
  return error;
}

function isMissingModelsReadScopeError(error) {
  const message = error && error.message ? String(error.message) : "";
  return /api\.model\.read/i.test(message);
}

function isModelSelectionError(error) {
  const message = error && error.message ? String(error.message) : "";
  if (!message) {
    return false;
  }

  return (
    /model/i.test(message) &&
    /not found|does not exist|not available|unsupported|access|permission|exist/i.test(message) &&
    !/api\.model\.read/i.test(message)
  );
}

function isResponsesOnlyCredential(credential) {
  const bundle = credential && credential.credentialBundle && typeof credential.credentialBundle === "object"
    ? credential.credentialBundle
    : {};
  const authMode = bundle.auth_mode || bundle.authMode || null;
  return String(authMode || "").trim().toLowerCase() === "chatgpt";
}

function resolveTransportMode(credential) {
  return isResponsesOnlyCredential(credential) ? "chatgpt" : "openai";
}

function buildResponsesRequestUrl(credential, defaultBaseUrl) {
  const transportMode = resolveTransportMode(credential);
  const baseUrl = credential && credential.baseUrl ? credential.baseUrl : defaultBaseUrl;
  return transportMode === "chatgpt"
    ? buildChatGptResponsesUrl(baseUrl)
    : buildResponsesUrl(baseUrl);
}

function buildProbeTargetSummary(credential, defaultBaseUrl) {
  const transportMode = resolveTransportMode(credential);
  const baseUrl = credential && credential.baseUrl ? credential.baseUrl : defaultBaseUrl;
  return {
    transportMode,
    requestBaseUrl: transportMode === "chatgpt"
      ? stripTrailingSlash(baseUrl || CHATGPT_DEFAULT_BASE_URL)
      : stripTrailingSlash(baseUrl || defaultBaseUrl)
  };
}

function applyTransportHeaders(headers, credential, options = {}) {
  const transportMode = resolveTransportMode(credential);
  const nextHeaders = { ...headers };

  if (transportMode === "chatgpt") {
    if (!nextHeaders["OpenAI-Beta"] && !nextHeaders["openai-beta"]) {
      nextHeaders["OpenAI-Beta"] = "responses=experimental";
    }
    if (!nextHeaders.originator) {
      nextHeaders.originator = "codex_cli_rs";
    }
    nextHeaders["content-type"] = "application/json";
    nextHeaders.accept = options.accept || (options.stream ? "text/event-stream" : "application/json");
  }

  return nextHeaders;
}

function normalizeChatGptInput(input) {
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: input
          }
        ]
      }
    ];
  }

  if (Array.isArray(input)) {
    return input;
  }

  if (input && typeof input === "object") {
    return [input];
  }

  return [];
}

function normalizeChatGptCodexModel(model) {
  const value = String(model || "").trim();
  if (!value) {
    return value;
  }

  const lower = value.toLowerCase();
  if (lower === "gpt-5.4-codex") {
    return "gpt-5.4";
  }

  return value;
}

function prepareResponsesRequestBody(body, credential, options = {}) {
  const transportMode = resolveTransportMode(credential);
  const nextBody = body && typeof body === "object"
    ? { ...body }
    : {};

  if (transportMode === "chatgpt") {
    nextBody.model = normalizeChatGptCodexModel(nextBody.model);

    if (!Object.prototype.hasOwnProperty.call(nextBody, "instructions")) {
      nextBody.instructions = "";
    }

    if (!Object.prototype.hasOwnProperty.call(nextBody, "store")) {
      nextBody.store = false;
    }

    delete nextBody.max_output_tokens;
    delete nextBody.temperature;
    delete nextBody.metadata;
    delete nextBody.user;
    delete nextBody.stop;
    nextBody.input = normalizeChatGptInput(nextBody.input);
  }

  if (Object.prototype.hasOwnProperty.call(options, "stream")) {
    nextBody.stream = options.stream === true;
  }

  return nextBody;
}

class CodexResponsesClient {
  constructor(config = {}) {
    this.authProvider = config.authProvider || null;
    this.fetchImpl = config.fetchImpl || fetch;
    this.defaultBaseUrl = stripTrailingSlash(config.defaultBaseUrl || "https://api.openai.com/v1");
    this.requestTimeoutMs = Number(config.requestTimeoutMs || 60000) || 60000;
    this._refreshPromiseByAccountId = new Map();
    this.probeModels = Array.isArray(config.probeModels) && config.probeModels.length > 0
      ? config.probeModels.map((item) => String(item || "").trim()).filter(Boolean)
      : DEFAULT_PROBE_MODELS.slice();
  }

  isAvailable() {
    return Boolean(this.authProvider && typeof this.authProvider.resolveCredential === "function");
  }

  async _requestResponses(body, credential, options = {}) {
    const mergedBundle = {
      ...(credential.credentialBundle && typeof credential.credentialBundle === "object" ? credential.credentialBundle : {}),
      ...(credential.accessToken ? { accessToken: credential.accessToken } : {}),
      ...(credential.chatGptAccountId ? { chatGptAccountId: credential.chatGptAccountId } : {})
    };
    const headers = applyTransportHeaders(
      buildHeadersForCredential(mergedBundle, "text/event-stream,application/json"),
      credential,
      { accept: "text/event-stream,application/json", stream: true }
    );
    const response = await this.fetchImpl(buildResponsesRequestUrl(credential, this.defaultBaseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(prepareResponsesRequestBody(body, credential, { stream: true })),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      let payload = null;

      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = null;
      }

      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        rawText ||
        "Codex responses request failed: " + (response.status || 502);
      throw buildRequestError(response.status || 502, message, {
        upstream: {
          provider: "codex-responses",
          status: response.status || 502,
          body: payload || rawText || null
        }
      });
    }

    const contentType = String(response.headers.get("content-type") || "");
    const transportMode = resolveTransportMode(credential);
    const shouldTreatAsSse = Boolean(response.body) && (
      /text\/event-stream/i.test(contentType) ||
      (transportMode === "chatgpt" && !contentType)
    );

    if (!shouldTreatAsSse) {
      const payload = await response.json().catch(() => ({}));
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        "Codex responses request failed: invalid response payload";
      throw buildRequestError(response.status || 502, message, {
        upstream: {
          provider: "codex-responses",
          status: response.status || 502,
          body: payload || null
        }
      });
    }

    const reader = createSseReader(response.body);
    let text = "";
    let completedResponse = null;
    let outputItems = [];

    try {
      while (true) {
        const next = await reader.next();
        if (next.done) {
          break;
        }

        const entry = next.value;
        if (!entry || !entry.data) {
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(entry.data);
        } catch {
          continue;
        }

        if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
          text += payload.delta;
          if (typeof options.onEvent === "function" && payload.delta) {
            options.onEvent({ type: "text_delta", text: payload.delta });
          }
          continue;
        }

        if (payload.type === "response.output_text.done" && typeof payload.text === "string" && !text) {
          text = payload.text;
          continue;
        }

        if (payload.type === "response.output_item.done" && payload.item && typeof payload.item === "object") {
          outputItems = upsertResponseOutputItem(outputItems, payload.item);
          if (
            typeof options.onEvent === "function" &&
            ["tool_call", "function_call"].includes(String(payload.item.type || "")) &&
            payload.item.name
          ) {
            options.onEvent({
              type: "tool_call",
              toolCall: {
                id: payload.item.call_id || payload.item.id || "call_unknown",
                name: String(payload.item.name),
                input: normalizeJsonStringObject(payload.item.arguments)
              }
            });
          }
          continue;
        }

        if (payload.type === "response.completed" && payload.response) {
          completedResponse = {
            ...payload.response,
            output: Array.isArray(payload.response.output) && payload.response.output.length > 0
              ? payload.response.output
              : outputItems
          };
          break;
        }
      }
    } finally {
      await reader.cancel();
    }

    const finalResponse = completedResponse || {
      model: body.model || null,
      output: outputItems,
      usage: null
    };

    return {
      id: finalResponse.id || null,
      finalText: text,
      toolCalls: extractToolCallsFromResponsesOutput(finalResponse.output),
      usage: finalResponse.usage || null,
      raw: finalResponse
    };
  }

  async _probeModels(credential) {
    const mergedBundle = {
      ...(credential.credentialBundle && typeof credential.credentialBundle === "object" ? credential.credentialBundle : {}),
      ...(credential.accessToken ? { accessToken: credential.accessToken } : {}),
      ...(credential.chatGptAccountId ? { chatGptAccountId: credential.chatGptAccountId } : {})
    };
    const headers = buildHeadersForCredential(mergedBundle, "application/json");
    delete headers["content-type"];

    const response = await this.fetchImpl(buildModelsUrl(credential.baseUrl || this.defaultBaseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const rawText = await response.text().catch(() => "");
    let payload = null;

    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        rawText ||
        "Codex models probe failed: " + (response.status || 502);
      throw buildRequestError(response.status || 502, message, {
        upstream: {
          provider: "codex-models-probe",
          status: response.status || 502,
          body: payload || rawText || null
        }
      });
    }

    const models = Array.isArray(payload && payload.data) ? payload.data : [];
    return {
      ok: true,
      accountId: credential.accountId || null,
      accountName: credential.accountName || null,
      baseUrl: credential.baseUrl || this.defaultBaseUrl,
      probeTransport: "models",
      modelCount: models.length,
      sampleModels: models
        .map((item) => item && (item.id || item.model || item.name || item.modelName || null))
        .filter(Boolean)
        .slice(0, 5)
    };
  }

  _probeModelCandidates(credential) {
    const bundle = credential && credential.credentialBundle && typeof credential.credentialBundle === "object"
      ? credential.credentialBundle
      : {};

    return [
      credential && credential.probeModel ? credential.probeModel : null,
      bundle.probeModel,
      bundle.defaultModel,
      bundle.model,
      ...this.probeModels
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index);
  }

  async _probeResponses(credential) {
    const candidates = this._probeModelCandidates(credential);
    let lastModelError = null;
    const transportMode = resolveTransportMode(credential);

    for (const model of candidates) {
      try {
        if (transportMode === "chatgpt") {
          await this._requestResponses({
            model,
            input: "ping"
          }, credential);
        } else {
          const mergedBundle = {
            ...(credential.credentialBundle && typeof credential.credentialBundle === "object" ? credential.credentialBundle : {}),
            ...(credential.accessToken ? { accessToken: credential.accessToken } : {}),
            ...(credential.chatGptAccountId ? { chatGptAccountId: credential.chatGptAccountId } : {})
          };
          const headers = applyTransportHeaders(
            buildHeadersForCredential(mergedBundle, "application/json"),
            credential,
            { accept: "application/json", stream: false }
          );
          const response = await this.fetchImpl(buildResponsesRequestUrl(credential, this.defaultBaseUrl), {
            method: "POST",
            headers,
            body: JSON.stringify(prepareResponsesRequestBody({
              model,
              input: "ping"
            }, credential, { stream: false })),
            signal: AbortSignal.timeout(this.requestTimeoutMs)
          });
          const rawText = await response.text().catch(() => "");
          let payload = null;

          try {
            payload = rawText ? JSON.parse(rawText) : null;
          } catch {
            payload = null;
          }

          if (!response.ok) {
            const message =
              (payload && payload.error && payload.error.message) ||
              (payload && payload.message) ||
              rawText ||
              "Codex responses probe failed: " + (response.status || 502);
            throw buildRequestError(response.status || 502, message, {
              upstream: {
                provider: "codex-responses-probe",
                status: response.status || 502,
                body: payload || rawText || null,
                model
              }
            });
          }
        }
      } catch (error) {
        if (isModelSelectionError(error)) {
          lastModelError = error;
          continue;
        }

        throw error;
      }

      return {
        ok: true,
        accountId: credential.accountId || null,
        accountName: credential.accountName || null,
        ...buildProbeTargetSummary(credential, this.defaultBaseUrl),
        probeTransport: "responses",
        modelCount: null,
        sampleModels: [model],
        verifiedModel: model
      };
    }

    if (lastModelError) {
      return {
        ok: true,
        accountId: credential.accountId || null,
        accountName: credential.accountName || null,
        ...buildProbeTargetSummary(credential, this.defaultBaseUrl),
        probeTransport: "responses",
        modelCount: null,
        sampleModels: [],
        verifiedModel: null,
        note: "鉴权成功，但当前探测模型不可用；请在实际请求时使用该账号有权限的模型。"
      };
    }

    throw buildRequestError(503, "No probe model is configured for Codex responses", {
      upstream: {
        provider: "codex-responses-probe",
        status: 503
      }
    });
  }

  async _refreshCredential(credential) {
    if (!credential || !credential.refreshToken || !credential.accountId) {
      return credential;
    }

    const accountId = String(credential.accountId);
    const existing = this._refreshPromiseByAccountId.get(accountId);
    if (existing) {
      await existing;
      return this.authProvider && typeof this.authProvider.listCredentials === "function"
        ? this.authProvider.listCredentials({ accountId }).find(() => true) || credential
        : credential;
    }

    const now = Date.now();
    const expiresAt = Number(credential.expiresAt) || 0;
    if (expiresAt > now + TOKEN_EXPIRY_BUFFER_MS) {
      return credential;
    }

    const refreshPromise = this._doRefresh(accountId, credential.refreshToken, credential.clientId);
    this._refreshPromiseByAccountId.set(accountId, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this._refreshPromiseByAccountId.delete(accountId);
    }

    if (this.authProvider && typeof this.authProvider.listCredentials === "function") {
      const updated = this.authProvider.listCredentials({ accountId }).find(() => true);
      if (updated && updated.accessToken) {
        return updated;
      }
    }

    return credential;
  }

  async _doRefresh(accountId, refreshToken, clientId) {
    const resolvedClientId = clientId || OPENAI_DEFAULT_CLIENT_ID;
    log.info("codex token refresh starting", { accountId });

    try {
      const result = await refreshOpenAIToken(refreshToken, resolvedClientId, this.fetchImpl);
      const newAccessToken = result.access_token || result.accessToken || null;
      const newRefreshToken = result.refresh_token || result.refreshToken || null;
      const expiresIn = Number(result.expires_in || result.expiresIn || 0) || 0;

      if (!newAccessToken) {
        log.warn("codex token refresh returned no access_token", { accountId });
        return;
      }

      const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : (parseJwtExp(newAccessToken) || 0);

      if (this.authProvider && typeof this.authProvider.updateAccountToken === "function") {
        this.authProvider.updateAccountToken(accountId, {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken || refreshToken,
          expiresAt,
          credentialBundle: {
            accessToken: newAccessToken,
            access_token: newAccessToken,
            last_refresh: new Date().toISOString(),
            tokens: {
              access_token: newAccessToken,
              ...(newRefreshToken || refreshToken ? { refresh_token: newRefreshToken || refreshToken } : {})
            }
          }
        });
      }

      log.info("codex token refresh succeeded", { accountId });
    } catch (error) {
      log.warn("codex token refresh failed", {
        accountId,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  async run(body, options = {}) {
    if (!this.isAvailable()) {
      throw createBridgeError(503, "Codex responses client is not configured", "service_unavailable_error");
    }

    const triedAccounts = new Set();
    const explicitAccountId = options.accountId ? String(options.accountId) : null;
    const stickyAccountId = options.stickyAccountId ? String(options.stickyAccountId) : null;

    while (true) {
      let credential = this.authProvider.resolveCredential({
        accountId: explicitAccountId,
        stickyAccountId,
        excludeIds: [...triedAccounts]
      });

      if (!credential) {
        throw createBridgeError(503, "No usable Codex credentials available", "service_unavailable_error");
      }

      try {
        credential = await this._refreshCredential(credential);
        const requestBody = prepareResponsesRequestBody(body, credential, {
          stream: body && body.stream === true
        });

        if (typeof options.onDecision === "function") {
          options.onDecision({
            type: "credential_selected",
            accountId: credential.accountId || null,
            accountName: credential.accountName || null,
            authSource: credential.source || "codex-file",
            resolvedProviderModel: requestBody && requestBody.model ? requestBody.model : null
          });
        }

        const result = await this._requestResponses(requestBody, credential, options);
        if (credential.accountId && typeof this.authProvider.clearFailure === "function") {
          this.authProvider.clearFailure(credential.accountId);
        }

        return {
          ...result,
          accountId: credential.accountId || null,
          accountName: credential.accountName || null
        };
      } catch (error) {
        const isAuthError = error && (Number(error.status) === 401 || /unauthorized|invalid.*token|token.*expired/i.test(error && error.message ? error.message : ""));

        if (isAuthError && credential.refreshToken && credential.accountId) {
          try {
            await this._doRefresh(credential.accountId, credential.refreshToken, credential.clientId);
            const refreshed = this.authProvider.listCredentials({ accountId: credential.accountId }).find(() => true);
            if (refreshed && refreshed.accessToken && refreshed.accessToken !== credential.accessToken) {
              const retryResult = await this._requestResponses(body, refreshed, options);
              if (credential.accountId && typeof this.authProvider.clearFailure === "function") {
                this.authProvider.clearFailure(credential.accountId);
              }
              return {
                ...retryResult,
                accountId: refreshed.accountId || null,
                accountName: refreshed.accountName || null
              };
            }
          } catch {
            // Refresh or retry failed — fall through to normal failover
          }
        }

        if (credential.accountId && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(credential.accountId, error);
        }

        if (
          shouldFailoverAccount(error) &&
          credential.accountId &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(credential.accountId, error.message || String(error));
        }

        if (explicitAccountId || !shouldFailoverAccount(error) || !credential.accountId) {
          throw error;
        }

        triedAccounts.add(credential.accountId);
      }
    }
  }

  async probeAccount(accountId) {
    if (!this.isAvailable()) {
      throw createBridgeError(503, "Codex responses client is not configured", "service_unavailable_error");
    }

    let credential = this.authProvider.resolveCredential({
      accountId: accountId ? String(accountId) : null
    });

    if (!credential) {
      throw createBridgeError(404, "Codex account not found or not usable", "not_found_error");
    }

    try {
      credential = await this._refreshCredential(credential);
      let result;

      if (isResponsesOnlyCredential(credential)) {
        result = await this._probeResponses(credential);
      } else {
        try {
          result = await this._probeModels(credential);
        } catch (error) {
          if (!isMissingModelsReadScopeError(error)) {
            throw error;
          }

          result = await this._probeResponses(credential);
        }
      }

      if (credential.accountId && typeof this.authProvider.clearFailure === "function") {
        this.authProvider.clearFailure(credential.accountId);
      }

      return result;
    } catch (error) {
      const isAuthError = error && (Number(error.status) === 401 || /unauthorized|invalid.*token|token.*expired/i.test(error && error.message ? error.message : ""));

      if (isAuthError && credential.refreshToken && credential.accountId) {
        try {
          await this._doRefresh(credential.accountId, credential.refreshToken, credential.clientId);
          const refreshed = this.authProvider.listCredentials({ accountId: credential.accountId }).find(() => true);
          if (refreshed && refreshed.accessToken && refreshed.accessToken !== credential.accessToken) {
            const retryResult = isResponsesOnlyCredential(refreshed)
              ? await this._probeResponses(refreshed)
              : await this._probeModels(refreshed);
            if (credential.accountId && typeof this.authProvider.clearFailure === "function") {
              this.authProvider.clearFailure(credential.accountId);
            }
            return retryResult;
          }
        } catch {
          // Ignore refresh retry errors and fall through to the original error.
        }
      }

      if (credential.accountId && typeof this.authProvider.recordFailure === "function") {
        this.authProvider.recordFailure(credential.accountId, error);
      }

      throw error;
    }
  }
}

module.exports = {
  CodexResponsesClient,
  buildHeadersForCredential,
  buildChatGptResponsesUrl,
  buildModelsUrl,
  buildResponsesUrl,
  refreshOpenAIToken,
  parseJwtExp,
  extractClientIdFromToken
};
