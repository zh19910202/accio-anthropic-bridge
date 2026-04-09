"use strict";

const crypto = require("node:crypto");

const modelAliases = require("../config/model-aliases.json");

const { writeAccountToFile } = require("./accounts-file");
const { isTimeoutLikeError, shouldFailoverAccount } = require("./errors");
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
const {
  DIRECT_GATEWAY_DEFAULT_IAI_TAG,
  createGenerateContentRequest,
  serializeGenerateContentRequest
} = require("./direct-gateway-sdk");
const { delay } = require("./utils");

const DEFAULT_PROVIDER_MODEL = "claude-opus-4-6";
const CURRENT_DIRECT_MAX_OUTPUT_TOKENS = 16384;
const UUID_V4ISH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THINKING_MODEL_RE = /claude-(opus|sonnet)/i;
const TOKEN_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const GATEWAY_CONN_ERROR_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i;
const SENSITIVE_KEY_RE = /^(token|accesstoken|authorization)$/i;

function mapRequestedModel(model) {
  const requested = normalizeRequestedModel(model);

  if (!requested) {
    return DEFAULT_PROVIDER_MODEL;
  }

  return modelAliases[requested] || requested;
}

function supportsThinkingForModel(model) {
  const resolved = mapRequestedModel(model);
  return THINKING_MODEL_RE.test(String(resolved || ""));
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

function toDirectUpstreamThinkingFields(thinking, model) {
  // Current Accio desktop chat path does not send reasoning fields for
  // Claude/OpenAI requests. Keep bridge payload aligned until we capture a
  // confirmed successful upstream request that includes them.
  void thinking;
  void model;
  return {};
}

function normalizeDirectMaxOutputTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.min(Math.floor(parsed), CURRENT_DIRECT_MAX_OUTPUT_TOKENS);
}

function normalizeDirectRequestId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized && UUID_V4ISH_RE.test(normalized)) {
    return normalized;
  }

  return crypto.randomUUID();
}

