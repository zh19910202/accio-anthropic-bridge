"use strict";

const crypto = require("node:crypto");

const modelAliases = require("../config/model-aliases.json");

const { writeAccountToFile } = require("./accounts-file");
const { shouldFailoverAccount } = require("./errors");
const {
  buildGatewayAuthCallbackQuery,
  refreshAuthPayloadViaUpstream,
  waitForGatewayAuthenticatedUser
} = require("./gateway-auth");
const { extractGatewayModels } = require("./models");
const { extractAccessToken } = require("./gateway-manager");
const { normalizeRequestedModel } = require("./model");
const { safeJsonParse } = require("./jsonc");
const log = require("./logger");
const { maskToken } = require("./redaction");
const { readAccioUtdid, extractCnaFromCookie, normalizeCookieHeader } = require("./discovery");

const DEFAULT_PROVIDER_MODEL = "claude-opus-4-6";

function mapRequestedModel(model, protocol) {
  const requested = normalizeRequestedModel(model);

  if (!requested) {
    return DEFAULT_PROVIDER_MODEL;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function toPositiveInteger(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return Math.floor(number);
}

function normalizeAnthropicThinking(thinking, maxTokens) {
  if (!thinking || typeof thinking !== "object" || thinking.type !== "enabled") {
    return null;
  }

  const budgetTokens = toPositiveInteger(thinking.budget_tokens);

  if (!budgetTokens) {
    return null;
  }

  const maxOutputTokens = toPositiveInteger(maxTokens);

  return {
    type: "enabled",
    budget_tokens: maxOutputTokens
      ? Math.min(budgetTokens, Math.max(1, maxOutputTokens - 1))
      : budgetTokens
  };
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }

  return null;
}

function resolveOpenAiThinking(body) {
  const directThinking = normalizeAnthropicThinking(body.thinking, body.max_tokens);

  if (directThinking) {
    return directThinking;
  }

  const reasoning = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : null;
  const effort = normalizeReasoningEffort(
    body.reasoning_effort || (reasoning && (reasoning.effort || reasoning.level))
  );

  if (!effort) {
    return null;
  }

  const maxOutputTokens = toPositiveInteger(body.max_tokens);

  if (!maxOutputTokens) {
    return null;
  }

  const ratioByEffort = {
    low: 0.25,
    medium: 0.5,
    high: 0.8
  };
  let budgetTokens = Math.floor(maxOutputTokens * ratioByEffort[effort]);

  budgetTokens = Math.max(128, budgetTokens);
  budgetTokens = Math.min(budgetTokens, Math.max(1, maxOutputTokens - 1));

  return budgetTokens > 0
    ? {
        type: "enabled",
        budget_tokens: budgetTokens
      }
    : null;
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
  const rawThinking = extractThinkingConfigFromAnthropic(body);
  const thinking = normalizeAnthropicThinking(rawThinking, body.max_tokens) || rawThinking;
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
  const thinking = resolveOpenAiThinking(body);

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
      stop_sequences: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : [],
      ...(thinking ? { thinking } : {})
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
    this.thinkingBlocks = [];
    this.stopReason = null;
    this.usage = null;
    this.currentTool = null;
    this.currentThinking = null;
    this.error = null;
    this.emittedEvents = 0;
  }

  emit(event, onEvent) {
    if (typeof onEvent !== "function" || !event || typeof event !== "object") {
      return;
    }

    this.emittedEvents += 1;
    onEvent(event);
  }

  hasVisibleOutput() {
    return this.emittedEvents > 0;
  }

  applyNormalizedParts(parts, onEvent) {
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part.text === "string" && part.text) {
        this.text += part.text;

        this.emit({ type: "text_delta", text: part.text }, onEvent);
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

    this.emit({ type: "claude_raw", raw }, onEvent);

    if (raw.type === "message_start" && raw.message) {
      this.id = raw.message.id || this.id;
      this.model = raw.message.model || this.model;
      this.usage = raw.message.usage || this.usage;
      return;
    }

    if (raw.type === "content_block_start" && raw.content_block) {
      const block = raw.content_block;

      if (block.type === "thinking") {
        this.currentThinking = {
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          signature: block.signature || null
        };
        return;
      }

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

        if (deltaText) {
          this.emit({ type: "text_delta", text: deltaText }, onEvent);
        }

        return;
      }

      if (raw.delta.type === "thinking_delta" && this.currentThinking) {
        this.currentThinking.thinking += raw.delta.thinking || "";
        return;
      }

      if (raw.delta.type === "signature_delta" && this.currentThinking) {
        this.currentThinking.signature = raw.delta.signature || this.currentThinking.signature;
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

      this.emit({ type: "tool_call", toolCall }, onEvent);

      this.currentTool = null;
      return;
    }

    if (raw.type === "content_block_stop" && this.currentThinking) {
      const thinkingBlock = {
        type: "thinking",
        thinking: this.currentThinking.thinking || ""
      };

      if (this.currentThinking.signature) {
        thinkingBlock.signature = this.currentThinking.signature;
      }

      if (thinkingBlock.thinking || thinkingBlock.signature) {
        this.thinkingBlocks.push(thinkingBlock);
      }

      this.currentThinking = null;
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
      thinkingBlocks: this.thinkingBlocks,
      stopReason:
        this.stopReason ||
        (this.toolCalls.length > 0 && !this.text ? "tool_use" : "end_turn"),
      usage: this.usage || null
    };
  }
}

