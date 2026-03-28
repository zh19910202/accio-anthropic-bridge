"use strict";

const crypto = require("node:crypto");

const modelAliases = require("../config/model-aliases.json");

const { shouldFailoverAccount } = require("./errors");
const { extractAccessToken } = require("./gateway-manager");
const { normalizeRequestedModel } = require("./model");

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapRequestedModel(model, protocol) {
  const requested = normalizeRequestedModel(model);
  const fallback = "claude-opus-4-6";

  if (!requested) {
    return fallback;
  }

  return modelAliases[requested] || requested;
}

function supportsThinkingForModel(model) {
  const resolved = mapRequestedModel(model);
  return /claude-(opus|sonnet)/i.test(String(resolved || ""));
}

function extractThinkingConfigFromAnthropic(body) {
  if (!body || !body.thinking || body.thinking === false) {
    return null;
  }

  if (body.thinking === true) {
    return { type: "enabled" };
  }

  if (typeof body.thinking === "object") {
    const type = String(body.thinking.type || "enabled");
    const budgetTokens = Number(body.thinking.budget_tokens || body.thinking.budgetTokens || 0) || null;
    return budgetTokens ? { type, budget_tokens: budgetTokens } : { type };
  }

  return { type: "enabled" };
}

function inferProvider(model) {
  const value = String(model || "").toLowerCase();

  if (value.includes("claude")) {
    return "claude";
  }

  if (value.includes("gpt")) {
    return "openai";
  }

  if (value.includes("gemini")) {
    return "gemini";
  }

  return "unknown";
}

function toToolDeclarations(tools, pickSchema) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || !tool.name) {
        return null;
      }

      return {
        name: tool.name,
        description: tool.description || "",
        parameters_json: JSON.stringify(pickSchema(tool) || {})
      };
    })
    .filter(Boolean);
}

function normalizeImagePart(block) {
  if (!block || typeof block !== "object") {
    return null;
  }

  if (block.type === "image_url" && block.image_url && block.image_url.url) {
    return {
      file_data: {
        file_uri: block.image_url.url,
        mime_type: "image/png"
      }
    };
  }

  if (block.type !== "image") {
    return null;
  }

  const source = block.source || {};

  if (source.type === "base64" && source.data) {
    return {
      inline_data: {
        mime_type: source.media_type || "image/png",
        data: source.data
      }
    };
  }

  if (source.type === "url" && source.url) {
    return {
      file_data: {
        file_uri: source.url,
        mime_type: source.media_type || "image/png"
      }
    };
  }

  return null;
}

function buildAnthropicToolNameMap(messages) {
  const map = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = Array.isArray(message && message.content)
      ? message.content
      : [];

    for (const block of content) {
      if (block && block.type === "tool_use" && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }

  return map;
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") {
    return safeJsonParse(content, { result: content });
  }

  if (!Array.isArray(content)) {
    return content && typeof content === "object" ? content : { result: content };
  }

  const textParts = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);

  if (textParts.length === 1) {
    return safeJsonParse(textParts[0], { result: textParts[0] });
  }

  if (textParts.length > 1) {
    return { result: textParts.join("\n") };
  }

  return { result: content };
}

function toAnthropicDirectParts(content, role, toolNameById) {
  const normalized = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const parts = [];

  for (const block of Array.isArray(normalized) ? normalized : []) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      parts.push({ text: block.text || "" });
      continue;
    }

    const imagePart = normalizeImagePart(block);

    if (imagePart) {
      parts.push(imagePart);
      continue;
    }

    if (role === "assistant" && block.type === "tool_use") {
      parts.push({
        function_call: {
          id: block.id || crypto.randomUUID(),
          name: block.name || "unknown",
          args_json: JSON.stringify(block.input || {})
        }
      });
      continue;
    }

    if (role === "user" && block.type === "tool_result") {
      parts.push({
        function_response: {
          id: block.tool_use_id || "",
          name: toolNameById.get(block.tool_use_id) || block.name || "tool",
          response_json: JSON.stringify(normalizeToolResultContent(block.content))
        }
      });
    }
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function buildDirectRequestFromAnthropic(body) {
  const toolNameById = buildAnthropicToolNameMap(body.messages);
  const contents = [];
  const thinking = extractThinkingConfigFromAnthropic(body);
  const resolvedModel = mapRequestedModel(body.model, "anthropic");

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "model" : "user";

    contents.push({
      role,
      parts: toAnthropicDirectParts(message && message.content, message && message.role, toolNameById)
    });
  }

  return {
    protocol: "anthropic",
    model: resolvedModel,
    thinking,
    requestBody: {
      model: resolvedModel,
      request_id: `anthropic-${Date.now()}`,
      contents,
      system_instruction: typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
            .filter((block) => block && block.type === "text" && block.text)
            .map((block) => block.text)
            .join("\n\n")
          : "",
      tools: toToolDeclarations(body.tools, (tool) => tool.input_schema),
      temperature: body.temperature,
      max_output_tokens: body.max_tokens,
      stop_sequences: Array.isArray(body.stop_sequences) ? body.stop_sequences : [],
      ...(thinking ? { thinking } : {})
    }
  };
}