function normalizeDirectMessageId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || crypto.randomUUID();
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
        parametersJson: JSON.stringify(pickSchema(tool) || {})
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
      fileData: {
        fileUri: block.image_url.url,
        mimeType: "image/png"
      }
    };
  }

  if (block.type !== "image") {
    return null;
  }

  const source = block.source || {};

  if (source.type === "base64" && source.data) {
    return {
      inlineData: {
        mimeType: source.media_type || "image/png",
        data: source.data
      }
    };
  }

  if (source.type === "url" && source.url) {
    return {
      fileData: {
        fileUri: source.url,
        mimeType: source.media_type || "image/png"
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
        functionCall: {
          id: block.id || crypto.randomUUID(),
          name: block.name || "unknown",
          argsJson: JSON.stringify(block.input || {})
        }
      });
      continue;
    }

    if (role === "user" && block.type === "tool_result") {
      parts.push({
        functionResponse: {
          id: block.tool_use_id || "",
          name: toolNameById.get(block.tool_use_id) || block.name || "tool",
          responseJson: JSON.stringify(normalizeToolResultContent(block.content))
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
  const resolvedModel = mapRequestedModel(body.model);

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
    requestBody: createGenerateContentRequest({
      model: resolvedModel,
      requestId: normalizeDirectRequestId(),
      messageId: normalizeDirectMessageId(),
      iaiTag: DIRECT_GATEWAY_DEFAULT_IAI_TAG,
      contents,
      systemInstruction: typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
            .filter((block) => block && block.type === "text" && block.text)
            .map((block) => block.text)
            .join("\n\n")
          : "",
      tools: toToolDeclarations(body.tools, (tool) => tool.input_schema),
      temperature: body.temperature,
      maxOutputTokens: normalizeDirectMaxOutputTokens(body.max_tokens),
      stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences : [],
      ...toDirectUpstreamThinkingFields(thinking, resolvedModel)
    })
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
        functionCall: {
          id: toolCall.id || crypto.randomUUID(),
          name: fn.name,
          argsJson: fn.arguments || "{}"
        }
      });
    }
  }

  if (message && message.role === "tool") {
    parts.push({
      functionResponse: {
        id: message.tool_call_id || "",
        name: toolNameById.get(message.tool_call_id) || message.name || "tool",
        responseJson: JSON.stringify(
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
  const resolvedModel = mapRequestedModel(body.model);

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
    requestBody: createGenerateContentRequest({
      model: resolvedModel,
      requestId: normalizeDirectRequestId(),
      messageId: normalizeDirectMessageId(),
      iaiTag: DIRECT_GATEWAY_DEFAULT_IAI_TAG,
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
      maxOutputTokens: normalizeDirectMaxOutputTokens(body.max_tokens),
      stopSequences: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : []
    })
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

const SSE_IDLE_TIMEOUT_MS = 180 * 1000;

class SseIdleTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`SSE stream idle timeout: no data received for ${timeoutMs / 1000}s`);
    this.name = "SseIdleTimeoutError";
    this.status = 504;
    this.type = "api_timeout_error";
    this.timeoutMs = timeoutMs;
  }
}

async function* parseSseEvents(stream, maxBufferSize = 10 * 1024 * 1024) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      let idleTimer;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new SseIdleTimeoutError(SSE_IDLE_TIMEOUT_MS)),
            SSE_IDLE_TIMEOUT_MS
          );
        })
      ]).finally(() => clearTimeout(idleTimer));

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

  return text.replace(new RegExp(token.replace(TOKEN_ESCAPE_RE, "\\$&"), "g"), maskToken(token));
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

        if (SENSITIVE_KEY_RE.test(normalizedKey) && typeof item === "string") {
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

const UPSTREAM_STATUS_MAP = new Map([
  [400, 400],
  [401, 401],
  [402, 401],
  [403, 401],
  [404, 404],
  [408, 408],
  [429, 429]
]);

function mapUpstreamErrorStatus(errorCode) {
  const code = Number(errorCode) || 0;
  const mapped = UPSTREAM_STATUS_MAP.get(code);
  if (mapped) {
    return mapped;
  }

  return code >= 500 ? code : 502;
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

function summarizeDirectUpstreamRequest(upstreamBody, request, resolvedProviderModel, auth) {
  const requestBody = upstreamBody && typeof upstreamBody === "object" && !Array.isArray(upstreamBody)
    ? upstreamBody
    : {};
  const contents = Array.isArray(requestBody.contents) ? requestBody.contents : [];
  const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];
  const bodyKeys = Object.keys(requestBody).filter((key) => key !== "token").sort();

  return {
    endpoint: "/generateContent",
    protocol: request && request.protocol ? String(request.protocol) : null,
    requestedModel: request && request.model ? String(request.model) : null,
    resolvedProviderModel: resolvedProviderModel ? String(resolvedProviderModel) : null,
    authSource: auth && auth.source ? String(auth.source) : null,
    bodyKeys,
    contentsCount: contents.length,
    toolsCount: tools.length,
    hasSystemInstruction: Boolean(requestBody.system_instruction),
    hasThinking: Boolean(
      requestBody.include_thoughts ||
      requestBody.thinking_budget ||
      requestBody.thinking_level ||
      requestBody.reasoning_effort
    ),
    maxOutputTokens: Number(requestBody.max_output_tokens || 0) || null,
    stopSequencesCount: Array.isArray(requestBody.stop_sequences) ? requestBody.stop_sequences.length : 0
  };
}

function attachUpstreamRequestSummary(error, requestSummary) {
  if (!error || !requestSummary || typeof requestSummary !== "object") {
    return error;
  }

  error.details = error.details && typeof error.details === "object"
    ? error.details
    : {};
  error.details.upstream = error.details.upstream && typeof error.details.upstream === "object"
    ? error.details.upstream
    : {};
  error.details.upstream.request = requestSummary;

  if (
    error.status === 400 &&
    String(error.type || "").toLowerCase() === "invalid_request_error" &&
    !error.details.upstream.hint
  ) {
    error.details.upstream.hint = "direct-llm upstream rejected the /generateContent payload; request summary attached for protocol debugging";
  }

  return error;
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
    this._accountStandbyReadyTarget = Math.max(1, Number(config.accountStandbyReadyTarget || 1));
    this._currentServingCredential = null;
    this._currentServingAt = 0;
    this._preparedCredentials = [];
    this._standbyCooldownCredentials = [];
    this._preparedCredentialsAt = 0;
    this._preparedLastError = null;
    this._standbyRefreshPromise = null;
    this._standbyTimer = null;
    this._standbyRunRefresh = null;
    this._standbyListeners = new Set();
  }

  _mapConfiguredAccountToCredential(account) {
    if (!account) {
      return null;
    }

    return {
      accountId: account.id,
      accountName: account.name,
      token: account.accessToken,
      refreshToken: account.refreshToken || null,
      cookie: account.cookie || null,
      user: account.user || null,
      expiresAt: account.expiresAt || null,
      expiresAtRaw: account.expiresAtRaw || null,
      source: account.source,
      transportOverride: account.transportOverride || null,
      baseUrl: account.baseUrl || null
    };
  }

  _mapCredentialToConfiguredAccount(credential) {
    if (!credential || !credential.accountId) {
      return null;
    }

    return {
      id: String(credential.accountId),
      name: credential.accountName || String(credential.accountId),
      accessToken: credential.token || null,
      refreshToken: credential.refreshToken || null,
      cookie: credential.cookie || null,
      user: credential.user || null,
      expiresAt: credential.expiresAt || null,
      expiresAtRaw: credential.expiresAtRaw || null,
      source: credential.source || null,
      transportOverride: credential.transportOverride || null,
      baseUrl: credential.baseUrl || null,
      enabled: true
    };
  }

  _getCurrentServingAccountId() {
    return this._currentServingCredential && this._currentServingCredential.accountId
      ? String(this._currentServingCredential.accountId)
      : "";
  }

  _getPreferredActiveAccountId() {
    if (!this.authProvider || typeof this.authProvider.getSummary !== "function") {
      return "";
    }

    const summary = this.authProvider.getSummary();
    return summary && summary.activeAccount ? String(summary.activeAccount) : "";
  }

  _buildStandbyRecord(credential, extras = {}) {
    return {
      accountId: credential && credential.accountId ? String(credential.accountId) : null,
      accountName: credential && credential.accountName ? String(credential.accountName) : null,
      source: credential && credential.source ? String(credential.source) : null,
      state: extras.state ? String(extras.state) : "ready",
      quotaCheckedAt: extras.quotaCheckedAt ? String(extras.quotaCheckedAt) : null,
      nextCheckAt: extras.nextCheckAt ? new Date(extras.nextCheckAt).toISOString() : null,
      reason: extras.reason ? String(extras.reason) : null,
      usagePercent: typeof extras.usagePercent === "number" ? extras.usagePercent : null,
      refreshCountdownSeconds: typeof extras.refreshCountdownSeconds === "number" ? extras.refreshCountdownSeconds : null
    };
  }

  _mergePreparedCredential(previous, credential) {
    return {
      ...(previous || {}),
      ...(credential || {}),
      quotaCheckedAt: credential && credential.quotaCheckedAt
        ? String(credential.quotaCheckedAt)
        : (previous && previous.quotaCheckedAt ? String(previous.quotaCheckedAt) : null)
    };
  }

  _mergeCooldownRecord(previous, credential, extras = {}) {
    return this._buildStandbyRecord(
      {
        ...(previous || {}),
        ...(credential || {})
      },
      {
        state: extras.state || (previous && previous.state) || "cooldown",
        quotaCheckedAt: extras.quotaCheckedAt != null
          ? extras.quotaCheckedAt
          : (previous && previous.quotaCheckedAt) || null,
        nextCheckAt: extras.nextCheckAt != null
          ? extras.nextCheckAt
          : (previous && previous.nextCheckAt) || null,
        reason: extras.reason != null
          ? extras.reason
          : (previous && previous.reason) || null,
        usagePercent: extras.usagePercent != null
          ? extras.usagePercent
          : (previous && typeof previous.usagePercent === "number" ? previous.usagePercent : null),
        refreshCountdownSeconds: extras.refreshCountdownSeconds != null
          ? extras.refreshCountdownSeconds
          : (previous && typeof previous.refreshCountdownSeconds === "number"
            ? previous.refreshCountdownSeconds
            : null)
      }
    );
  }

  _syncStandbyCooldownToAuthProvider(accountId, error, untilMs) {
    if (!accountId || !this.authProvider) {
      return;
    }

    const reason = error && error.message ? String(error.message) : String(error);

    if (typeof this.authProvider.recordFailure === "function") {
      this.authProvider.recordFailure(accountId, error);
    }

    if (typeof this.authProvider.invalidateAccountUntil === "function") {
      this.authProvider.invalidateAccountUntil(accountId, untilMs, reason);
      return;
    }

    if (typeof this.authProvider.invalidateAccount === "function") {
      this.authProvider.invalidateAccount(accountId, reason, untilMs);
    }
  }

  _clearStandbyAuthState(accountId) {
    if (!accountId || !this.authProvider) {
      return;
    }

    if (typeof this.authProvider.clearFailure === "function") {
      this.authProvider.clearFailure(accountId);
    }

    if (typeof this.authProvider.clearInvalidation === "function") {
      this.authProvider.clearInvalidation(accountId);
    }
  }

  _sortCooldownCredentials(records) {
    return [...records].sort((left, right) => {
      const leftAt = left && left.nextCheckAt ? new Date(left.nextCheckAt).getTime() : Number.POSITIVE_INFINITY;
      const rightAt = right && right.nextCheckAt ? new Date(right.nextCheckAt).getTime() : Number.POSITIVE_INFINITY;
      if (leftAt !== rightAt) {
        return leftAt - rightAt;
      }

      return String(left && left.accountId ? left.accountId : "").localeCompare(String(right && right.accountId ? right.accountId : ""));
    });
  }

  _upsertPreparedCredential(credential) {
    if (!credential || !credential.accountId) {
      return;
    }

    const accountId = String(credential.accountId);
    const next = this._preparedCredentials.filter((item) => String(item && item.accountId ? item.accountId : "") !== accountId);
    next.push(credential);
    // Sort by usagePercent ascending so accounts with the most remaining
    // quota are selected first during failover.
    next.sort((a, b) => {
      const aUsage = typeof a.usagePercent === "number" ? a.usagePercent : 50;
      const bUsage = typeof b.usagePercent === "number" ? b.usagePercent : 50;
      return aUsage - bUsage;
    });
    this._preparedCredentials = next;
    this._standbyCooldownCredentials = this._standbyCooldownCredentials.filter((item) => String(item && item.accountId ? item.accountId : "") !== accountId);
    this._preparedCredentialsAt = Date.now();
  }

  _upsertCooldownCredential(record) {
    if (!record || !record.accountId) {
      return;
    }

    const accountId = String(record.accountId);
    this._preparedCredentials = this._preparedCredentials.filter((item) => String(item && item.accountId ? item.accountId : "") !== accountId);
    const next = this._standbyCooldownCredentials.filter((item) => String(item && item.accountId ? item.accountId : "") !== accountId);
    next.push(record);
    this._standbyCooldownCredentials = this._sortCooldownCredentials(next);
    this._preparedCredentialsAt = Date.now();
  }

  _findCooldownProbeCandidate(options = {}) {
    if (
      !this._accountStandbyEnabled ||
      !this.authProvider ||
      typeof this.authProvider.getConfiguredAccounts !== "function" ||
      options.accountId ||
      !Array.isArray(options.excludeIds) ||
      options.excludeIds.length === 0
    ) {
      return null;
    }

    const excluded = new Set(options.excludeIds.map(String));
    const now = Date.now();
    const forceProbe = options.forceProbe === true;
    const candidateRecord = this._standbyCooldownCredentials.find((record) => {
      if (!record || !record.accountId || excluded.has(String(record.accountId))) {
        return false;
      }

      if (forceProbe) {
        return true;
      }

      const nextCheckAtMs = record.nextCheckAt ? new Date(record.nextCheckAt).getTime() : 0;
      return !Number.isFinite(nextCheckAtMs) || nextCheckAtMs <= now;
    });

    if (!candidateRecord || !candidateRecord.accountId) {
      return null;
    }

    const invalidUntil = typeof this.authProvider.getInvalidUntil === "function"
      ? Number(this.authProvider.getInvalidUntil(candidateRecord.accountId) || 0)
      : 0;
    if (invalidUntil > now) {
      return null;
    }

    const account = this.authProvider.getConfiguredAccounts().find((item) => {
      if (!item || !item.id || String(item.id) !== String(candidateRecord.accountId)) {
        return false;
      }

      if (item.source === "gateway" || !item.enabled || !item.accessToken) {
        return false;
      }

      if (item.expiresAt && Number(item.expiresAt) <= now) {
        return false;
      }

      return true;
    });

    if (!account) {
      return null;
    }

    return {
      record: candidateRecord,
      credential: this._mapConfiguredAccountToCredential(account)
    };
  }

  async _probeCooldownCredential(options = {}) {
    const matched = this._findCooldownProbeCandidate(options);
    if (!matched || !matched.credential || !matched.credential.accountId) {
      return null;
    }

    let { credential } = matched;
    const checkedAt = new Date().toISOString();

    try {
      const quota = await this.fetchQuotaStatus(credential, {
        reason: "standby_cooldown_probe"
      });
      credential = quota && quota.resolvedAuth ? quota.resolvedAuth : credential;
      this._clearStandbyAuthState(credential.accountId);
      const usagePercent = Number(quota && quota.usagePercent);

      if (Number.isFinite(usagePercent) && usagePercent >= 100) {
        const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
        const reason = `quota precheck skipped account at ${Math.round(usagePercent)}%`;
        if (typeof this.authProvider.invalidateAccountUntil === "function") {
          this.authProvider.invalidateAccountUntil(credential.accountId, refreshUntilMs, reason);
        } else if (typeof this.authProvider.invalidateAccount === "function") {
          this.authProvider.invalidateAccount(credential.accountId, reason, refreshUntilMs);
        }

        this._upsertCooldownCredential(this._buildStandbyRecord(credential, {
          state: "cooldown",
          quotaCheckedAt: quota && quota.checkedAt ? quota.checkedAt : checkedAt,
          nextCheckAt: refreshUntilMs || (Date.now() + this._quotaCacheTtlMs),
          reason,
          usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
          refreshCountdownSeconds: Number(quota && quota.refreshCountdownSeconds) || null
        }));
        this._emitStandbyState();
        return null;
      }

      const preparedCredential = {
        ...credential,
        quotaCheckedAt: quota && quota.checkedAt ? quota.checkedAt : checkedAt,
        usagePercent: Number.isFinite(usagePercent) ? usagePercent : null
      };
      this._upsertPreparedCredential(preparedCredential);
      this._emitStandbyState();
      return preparedCredential;
    } catch (error) {
      const nextCheckAt = Date.now() + Math.min(15000, Math.max(3000, this._accountStandbyRefreshMs));
      this._syncStandbyCooldownToAuthProvider(credential.accountId, error, nextCheckAt);
      this._upsertCooldownCredential(this._buildStandbyRecord(credential, {
        state: "rechecking",
        quotaCheckedAt: matched.record && matched.record.quotaCheckedAt ? matched.record.quotaCheckedAt : checkedAt,
        nextCheckAt,
        reason: error && error.message ? error.message : String(error)
      }));
      this._emitStandbyState();
      return null;
    }
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

  async _resolveDirectEmpid(auth) {
    const fromAuthUser = auth && auth.user && auth.user.id ? String(auth.user.id).trim() : "";
    if (fromAuthUser) {
      return fromAuthUser;
    }

    const fromRefreshBinding = auth && auth.refreshBoundUserId ? String(auth.refreshBoundUserId).trim() : "";
    if (fromRefreshBinding) {
      return fromRefreshBinding;
    }

    if (auth && auth.source === "gateway") {
      const gateway = await this._readGatewayState().catch(() => null);
      const gatewayUserId = gateway && gateway.user && gateway.user.id ? String(gateway.user.id).trim() : "";
      if (gatewayUserId) {
        return gatewayUserId;
      }
    }

    const fromAccountId = auth && auth.accountId ? String(auth.accountId).trim() : "";
    if (fromAccountId) {
      return fromAccountId;
    }

    return this.config && this.config.accountId ? String(this.config.accountId).trim() : "";
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
    return GATEWAY_CONN_ERROR_RE.test(message);
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

    const nextSource = refreshedAuth.source || auth.source || "gateway-auth-callback";
    try {
      writeAccountToFile(this.config.accountsPath, auth.accountId, refreshedAuth.accessToken, {
        user: refreshedAuth.user || auth.user || null,
        expiresAtMs: refreshedAuth.expiresAtMs || auth.expiresAt || null,
        expiresAtRaw: refreshedAuth.expiresAtRaw || auth.expiresAtRaw || null,
        refreshToken: refreshedAuth.refreshToken || auth.refreshToken || null,
        cookie: refreshedAuth.cookie || auth.cookie || null,
        source: nextSource,
        authPayload: {
          accessToken: refreshedAuth.accessToken,
          refreshToken: refreshedAuth.refreshToken || auth.refreshToken || null,
          expiresAtRaw: refreshedAuth.expiresAtRaw || auth.expiresAtRaw || null,
          expiresAtMs: refreshedAuth.expiresAtMs || auth.expiresAt || null,
          cookie: refreshedAuth.cookie || auth.cookie || null,
          user: refreshedAuth.user || auth.user || null,
          source: nextSource,
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

  async _prepareDirectAccountAuth(auth, context = {}) {
    if (!auth || auth.source === "gateway" || !auth.refreshToken) {
      return auth;
    }

    const refreshedAuth = await this._refreshAuthPayloadViaUpstream(auth, context);
    const nextAuth = {
      ...auth,
      token: refreshedAuth.accessToken,
      refreshToken: refreshedAuth.refreshToken || auth.refreshToken || null,
      expiresAtRaw: refreshedAuth.expiresAtRaw || auth.expiresAtRaw || null,
      expiresAt: refreshedAuth.expiresAtMs || auth.expiresAt || null,
      cookie: refreshedAuth.cookie || auth.cookie || null,
      user: refreshedAuth.user || auth.user || null,
      source: auth.source,
      refreshBoundUserId: refreshedAuth.refreshBoundUserId || null,
      refreshedAt: refreshedAuth.refreshedAt || null
    };

    this._persistCredentialRefresh(auth, {
      accessToken: nextAuth.token,
      refreshToken: nextAuth.refreshToken,
      expiresAtRaw: nextAuth.expiresAtRaw,
      expiresAtMs: nextAuth.expiresAt,
      cookie: nextAuth.cookie,
      user: nextAuth.user,
      source: nextAuth.source
    });

    return nextAuth;
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
      Array.isArray(options.excludeIds) &&
      options.excludeIds.length > 0;
    const standbyOptions = failoverMode
      ? { ...options, stickyAccountId: null }
      : options;

    if (this.authProvider && authMode !== "gateway") {
      const currentCredential = this._resolveCurrentServingCredential(standbyOptions);
      if (currentCredential) {
        return currentCredential;
      }

      let standbyCredential = this._resolvePreparedCredential(standbyOptions);
      if (!standbyCredential && failoverMode) {
        await this.refreshPreparedCredentials();
        standbyCredential = this._resolvePreparedCredential(standbyOptions);
        if (!standbyCredential) {
          standbyCredential = await this._probeCooldownCredential({
            ...standbyOptions,
            forceProbe: true
          });
        }
      }

      if (standbyCredential) {
        return standbyCredential;
      }

      if (failoverMode) {
        const emergencyCredential = this.authProvider.resolveCredential({
          excludeIds: options.excludeIds
        });
        if (emergencyCredential && emergencyCredential.accountId && emergencyCredential.source !== "gateway") {
          log.warn("failover falling back to unprepared credential", {
            accountId: emergencyCredential.accountId,
            accountName: emergencyCredential.accountName || null,
            excludeIds: Array.isArray(options.excludeIds) ? options.excludeIds.map(String) : []
          });
          return emergencyCredential;
        }

        throw new Error("No prepared standby credential available for failover");
      }

      const credential = this.authProvider.resolveCredential({
        accountId: standbyOptions.accountId,
        stickyAccountId: standbyOptions.stickyAccountId,
        excludeIds: standbyOptions.excludeIds
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
    if (!this._accountStandbyEnabled || !this.authProvider || this._standbyRunRefresh) {
      return;
    }

    const runRefresh = async () => {
      this._standbyTimer = null;

      try {
        await this.refreshPreparedCredentials();
      } catch (error) {
        log.debug("prepared account refresh failed", {
          error: error && error.message ? error.message : String(error)
        });
      } finally {
        if (this._standbyRunRefresh !== runRefresh) {
          return;
        }

        const delayMs = this._getNextStandbyRefreshDelayMs();
        this._standbyTimer = setTimeout(() => {
          runRefresh().catch(() => {});
        }, delayMs);
        if (this._standbyTimer && typeof this._standbyTimer.unref === "function") {
          this._standbyTimer.unref();
        }
      }
    };

    this._standbyRunRefresh = runRefresh;
    runRefresh().catch(() => {});
  }

  stopAccountStandbyLoop() {
    if (this._standbyTimer) {
      clearTimeout(this._standbyTimer);
      this._standbyTimer = null;
    }

    this._standbyRunRefresh = null;
  }

  /**
   * Nudge the standby loop to refresh sooner when the prepared pool
   * drops below target (e.g. after an account is invalidated during failover).
   * Does nothing if the loop is not running or already refreshing.
   */
  _nudgeStandbyLoop() {
    if (!this._standbyRunRefresh || !this._standbyTimer) {
      return;
    }

    const preparedCount = this._preparedCredentials.length;
    if (preparedCount >= this._accountStandbyReadyTarget) {
      return;
    }

    clearTimeout(this._standbyTimer);
    this._standbyTimer = null;

    const runRefresh = this._standbyRunRefresh;
    this._standbyTimer = setTimeout(() => {
      runRefresh().catch(() => {});
    }, 500);

    if (this._standbyTimer && typeof this._standbyTimer.unref === "function") {
      this._standbyTimer.unref();
    }
  }

  _getNextStandbyRefreshDelayMs() {
    const defaultDelayMs = Math.max(5000, this._accountStandbyRefreshMs);
    const now = Date.now();

    // Find the earliest cooldown account recovery time
    const nextRecoverAtMs = this._standbyCooldownCredentials.reduce((earliest, record) => {
      const nextCheckAtMs = record && record.nextCheckAt ? new Date(record.nextCheckAt).getTime() : 0;
      if (!Number.isFinite(nextCheckAtMs) || nextCheckAtMs <= 0) {
        return earliest;
      }
      return Math.min(earliest, nextCheckAtMs);
    }, Number.POSITIVE_INFINITY);

    if (this._preparedCredentials.length >= this._accountStandbyReadyTarget) {
      // Even when we have enough ready accounts, don't wait too long if a
      // cooldown account is about to recover (within 60s). This keeps the
      // pool topped up instead of discovering exhaustion during a request.
      if (Number.isFinite(nextRecoverAtMs) && nextRecoverAtMs - now < 60000) {
        return Math.max(1000, nextRecoverAtMs - now);
      }
      return Math.max(defaultDelayMs, 2 * 60 * 1000);
    }

    if (Number.isFinite(nextRecoverAtMs)) {
      return Math.max(1000, Math.min(defaultDelayMs, nextRecoverAtMs - now));
    }

    return Math.min(defaultDelayMs, 5000);
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
    const prepared = this._preparedCredentials;
    const cooldown = this._standbyCooldownCredentials;
    const nextRecover = cooldown[0] || null;
    return {
      enabled: this._accountStandbyEnabled,
      currentAccountId: this._currentServingCredential && this._currentServingCredential.accountId
        ? String(this._currentServingCredential.accountId)
        : null,
      currentAccountName: this._currentServingCredential && this._currentServingCredential.accountName
        ? String(this._currentServingCredential.accountName)
        : null,
      currentAccountSelectedAt: this._currentServingAt ? new Date(this._currentServingAt).toISOString() : null,
      refreshedAt: this._preparedCredentialsAt ? new Date(this._preparedCredentialsAt).toISOString() : null,
      lastError: this._preparedLastError || null,
      trackedCount: prepared.length + cooldown.length,
      candidateCount: prepared.length,
      readyCount: prepared.length,
      cooldownCount: cooldown.length,
      nextAccountId: prepared[0] && prepared[0].accountId
        ? String(prepared[0].accountId)
        : null,
      nextAccountName: prepared[0] && prepared[0].accountName
        ? String(prepared[0].accountName)
        : null,
      nextRecoverAccountId: nextRecover && nextRecover.accountId ? String(nextRecover.accountId) : null,
      nextRecoverAccountName: nextRecover && nextRecover.accountName ? String(nextRecover.accountName) : null,
      nextRecoverAt: nextRecover && nextRecover.nextCheckAt ? String(nextRecover.nextCheckAt) : null,
      candidates: prepared.map((credential, index) => ({
        order: index + 1,
        accountId: credential && credential.accountId ? String(credential.accountId) : null,
        accountName: credential && credential.accountName ? String(credential.accountName) : null,
        source: credential && credential.source ? String(credential.source) : null,
        quotaCheckedAt: credential && credential.quotaCheckedAt ? String(credential.quotaCheckedAt) : null
      })),
      cooldownCandidates: cooldown.map((credential, index) => ({
        order: index + 1,
        accountId: credential && credential.accountId ? String(credential.accountId) : null,
        accountName: credential && credential.accountName ? String(credential.accountName) : null,
        source: credential && credential.source ? String(credential.source) : null,
        quotaCheckedAt: credential && credential.quotaCheckedAt ? String(credential.quotaCheckedAt) : null,
        nextCheckAt: credential && credential.nextCheckAt ? String(credential.nextCheckAt) : null,
        reason: credential && credential.reason ? String(credential.reason) : null,
        usagePercent: credential && typeof credential.usagePercent === "number" ? credential.usagePercent : null,
        refreshCountdownSeconds: credential && typeof credential.refreshCountdownSeconds === "number"
          ? credential.refreshCountdownSeconds
          : null
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

  _setCurrentServingCredential(credential) {
    if (!credential || !credential.accountId || credential.source === "gateway") {
      return;
    }

    this._currentServingCredential = {
      accountId: credential.accountId,
      accountName: credential.accountName || null,
      token: credential.token || null,
      refreshToken: credential.refreshToken || null,
      cookie: credential.cookie || null,
      user: credential.user || null,
      expiresAt: credential.expiresAt || null,
      expiresAtRaw: credential.expiresAtRaw || null,
      source: credential.source || null
    };
    this._currentServingAt = Date.now();
    this._emitStandbyState();
  }

  _clearCurrentServingCredential(accountId = null) {
    if (!this._currentServingCredential) {
      return;
    }

    if (accountId && String(this._currentServingCredential.accountId || "") !== String(accountId)) {
      return;
    }

    this._currentServingCredential = null;
    this._currentServingAt = 0;
    this._emitStandbyState();
  }

  _resolveCurrentServingCredential(options = {}) {
    if (
      !this._currentServingCredential ||
      options.accountId ||
      options.stickyAccountId ||
      !this.authProvider ||
      !this._currentServingCredential.accountId
    ) {
      return null;
    }

    const excludeIds = new Set(Array.isArray(options.excludeIds) ? options.excludeIds.map(String) : []);
    const currentAccountId = String(this._currentServingCredential.accountId);

    if (excludeIds.has(currentAccountId)) {
      return null;
    }

    if (typeof this.authProvider.isAccountUsable === "function" && !this.authProvider.isAccountUsable(currentAccountId)) {
      this._clearCurrentServingCredential(currentAccountId);
      return null;
    }

    return { ...this._currentServingCredential };
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
      const cooling = [];
      const previousPreparedByAccountId = new Map(
        this._preparedCredentials
          .filter((credential) => credential && credential.accountId)
          .map((credential) => [String(credential.accountId), credential])
      );
      const previousCooldownByAccountId = new Map(
        this._standbyCooldownCredentials
          .filter((credential) => credential && credential.accountId)
          .map((credential) => [String(credential.accountId), credential])
      );
      const unknownAccounts = [];
      const dueCooldownAccounts = [];
      const now = Date.now();
      const currentServingAccountId = this._getCurrentServingAccountId();
      const preferredActiveAccountId = this._getPreferredActiveAccountId();
      const desiredReadyCount = Math.max(1, this._accountStandbyReadyTarget);
      const fullScan = this._preparedCredentialsAt === 0;
      const excludedAccountIds = new Set(
        [currentServingAccountId, preferredActiveAccountId].filter(Boolean).map(String)
      );
      const credentials = this.authProvider.listCredentials({
        excludeIds: [...excludedAccountIds]
      });
      const credentialByAccountId = new Map(
        credentials
          .filter((credential) => credential && credential.accountId && credential.source !== "gateway")
          .map((credential) => [String(credential.accountId), credential])
      );
      const configuredAccounts = (
        typeof this.authProvider.getConfiguredAccounts === "function"
          ? this.authProvider.getConfiguredAccounts()
          : credentials.map((credential) => this._mapCredentialToConfiguredAccount(credential)).filter(Boolean)
      )
        .filter((account) => {
          if (!account || !account.id || account.source === "gateway") {
            return false;
          }

          if (excludedAccountIds.has(String(account.id))) {
            return false;
          }

          if (!account.enabled || !account.accessToken) {
            return false;
          }

          if (account.expiresAt && Number(account.expiresAt) <= now) {
            return false;
          }

          return true;
        });

      for (const account of configuredAccounts) {
        const accountId = String(account.id);
        let credential = credentialByAccountId.get(accountId) || this._mapConfiguredAccountToCredential(account);
        const previousPrepared = previousPreparedByAccountId.get(accountId) || null;
        const previousCooldown = previousCooldownByAccountId.get(accountId) || null;

        if (!credential || !credential.accountId) {
          continue;
        }

        const invalidUntil = typeof this.authProvider.getInvalidUntil === "function"
          ? Number(this.authProvider.getInvalidUntil(accountId) || 0)
          : 0;
        const lastFailure = typeof this.authProvider.getLastFailure === "function"
          ? this.authProvider.getLastFailure(accountId)
          : null;

        if (invalidUntil > now) {
          cooling.push(this._mergeCooldownRecord(previousCooldown, credential, {
            state: "cooldown",
            nextCheckAt: invalidUntil,
            reason: lastFailure && lastFailure.reason ? lastFailure.reason : "账号冷却中"
          }));
          continue;
        }

        if (previousPrepared) {
          prepared.push(this._mergePreparedCredential(previousPrepared, credential));
          continue;
        }

        const nextCheckAtMs = previousCooldown && previousCooldown.nextCheckAt
          ? new Date(previousCooldown.nextCheckAt).getTime()
          : 0;
        if (previousCooldown && Number.isFinite(nextCheckAtMs) && nextCheckAtMs > now) {
          cooling.push(this._mergeCooldownRecord(previousCooldown, credential));
          continue;
        }

        if (previousCooldown) {
          dueCooldownAccounts.push({
            credential,
            previousCooldown
          });
          continue;
        }

        unknownAccounts.push({
          credential,
          previousCooldown: null
        });
      }

      const probeEntry = async (entry) => {
        let { credential } = entry;
        const previousCooldown = entry.previousCooldown || null;
        let quota = null;
        try {
          quota = await this.fetchQuotaStatus(credential, {
            reason: "standby_refresh"
          });
          credential = quota && quota.resolvedAuth ? quota.resolvedAuth : credential;
        } catch (error) {
          const nextCheckAt = now + Math.min(30000, Math.max(5000, this._accountStandbyRefreshMs));
          this._syncStandbyCooldownToAuthProvider(credential.accountId, error, nextCheckAt);
          cooling.push(this._mergeCooldownRecord(previousCooldown, credential, {
            state: "rechecking",
            nextCheckAt,
            reason: error && error.message ? error.message : String(error)
          }));
          return false;
        }

        this._clearStandbyAuthState(credential.accountId);
        const usagePercent = Number(quota && quota.usagePercent);
        if (Number.isFinite(usagePercent) && usagePercent >= 100) {
          const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
          const reason = `quota precheck skipped account at ${Math.round(usagePercent)}%`;
          if (typeof this.authProvider.invalidateAccountUntil === "function") {
            this.authProvider.invalidateAccountUntil(credential.accountId, refreshUntilMs, reason);
          } else if (typeof this.authProvider.invalidateAccount === "function") {
            this.authProvider.invalidateAccount(credential.accountId, reason, refreshUntilMs);
          }
          cooling.push(this._mergeCooldownRecord(previousCooldown, credential, {
            state: "cooldown",
            quotaCheckedAt: quota && quota.checkedAt ? quota.checkedAt : new Date().toISOString(),
            nextCheckAt: refreshUntilMs || (now + this._quotaCacheTtlMs),
            reason,
            usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
            refreshCountdownSeconds: Number(quota && quota.refreshCountdownSeconds) || null
          }));
          return false;
        }

        prepared.push(this._mergePreparedCredential(previousPreparedByAccountId.get(String(credential.accountId)), {
          ...credential,
          quotaCheckedAt: quota && quota.checkedAt ? quota.checkedAt : new Date().toISOString(),
          usagePercent: Number.isFinite(usagePercent) ? usagePercent : null
        }));
        return true;
      };

      // Probe unknown accounts in parallel batches of up to 3 for lower latency.
      const PROBE_CONCURRENCY = 3;
      for (let i = 0; i < unknownAccounts.length; i += PROBE_CONCURRENCY) {
        await Promise.allSettled(
          unknownAccounts.slice(i, i + PROBE_CONCURRENCY).map(probeEntry)
        );
      }

      if (fullScan || prepared.length < desiredReadyCount) {
        for (let i = 0; i < dueCooldownAccounts.length; i += PROBE_CONCURRENCY) {
          await Promise.allSettled(
            dueCooldownAccounts.slice(i, i + PROBE_CONCURRENCY).map(probeEntry)
          );

          if (!fullScan && prepared.length >= desiredReadyCount) {
            break;
          }
        }
      }

      if (!fullScan && prepared.length >= desiredReadyCount) {
        for (const entry of dueCooldownAccounts) {
          if (!entry || !entry.previousCooldown) {
            continue;
          }

          const accountId = String(entry.previousCooldown.accountId || "");
          const alreadyTracked = cooling.some((record) => String(record && record.accountId ? record.accountId : "") === accountId)
            || prepared.some((record) => String(record && record.accountId ? record.accountId : "") === accountId);
          if (alreadyTracked) {
            continue;
          }

          cooling.push(this._mergeCooldownRecord(entry.previousCooldown, entry.credential));
        }
      }

      this._preparedCredentials = prepared;
      this._standbyCooldownCredentials = this._sortCooldownCredentials(cooling);
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
    // Use only accountId — quota usage does not change when the token is refreshed
    return String(auth && auth.accountId ? auth.accountId : "");
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

  async fetchQuotaStatus(auth, options = {}) {
    if (!this._quotaPreflightEnabled || !auth || !auth.token) {
      return null;
    }

    let preparedAuth = auth;
    if (options.refreshAccount !== false && auth.source !== "gateway" && auth.refreshToken) {
      preparedAuth = await this._prepareDirectAccountAuth(auth, {
        reason: options.reason || "quota_preflight"
      });
    }

    const cached = this._getCachedQuota(preparedAuth);
    if (cached) {
      return {
        ...cached,
        resolvedAuth: preparedAuth
      };
    }

    const url = new URL("/api/entitlement/quota", this.config.upstreamBaseUrl);
    url.searchParams.set("accessToken", String(preparedAuth.token));
    url.searchParams.set("utdid", this._utdid || "");
    url.searchParams.set("version", "0.0.0");

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "x-language": this.config.language ? String(this.config.language) : "zh",
        "x-utdid": this._utdid || "",
        "x-app-version": "0.0.0",
        "x-os": process.platform,
        "x-cna": extractCnaFromCookie(preparedAuth.cookie),
        cookie: normalizeCookieHeader(preparedAuth.cookie),
        accept: "application/json, text/plain, */*"
      },
      signal: AbortSignal.timeout(Math.min(4000, Number(this.config.requestTimeoutMs || 4000)))
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload || payload.success !== true || !payload.data) {
      const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
      throw new Error(`Quota request failed: ${message}`);
    }

    const quota = this._setCachedQuota(preparedAuth, {
      available: true,
      usagePercent: Number(payload.data.usagePercent),
      refreshCountdownSeconds: Number(payload.data.refreshCountdownSeconds),
      checkedAt: new Date().toISOString()
    });

    return {
      ...quota,
      resolvedAuth: preparedAuth
    };
  }

  async shouldSkipAccountByQuota(auth, options = {}) {
    if (!this._quotaPreflightEnabled || !auth || options.explicitAccountId) {
      return { skip: false, quota: null, auth };
    }

    let quota = null;
    let preparedAuth = auth;
    try {
      quota = await this.fetchQuotaStatus(auth, {
        reason: "direct_request_preflight"
      });
      preparedAuth = quota && quota.resolvedAuth ? quota.resolvedAuth : auth;
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
      return { skip: false, quota: null, auth };
    }

    const usagePercent = Number(quota && quota.usagePercent);
    if (!Number.isFinite(usagePercent) || usagePercent < 100) {
      if (preparedAuth.source === "gateway") {
        this._clearGatewayQuotaCooldown();
      }
      return { skip: false, quota, auth: preparedAuth };
    }

    if (preparedAuth.source === "gateway") {
      const gatewayReason = "quota exhausted (gateway cooling down until refresh)";
      this._setGatewayQuotaCooldown(quota, gatewayReason);
      return {
        skip: String(this.config.authMode || "auto") === "auto",
        quota,
        auth: preparedAuth,
        gateway: true
      };
    }

    if (!this.authProvider) {
      return { skip: false, quota, auth: preparedAuth };
    }

    const refreshUntilMs = this._getQuotaRefreshUntilMs(quota);
    const reason = usagePercent !== null
      ? `quota precheck skipped account at ${Math.round(usagePercent)}%`
      : "quota precheck skipped account";

    if (typeof this.authProvider.invalidateAccountUntil === "function") {
      this.authProvider.invalidateAccountUntil(preparedAuth.accountId, refreshUntilMs, reason);
    } else if (typeof this.authProvider.invalidateAccount === "function") {
      this.authProvider.invalidateAccount(preparedAuth.accountId, reason, refreshUntilMs);
    }

    return { skip: true, quota, auth: preparedAuth };
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

  /**
   * Shared error handling for the run() loop: record failure, invalidate if
   * needed, clear serving credential, and decide whether to continue failover.
   *
   * Returns { shouldContinue: boolean, clearTokenCache: boolean }.
   */
  /**
   * Extract an appropriate invalidation duration from the error.
   *
   * Priority:
   * 1. Upstream refreshCountdownSeconds (precise quota window)
   * 2. Short cooldown for transient errors (503, 529, timeout)
   * 3. Default 5-minute fallback
   */
  _computeInvalidationUntilMs(error) {
    const status = Number(error && error.status) || 0;

    // Try to extract refreshCountdownSeconds from structured error details
    const details = error && error.details && error.details.upstream && error.details.upstream.body;
    const refreshSeconds = Number(
      (details && (details.refreshCountdownSeconds ||
        (details.data && details.data.refreshCountdownSeconds))) || 0
    );

    if (Number.isFinite(refreshSeconds) && refreshSeconds > 0) {
      return Date.now() + refreshSeconds * 1000;
    }

    // Auth errors (401/403) → short cooldown (15s) — token refresh can fix these quickly
    if (status === 401 || status === 403) {
      return Date.now() + 15 * 1000;
    }

    // Transient server errors → short cooldown (30s) instead of default 5min
    if (status === 503 || status === 504 || status === 529 || status === 408) {
      return Date.now() + 30 * 1000;
    }

    // Connection errors (no status code) → short cooldown (20s) — usually transient
    if (!status && error && (error.code === "ECONNREFUSED" || error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" || /fetch failed|network|timeout|aborted due to timeout/i.test(error.message || ""))) {
      return Date.now() + 20 * 1000;
    }

    // Default: let invalidateAccount use its own fallback (5min)
    return null;
  }

  _handleRunError({ auth, error, explicitAccountId, stickyAccountId, triedAccounts, onDecision, responseStarted, phase }) {
    if (auth.source === "gateway") {
      this._rememberGatewayQuotaFailure(error);
    }

    if (auth.accountId && this.authProvider && typeof this.authProvider.recordFailure === "function") {
      this.authProvider.recordFailure(auth.accountId, error);
    }

    if (
      shouldFailoverAccount(error) &&
      auth.accountId &&
      this.authProvider &&
      typeof this.authProvider.invalidateAccount === "function"
    ) {
      const untilMs = this._computeInvalidationUntilMs(error);
      this.authProvider.invalidateAccount(auth.accountId, error.message, untilMs);
    }

    this._clearCurrentServingCredential(auth.accountId);

    // Nudge standby loop to replenish prepared pool sooner
    this._nudgeStandbyLoop();

    const shouldContinue = this._maybeContinueAfterAccountError({
      auth,
      error,
      explicitAccountId,
      stickyAccountId,
      triedAccounts,
      onDecision,
      responseStarted,
      phase
    });

    return shouldContinue;
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

  /**
   * Synchronous fast check: are there any usable accounts in the prepared pool
   * or a current serving credential? Used for pre-flight transport decisions
   * to avoid sending requests to a transport where all accounts are in cooldown.
   */
  hasReadyAccounts() {
    if (this._currentServingCredential && this._currentServingCredential.accountId) {
      return true;
    }

    if (this._preparedCredentials.length > 0) {
      return true;
    }

    // Fall back to checking auth provider for any usable account
    if (this.authProvider && typeof this.authProvider.listCredentials === "function") {
      const credentials = this.authProvider.listCredentials({});
      return credentials.some((credential) =>
        credential && credential.accountId &&
        this.authProvider.isAccountUsable(String(credential.accountId))
      );
    }

    return false;
  }

  _buildAttemptBudget() {
    if (!this.authProvider || typeof this.authProvider.listCredentials !== "function") {
      return 10;
    }

    const credentials = this.authProvider.listCredentials({});
    const count = Array.isArray(credentials) ? credentials.length : 0;
    return Math.max(10, (count * 2) + 2);
  }

  _buildRetryKey(auth) {
    if (!auth || typeof auth !== "object") {
      return null;
    }

    if (auth.accountId) {
      return `account:${auth.accountId}`;
    }

    if (auth.source) {
      return `source:${auth.source}`;
    }

    return null;
  }

  _maybeRetryTimeoutOnSameAccount({ auth, error, phase, responseStarted, retryCounts, onDecision }) {
    if (responseStarted || !isTimeoutLikeError(error)) {
      return false;
    }

    const retryKey = this._buildRetryKey(auth);
    if (!retryKey) {
      return false;
    }

    const retries = Number(retryCounts.get(retryKey) || 0);
    if (retries >= 1) {
      return false;
    }

    retryCounts.set(retryKey, retries + 1);

    if (typeof onDecision === "function") {
      onDecision({
        type: "same_account_retry",
        accountId: auth.accountId || null,
        accountName: auth.accountName || null,
        authSource: auth.source || null,
        reason: error && error.message ? error.message : String(error),
        status: error && error.status ? error.status : null,
        phase: phase || null,
        responseStarted: false,
        retryAttempt: retries + 1
      });
    }

    return true;
  }

  async run(request, options = {}) {
    const explicitAccountId = options.accountId || request.accountId || null;
    const stickyAccountId = options.stickyAccountId || null;
    const MAX_FAILOVER_ATTEMPTS = this._buildAttemptBudget();
    const triedAccounts = new Set();
    const timeoutRetryCounts = new Map();
    let lastError = null;
    let attempts = 0;
    let pinnedRetryAuth = null;
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
      let auth = pinnedRetryAuth;
      pinnedRetryAuth = null;

      if (!auth) {
        auth = await this.getAuthToken({
          allowAutostart: false,
          accountId: explicitAccountId,
          stickyAccountId,
          excludeIds: [...triedAccounts]
        });
      }
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
      auth = quotaDecision && quotaDecision.auth ? quotaDecision.auth : auth;

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

        this._clearCurrentServingCredential(auth.accountId);
        // Await refresh so the next iteration sees up-to-date standby data.
        // Use a short timeout wrapper to avoid blocking the failover loop too long.
        await Promise.race([
          this.refreshPreparedCredentials().catch(() => {}),
          delay(3000)
        ]);
        continue;
      }

      const activeAuth = auth;

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

      const requestBody = request && request.requestBody && typeof request.requestBody === "object"
        ? request.requestBody
        : {};
      const resolvedEmpid = requestBody.empid
        ? String(requestBody.empid).trim()
        : await this._resolveDirectEmpid(activeAuth);
      const upstreamRequest = createGenerateContentRequest({
        ...requestBody,
        model: modelInfo.resolvedProviderModel,
        requestId: normalizeDirectRequestId(
          requestBody.requestId || requestBody.request_id || ""
        ),
        messageId: normalizeDirectMessageId(
          requestBody.messageId || requestBody.message_id || ""
        ),
        iaiTag: requestBody.iaiTag || requestBody.iai_tag || DIRECT_GATEWAY_DEFAULT_IAI_TAG,
        token: activeAuth.token,
        empid: resolvedEmpid || undefined
      });
      const upstreamBody = serializeGenerateContentRequest(upstreamRequest);
      const normalizedRequestSummary = summarizeDirectUpstreamRequest(
        upstreamBody,
        request,
        modelInfo.resolvedProviderModel,
        activeAuth
      );
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

        if (this._maybeRetryTimeoutOnSameAccount({
          auth: activeAuth,
          error,
          phase: "fetch",
          responseStarted: false,
          retryCounts: timeoutRetryCounts,
          onDecision: options.onDecision
        })) {
          lastError = error;
          pinnedRetryAuth = activeAuth;
          await delay(250);
          continue;
        }

        const shouldContinue = this._handleRunError({
          auth: activeAuth, error, explicitAccountId, stickyAccountId,
          triedAccounts, onDecision: options.onDecision, responseStarted: false, phase: "fetch"
        });

        if (shouldContinue) {
          lastError = error;
          await Promise.race([
            this.refreshPreparedCredentials().catch(() => {}),
            delay(2000)
          ]);
          continue;
        }

        throw error;
      }

      if (!res.ok) {
        const rawText = await res.text().catch(() => "");
        const upstreamError = attachUpstreamRequestSummary(
          new UpstreamHttpError(res.status, res.statusText, rawText, activeAuth.token),
          normalizedRequestSummary
        );

        if (activeAuth.source === "gateway" && (res.status === 401 || res.status === 403)) {
          this.clearTokenCache();
        }

        if (this._maybeRetryTimeoutOnSameAccount({
          auth: activeAuth,
          error: upstreamError,
          phase: "http",
          responseStarted: false,
          retryCounts: timeoutRetryCounts,
          onDecision: options.onDecision
        })) {
          lastError = upstreamError;
          pinnedRetryAuth = activeAuth;
          await delay(250);
          continue;
        }

        const shouldContinue = this._handleRunError({
          auth: activeAuth, error: upstreamError, explicitAccountId, stickyAccountId,
          triedAccounts, onDecision: options.onDecision, responseStarted: false, phase: "http"
        });

        if (shouldContinue) {
          lastError = upstreamError;
          await Promise.race([
            this.refreshPreparedCredentials().catch(() => {}),
            delay(2000)
          ]);
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
        attachUpstreamRequestSummary(state.error, normalizedRequestSummary);

        if (this._maybeRetryTimeoutOnSameAccount({
          auth: activeAuth,
          error: state.error,
          phase: "stream",
          responseStarted: state.hasVisibleOutput(),
          retryCounts: timeoutRetryCounts,
          onDecision: options.onDecision
        })) {
          lastError = state.error;
          pinnedRetryAuth = activeAuth;
          await delay(250);
          continue;
        }

        const shouldContinue = this._handleRunError({
          auth: activeAuth, error: state.error, explicitAccountId, stickyAccountId,
          triedAccounts, onDecision: options.onDecision,
          responseStarted: state.hasVisibleOutput(), phase: "stream"
        });

        if (shouldContinue) {
          lastError = state.error;
          await Promise.race([
            this.refreshPreparedCredentials().catch(() => {}),
            delay(2000)
          ]);
          continue;
        }

        throw state.error;
      }

      if (activeAuth.accountId && this.authProvider) {
        if (typeof this.authProvider.clearFailure === "function" &&
            typeof this.authProvider.getLastFailure === "function" &&
            this.authProvider.getLastFailure(activeAuth.accountId)) {
          this.authProvider.clearFailure(activeAuth.accountId);
        }

        if (typeof this.authProvider.clearInvalidation === "function" &&
            typeof this.authProvider.getInvalidUntil === "function" &&
            this.authProvider.getInvalidUntil(activeAuth.accountId)) {
          this.authProvider.clearInvalidation(activeAuth.accountId);
        }
      }

      if (activeAuth.source === "gateway") {
        this._clearGatewayQuotaCooldown();
      } else if (activeAuth.accountId) {
        this._setCurrentServingCredential(activeAuth);
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
  SseIdleTimeoutError,
  UpstreamHttpError,
  UpstreamSseError,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi,
  extractThinkingConfigFromAnthropic,
  mapRequestedModel,
  supportsThinkingForModel
};
