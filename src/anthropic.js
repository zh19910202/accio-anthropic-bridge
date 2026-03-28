"use strict";

const crypto = require("node:crypto");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeSystemPrompt(system) {
  if (typeof system === "string") {
    return system;
  }

  if (!Array.isArray(system)) {
    return "";
  }

  return system
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text") {
        return block.text || "";
      }

      return `[Unsupported system block: ${block.type || "unknown"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeContent(content) {
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

      if (block.type === "text") {
        return block.text || "";
      }

      if (block.type === "image" || block.type === "image_url") {
        return "[Image omitted by bridge]";
      }

      if (block.type === "tool_use") {
        return `[Assistant requested tool ${block.name || "unknown"} id=${
          block.id || "unknown"
        }]\n${JSON.stringify(block.input || {})}`;
      }

      if (block.type === "tool_result") {
        const value =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content || "");
        return `[Tool result for ${block.tool_use_id || "unknown"}]\n${value}`;
      }

      return `[Unsupported content block: ${block.type || "unknown"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function flattenAnthropicRequest(body) {
  const lines = [];
  const system = normalizeSystemPrompt(body.system);

  if (system.trim()) {
    lines.push("System:");
    lines.push(system.trim());
    lines.push("");
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    lines.push("Available tools:");

    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object" || !tool.name) {
        continue;
      }

      lines.push(`- ${tool.name}`);

      if (tool.description) {
        lines.push(`  Description: ${tool.description}`);
      }

      if (tool.input_schema && Object.keys(tool.input_schema).length > 0) {
        lines.push(`  JSON schema: ${JSON.stringify(tool.input_schema)}`);
      }
    }

    lines.push("");
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    lines.push("Conversation:");

    for (const message of body.messages) {
      const role = (message && message.role) || "user";
      const text = normalizeContent(message && message.content);
      lines.push(`${role.toUpperCase()}:`);
      lines.push(text || "[Empty]");
      lines.push("");
    }
  }

  lines.push("Answer the latest user request directly.");
  return lines.join("\n").trim();
}

function estimateTokens(text) {
  if (!text) {
    return 0;
  }

  const str = String(text);
  let tokens = 0;

  for (const char of str) {
    // CJK and other multibyte characters ≈ 1.5 tokens on average;
    // ASCII characters ≈ 0.25 tokens (roughly 4 chars per token).
    tokens += char.charCodeAt(0) > 0x7f ? 1.5 : 0.25;
  }

  return Math.max(1, Math.ceil(tokens));
}

function buildMessageResponse(body, text, extras = {}) {
  const toolCalls = Array.isArray(extras.toolCalls) ? extras.toolCalls : [];
  const content = [];

  if (text || toolCalls.length === 0) {
    content.push({
      type: "text",
      text: text || ""
    });
  }

  for (const toolCall of toolCalls) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input || {}
    });
  }

  return {
    id: extras.id || generateId("msg"),
    type: "message",
    role: "assistant",
    model: body.model || "accio-bridge",
    content,
    stop_reason:
      extras.stopReason || (toolCalls.length > 0 && !text ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: extras.inputTokens || 0,
      output_tokens: extras.outputTokens || 0
    },
    accio: {
      conversation_id: extras.conversationId || null,
      session_id: extras.sessionId || null,
      tool_results: extras.toolResults || [],
      account_id: extras.accountId || null,
      account_name: extras.accountName || null
    }
  };
}

function buildErrorResponse(message, type, extras = {}) {
  return {
    type: "error",
    error: {
      type: type || "api_error",
      message
    },
    ...(extras.details ? { details: extras.details } : {})
  };
}

function normalizeAccioToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || !toolCall.name) {
        return null;
      }

      return {
        id: toolCall.id || generateId("tool"),
        name: toolCall.name,
        input:
          toolCall.input ||
          toolCall.arguments ||
          toolCall.args ||
          toolCall.parameters ||
          {}
      };
    })
    .filter(Boolean);
}

function extractAccioToolCalls(result) {
  const candidates = [
    result && result.finalMessage && result.finalMessage.tool_calls,
    result && result.finalMessage && result.finalMessage.toolCalls,
    result && result.channelResponse && result.channelResponse.tool_calls,
    result && result.channelResponse && result.channelResponse.toolCalls,
    result &&
      result.finalMessage &&
      result.finalMessage.metadata &&
      result.finalMessage.metadata.tool_calls
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAccioToolCalls(candidate);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

module.exports = {
  buildErrorResponse,
  buildMessageResponse,
  estimateTokens,
  extractAccioToolCalls,
  flattenAnthropicRequest,
  normalizeContent,
  normalizeSystemPrompt
};