async function* parseSseEvents(stream, maxBufferSize = 10 * 1024 * 1024) {
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

      if (buffer.length > maxBufferSize) {
        throw new Error(`SSE buffer exceeded ${maxBufferSize} bytes — possible malformed stream`);
      }

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

function buildGatewayCooldownError(details = {}) {
  const refreshUntilMs = Number(details.refreshUntilMs || 0);
  const refreshCountdownSeconds = Number(details.refreshCountdownSeconds || 0);
  const message = details.message || "quota exhausted (gateway cooling down until refresh)";
  const error = new Error(message);
  error.name = "GatewayQuotaCooldownError";
  error.status = 429;
  error.type = "rate_limit_error";
  error.details = {
    upstream: {
      status: 429,
      statusText: "Too Many Requests",
      body: {
        message,
        source: "gateway-cooldown",
        refreshUntilMs: Number.isFinite(refreshUntilMs) && refreshUntilMs > 0 ? refreshUntilMs : null,
        refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds) && refreshCountdownSeconds > 0
          ? refreshCountdownSeconds
          : null
      }
    }
  };
  return error;
}

class DirectLlmClient {
  constructor(config) {
    this.config = config;
    this.authProvider = config.authProvider || null;
    this.gatewayManager = config.gatewayManager || null;
    this.fetchImpl = config.fetchImpl || fetch;
    this._cachedToken = null;
    this._cachedAt = 0;
    this._cacheTtlMs = Number(config.authCacheTtlMs || 2 * 60 * 1000);
    this._availableModels = null;
    this._availableModelsAt = 0;
    this._modelsCacheTtlMs = Number(config.modelsCacheTtlMs || 30 * 1000);
    this._quotaPreflightEnabled = config.quotaPreflightEnabled !== false;
    this._quotaCacheTtlMs = Number(config.quotaCacheTtlMs || 30 * 1000);
    this._quotaCache = new Map();
    this._gatewayQuotaInvalidUntil = 0;
    this._gatewayQuotaReason = null;
    this._gatewayQuota = null;
    this._utdid = readAccioUtdid(config.accioHome);
    this._accountStandbyEnabled = config.accountStandbyEnabled !== false;
    this._accountStandbyRefreshMs = Number(config.accountStandbyRefreshMs || 30000);
    this._preparedCredentials = [];
    this._preparedCredentialsAt = 0;
    this._preparedLastError = null;
    this._standbyRefreshPromise = null;
    this._standbyTimer = null;
    this._standbyListeners = new Set();
  }

  _deriveGatewayBaseUrl() {
    return String(this.gatewayManager && this.gatewayManager.baseUrl
      ? this.gatewayManager.baseUrl
      : this.config.localGatewayBaseUrl || "http://127.0.0.1:4097").replace(/\/$/, "");
  }

