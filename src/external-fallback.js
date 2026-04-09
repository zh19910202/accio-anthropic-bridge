"use strict";

const modelAliases = require("../config/model-aliases.json");
const log = require("./logger");
const { flattenAnthropicRequest, normalizeContent, normalizeSystemPrompt } = require("./anthropic");
const { normalizeRequestedModel } = require("./model");
const { flattenOpenAiRequest } = require("./openai");

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_BETAS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14"
];
const HTML_CONTENT_RE = /text\/html/i;
const SSE_CONTENT_RE = /text\/event-stream/i;
const JSON_CONTENT_RE = /application\/json/i;
const STREAMING_REQUIRED_RE = /streaming is required for operations that may take longer than 10 minutes/i;
const UNSUPPORTED_ENDPOINT_RE = /chat\/completions endpoint not supported|endpoint not supported/i;
const NOT_FOUND_RE = /404|not[_\s-]?found/;
const { classifyErrorType, isTimeoutLikeError } = require("./errors");
const { delay } = require("./utils");

function createFallbackId() {
  return "fb_" + Math.random().toString(36).slice(2, 10);
}

function normalizeReasoningEffort(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(text) ? text : "";
}

function normalizeProtocolSelection(protocolValue, openaiApiStyleValue) {
  const protocol = String(protocolValue || "").trim().toLowerCase();
  const openaiApiStyle = normalizeOpenAiApiStyle(openaiApiStyleValue);

  if (protocol === "anthropic") {
    return {
      protocol: "anthropic",
      openaiApiStyle: "auto"
    };
  }

  if (protocol === "openai-responses" || protocol === "openai_responses" || protocol === "responses") {
    return {
      protocol: "openai",
      openaiApiStyle: "responses"
    };
  }

  if (
    protocol === "openai-chat-completions" ||
    protocol === "openai_chat_completions" ||
    protocol === "chat_completions"
  ) {
    return {
      protocol: "openai",
      openaiApiStyle: "chat_completions"
    };
  }

  if (protocol === "openai-auto" || protocol === "openai_auto") {
    return {
      protocol: "openai",
      openaiApiStyle: "auto"
    };
  }

  return {
    protocol: "openai",
    openaiApiStyle
  };
}

function normalizeOpenAiApiStyle(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["chat_completions", "responses", "auto"].includes(text) ? text : "auto";
}