function buildOpenAiToolNameMap(messages) {
  const map = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    for (const toolCall of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
      const fn = toolCall && toolCall.function;

      if (toolCall && toolCall.id && fn && fn.name) {
        map.set(toolCall.id, fn.name);
      }
    }
  }

  return map;
}

function normalizeOpenAiContentParts(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [{ type: "text", text: "" }];
}

function toOpenAiDirectParts(message, toolNameById) {
  const parts = [];

  for (const block of normalizeOpenAiContentParts(message && message.content)) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      parts.push({ text: block.text || "" });
      continue;
    }

    const imagePart = normalizeImagePart(block);

    if (imagePart) {
      parts.push(imagePart);
    }
  }

  if (message && message.role === "assistant") {
    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = toolCall && toolCall.function;

      if (!fn || !fn.name) {
        continue;
      }

      parts.push({
        function_call: {
          id: toolCall.id || crypto.randomUUID(),
          name: fn.name,
          args_json: fn.arguments || "{}"
        }
      });
    }
  }

  if (message && message.role === "tool") {
    parts.push({
      function_response: {
        id: message.tool_call_id || "",
        name: toolNameById.get(message.tool_call_id) || message.name || "tool",
        response_json: JSON.stringify(
          normalizeToolResultContent(message.content)
        )
      }
    });
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function buildDirectRequestFromOpenAi(body) {
  const toolNameById = buildOpenAiToolNameMap(body.messages);
  const contents = [];
  const resolvedModel = mapRequestedModel(body.model, "openai");

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: toOpenAiDirectParts(message, toolNameById)
    });
  }

  return {
    protocol: "openai",
    model: resolvedModel,
    requestBody: {
      model: resolvedModel,
      request_id: `openai-${Date.now()}`,
      contents,
      tools: toToolDeclarations(
        Array.isArray(body.tools)
          ? body.tools
            .map((tool) => tool && (tool.function || tool))
            .filter(Boolean)
          : [],
        (tool) => tool.parameters || tool.input_schema
      ),
      temperature: body.temperature,
      max_output_tokens: body.max_tokens,
      stop_sequences: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : []
    }
  };
}

function maybeParseJsonString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return safeJsonParse(value, value);
}

class DirectResponseAccumulator {
  constructor(model) {
    this.model = model;
    this.provider = inferProvider(model);
    this.id = null;
    this.text = "";
    this.toolCalls = [];
    this.stopReason = null;
    this.usage = null;
    this.currentTool = null;
    this.error = null;
  }

  applyNormalizedParts(parts, onEvent) {
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part.text === "string" && part.text) {
        this.text += part.text;

        if (typeof onEvent === "function") {
          onEvent({ type: "text_delta", text: part.text });
        }
      }

      const functionCall = part.functionCall || part.function_call;

