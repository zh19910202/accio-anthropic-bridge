"use strict";

const log = require("./logger");
const { flattenAnthropicRequest, normalizeContent, normalizeSystemPrompt } = require("./anthropic");
const { flattenOpenAiRequest } = require("./openai");

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const { classifyErrorType } = require("./errors");
const { delay } = require("./utils");

function createFallbackId() {
  return "fb_" + Math.random().toString(36).slice(2, 10);
}

function normalizeReasoningEffort(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(text) ? text : "";
}

function normalizeFallbackTarget(target = {}, index = 0) {
  return {
    id: String(target.id || createFallbackId()),
    name: String(target.name || ("渠道 " + (index + 1))).trim() || ("渠道 " + (index + 1)),
    enabled: target.enabled !== false,
    baseUrl: String(target.baseUrl || "").trim().replace(/\/$/, ""),
    apiKey: String(target.apiKey || "").trim(),
    model: String(target.model || "").trim(),
    protocol: String(target.protocol || "openai").toLowerCase() === "anthropic" ? "anthropic" : "openai",
    anthropicVersion: String(target.anthropicVersion || DEFAULT_ANTHROPIC_VERSION).trim() || DEFAULT_ANTHROPIC_VERSION,
    timeoutMs: Number(target.timeoutMs || 60000) || 60000,
    reasoningEffort: normalizeReasoningEffort(target.reasoningEffort)
  };
}

function normalizeFallbackTargets(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets
    .map((target, index) => normalizeFallbackTarget(target, index))
    .filter((target) => target.enabled !== false);
}

function createTimeoutController(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, clear() {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("The operation was aborted due to timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

function isRetryableFetchError(error) {
  const status = Number(error && error.status ? error.status : 0);
  const type = String(error && error.type ? error.type : "").toLowerCase();
  const message = String(error && error.message ? error.message : "").toLowerCase();

  if (status === 408 || status === 429 || status >= 500) {
    return true;
  }

  return type === "timeout_error" || type === "api_connection_error" || /fetch failed|timed out|terminated|econnreset|socket hang up/.test(message);
}

function normalizeFetchError(error) {
  if (error && typeof error === "object" && (error.status || error.type)) {
    return error;
  }

  const normalized = new Error(error && error.message ? error.message : String(error));
  normalized.status = 502;
  normalized.type = classifyErrorType(normalized.status, normalized);
  return normalized;
}

function isAnthropicWrappedNotFoundPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const message = String(payload.msg || payload.message || "").toLowerCase();
  return payload.success === false && /404|not[_\s-]?found/.test(message);
}

function hasAnthropicImages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message && message.content) ? message.content : []) {
      if (block && (block.type === "image" || block.type === "image_url")) {
        return true;
      }
    }
  }

  return false;
}

function hasOpenAiImages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message && message.content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (block && (block.type === "image_url" || block.type === "input_image")) {
        return true;
      }
    }
  }

  return false;
}

function hasOpenAiTools(tools) {
  return Array.isArray(tools) && tools.some((tool) => {
    const fn = tool && (tool.function || tool);
    return Boolean(fn && fn.name);
  });
}

function normalizeContentString(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text" || block.type === "input_text" || block.type === "output_text") {
        return block.text || "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicToFallbackMessages(body) {
  const messages = [];
  const system = normalizeSystemPrompt(body && body.system);

  if (system) {
    messages.push({ role: "system", content: system });
  }

  for (const message of Array.isArray(body && body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "assistant" : "user";
    const content = normalizeContent(message && message.content);
    messages.push({ role, content: content || "[Empty]" });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: flattenAnthropicRequest(body || {}) });
  }

  return messages;
}

function anthropicToAnthropicPayload(body) {
  const system = normalizeSystemPrompt(body && body.system);
  const messages = [];

  for (const message of Array.isArray(body && body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "assistant" : "user";
    const content = normalizeContent(message && message.content) || "[Empty]";
    messages.push({
      role,
      content: [{ type: "text", text: content }]
    });
  }

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: flattenAnthropicRequest(body || {}) }]
    });
  }

  return {
    system: system || undefined,
    messages
  };
}

function openAiToAnthropicPayload(body) {
  const systemParts = [];
  const messages = [];

  for (const message of Array.isArray(body && body.messages) ? body.messages : []) {
    const role = message && message.role;
    const content = normalizeContentString(message && message.content) || "[Empty]";

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    messages.push({
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: content }]
    });
  }

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: flattenOpenAiRequest(body || {}) }]
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages
  };
}