function stripTrailingSlash(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function normalizeSupportedModelId(value) {
  const requested = normalizeRequestedModel(value);
  if (!requested) {
    return "";
  }

  return String(modelAliases[requested] || requested).trim();
}

function parseHeaderTokenList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseHeaderTokenList(entry));
  }

  if (value == null) {
    return [];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeHeaderTokenLists(...values) {
  const merged = [];
  const seen = new Set();

  for (const value of values) {
    for (const token of parseHeaderTokenList(value)) {
      const key = token.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(token);
    }
  }

  return merged;
}

function normalizeSupportedModels(value, fallbackModel = "") {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : [];
  const seen = new Set();
  const normalized = [];

  for (const item of rawValues) {
    const model = normalizeSupportedModelId(item);
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    normalized.push(model);
  }

  const fallback = normalizeSupportedModelId(fallbackModel);
  if (normalized.length === 0 && fallback) {
    normalized.push(fallback);
  }

  return normalized;
}

function normalizeFallbackTarget(target = {}, index = 0) {
  const selection = normalizeProtocolSelection(target.protocol, target.openaiApiStyle);

  return {
    id: String(target.id || createFallbackId()),
    name: String(target.name || ("渠道 " + (index + 1))).trim() || ("渠道 " + (index + 1)),
    enabled: target.enabled !== false,
    baseUrl: stripTrailingSlash(target.baseUrl || ""),
    apiKey: String(target.apiKey || "").trim(),
    model: String(target.model || "").trim(),
    supportedModels: normalizeSupportedModels(target.supportedModels, target.model),
    protocol: selection.protocol,
    openaiApiStyle: selection.openaiApiStyle,
    anthropicVersion: String(target.anthropicVersion || DEFAULT_ANTHROPIC_VERSION).trim() || DEFAULT_ANTHROPIC_VERSION,
    timeoutMs: Number(target.timeoutMs || 60000) || 60000,
    reasoningEffort: normalizeReasoningEffort(target.reasoningEffort)
  };
}

function serializeFallbackTarget(target = {}) {
  const normalized = normalizeFallbackTarget(target, 0);
  const protocol = normalized.protocol === "anthropic"
    ? "anthropic"
    : normalized.openaiApiStyle === "responses"
      ? "openai-responses"
      : normalized.openaiApiStyle === "chat_completions"
        ? "openai-chat-completions"
        : "openai";

  return {
    id: normalized.id,
    name: normalized.name,
    enabled: normalized.enabled,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey,
    model: normalized.model,
    supportedModels: normalized.supportedModels,
    protocol,
    anthropicVersion: normalized.anthropicVersion,
    timeoutMs: normalized.timeoutMs,
    reasoningEffort: normalized.reasoningEffort
  };
}

function normalizeFallbackTargets(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets
    .map((target, index) => normalizeFallbackTarget(target, index));
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

function isOpenAiChatCompletionsUnsupported(error) {
  const status = Number(error && error.status ? error.status : 0);
  const message = String(error && error.message ? error.message : "").toLowerCase();
  return status === 404 || UNSUPPORTED_ENDPOINT_RE.test(message);
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

function isHtmlResponse(contentType) {
  return HTML_CONTENT_RE.test(String(contentType || ""));
}

function buildAnthropicMessageUrls(baseUrl, preferredPath = null) {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl);
  const lower = normalizedBaseUrl.toLowerCase();
  const candidates = [];
  const pushUnique = (url) => {
    const normalized = stripTrailingSlash(url);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const knownPaths = ["/messages", "/v1/messages"];
  const preferred = knownPaths.includes(preferredPath) ? preferredPath : null;

  const pushPreferredFromPrefix = (prefix) => {
    if (!preferred) {
      return;
    }
    pushUnique(prefix + preferred);
  };

  if (lower.endsWith("/v1/messages")) {
    const prefix = normalizedBaseUrl.slice(0, -"/v1/messages".length);
    pushPreferredFromPrefix(prefix);
    pushUnique(normalizedBaseUrl);
    pushUnique(prefix + "/messages");
    return candidates;
  }

  if (lower.endsWith("/messages")) {
    const prefix = normalizedBaseUrl.slice(0, -"/messages".length);
    pushPreferredFromPrefix(prefix);
    pushUnique(normalizedBaseUrl);
    pushUnique(prefix + "/v1/messages");
    return candidates;
  }

  if (lower.endsWith("/v1")) {
    const prefix = normalizedBaseUrl.slice(0, -"/v1".length);
    if (preferred === "/messages") {
      pushUnique(prefix + "/messages");
    } else if (preferred === "/v1/messages") {
      pushUnique(normalizedBaseUrl + "/messages");
    }
    pushUnique(normalizedBaseUrl + "/messages");
    pushUnique(prefix + "/messages");
    return candidates;
  }

  pushPreferredFromPrefix(normalizedBaseUrl);
  pushUnique(normalizedBaseUrl + "/messages");
  pushUnique(normalizedBaseUrl + "/v1/messages");
  return candidates;
}

function isAnthropicWrappedNotFoundPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const message = String(payload.msg || payload.message || "").toLowerCase();
  return payload.success === false && NOT_FOUND_RE.test(message);
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

function normalizeJsonStringObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeAnthropicToolDefinitions(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || !tool.name) {
        return null;
      }

      return {
        type: "function",
        function: {
          name: String(tool.name),
          description: tool.description ? String(tool.description) : "",
          parameters:
            tool.input_schema && typeof tool.input_schema === "object"
              ? tool.input_schema
              : { type: "object", properties: {}, required: [] }
        }
      };
    })
    .filter(Boolean);
}

function normalizeAnthropicToolChoice(toolChoice, apiStyle = "chat_completions") {
  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }

  const type = String(toolChoice.type || "").trim().toLowerCase();

  if (!type || type === "auto") {
    return "auto";
  }

  if (type === "any") {
    return "required";
  }

  if (type === "tool" && toolChoice.name) {
    if (apiStyle === "responses") {
      return {
        type: "function",
        name: String(toolChoice.name)
      };
    }

    return {
      type: "function",
      function: {
        name: String(toolChoice.name)
      }
    };
  }

  return undefined;
}

function normalizeAnthropicToolResultText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content || "");
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text") {
        return block.text || "";
      }

      if (typeof block.text === "string") {
        return block.text;
      }

      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeAnthropicToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content || "");
  }

  const textBlocks = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      textBlocks.push({
        type: "text",
        text: typeof block.text === "string" ? block.text : ""
      });
      continue;
    }

    return normalizeAnthropicToolResultText(content);
  }

  return textBlocks;
}