      if (functionCall && functionCall.name) {
        const id = functionCall.id || crypto.randomUUID();
        const input = maybeParseJsonString(functionCall.argsJson || functionCall.args_json || "{}");
        const toolCall = {
          id,
          name: functionCall.name,
          input: input && typeof input === "object" ? input : {}
        };

        if (!this.toolCalls.find((item) => item.id === toolCall.id)) {
          this.toolCalls.push(toolCall);
        }
      }
    }
  }

  applyClaudeEvent(raw, onEvent) {
    if (!raw || typeof raw !== "object" || !raw.type) {
      return;
    }

    if (typeof onEvent === "function") {
      onEvent({ type: "claude_raw", raw });
    }

    if (raw.type === "message_start" && raw.message) {
      this.id = raw.message.id || this.id;
      this.model = raw.message.model || this.model;
      this.usage = raw.message.usage || this.usage;
      return;
    }

    if (raw.type === "content_block_start" && raw.content_block) {
      const block = raw.content_block;

      if (block.type === "tool_use") {
        this.currentTool = {
          id: block.id || crypto.randomUUID(),
          name: block.name || "tool",
          inputJson:
            block.input && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input)
              : ""
        };
      }

      return;
    }

    if (raw.type === "content_block_delta" && raw.delta) {
      if (raw.delta.type === "text_delta") {
        const deltaText = raw.delta.text || "";
        this.text += deltaText;

        if (typeof onEvent === "function" && deltaText) {
          onEvent({ type: "text_delta", text: deltaText });
        }

        return;
      }

      if (raw.delta.type === "input_json_delta" && this.currentTool) {
        this.currentTool.inputJson += raw.delta.partial_json || "";
      }

      return;
    }

    if (raw.type === "content_block_stop" && this.currentTool) {
      const input = maybeParseJsonString(this.currentTool.inputJson || "{}");
      const toolCall = {
        id: this.currentTool.id,
        name: this.currentTool.name,
        input: input && typeof input === "object" ? input : {}
      };

      if (!this.toolCalls.find((item) => item.id === toolCall.id)) {
        this.toolCalls.push(toolCall);
      }

      if (typeof onEvent === "function") {
        onEvent({ type: "tool_call", toolCall });
      }

      this.currentTool = null;
      return;
    }

    if (raw.type === "message_delta") {
      this.stopReason =
        (raw.delta && raw.delta.stop_reason) || this.stopReason || null;
      this.usage = {
        ...(this.usage || {}),
        ...(raw.usage || {})
      };
    }
  }

  applyFrame(frame, onEvent) {
    if (frame && (frame.error_code || frame.error_message)) {
      this.error = new UpstreamSseError(frame);
      return;
    }

    if (frame.id) {
      this.id = frame.id;
    }

    if (frame.model) {
      this.model = frame.model;
    }

    if (frame.usage_metadata) {
      this.usage = frame.usage_metadata;
    }

    if (frame.finish_reason) {
      this.stopReason = frame.finish_reason;
    }

    if (frame.content && Array.isArray(frame.content.parts)) {
      this.applyNormalizedParts(frame.content.parts, onEvent);
    }

    if (frame.raw_response_json) {
      const raw = safeJsonParse(frame.raw_response_json, null);

      if (raw && raw.type) {
        this.applyClaudeEvent(raw, onEvent);
      }
    }
  }

  toResult() {
    return {
      id: this.id || `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      model: this.model,
      finalText: this.text,
      toolCalls: this.toolCalls,
      stopReason:
        this.stopReason ||
        (this.toolCalls.length > 0 && !this.text ? "tool_use" : "end_turn"),
      usage: this.usage || null
    };
  }
}

async function* parseSseEvents(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const lines = block.split("\n");
        const dataLines = [];

        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length === 0) {
          continue;
        }

        const data = dataLines.join("\n");

        if (data === "[DONE]") {
          continue;
        }

        yield safeJsonParse(data, null);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function maskToken(token) {
  if (!token || typeof token !== "string") {
    return "***";
  }

  return token.length > 8 ? `${token.slice(0, 8)}***` : "***";
}

function sanitizeErrorText(text, token) {
  if (!text || !token) {
    return text || "";
  }

  return text.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), maskToken(token));
}

function sanitizeErrorBody(value, token) {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeErrorText(value, token);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorBody(item, token));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const normalizedKey = String(key || "").toLowerCase();

        if ((normalizedKey === "token" || normalizedKey === "accesstoken" || normalizedKey === "authorization") && typeof item === "string") {
          return [key, maskToken(item)];
        }

        return [key, sanitizeErrorBody(item, token)];
      })
    );
  }

  return value;
}

function extractErrorMessage(parsed, fallback) {
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }

  if (parsed.error && typeof parsed.error === "object") {
    if (typeof parsed.error.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }

    if (typeof parsed.error.msg === "string" && parsed.error.msg.trim()) {
      return parsed.error.msg.trim();
    }
  }

  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message.trim();
  }

  if (typeof parsed.msg === "string" && parsed.msg.trim()) {
    return parsed.msg.trim();
  }

  return fallback;
}

function extractErrorType(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.type === "string") {
    return parsed.error.type;
  }

  if (typeof parsed.type === "string") {
    return parsed.type;
  }

  return null;
}

function mapUpstreamErrorStatus(errorCode) {
  const code = Number(errorCode) || 0;

  if (code === 400) {
    return 400;
  }

  if (code === 401 || code === 402 || code === 403) {
    return 401;
  }

  if (code === 404) {
    return 404;
  }

  if (code === 408) {
    return 408;
  }

  if (code === 429) {
    return 429;
  }

  if (code >= 500) {
    return code;
  }

  return 502;
}

function classifyUpstreamSseErrorType(code, message) {
  const normalized = String(message || "").toLowerCase();

  if (code === "401" || code === "402" || code === "403" || normalized.includes("unauthorized")) {
    return "authentication_error";
  }

  if (code === "429" || normalized.includes("rate limit")) {
    return "rate_limit_error";
  }

  if (code === "400" || normalized.includes("invalid") || normalized.includes("bad request")) {
    return "invalid_request_error";
  }

  if (code === "408" || normalized.includes("timeout")) {
    return "api_timeout_error";
  }

  return "api_error";
}

class UpstreamHttpError extends Error {
  constructor(status, statusText, bodyText, token) {
    const parsed = safeJsonParse(bodyText, null);
    const sanitizedParsed = sanitizeErrorBody(parsed, token);
    const sanitizedText = sanitizeErrorText(bodyText || "", token);
    const fallbackMessage = sanitizedText || `Direct LLM upstream request failed: ${status} ${statusText}`;
    const message = extractErrorMessage(sanitizedParsed, fallbackMessage);

    super(message);
    this.name = "UpstreamHttpError";
    this.status = Number(status) || 500;
    this.statusText = statusText || "";
    this.type = extractErrorType(sanitizedParsed) || null;
    this.bodyText = sanitizedText;
    this.body = sanitizedParsed || sanitizedText || null;
    this.details = {
      upstream: {
        status: this.status,
        statusText: this.statusText,
        body: this.body
      }
    };
  }
}

class UpstreamSseError extends Error {
  constructor(frame) {
    const code = String(frame && frame.error_code ? frame.error_code : "").trim() || null;
    const message =
      String(frame && frame.error_message ? frame.error_message : "").trim() ||
      "Direct LLM upstream stream returned an error frame";

    super(message);
    this.name = "UpstreamSseError";
    this.status = mapUpstreamErrorStatus(code);
    this.statusText = "OK";
    this.type = classifyUpstreamSseErrorType(code, message);
    this.code = code;
    this.body = frame || null;
    this.details = {
      upstream: {
        status: 200,
        statusText: "OK",
        body: frame || null
      }
    };
  }
}

class DirectLlmClient {
  constructor(config) {
    this.config = config;
    this.authProvider = config.authProvider || null;
    this.gatewayManager = config.gatewayManager || null;
    this._cachedToken = null;
    this._cachedAt = 0;
    this._cacheTtlMs = Number(config.authCacheTtlMs || 2 * 60 * 1000);
  }

  async getGatewayToken(options = {}) {
    if (this._cachedToken && Date.now() - this._cachedAt < this._cacheTtlMs) {
      return this._cachedToken;
    }

    if (this.gatewayManager) {
      const result = await this.gatewayManager.resolveAccessToken({
        allowAutostart: options.allowAutostart !== false
      });

      this._cachedToken = result.token;
      this._cachedAt = Date.now();
      return result.token;
    }

    const res = await fetch(`${this.config.localGatewayBaseUrl}/debug/auth/ws-status`);
    const payload = await res.json();
    const token = extractAccessToken(payload);

    if (!token) {
      this._cachedToken = null;
      throw new Error("Unable to resolve Accio access token from local gateway");
    }

    this._cachedToken = token;
    this._cachedAt = Date.now();
    return token;
  }

  async getAuthToken(options = {}) {
    const authMode = String(this.config.authMode || "auto");

    if (this.authProvider && authMode !== "gateway") {
      const credential = this.authProvider.resolveCredential({
        accountId: options.accountId,
        stickyAccountId: options.stickyAccountId,
        excludeIds: options.excludeIds
      });

      if (credential) {
        return credential;
      }

      if (authMode === "file" || authMode === "env") {
        throw new Error(`No usable credentials available for auth mode ${authMode}`);
      }
    }

    return {
      accountId: null,
      accountName: null,
      token: await this.getGatewayToken({ allowAutostart: options.allowAutostart !== false }),
      source: "gateway"
    };
  }

  clearTokenCache() {
    this._cachedToken = null;
    this._cachedAt = 0;
  }

  async isAvailable() {
    try {
      const auth = await this.getAuthToken({ allowAutostart: false });
      return Boolean(auth && auth.token);
    } catch {
      return false;
    }
  }

  async run(request, options = {}) {
    const explicitAccountId = options.accountId || request.accountId || null;
    const stickyAccountId = options.stickyAccountId || null;
    const triedAccounts = new Set();
    let lastError = null;

    while (true) {
      const auth = await this.getAuthToken({
        allowAutostart: true,
        accountId: explicitAccountId,
        stickyAccountId,
        excludeIds: [...triedAccounts]
      });
      const token = auth && auth.token;

      if (!token) {
        throw new Error("Accio access token is unavailable");
      }

      if (typeof options.onDecision === "function") {
        options.onDecision({
          type: "direct_attempt",
          accountId: auth.accountId,
          accountName: auth.accountName || null,
          authSource: auth.source,
          resolvedProviderModel: request.model,
          thinking: request.thinking || null
        });
      }

      const upstreamBody = {
        ...request.requestBody,
        token
      };
      let res;

      try {
        res = await fetch(`${this.config.upstreamBaseUrl}/generateContent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream"
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs)
        });
      } catch (error) {
        if (auth.source === "gateway") {
          this.clearTokenCache();
        }

        throw error;
      }

      if (!res.ok) {
        const rawText = await res.text().catch(() => "");
        const upstreamError = new UpstreamHttpError(res.status, res.statusText, rawText, token);

        if (auth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(auth.accountId, upstreamError);
        }

        if (
          shouldFailoverAccount(upstreamError) &&
          auth.accountId &&
          this.authProvider &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(auth.accountId, upstreamError.message);
        }

        if (shouldFailoverAccount(upstreamError) && !explicitAccountId && auth.accountId) {
          triedAccounts.add(auth.accountId);
          lastError = upstreamError;

          if (typeof options.onDecision === "function") {
            options.onDecision({
              type: "account_failover",
              accountId: auth.accountId,
              accountName: auth.accountName || null,
              reason: upstreamError.message,
              status: upstreamError.status
            });
          }

          const next = this.authProvider
            ? this.authProvider.resolveCredential({ stickyAccountId, excludeIds: [...triedAccounts] })
            : null;

          if (next && !triedAccounts.has(next.accountId || "")) {
            continue;
          }

          if (String(this.config.authMode || "auto") === "auto" && auth.source !== "gateway") {
            continue;
          }
        }

        throw upstreamError;
      }

      if (!res.body) {
        throw new Error("Direct LLM response has no body");
      }

      const state = new DirectResponseAccumulator(request.model);

      for await (const frame of parseSseEvents(res.body)) {
        if (!frame) {
          continue;
        }

        state.applyFrame(frame, options.onEvent);

        if (state.error) {
          break;
        }
      }

      if (state.error) {
        if (auth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(auth.accountId, state.error);
        }

        if (
          shouldFailoverAccount(state.error) &&
          auth.accountId &&
          this.authProvider &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(auth.accountId, state.error.message);
        }

        if (shouldFailoverAccount(state.error) && !explicitAccountId && auth.accountId) {
          triedAccounts.add(auth.accountId);
          lastError = state.error;

          if (typeof options.onDecision === "function") {
            options.onDecision({
              type: "account_failover",
              accountId: auth.accountId,
              accountName: auth.accountName || null,
              reason: state.error.message,
              status: state.error.status || null
            });
          }

          const next = this.authProvider
            ? this.authProvider.resolveCredential({ stickyAccountId, excludeIds: [...triedAccounts] })
            : null;

          if (next && !triedAccounts.has(next.accountId || "")) {
            continue;
          }
        }

        throw state.error;
      }

      if (auth.accountId && this.authProvider) {
        if (typeof this.authProvider.clearFailure === "function") {
          this.authProvider.clearFailure(auth.accountId);
        }

        if (typeof this.authProvider.clearInvalidation === "function") {
          this.authProvider.clearInvalidation(auth.accountId);
        }
      }

      return {
        ...state.toResult(),
        accountId: auth.accountId,
        accountName: auth.accountName || null,
        authSource: auth.source,
        resolvedProviderModel: request.model,
        thinking: request.thinking || null
      };
    }

    throw lastError;
  }
}

module.exports = {
  DirectLlmClient,
  UpstreamHttpError,
  UpstreamSseError,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi,
  extractThinkingConfigFromAnthropic,
  mapRequestedModel,
  supportsThinkingForModel
};