  async _readGatewayState() {
    const normalized = this._deriveGatewayBaseUrl();

    try {
      const response = await this.fetchImpl(`${normalized}/auth/status`, {
        signal: AbortSignal.timeout(3000)
      });

      if (!response.ok) {
        return {
          reachable: true,
          authenticated: false,
          baseUrl: normalized,
          status: response.status,
          user: null
        };
      }

      const payload = await response.json();
      return {
        reachable: true,
        authenticated: Boolean(payload && payload.authenticated),
        baseUrl: normalized,
        status: response.status,
        user: payload && payload.user ? payload.user : null
      };
    } catch (error) {
      return {
        reachable: false,
        authenticated: false,
        baseUrl: normalized,
        status: null,
        user: null,
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  async _requestGatewayJson(pathname, options = {}) {
    const response = await this.fetchImpl(`${this._deriveGatewayBaseUrl()}${pathname}`, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(Number(options.timeoutMs || 8000))
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  _isGatewayConnectionError(error) {
    const message = error && error.message ? String(error.message) : String(error || "");
    return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(message);
  }

  async _waitForGatewayReachable(waitMs = 20000, pollMs = 500) {
    const deadline = Date.now() + waitMs;
    let lastGateway = null;

    while (Date.now() < deadline) {
      const gateway = await this._readGatewayState();
      lastGateway = gateway;

      if (gateway && gateway.reachable) {
        return gateway;
      }

      await delay(pollMs);
    }

    return lastGateway;
  }

  async _requestGatewayText(pathname, options = {}) {
    const response = await this.fetchImpl(`${this._deriveGatewayBaseUrl()}${pathname}`, {
      method: options.method || "GET",
      headers: {
        ...(options.headers || {})
      },
      body: options.body || undefined,
      redirect: options.redirect || "manual",
      signal: AbortSignal.timeout(Number(options.timeoutMs || 15000))
    });
    const text = await response.text();

    if (!response.ok) {
      const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    return {
      status: response.status,
      text,
      location: response.headers.get("location") || null
    };
  }

  async _requestGatewayTextWithAutostart(pathname, options = {}) {
    try {
      return await this._requestGatewayText(pathname, options);
    } catch (error) {
      if (!this._isGatewayConnectionError(error)) {
        throw error;
      }

      if (!this.gatewayManager || typeof this.gatewayManager.ensureStarted !== "function") {
        throw error;
      }

      log.warn("gateway text request failed before autostart retry", {
        pathname,
        baseUrl: this._deriveGatewayBaseUrl(),
        error: error && error.message ? error.message : String(error)
      });

      await this.gatewayManager.ensureStarted();
      const gateway = await this._waitForGatewayReachable(
        Number(this.gatewayManager.waitMs || 20000),
        Number(this.gatewayManager.pollMs || 500)
      );

      if (!gateway || !gateway.reachable) {
        const retryError = new Error(`Gateway did not become reachable after launching Accio for ${pathname}`);
        retryError.type = "gateway_unreachable";
        throw retryError;
      }

      return this._requestGatewayText(pathname, options);
    }
  }

  async _forwardGatewayAuthCallback(payload, options = {}) {
    const query = buildGatewayAuthCallbackQuery(payload, options);
    return this._requestGatewayTextWithAutostart(`/auth/callback?${query}`, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      timeoutMs: Number(options.timeoutMs || 15000)
    });
  }

  async _waitForGatewayAuthenticatedUser(expectedUserId = "", waitMs = 15000, pollMs = 500) {
    return waitForGatewayAuthenticatedUser(
      () => this._readGatewayState(),
      expectedUserId,
      waitMs,
      pollMs
    );
  }

  async _refreshAuthPayloadViaUpstream(auth, context = {}) {
    const refreshed = await refreshAuthPayloadViaUpstream(this.config, {
      accessToken: auth && auth.token ? auth.token : "",
      refreshToken: auth && auth.refreshToken ? auth.refreshToken : "",
      expiresAtRaw: auth && auth.expiresAtRaw ? auth.expiresAtRaw : "",
      expiresAtMs: auth && auth.expiresAt ? auth.expiresAt : null,
      cookie: auth && auth.cookie ? auth.cookie : null,
      user: auth && auth.user ? auth.user : null,
      source: auth && auth.source ? auth.source : null
    }, {
      ...context,
      accountId: auth && auth.accountId ? auth.accountId : null,
      fetchImpl: this.fetchImpl,
      utdid: this._utdid || "",
      log,
      timeoutMs: 15000
    });

    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAtRaw: refreshed.expiresAtRaw,
      expiresAtMs: refreshed.expiresAtMs,
      cookie: refreshed.cookie || auth.cookie || null,
      user: refreshed.user || auth.user || null,
      source: refreshed.source,
      refreshBoundUserId: refreshed.refreshBoundUserId || null,
      refreshedAt: refreshed.refreshedAt
    };
  }

  _persistCredentialRefresh(auth, refreshedAuth) {
    if (!this.config.accountsPath || !auth || !auth.accountId || !refreshedAuth || !refreshedAuth.accessToken) {
      return;
    }

    try {
      writeAccountToFile(this.config.accountsPath, auth.accountId, refreshedAuth.accessToken, {
        user: refreshedAuth.user || auth.user || null,
        expiresAtMs: refreshedAuth.expiresAtMs || auth.expiresAt || null,
        expiresAtRaw: refreshedAuth.expiresAtRaw || auth.expiresAtRaw || null,
        refreshToken: refreshedAuth.refreshToken || auth.refreshToken || null,
        cookie: refreshedAuth.cookie || auth.cookie || null,
        source: "gateway-auth-callback",
        authPayload: {
          accessToken: refreshedAuth.accessToken,
          refreshToken: refreshedAuth.refreshToken || auth.refreshToken || null,
          expiresAtRaw: refreshedAuth.expiresAtRaw || auth.expiresAtRaw || null,
          expiresAtMs: refreshedAuth.expiresAtMs || auth.expiresAt || null,
          cookie: refreshedAuth.cookie || auth.cookie || null,
          user: refreshedAuth.user || auth.user || null,
          source: "gateway-auth-callback",
          capturedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      log.warn("persist auth payload after automatic gateway switch failed", {
        accountId: auth.accountId,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  async ensureGatewayAccountReady(auth) {
    if (!auth || auth.source === "gateway" || !auth.refreshToken || !auth.user || !auth.user.id) {
      return auth;
    }

    const expectedUserId = String(auth.user.id);
    const gatewayBefore = await this._readGatewayState();
    const currentGatewayUserId = gatewayBefore && gatewayBefore.user && gatewayBefore.user.id
      ? String(gatewayBefore.user.id)
      : "";

    if (gatewayBefore && gatewayBefore.reachable && gatewayBefore.authenticated && currentGatewayUserId === expectedUserId) {
      return auth;
    }

    const primedAuthPayload = await this._refreshAuthPayloadViaUpstream(auth, {
      previousUserId: currentGatewayUserId || null
    });

    if (gatewayBefore && gatewayBefore.reachable && gatewayBefore.authenticated) {
      await this._requestGatewayJson("/auth/logout", { method: "POST", body: {} }).catch((error) => {
        log.warn("automatic account switch logout before callback replay failed", {
          accountId: auth.accountId || null,
          error: error && error.message ? error.message : String(error)
        });
      });
    }

    await this._forwardGatewayAuthCallback(primedAuthPayload, { includeState: false, timeoutMs: 20000 });
    const gatewayAfter = await this._waitForGatewayAuthenticatedUser(expectedUserId, 20000, 500);
    const currentUserId = gatewayAfter && gatewayAfter.user && gatewayAfter.user.id
      ? String(gatewayAfter.user.id)
      : "";
    const switched = Boolean(gatewayAfter && gatewayAfter.reachable && gatewayAfter.authenticated && currentUserId === expectedUserId);

    if (!switched) {
      const error = new Error(`Automatic gateway account switch did not confirm target user ${expectedUserId}`);
      error.status = 502;
      error.type = "gateway_account_switch_failed";
      error.details = {
        expectedUserId,
        currentUserId: currentUserId || null
      };
      throw error;
    }

    const nextAuth = {
      ...auth,
      token: primedAuthPayload.accessToken,
      refreshToken: primedAuthPayload.refreshToken,
      expiresAtRaw: primedAuthPayload.expiresAtRaw,
      expiresAt: primedAuthPayload.expiresAtMs || auth.expiresAt || null,
      cookie: primedAuthPayload.cookie || auth.cookie || null,
      user: gatewayAfter && gatewayAfter.user ? gatewayAfter.user : auth.user,
      source: "gateway-auth-callback"
    };

    this._persistCredentialRefresh(auth, {
      accessToken: nextAuth.token,
      refreshToken: nextAuth.refreshToken,
      expiresAtRaw: nextAuth.expiresAtRaw,
      expiresAtMs: nextAuth.expiresAt,
      cookie: nextAuth.cookie,
      user: nextAuth.user
    });

    return nextAuth;
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

    const res = await this.fetchImpl(`${this.config.localGatewayBaseUrl}/debug/auth/ws-status`);
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
    const failoverMode = !options.accountId &&
      !options.stickyAccountId &&
      Array.isArray(options.excludeIds) &&
      options.excludeIds.length > 0;

    if (this.authProvider && authMode !== "gateway") {
      let standbyCredential = this._resolvePreparedCredential(options);
      if (!standbyCredential && failoverMode) {
        await this.refreshPreparedCredentials();
        standbyCredential = this._resolvePreparedCredential(options);
      }

      if (standbyCredential) {
        return standbyCredential;
      }

      if (failoverMode) {
        throw new Error("No prepared standby credential available for failover");
      }

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

    if (authMode === "auto") {
      const gatewayCooldown = this._getGatewayQuotaCooldown();
      if (gatewayCooldown.coolingDown) {
        throw buildGatewayCooldownError({
          message: gatewayCooldown.reason || "quota exhausted (gateway cooling down until refresh)",
          refreshUntilMs: gatewayCooldown.invalidUntil,
          refreshCountdownSeconds: gatewayCooldown.refreshCountdownSeconds
        });
      }
    }

    return {
      accountId: null,
      accountName: null,
      token: await this.getGatewayToken({ allowAutostart: options.allowAutostart !== false }),
      source: "gateway"
    };
  }

  startAccountStandbyLoop() {
    if (!this._accountStandbyEnabled || !this.authProvider || this._standbyTimer) {
      return;
    }

    const runRefresh = () => {
      this.refreshPreparedCredentials().catch((error) => {
        log.debug("prepared account refresh failed", {
          error: error && error.message ? error.message : String(error)
        });
      });
    };

    runRefresh();
    this._standbyTimer = setInterval(runRefresh, Math.max(5000, this._accountStandbyRefreshMs));
    if (this._standbyTimer && typeof this._standbyTimer.unref === "function") {
      this._standbyTimer.unref();
    }
  }

  stopAccountStandbyLoop() {
    if (this._standbyTimer) {
      clearInterval(this._standbyTimer);
      this._standbyTimer = null;
    }
  }

  _emitStandbyState() {
    const state = this.getStandbyState();
    for (const listener of this._standbyListeners) {
      try {
        listener(state);
      } catch {
        // Ignore listener errors so request handling stays isolated.
      }
    }
  }

  getStandbyState() {
    return {
      enabled: this._accountStandbyEnabled,
      refreshedAt: this._preparedCredentialsAt ? new Date(this._preparedCredentialsAt).toISOString() : null,
      lastError: this._preparedLastError || null,
      candidateCount: this._preparedCredentials.length,
      nextAccountId: this._preparedCredentials[0] && this._preparedCredentials[0].accountId
        ? String(this._preparedCredentials[0].accountId)
        : null,
      nextAccountName: this._preparedCredentials[0] && this._preparedCredentials[0].accountName
        ? String(this._preparedCredentials[0].accountName)
        : null,
      candidates: this._preparedCredentials.map((credential, index) => ({
        order: index + 1,
        accountId: credential && credential.accountId ? String(credential.accountId) : null,
        accountName: credential && credential.accountName ? String(credential.accountName) : null,
        source: credential && credential.source ? String(credential.source) : null,
        quotaCheckedAt: credential && credential.quotaCheckedAt ? String(credential.quotaCheckedAt) : null
      }))
    };
  }

  subscribeStandby(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    this._standbyListeners.add(listener);
    return () => {
      this._standbyListeners.delete(listener);
    };
  }

  _resolvePreparedCredential(options = {}) {
    if (
      !this._accountStandbyEnabled ||
      !this.authProvider ||
      options.accountId ||
      options.stickyAccountId ||
      !Array.isArray(options.excludeIds) ||
      options.excludeIds.length === 0
    ) {
      return null;
    }

    const excluded = new Set(options.excludeIds.map(String));
    const matched = this._preparedCredentials.find((credential) => {
      return credential &&
        credential.accountId &&
        !excluded.has(String(credential.accountId)) &&
        this.authProvider.isAccountUsable(String(credential.accountId));
    });

    return matched || null;
  }

  async refreshPreparedCredentials() {
    if (
      !this._accountStandbyEnabled ||
      !this.authProvider ||
      !this._quotaPreflightEnabled ||
      typeof this.authProvider.listCredentials !== "function"
    ) {
      return [];
    }

    if (this._standbyRefreshPromise) {
      return this._standbyRefreshPromise;
    }

    this._standbyRefreshPromise = (async () => {
      const prepared = [];
      const credentials = this.authProvider.listCredentials();

      for (const credential of credentials) {
        if (!credential || !credential.accountId || credential.source === "gateway") {
          continue;
        }

        if (!this.authProvider.isAccountUsable(credential.accountId)) {
          continue;
        }

        let quota = null;
        try {
          quota = await this.fetchQuotaStatus(credential);
        } catch {
          continue;
        }

        const usagePercent = Number(quota && quota.usagePercent);
        if (Number.isFinite(usagePercent) && usagePercent >= 100) {
          const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
          const reason = `quota precheck skipped account at ${Math.round(usagePercent)}%`;
          if (typeof this.authProvider.invalidateAccountUntil === "function") {
            this.authProvider.invalidateAccountUntil(credential.accountId, refreshUntilMs, reason);
          } else if (typeof this.authProvider.invalidateAccount === "function") {
            this.authProvider.invalidateAccount(credential.accountId, reason, refreshUntilMs);
          }
          continue;
        }

        prepared.push({
          ...credential,
          quotaCheckedAt: quota && quota.checkedAt ? quota.checkedAt : new Date().toISOString()
        });
      }

      this._preparedCredentials = prepared;
      this._preparedCredentialsAt = Date.now();
      this._preparedLastError = null;
      this._emitStandbyState();
      return prepared;
    })();

    try {
      return await this._standbyRefreshPromise;
    } catch (error) {
      this._preparedLastError = error && error.message ? String(error.message) : String(error);
      this._emitStandbyState();
      throw error;
    } finally {
      this._standbyRefreshPromise = null;
    }
  }

  clearTokenCache() {
    this._cachedToken = null;
    this._cachedAt = 0;
  }

  _getQuotaCacheKey(auth) {
    return `${String(auth && auth.accountId ? auth.accountId : "")}:${String(auth && auth.token ? auth.token : "")}`;
  }

  _getCachedQuota(auth) {
    const key = this._getQuotaCacheKey(auth);
    const cached = this._quotaCache.get(key);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.at >= this._quotaCacheTtlMs) {
      this._quotaCache.delete(key);
      return null;
    }

    return cached.value;
  }

  _setCachedQuota(auth, value) {
    const key = this._getQuotaCacheKey(auth);
    this._quotaCache.set(key, { at: Date.now(), value });
    return value;
  }

  _getQuotaRefreshUntilMs(quota) {
    const seconds = Number(quota && quota.refreshCountdownSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }

    return Date.now() + (Math.max(1, Math.floor(seconds)) * 1000);
  }

  _clearGatewayQuotaCooldown() {
    this._gatewayQuotaInvalidUntil = 0;
    this._gatewayQuotaReason = null;
    this._gatewayQuota = null;
  }

  _setGatewayQuotaCooldown(quota, reason) {
    const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
    this._gatewayQuotaInvalidUntil = Number.isFinite(refreshUntilMs) && refreshUntilMs > 0 ? refreshUntilMs : 0;
    this._gatewayQuotaReason = reason || "quota exhausted (gateway cooling down until refresh)";
    this._gatewayQuota = quota || null;
  }

  _getGatewayQuotaCooldown() {
    if (!Number.isFinite(this._gatewayQuotaInvalidUntil) || this._gatewayQuotaInvalidUntil <= 0) {
      return {
        coolingDown: false,
        invalidUntil: 0,
        reason: null,
        refreshCountdownSeconds: null
      };
    }

    if (this._gatewayQuotaInvalidUntil <= Date.now()) {
      this._clearGatewayQuotaCooldown();
      return {
        coolingDown: false,
        invalidUntil: 0,
        reason: null,
        refreshCountdownSeconds: null
      };
    }

    return {
      coolingDown: true,
      invalidUntil: this._gatewayQuotaInvalidUntil,
      reason: this._gatewayQuotaReason,
      refreshCountdownSeconds: Math.max(1, Math.ceil((this._gatewayQuotaInvalidUntil - Date.now()) / 1000))
    };
  }

  _rememberGatewayQuotaFailure(error) {
    if (!error || String(this.config.authMode || "auto") !== "auto") {
      return;
    }

    const current = this._getGatewayQuotaCooldown();
    if (current.coolingDown) {
      return;
    }

    const message = String(error.message || "").toLowerCase();
    if (!(Number(error.status || 0) === 429 || /quota/.test(message))) {
      return;
    }

    const refreshCountdownSeconds =
      Number(
        error &&
        error.details &&
        error.details.upstream &&
        error.details.upstream.body &&
        (
          error.details.upstream.body.refreshCountdownSeconds ||
          (error.details.upstream.body.data && error.details.upstream.body.data.refreshCountdownSeconds)
        )
      ) || Math.max(30, Math.ceil(this._quotaCacheTtlMs / 1000));

    this._setGatewayQuotaCooldown(
      { refreshCountdownSeconds },
      error.message || "quota exhausted (gateway cooling down until refresh)"
    );
  }

  async fetchQuotaStatus(auth) {
    if (!this._quotaPreflightEnabled || !auth || !auth.token) {
      return null;
    }

    const cached = this._getCachedQuota(auth);
    if (cached) {
      return cached;
    }

    const url = new URL("/api/entitlement/quota", this.config.upstreamBaseUrl);
    url.searchParams.set("accessToken", String(auth.token));
    url.searchParams.set("utdid", this._utdid || "");
    url.searchParams.set("version", "0.0.0");

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "x-language": this.config.language ? String(this.config.language) : "zh",
        "x-utdid": this._utdid || "",
        "x-app-version": "0.0.0",
        "x-os": process.platform,
        "x-cna": extractCnaFromCookie(auth.cookie),
        cookie: normalizeCookieHeader(auth.cookie),
        accept: "application/json, text/plain, */*"
      },
      signal: AbortSignal.timeout(Math.min(4000, Number(this.config.requestTimeoutMs || 4000)))
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload || payload.success !== true || !payload.data) {
      const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
      throw new Error(`Quota request failed: ${message}`);
    }

    return this._setCachedQuota(auth, {
      available: true,
      usagePercent: Number(payload.data.usagePercent),
      refreshCountdownSeconds: Number(payload.data.refreshCountdownSeconds),
      checkedAt: new Date().toISOString()
    });
  }

  async shouldSkipAccountByQuota(auth, options = {}) {
    if (!this._quotaPreflightEnabled || !auth || options.explicitAccountId) {
      return { skip: false, quota: null };
    }

    let quota = null;
    try {
      quota = await this.fetchQuotaStatus(auth);
    } catch (error) {
      if (typeof options.onDecision === "function") {
        options.onDecision({
          type: "quota_check_failed",
          accountId: auth.accountId,
          accountName: auth.accountName || null,
          authSource: auth.source,
          reason: error && error.message ? error.message : String(error),
          status: null
        });
      }
      return { skip: false, quota: null };
    }

    const usagePercent = Number(quota && quota.usagePercent);
    if (!Number.isFinite(usagePercent) || usagePercent < 100) {
      if (auth.source === "gateway") {
        this._clearGatewayQuotaCooldown();
      }
      return { skip: false, quota };
    }

    if (auth.source === "gateway") {
      const gatewayReason = "quota exhausted (gateway cooling down until refresh)";
      this._setGatewayQuotaCooldown(quota, gatewayReason);
      return {
        skip: String(this.config.authMode || "auto") === "auto",
        quota,
        gateway: true
      };
    }

    if (!this.authProvider) {
      return { skip: false, quota };
    }

    const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
    const reason = usagePercent !== null
      ? `quota precheck skipped account at ${Math.round(usagePercent)}%`
      : "quota precheck skipped account";

    if (typeof this.authProvider.invalidateAccountUntil === "function") {
      this.authProvider.invalidateAccountUntil(auth.accountId, refreshUntilMs, reason);
    } else if (typeof this.authProvider.invalidateAccount === "function") {
      this.authProvider.invalidateAccount(auth.accountId, reason, refreshUntilMs);
    }

    const next = this.authProvider.resolveCredential({
      stickyAccountId: options.stickyAccountId,
      excludeIds: [...(options.excludeIds || []), auth.accountId]
    });

    if (!next || !next.accountId) {
      return { skip: false, quota };
    }

    return { skip: true, quota };
  }

  _canContinueFailover(auth, triedAccounts, stickyAccountId) {
    const next = this.authProvider
      ? this.authProvider.resolveCredential({
          stickyAccountId,
          excludeIds: [...triedAccounts]
        })
      : null;

    if (next && next.accountId && !triedAccounts.has(next.accountId)) {
      return true;
    }

    return String(this.config.authMode || "auto") === "auto" && auth && auth.source !== "gateway";
  }

  _maybeContinueAfterAccountError({
    auth,
    error,
    explicitAccountId,
    stickyAccountId,
    triedAccounts,
    onDecision,
    responseStarted,
    phase
  }) {
    if (!shouldFailoverAccount(error) || explicitAccountId || !auth || !auth.accountId) {
      return false;
    }

    if (responseStarted) {
      if (typeof onDecision === "function") {
        onDecision({
          type: "account_failover_blocked",
          accountId: auth.accountId,
          accountName: auth.accountName || null,
          authSource: auth.source,
          reason: error && error.message ? error.message : String(error),
          status: error && error.status ? error.status : null,
          phase: phase || null,
          responseStarted: true
        });
      }
      return false;
    }

    triedAccounts.add(auth.accountId);

    if (typeof onDecision === "function") {
      onDecision({
        type: "account_failover",
        accountId: auth.accountId,
        accountName: auth.accountName || null,
        authSource: auth.source,
        reason: error && error.message ? error.message : String(error),
        status: error && error.status ? error.status : null,
        phase: phase || null,
        responseStarted: false
      });
    }

    return this._canContinueFailover(auth, triedAccounts, stickyAccountId);
  }

  _isModelsCacheFresh() {
    return this._availableModels && Date.now() - this._availableModelsAt < this._modelsCacheTtlMs;
  }

  async listAvailableModels() {
    if (this._isModelsCacheFresh()) {
      return this._availableModels;
    }

    const res = await this.fetchImpl(`${this.config.localGatewayBaseUrl}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(Math.min(5000, Number(this.config.requestTimeoutMs || 5000)))
    });

    if (!res.ok) {
      throw new Error(`Local gateway /models failed: ${res.status} ${res.statusText}`);
    }

    const models = extractGatewayModels(await res.json());
    this._availableModels = new Set(models.map((item) => item.id));
    this._availableModelsAt = Date.now();
    return this._availableModels;
  }

  async resolveProviderModel(requestedModel) {
    const requested = normalizeRequestedModel(requestedModel);
    const normalized = mapRequestedModel(requestedModel);
    let available = null;

    try {
      available = await this.listAvailableModels();
    } catch {
      return {
        requestedModel: requested || null,
        normalizedModel: normalized,
        resolvedProviderModel: normalized || DEFAULT_PROVIDER_MODEL,
        modelResolution: "alias"
      };
    }

    if (!available || available.size === 0) {
      return {
        requestedModel: requested || null,
        normalizedModel: normalized,
        resolvedProviderModel: normalized || DEFAULT_PROVIDER_MODEL,
        modelResolution: "alias"
      };
    }

    const candidates = [];
    if (requested) {
      candidates.push(requested);
    }
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }

    for (const candidate of candidates) {
      if (available.has(candidate)) {
        return {
          requestedModel: requested || null,
          normalizedModel: normalized,
          resolvedProviderModel: candidate,
          modelResolution: candidate === normalized ? "alias-match" : "direct-match"
        };
      }
    }

    return {
      requestedModel: requested || null,
      normalizedModel: normalized,
      resolvedProviderModel: available.has(DEFAULT_PROVIDER_MODEL) ? DEFAULT_PROVIDER_MODEL : (normalized || DEFAULT_PROVIDER_MODEL),
      modelResolution: "fallback"
    };
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
    const MAX_FAILOVER_ATTEMPTS = 10;
    const triedAccounts = new Set();
    let lastError = null;
    let attempts = 0;
    const modelInfo = await this.resolveProviderModel(request.model);

    if (typeof options.onDecision === "function") {
      options.onDecision({
        type: "model_resolution",
        requestedModel: modelInfo.requestedModel,
        normalizedModel: modelInfo.normalizedModel,
        resolvedProviderModel: modelInfo.resolvedProviderModel,
        resolution: modelInfo.modelResolution
      });
    }

    while (attempts < MAX_FAILOVER_ATTEMPTS) {
      attempts++;
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

      const quotaDecision = await this.shouldSkipAccountByQuota(auth, {
        explicitAccountId,
        stickyAccountId,
        excludeIds: [...triedAccounts],
        onDecision: options.onDecision
      });

      if (quotaDecision.skip && auth.source === "gateway") {
        throw buildGatewayCooldownError({
          message: "quota exhausted (gateway cooling down until refresh)",
          refreshUntilMs: this._gatewayQuotaInvalidUntil,
          refreshCountdownSeconds: quotaDecision.quota && quotaDecision.quota.refreshCountdownSeconds
        });
      }

      if (quotaDecision.skip && auth.accountId && this.authProvider) {
        const usagePercent = quotaDecision.quota && Number.isFinite(Number(quotaDecision.quota.usagePercent))
          ? Number(quotaDecision.quota.usagePercent)
          : null;
        const reason = usagePercent !== null
          ? `quota precheck skipped account at ${Math.round(usagePercent)}%`
          : "quota precheck skipped account";
        triedAccounts.add(auth.accountId);

        if (typeof options.onDecision === "function") {
          options.onDecision({
            type: "account_failover",
            accountId: auth.accountId,
            accountName: auth.accountName || null,
            authSource: auth.source,
            reason,
            status: 429
          });
        }

        this.refreshPreparedCredentials().catch(() => {});
        continue;
      }

      let activeAuth = auth;
      if (activeAuth.accountId && activeAuth.source !== "gateway") {
        try {
          activeAuth = await this.ensureGatewayAccountReady(activeAuth);
        } catch (error) {
          if (activeAuth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
            this.authProvider.recordFailure(activeAuth.accountId, error);
          }

          if (activeAuth.accountId && this.authProvider && typeof this.authProvider.invalidateAccount === "function") {
            this.authProvider.invalidateAccount(activeAuth.accountId, error && error.message ? error.message : String(error));
          }

          if (typeof options.onDecision === "function") {
            options.onDecision({
              type: "account_failover",
              accountId: activeAuth.accountId,
              accountName: activeAuth.accountName || null,
              authSource: activeAuth.source,
              reason: error && error.message ? error.message : String(error),
              status: error && error.status ? error.status : 502,
              phase: "account-switch"
            });
          }

          triedAccounts.add(activeAuth.accountId);
          this.refreshPreparedCredentials().catch(() => {});

          if (this._canContinueFailover(activeAuth, triedAccounts, stickyAccountId)) {
            lastError = error;
            continue;
          }

          throw error;
        }
      }

      if (typeof options.onDecision === "function") {
        options.onDecision({
          type: "direct_attempt",
          accountId: activeAuth.accountId,
          accountName: activeAuth.accountName || null,
          authSource: activeAuth.source,
          requestedModel: modelInfo.requestedModel,
          normalizedModel: modelInfo.normalizedModel,
          resolvedProviderModel: modelInfo.resolvedProviderModel,
          resolution: modelInfo.modelResolution,
          thinking: request.thinking || null
        });
      }

      const upstreamBody = {
        ...request.requestBody,
        model: modelInfo.resolvedProviderModel,
        token: activeAuth.token
      };
      let res;

      try {
        res = await this.fetchImpl(`${this.config.upstreamBaseUrl}/generateContent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream"
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs)
        });
      } catch (error) {
        if (activeAuth.source === "gateway") {
          this.clearTokenCache();
        }

        throw error;
      }

      if (!res.ok) {
        const rawText = await res.text().catch(() => "");
        const upstreamError = new UpstreamHttpError(res.status, res.statusText, rawText, activeAuth.token);

        if (activeAuth.source === "gateway" && (res.status === 401 || res.status === 403)) {
          this.clearTokenCache();
        }

        if (activeAuth.source === "gateway") {
          this._rememberGatewayQuotaFailure(upstreamError);
        }

        if (activeAuth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(activeAuth.accountId, upstreamError);
        }

        if (
          shouldFailoverAccount(upstreamError) &&
          activeAuth.accountId &&
          this.authProvider &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(activeAuth.accountId, upstreamError.message);
        }

        const shouldContinue = this._maybeContinueAfterAccountError({
          auth: activeAuth,
          error: upstreamError,
          explicitAccountId,
          stickyAccountId,
          triedAccounts,
          onDecision: options.onDecision,
          responseStarted: false,
          phase: "http"
        });

        if (shouldContinue) {
          lastError = upstreamError;
          continue;
        }

        throw upstreamError;
      }

      if (!res.body) {
        throw new Error("Direct LLM response has no body");
      }

      const state = new DirectResponseAccumulator(modelInfo.resolvedProviderModel);

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
        if (activeAuth.source === "gateway") {
          this._rememberGatewayQuotaFailure(state.error);
        }

        if (activeAuth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
          this.authProvider.recordFailure(activeAuth.accountId, state.error);
        }

        if (
          shouldFailoverAccount(state.error) &&
          activeAuth.accountId &&
          this.authProvider &&
          typeof this.authProvider.invalidateAccount === "function"
        ) {
          this.authProvider.invalidateAccount(activeAuth.accountId, state.error.message);
        }

        const shouldContinue = this._maybeContinueAfterAccountError({
          auth: activeAuth,
          error: state.error,
          explicitAccountId,
          stickyAccountId,
          triedAccounts,
          onDecision: options.onDecision,
          responseStarted: state.hasVisibleOutput(),
          phase: "stream"
        });

        if (shouldContinue) {
          lastError = state.error;
          continue;
        }

        throw state.error;
      }

      if (activeAuth.accountId && this.authProvider) {
        if (typeof this.authProvider.clearFailure === "function") {
          this.authProvider.clearFailure(activeAuth.accountId);
        }

        if (typeof this.authProvider.clearInvalidation === "function") {
          this.authProvider.clearInvalidation(activeAuth.accountId);
        }
      }

      if (activeAuth.source === "gateway") {
        this._clearGatewayQuotaCooldown();
      }

      return {
        ...state.toResult(),
        accountId: activeAuth.accountId,
        accountName: activeAuth.accountName || null,
        authSource: activeAuth.source,
        resolvedProviderModel: modelInfo.resolvedProviderModel,
        thinking: request.thinking || null
      };
    }

    throw lastError || new Error(`Failover exhausted after ${attempts} attempts`);
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