function sanitizeAnthropicInputMessages(messages) {
  const sanitized = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      sanitized.push({
        ...message,
        role,
        content
      });
      continue;
    }

    if (!Array.isArray(content)) {
      sanitized.push({
        ...message,
        role,
        content: [{ type: "text", text: normalizeContentString(content) || "" }]
      });
      continue;
    }

    const nextContent = [];

    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const type = String(block.type || "").trim().toLowerCase();

      if (type === "thinking" || type === "redacted_thinking") {
        continue;
      }

      if (type === "tool_result") {
        nextContent.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: sanitizeAnthropicToolResultContent(block.content)
        });
        continue;
      }

      if (type === "text") {
        nextContent.push({
          ...block,
          type: "text",
          text: typeof block.text === "string" ? block.text : ""
        });
        continue;
      }

      nextContent.push(block);
    }

    if (nextContent.length === 0) {
      nextContent.push({ type: "text", text: "" });
    }

    sanitized.push({
      ...message,
      role,
      content: nextContent
    });
  }

  return sanitized;
}

function sanitizeAnthropicRequestBody(body) {
  if (!body || typeof body !== "object") {
    return {};
  }

  return {
    ...body,
    messages: sanitizeAnthropicInputMessages(body.messages)
  };
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

// Alias: identical logic to normalizeContentString
const normalizeResponsesTextContent = normalizeContentString;

function openAiMessagesToResponsesInput(messages) {
  const input = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = String(message.role || "user");
    const contentText = normalizeResponsesTextContent(message.content);

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id || createFallbackId()),
        output: contentText || String(message.content || "")
      });
      continue;
    }

    if (role === "assistant") {
      if (contentText) {
        input.push({
          role: "assistant",
          content: [{ type: "input_text", text: contentText }]
        });
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const toolCall of toolCalls) {
        const fn = toolCall && toolCall.function ? toolCall.function : {};
        if (!fn.name) {
          continue;
        }

        input.push({
          type: "function_call",
          call_id: String(toolCall.id || createFallbackId()),
          name: String(fn.name),
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {})
        });
      }
      continue;
    }

    input.push({
      role: role === "system" ? "system" : "user",
      content: [{ type: "input_text", text: contentText || "[Empty]" }]
    });
  }

  if (input.length === 0) {
    input.push({
      role: "user",
      content: [{ type: "input_text", text: "[Empty]" }]
    });
  }

  return input;
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

function anthropicToOpenAiMessages(body) {
  const messages = [];
  const system = normalizeSystemPrompt(body && body.system);

  if (system) {
    messages.push({ role: "system", content: system });
  }

  for (const message of Array.isArray(body && body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(message && message.content)
      ? message.content
      : [{ type: "text", text: normalizeContent(message && message.content) || "[Empty]" }];

    if (role === "assistant") {
      const textParts = [];
      const toolCalls = [];

      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }

        if (block.type === "text") {
          if (block.text) {
            textParts.push(String(block.text));
          }
          continue;
        }

        if (block.type === "tool_use" && block.name) {
          toolCalls.push({
            id: String(block.id || createFallbackId()),
            type: "function",
            function: {
              name: String(block.name),
              arguments: JSON.stringify(block.input || {})
            }
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts.join("\n"),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
      }

      continue;
    }

    const textParts = [];

    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id || createFallbackId()),
          content: normalizeAnthropicToolResultText(block.content)
        });
        continue;
      }

      if (block.type === "text" && block.text) {
        textParts.push(String(block.text));
      }
    }

    if (textParts.length > 0) {
      messages.push({
        role: "user",
        content: textParts.join("\n")
      });
    }
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

function extractToolCallsFromChatCompletion(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];

  return toolCalls
    .map((toolCall) => {
      const fn = toolCall && toolCall.function ? toolCall.function : {};
      if (!fn.name) {
        return null;
      }

      return {
        id: toolCall.id || createFallbackId(),
        name: String(fn.name),
        input: normalizeJsonStringObject(fn.arguments)
      };
    })
    .filter(Boolean);
}

function extractToolCallsFromResponsesResult(result) {
  const output = Array.isArray(result && result.raw && result.raw.output) ? result.raw.output : [];

  return output
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
        id: item.call_id || item.id || createFallbackId(),
        name: String(item.name),
        input: normalizeJsonStringObject(item.arguments)
      };
    })
    .filter(Boolean);
}