function extractTextFromAnthropicMessage(payload) {
  const content = Array.isArray(payload && payload.content) ? payload.content : [];
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if (item.type === "text") {
        return item.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

}

function openAiToFallbackMessages(body) {
  const source = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = [];

  for (const message of source) {
    const role = message && ["system", "user", "assistant"].includes(message.role)
      ? message.role
      : "user";
    const content = normalizeContentString(message && message.content);
    messages.push({ role, content: content || "[Empty]" });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: flattenOpenAiRequest(body || {}) });
  }

  return messages;
}

function extractTextFromCompletion(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message && message.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        if (item.type === "text" || item.type === "output_text") {
          return item.text || "";
        }

        return "";
      })
      .filter(Boolean)
    .join("\n");
  }

  return "";
}

function normalizeAnthropicThinking(thinking) {
  if (!thinking || thinking === false) {
    return null;
  }

  if (thinking === true) {
    return {
      type: "enabled",
      budgetTokens: null
    };
  }

  if (typeof thinking !== "object") {
    return null;
  }

  const type = String(thinking.type || "enabled").trim().toLowerCase() || "enabled";
  const budgetTokens = Number(thinking.budget_tokens || thinking.budgetTokens || 0) || null;
  return {
    type,
    budgetTokens
  };
}

function mapAnthropicThinkingToOpenAiReasoning(thinking, fallbackReasoningEffort = "") {
  const normalized = normalizeAnthropicThinking(thinking);
  if (!normalized || normalized.type === "disabled") {
    return null;
  }

  let effort = normalizeReasoningEffort(fallbackReasoningEffort) || "medium";
  if (normalized.budgetTokens != null) {
    if (normalized.budgetTokens <= 1024) {
      effort = "low";
    } else if (normalized.budgetTokens > 4096) {
      effort = "high";
    }
  }

  return {
    reasoning_effort: effort,
    reasoning: {
      effort
    }
  };
}

function buildError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.type = classifyErrorType(status, error);
  if (details) {
    error.details = details;
  }
  return error;
}

function shouldFallbackToExternalProvider(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || 0);
  const type = String(error.type || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  // 413: payload too large — another provider may have a higher limit
  // 5xx except 501: transient server errors worth retrying externally
  // 501 Not Implemented is excluded: no external provider will support it either
  if (status === 401 || status === 403 || status === 408 || status === 413 || status === 429 || (status >= 500 && status !== 501)) {
    return true;
  }

  return (
    type === "authentication_error" ||
    type === "rate_limit_error" ||
    type === "overloaded_error" ||
    type === "timeout_error" ||
    type === "api_connection_error" ||
    /quota|unauthorized|rate limit|overloaded|timed out|fetch failed|terminated|provider unavailable/.test(message)
  );
}