function extractToolCallsFromAnthropicMessage(payload) {
  const content = Array.isArray(payload && payload.content) ? payload.content : [];

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || block.type !== "tool_use" || !block.name) {
        return null;
      }

      return {
        id: block.id || createFallbackId(),
        name: String(block.name),
        input: block.input && typeof block.input === "object" ? block.input : {}
      };
    })
    .filter(Boolean);
}

function isAnthropicStreamingRequiredErrorPayload(payload) {
  const error = payload && payload.error;
  const message = typeof (error && error.message) === "string"
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const type = String(error && error.type ? error.type : payload && payload.type ? payload.type : "").toLowerCase();

  return type === "proxy_error" && STREAMING_REQUIRED_RE.test(message);
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

function _parseSseRawEvent(rawEvent) {
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
  return data.length > 0 ? { event, data: data.join("\n") } : null;
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
          const parsed = _parseSseRawEvent(rawEvent);
          if (parsed) {
            return { done: false, value: parsed };
          }
          continue;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          if (!buffer.trim()) {
            return { done: true, value: null };
          }

          const parsed = _parseSseRawEvent(buffer);
          buffer = "";
          return parsed
            ? { done: false, value: parsed }
            : { done: true, value: null };
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

function shouldFallbackToExternalProvider(error) {
  if (!error) {
    return false;
  }

  if (isTimeoutLikeError(error)) {
    return true;
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
    type === "api_timeout_error" ||
    type === "api_connection_error" ||
    /quota|unauthorized|rate limit|overloaded|timed out|timeout|fetch failed|terminated|provider unavailable/.test(message)
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
    this.baseUrl = stripTrailingSlash(config.baseUrl || "");
    this.apiKey = String(config.apiKey || "");
    this.model = String(config.model || "");
    this.supportedModels = normalizeSupportedModels(config.supportedModels, this.model);
    this.timeoutMs = Number(config.timeoutMs || 60000);
    this.protocol = String(config.protocol || "openai").toLowerCase() === "anthropic" ? "anthropic" : "openai";
    this.openaiApiStyle = normalizeOpenAiApiStyle(config.openaiApiStyle);
    this.anthropicVersion = String(config.anthropicVersion || DEFAULT_ANTHROPIC_VERSION || "2023-06-01");
    this.reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
    this.preferredAnthropicMessagesPath = null;
    this.preferredAnthropicAuthMode = this.protocol === "anthropic"
      ? (this.preferredAnthropicAuthMode || null)
      : null;
    this.preferredOpenAiEndpoint = this.protocol === "openai" && this.openaiApiStyle !== "auto"
      ? this.openaiApiStyle
      : null;
  }

  isConfigured() {
    return this.enabled && Boolean(this.baseUrl && this.apiKey && this.model);
  }

  transportName() {
    return this.protocol === "anthropic" ? "external-anthropic" : "external-openai";
  }

  supportsRequestedModel(requestedModel) {
    const normalized = normalizeSupportedModelId(requestedModel);
    if (!normalized || this.supportedModels.length === 0) {
      return false;
    }

    return this.supportedModels.includes(normalized);
  }

  buildAnthropicMessageUrls() {
    return buildAnthropicMessageUrls(this.baseUrl, this.preferredAnthropicMessagesPath);
  }

  buildAnthropicAuthModes() {
    const modes = ["x-api-key", "bearer"];
    if (this.preferredAnthropicAuthMode && modes.includes(this.preferredAnthropicAuthMode)) {
      return [this.preferredAnthropicAuthMode, ...modes.filter((mode) => mode !== this.preferredAnthropicAuthMode)];
    }
    return modes;
  }

  async fetchAnthropicMessageResponse(body, options = {}) {
    let lastResponse = null;
    const requestHeaders = options && options.requestHeaders ? options.requestHeaders : null;
    for (const url of this.buildAnthropicMessageUrls()) {
      const authModes = this.buildAnthropicAuthModes();
      for (let authIndex = 0; authIndex < authModes.length; authIndex += 1) {
        const authMode = authModes[authIndex];
        const requestOptions = {
          method: "POST",
          headers: this.buildAnthropicHeaders(authMode, requestHeaders),
          body: JSON.stringify(body)
        };

        log.info("external fallback anthropic request begin", {
          protocol: this.transportName(),
          url,
          authMode
        });
        const response = body && body.stream === true
          ? await this.fetchStreamWithRetry(url, requestOptions)
          : await this.fetchWithRetry(url, {
              ...requestOptions,
              signal: AbortSignal.timeout(this.timeoutMs)
            });
        lastResponse = response;

        if ((response.status === 401 || response.status === 403) && authIndex < authModes.length - 1) {
          log.warn("external fallback anthropic auth rejected, trying alternate auth mode", {
            protocol: this.transportName(),
            url,
            authMode,
            status: response.status
          });
          continue;
        }

        if (response.status === 404) {
          log.warn("external fallback anthropic request got 404, trying next path", {
            protocol: this.transportName(),
            url
          });
          break;
        }

        const contentType = String(response.headers.get("content-type") || "");
        if (isHtmlResponse(contentType)) {
          log.warn("external fallback anthropic request got html response, trying next path", {
            protocol: this.transportName(),
            url
          });
          break;
        }

        if (JSON_CONTENT_RE.test(contentType)) {
          try {
            const probe = await response.clone().json();
            if (isAnthropicWrappedNotFoundPayload(probe)) {
              log.warn("external fallback anthropic request got wrapped 404, trying next path", {
                protocol: this.transportName(),
                url
              });
              break;
            }
          } catch {
            // Ignore probe parse failure and let caller handle the actual response.
          }
        }

        this.preferredAnthropicMessagesPath = String(url).endsWith("/v1/messages")
          ? "/v1/messages"
          : "/messages";
        this.preferredAnthropicAuthMode = authMode;

        return response;
      }
    }

    return lastResponse;
  }

  async _fetchWithRetryCore(url, options, { useTimeout = false } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeout = useTimeout ? createTimeoutController(this.timeoutMs) : null;
      try {
        if (attempt > 0) {
          log.warn("external fallback retrying request", {
            protocol: this.transportName(),
            url,
            attempt: attempt + 1
          });
        }

        const fetchOptions = timeout
          ? { ...options, signal: timeout.signal }
          : options;
        const response = await this.fetchImpl(url, fetchOptions);
        if (timeout) {
          timeout.clear();
        }
        return response;
      } catch (error) {
        if (timeout) {
          timeout.clear();
        }
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

  async fetchStreamWithRetry(url, options) {
    return this._fetchWithRetryCore(url, options, { useTimeout: true });
  }

  async fetchWithRetry(url, options) {
    return this._fetchWithRetryCore(url, options);
  }

  buildAnthropicHeaders(authMode = null, requestHeaders = null) {
    const mode = authMode || this.preferredAnthropicAuthMode || "x-api-key";
    const authHeaders = mode === "bearer"
      ? { authorization: "Bearer " + this.apiKey }
      : { "x-api-key": this.apiKey };
    const mergedBetas = mergeHeaderTokenLists(
      requestHeaders && (requestHeaders["anthropic-beta"] || requestHeaders["Anthropic-Beta"]),
      DEFAULT_ANTHROPIC_BETAS
    );

    return {
      ...authHeaders,
      "anthropic-version": this.anthropicVersion,
      "anthropic-beta": mergedBetas.join(","),
      "user-agent": "AnthropicSDK/TypeScript 0.39.0",
      "x-stainless-lang": "js",
      "x-stainless-os": "MacOS",
      "x-stainless-runtime": "node",
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
  }

  buildOpenAiHeaders(accept = "application/json") {
    return {
      authorization: "Bearer " + this.apiKey,
      "content-type": "application/json",
      accept
    };
  }

  buildOpenAiEndpoints() {
    if (this.openaiApiStyle === "chat_completions") {
      return ["chat_completions"];
    }

    if (this.openaiApiStyle === "responses") {
      return ["responses"];
    }

    const preferred = this.preferredOpenAiEndpoint;
    const ordered = [];
    const push = (name) => {
      if (!ordered.includes(name)) {
        ordered.push(name);
      }
    };
    if (preferred) {
      push(preferred);
    }
    push("chat_completions");
    push("responses");
    return ordered;
  }

  async requestOpenAiChatCompletions(body) {
    return this.fetchWithRetry(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers: this.buildOpenAiHeaders("application/json"),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  async requestOpenAiResponses(body) {
    return this.fetchStreamWithRetry(this.baseUrl + "/responses", {
      method: "POST",
      headers: this.buildOpenAiHeaders("text/event-stream,application/json"),
      body: JSON.stringify({
        ...body,
        stream: true
      })
    });
  }

  rememberOpenAiEndpoint(endpoint) {
    if (this.protocol !== "openai" || this.openaiApiStyle !== "auto") {
      return;
    }

    this.preferredOpenAiEndpoint = endpoint === "responses" ? "responses" : "chat_completions";
  }

  async collectOpenAiResponsesStream(response) {
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
        "External fallback responses request failed: " + (response.status || 502);
      throw buildError(response.status || 502, message, {
        upstream: {
          provider: this.transportName(),
          status: response.status || 502,
          body: payload || rawText || null
        }
      });
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!SSE_CONTENT_RE.test(contentType) || !response.body) {
      const payload = await response.json().catch(() => ({}));
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        "External fallback responses request failed: " + response.status;
      throw buildError(response.status || 502, message, {
        upstream: {
          provider: this.transportName(),
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
          continue;
        }

        if (payload.type === "response.output_text.done" && typeof payload.text === "string" && !text) {
          text = payload.text;
          continue;
        }

        if (payload.type === "response.output_item.done" && payload.item && typeof payload.item === "object") {
          outputItems = upsertResponseOutputItem(outputItems, payload.item);
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
      model: this.model,
      output: outputItems,
      usage: null
    };

    return {
      model: finalResponse && finalResponse.model ? finalResponse.model : this.model,
      text,
      toolCalls: extractToolCallsFromResponsesResult({ raw: finalResponse }),
      usage: finalResponse && finalResponse.usage ? finalResponse.usage : null,
      raw: finalResponse
    };
  }

  async collectAnthropicMessageStream(response) {
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
        "External fallback anthropic stream request failed: " + (response.status || 502);
      throw buildError(response.status || 502, message, {
        upstream: {
          provider: this.transportName(),
          status: response.status || 502,
          body: payload || rawText || null
        }
      });
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!SSE_CONTENT_RE.test(contentType) || !response.body) {
      const payload = await response.json().catch(() => ({}));
      const message =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        "External fallback anthropic stream request failed: " + (response.status || 502);
      throw buildError(response.status || 502, message, {
        upstream: {
          provider: this.transportName(),
          status: response.status || 502,
          body: payload || null
        }
      });
    }

    const reader = createSseReader(response.body);
    const blocks = new Map();
    let id = null;
    let model = this.model;
    let role = "assistant";
    let usage = null;
    let stopReason = null;
    let stopSequence = null;

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

        if (!payload || typeof payload !== "object") {
          continue;
        }

        if (payload.type === "message_start" && payload.message) {
          id = payload.message.id || id;
          model = payload.message.model || model;
          role = payload.message.role || role;
          usage = payload.message.usage || usage;
          continue;
        }

        if (payload.type === "content_block_start" && payload.content_block) {
          const index = Number(payload.index);
          if (!Number.isFinite(index)) {
            continue;
          }

          const block = payload.content_block;
          if (block.type === "tool_use") {
            blocks.set(index, {
              type: "tool_use",
              id: block.id || createFallbackId(),
              name: block.name || "tool",
              inputJson: block.input && Object.keys(block.input).length > 0
                ? JSON.stringify(block.input)
                : ""
            });
            continue;
          }

          if (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking") {
            blocks.set(index, {
              ...block
            });
          }
          continue;
        }

        if (payload.type === "content_block_delta" && payload.delta) {
          const index = Number(payload.index);
          const block = blocks.get(index);
          if (!block) {
            continue;
          }

          if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
            block.text = String(block.text || "") + payload.delta.text;
            continue;
          }

          if (payload.delta.type === "thinking_delta" && typeof payload.delta.thinking === "string") {
            block.thinking = String(block.thinking || "") + payload.delta.thinking;
            continue;
          }

          if (payload.delta.type === "input_json_delta" && block.type === "tool_use") {
            block.inputJson = String(block.inputJson || "") + String(payload.delta.partial_json || "");
          }
          continue;
        }

        if (payload.type === "message_delta") {
          stopReason = payload.delta && payload.delta.stop_reason
            ? payload.delta.stop_reason
            : stopReason;
          stopSequence = payload.delta && Object.prototype.hasOwnProperty.call(payload.delta, "stop_sequence")
            ? payload.delta.stop_sequence
            : stopSequence;
          usage = {
            ...(usage || {}),
            ...(payload.usage || {})
          };
          continue;
        }
      }
    } finally {
      await reader.cancel();
    }

    const content = [...blocks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, block]) => {
        if (!block || typeof block !== "object") {
          return null;
        }

        if (block.type === "tool_use") {
          return {
            type: "tool_use",
            id: block.id || createFallbackId(),
            name: block.name || "tool",
            input: normalizeJsonStringObject(block.inputJson)
          };
        }

        if (block.type === "thinking" || block.type === "redacted_thinking") {
          return {
            type: block.type,
            thinking: block.thinking || "",
            ...(block.signature ? { signature: block.signature } : {})
          };
        }

        return {
          type: "text",
          text: block.text || ""
        };
      })
      .filter(Boolean);

    const raw = {
      id: id || createFallbackId(),
      type: "message",
      role,
      model,
      content,
      stop_reason: stopReason || (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: stopSequence || null,
      usage: usage || null
    };

    return {
      model,
      text: extractTextFromAnthropicMessage(raw),
      toolCalls: extractToolCallsFromAnthropicMessage(raw),
      usage: raw.usage,
      raw
    };
  }

  async requestAnthropicMessage(body, options = {}) {
    if (!this.isConfigured()) {
      throw new Error("External fallback provider is not configured");
    }

    const payload = {
      ...sanitizeAnthropicRequestBody(body),
      model: this.model,
      stream: body && body.stream === true
    };

    return this.fetchAnthropicMessageResponse(payload, options);
  }

  isEligibleAnthropic(body) {
    if (!this.isConfigured()) {
      return false;
    }

    if (this.protocol === "anthropic") {
      return Boolean(body && typeof body === "object");
    }

    if (!body || hasAnthropicImages(body.messages)) {
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

  async complete({ messages, system, maxTokens, temperature, metadata, reasoning, tools, toolChoice, requestHeaders }) {
    if (!this.isConfigured()) {
      throw new Error("External fallback provider is not configured");
    }

    const isAnthropic = this.protocol === "anthropic";
    let usedAnthropicStreamingCollection = false;

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
      response = await this.fetchAnthropicMessageResponse(requestBody, { requestHeaders });

      const contentType = String(response.headers.get("content-type") || "");
      if (!requestBody.stream && /application\/json/i.test(contentType)) {
        const payload = await response.clone().json().catch(() => null);
        if (!response.ok && isAnthropicStreamingRequiredErrorPayload(payload)) {
          response = await this.fetchAnthropicMessageResponse({
            ...requestBody,
            stream: true
          }, { requestHeaders });
          usedAnthropicStreamingCollection = true;
        }
      }
    } else {
      const requestBody = {
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        metadata: metadata || undefined,
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(reasoning || {})
      };

      let lastError = null;
      for (const endpoint of this.buildOpenAiEndpoints()) {
        try {
          if (endpoint === "responses") {
            const responsesBody = {
              model: this.model,
              input: openAiMessagesToResponsesInput(messages),
              max_output_tokens: maxTokens,
              temperature,
              ...(Array.isArray(tools) && tools.length > 0
                ? {
                    tools: tools.map((tool) => ({
                      type: "function",
                      name: tool.function.name,
                      description: tool.function.description,
                      parameters: tool.function.parameters
                    }))
                  }
                : {}),
              ...(toolChoice
                ? {
                    tool_choice:
                      typeof toolChoice === "object" && toolChoice.function
                        ? {
                            type: "function",
                            name: toolChoice.function.name
                          }
                        : toolChoice
                  }
                : {}),
              ...(reasoning || {})
            };
            const responsesResponse = await this.requestOpenAiResponses(responsesBody);
            const result = await this.collectOpenAiResponsesStream(responsesResponse);
            this.rememberOpenAiEndpoint("responses");
            return result;
          }

          response = await this.requestOpenAiChatCompletions(requestBody);
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const message =
              (payload && payload.error && payload.error.message) ||
              (payload && payload.message) ||
              "External fallback request failed: " + (response.status || 502);
            throw buildError(response.status || 502, message, {
              upstream: {
                provider: this.transportName(),
                status: response.status || 502,
                body: payload || null
              }
            });
          }
          this.rememberOpenAiEndpoint("chat_completions");
          break;
        } catch (error) {
          lastError = error;
          if (endpoint === "chat_completions" && isOpenAiChatCompletionsUnsupported(error)) {
            this.rememberOpenAiEndpoint("responses");
            continue;
          }
          throw error;
        }
      }

      if (!response && lastError) {
        throw lastError;
      }
    }

    if (isAnthropic && usedAnthropicStreamingCollection) {
      return this.collectAnthropicMessageStream(response);
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
      toolCalls: isAnthropic ? extractToolCallsFromAnthropicMessage(payload) : extractToolCallsFromChatCompletion(payload),
      usage: payload && payload.usage ? payload.usage : null,
      raw: payload
    };
  }

  async completeNativeAnthropicBody(body, options = {}) {
    const requestHeaders = options && options.requestHeaders ? options.requestHeaders : null;
    const payload = {
      ...sanitizeAnthropicRequestBody(body),
      model: this.model,
      stream: body && body.stream === true
    };

    let response = await this.fetchAnthropicMessageResponse(payload, { requestHeaders });
    const contentType = String(response.headers.get("content-type") || "");

    if (!payload.stream && /application\/json/i.test(contentType)) {
      const errorPayload = await response.clone().json().catch(() => null);
      if (!response.ok && isAnthropicStreamingRequiredErrorPayload(errorPayload)) {
        response = await this.fetchAnthropicMessageResponse({
          ...payload,
          stream: true
        }, { requestHeaders });
        return this.collectAnthropicMessageStream(response);
      }
    }

    const responsePayload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw buildError(
        response.status || 502,
        (responsePayload && responsePayload.error && responsePayload.error.message) ||
          (responsePayload && responsePayload.message) ||
          `External fallback request failed: ${response.status || 502}`,
        {
          upstream: {
            provider: this.transportName(),
            status: response.status || 502,
            body: responsePayload || null
          }
        }
      );
    }

    return {
      model: this.model,
      text: extractTextFromAnthropicMessage(responsePayload),
      toolCalls: extractToolCallsFromAnthropicMessage(responsePayload),
      usage: responsePayload && responsePayload.usage ? responsePayload.usage : null,
      raw: responsePayload
    };
  }

  async completeAnthropic(body, options = {}) {
    if (this.protocol === "anthropic") {
      return this.completeNativeAnthropicBody(body, options);
    }

    return this.complete({
      messages: anthropicToOpenAiMessages(body),
      maxTokens: Number(body && body.max_tokens) || undefined,
      temperature: typeof (body && body.temperature) === "number" ? body.temperature : undefined,
      metadata: { source: "accio-bridge-anthropic-fallback" },
      tools: normalizeAnthropicToolDefinitions(body && body.tools),
      toolChoice: normalizeAnthropicToolChoice(body && body.tool_choice),
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
        openaiApiStyle: null,
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
      openaiApiStyle: this.openaiApiStyle === "auto"
        ? (this.preferredOpenAiEndpoint || "chat_completions")
        : this.openaiApiStyle,
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
    const previousEntries = Array.isArray(this.entries) ? this.entries : [];
    const previousClientsById = new Map(previousEntries.map((entry) => [entry.target.id, entry.client]));
    this.targets = targets;
    this.entries = targets.map((target) => ({
      target,
      client: (() => {
        const existing = previousClientsById.get(target.id);
        if (existing) {
          existing.updateConfig({
            ...target,
            fetchImpl: this.fetchImpl
          });
          return existing;
        }

        return new ExternalFallbackClient({
          ...target,
          fetchImpl: this.fetchImpl
        });
      })()
    }));
    return this.targets;
  }

  isConfigured() {
    return this.entries.some((entry) => entry.client.isConfigured());
  }

  getSettings() {
    return this.targets.map((target) => serializeFallbackTarget(target));
  }

  getEligibleAnthropic(body) {
    return this._rankEntriesByRequestedModel(
      this.entries.filter((entry) => entry.client.isEligibleAnthropic(body)),
      body && body.model
    );
  }

  getEligibleOpenAi(body) {
    return this._rankEntriesByRequestedModel(
      this.entries.filter((entry) => entry.client.isEligibleOpenAi(body)),
      body && body.model
    );
  }

  getConfiguredEntries() {
    return this.entries.filter((entry) => entry.client.isConfigured());
  }

  _rankEntriesByRequestedModel(entries, requestedModel) {
    const nativeMatches = entries.filter((entry) => entry.client.supportsRequestedModel(requestedModel));
    if (nativeMatches.length === 0) {
      return entries;
    }

    const matchedIds = new Set(nativeMatches.map((entry) => entry.target.id));
    return nativeMatches.concat(entries.filter((entry) => !matchedIds.has(entry.target.id)));
  }
}

module.exports = {
  DEFAULT_ANTHROPIC_VERSION,
  ExternalFallbackClient,
  ExternalFallbackPool,
  STREAMING_REQUIRED_RE,
  anthropicToAnthropicPayload,
  anthropicToFallbackMessages,
  normalizeFallbackTarget,
  normalizeFallbackTargets,
  openAiMessagesToResponsesInput,
  serializeFallbackTarget,
  sanitizeAnthropicRequestBody,
  openAiToAnthropicPayload,
  openAiToFallbackMessages,
  shouldFallbackToExternalProvider
};