class ExternalFallbackClient {
  constructor(config = {}) {
    this.fetchImpl = config.fetchImpl || fetch;
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    this.id = String(config.id || this.id || createFallbackId());
    this.name = String(config.name || this.name || "外部渠道");
    this.enabled = config.enabled !== false;
    this.baseUrl = String(config.baseUrl || "").replace(/\/$/, "");
    this.apiKey = String(config.apiKey || "");
    this.model = String(config.model || "");
    this.timeoutMs = Number(config.timeoutMs || 60000);
    this.protocol = String(config.protocol || "openai").toLowerCase() === "anthropic" ? "anthropic" : "openai";
    this.anthropicVersion = String(config.anthropicVersion || DEFAULT_ANTHROPIC_VERSION || "2023-06-01");
    this.reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
    this.preferredAnthropicMessagesPath = null;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.model);
  }

  transportName() {
    return this.protocol === "anthropic" ? "external-anthropic" : "external-openai";
  }

  buildAnthropicMessageUrls() {
    const candidates = [];
    const pushUnique = (url) => {
      if (!candidates.includes(url)) {
        candidates.push(url);
      }
    };

    if (this.preferredAnthropicMessagesPath) {
      pushUnique(this.baseUrl + this.preferredAnthropicMessagesPath);
    }

    pushUnique(this.baseUrl + "/messages");
    if (!/\/v1$/i.test(this.baseUrl)) {
      pushUnique(this.baseUrl + "/v1/messages");
    }

    return candidates;
  }

  async fetchAnthropicMessageResponse(body) {
    const requestOptions = {
      method: "POST",
      headers: this.buildAnthropicHeaders(),
      body: JSON.stringify(body)
    };

    let lastResponse = null;
    for (const url of this.buildAnthropicMessageUrls()) {
      log.info("external fallback anthropic request begin", {
        protocol: this.transportName(),
        url
      });
      const response = body && body.stream === true
        ? await this.fetchStreamWithRetry(url, requestOptions)
        : await this.fetchWithRetry(url, {
            ...requestOptions,
            signal: AbortSignal.timeout(this.timeoutMs)
          });
      lastResponse = response;

      if (response.status === 404) {
        log.warn("external fallback anthropic request got 404, trying next path", {
          protocol: this.transportName(),
          url
        });
        continue;
      }

      const contentType = String(response.headers.get("content-type") || "");
      if (/application\/json/i.test(contentType)) {
        try {
          const probe = await response.clone().json();
          if (isAnthropicWrappedNotFoundPayload(probe)) {
            log.warn("external fallback anthropic request got wrapped 404, trying next path", {
              protocol: this.transportName(),
              url
            });
            continue;
          }
        } catch {
          // Ignore probe parse failure and let caller handle the actual response.
        }
      }

      this.preferredAnthropicMessagesPath = String(url).endsWith("/v1/messages")
        ? "/v1/messages"
        : "/messages";

      return response;
    }

    return lastResponse;
  }

  async fetchStreamWithRetry(url, options) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeout = createTimeoutController(this.timeoutMs);
      try {
        if (attempt > 0) {
          log.warn("external fallback retrying request", {
            protocol: this.transportName(),
            url,
            attempt: attempt + 1
          });
        }

        const response = await this.fetchImpl(url, {
          ...options,
          signal: timeout.signal
        });
        timeout.clear();
        return response;
      } catch (error) {
        timeout.clear();
        const normalized = normalizeFetchError(error);
        lastError = normalized;

        log.warn("external fallback request failed", {
          protocol: this.transportName(),
          url,
          attempt: attempt + 1,
          status: normalized.status || null,
          type: normalized.type || null,
          error: normalized.message || String(normalized)
        });

        if (attempt >= 1 || !isRetryableFetchError(normalized)) {
          throw normalized;
        }

        await delay(250 * (2 ** attempt) + Math.floor(Math.random() * 200));
      }
    }

    throw lastError || new Error("External fallback fetch failed");
  }

  async fetchWithRetry(url, options) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0) {
          log.warn("external fallback retrying request", {
            protocol: this.transportName(),
            url,
            attempt: attempt + 1
          });
        }
        return await this.fetchImpl(url, options);
      } catch (error) {
        const normalized = normalizeFetchError(error);
        lastError = normalized;

        log.warn("external fallback request failed", {
          protocol: this.transportName(),
          url,
          attempt: attempt + 1,
          status: normalized.status || null,
          type: normalized.type || null,
          error: normalized.message || String(normalized)
        });

        if (attempt >= 1 || !isRetryableFetchError(normalized)) {
          throw normalized;
        }

        await delay(250 * (2 ** attempt) + Math.floor(Math.random() * 200));
      }
    }

    throw lastError || new Error("External fallback fetch failed");
  }

  buildAnthropicHeaders() {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
  }

  async requestAnthropicMessage(body) {
    if (!this.isConfigured()) {
      throw new Error("External fallback provider is not configured");
    }

    const payload = {
      ...(body && typeof body === "object" ? body : {}),
      model: this.model,
      stream: body && body.stream === true
    };

    return this.fetchAnthropicMessageResponse(payload);
  }

  isEligibleAnthropic(body) {
    if (!this.isConfigured()) {
      return false;
    }

    if (this.protocol === "anthropic") {
      return Boolean(body && typeof body === "object");
    }

    if (!body || (Array.isArray(body.tools) && body.tools.length > 0) || hasAnthropicImages(body.messages)) {
      return false;
    }

    return true;
  }

  isEligibleOpenAi(body) {
    if (!this.isConfigured()) {
      return false;
    }

    if (!body) {
      return false;
    }

    if (hasOpenAiTools(body.tools) || hasOpenAiImages(body.messages)) {
      return false;
    }

    return true;
  }

  async complete({ messages, system, maxTokens, temperature, metadata, reasoning }) {
    if (!this.isConfigured()) {
      throw new Error("External fallback provider is not configured");
    }

    const isAnthropic = this.protocol === "anthropic";

    let response;
    if (isAnthropic) {
      const requestBody = {
        model: this.model,
        system: system || undefined,
        messages,
        max_tokens: maxTokens || 4096,
        temperature,
        metadata: metadata || undefined,
        stream: false
      };
      response = await this.fetchAnthropicMessageResponse(requestBody);
    } else {
      const requestBody = JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        metadata: metadata || undefined,
        ...(reasoning || {})
      });
      response = await this.fetchWithRetry(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.apiKey,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: requestBody,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        "External fallback request failed: " + response.status;
      throw buildError(response.status, message, {
        upstream: {
          provider: this.transportName(),
          status: response.status,
          body: payload || null
        }
      });
    }

    return {
      model: this.model,
      text: isAnthropic ? extractTextFromAnthropicMessage(payload) : extractTextFromCompletion(payload),
      usage: payload && payload.usage ? payload.usage : null,
      raw: payload
    };
  }

  async completeAnthropic(body) {
    if (this.protocol === "anthropic") {
      const payload = anthropicToAnthropicPayload(body);
      return this.complete({
        system: payload.system,
        messages: payload.messages,
        maxTokens: Number(body && body.max_tokens) || undefined,
        temperature: typeof (body && body.temperature) === "number" ? body.temperature : undefined,
        metadata: { source: "accio-bridge-anthropic-fallback" }
      });
    }

    return this.complete({
      messages: anthropicToFallbackMessages(body),
      maxTokens: Number(body && body.max_tokens) || undefined,
      temperature: typeof (body && body.temperature) === "number" ? body.temperature : undefined,
      metadata: { source: "accio-bridge-anthropic-fallback" },
      reasoning: mapAnthropicThinkingToOpenAiReasoning(body && body.thinking, this.reasoningEffort)
    });
  }

  async completeOpenAi(body) {
    if (this.protocol === "anthropic") {
      const payload = openAiToAnthropicPayload(body);
      return this.complete({
        system: payload.system,
        messages: payload.messages,
        maxTokens: Number(body && (body.max_completion_tokens || body.max_tokens)) || undefined,
        temperature: typeof (body && body.temperature) === "number" ? body.temperature : undefined,
        metadata: { source: "accio-bridge-openai-fallback" }
      });
    }

    return this.complete({
      messages: openAiToFallbackMessages(body),
      maxTokens: Number(body && (body.max_completion_tokens || body.max_tokens)) || undefined,
      temperature: typeof (body && body.temperature) === "number" ? body.temperature : undefined,
      metadata: { source: "accio-bridge-openai-fallback" }
    });
  }

  async probe() {
    if (!this.isConfigured()) {
      throw new Error("External fallback provider is not configured");
    }

    if (this.protocol === "anthropic") {
      const result = await this.completeAnthropic({
        model: this.model,
        max_tokens: 32,
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
      });
      return {
        ok: true,
        protocol: this.protocol,
        transport: this.transportName(),
        model: result.model || this.model,
        usage: result.usage || null,
        preview: result.text || ""
      };
    }

    const result = await this.completeOpenAi({
      model: this.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }]
    });
    return {
      ok: true,
      protocol: this.protocol,
      transport: this.transportName(),
      model: result.model || this.model,
      usage: result.usage || null,
      preview: result.text || ""
    };
  }
}

class ExternalFallbackPool {
  constructor(config = {}) {
    this.fetchImpl = config.fetchImpl || fetch;
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    const targets = normalizeFallbackTargets(config.targets || []);
    this.targets = targets;
    this.entries = targets.map((target) => ({
      target,
      client: new ExternalFallbackClient({
        ...target,
        fetchImpl: this.fetchImpl
      })
    }));
    return this.targets;
  }

  isConfigured() {
    return this.entries.some((entry) => entry.client.isConfigured());
  }

  getSettings() {
    return this.targets.map((target) => ({ ...target }));
  }

  getEligibleAnthropic(body) {
    return this.entries.filter((entry) => entry.client.isEligibleAnthropic(body));
  }

  getEligibleOpenAi(body) {
    return this.entries.filter((entry) => entry.client.isEligibleOpenAi(body));
  }

  getConfiguredEntries() {
    return this.entries.filter((entry) => entry.client.isConfigured());
  }
}

module.exports = {
  DEFAULT_ANTHROPIC_VERSION,
  ExternalFallbackClient,
  ExternalFallbackPool,
  anthropicToAnthropicPayload,
  anthropicToFallbackMessages,
  normalizeFallbackTarget,
  normalizeFallbackTargets,
  openAiToAnthropicPayload,
  openAiToFallbackMessages,
  shouldFallbackToExternalProvider
};
