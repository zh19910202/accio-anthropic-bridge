"use strict";

const crypto = require("node:crypto");

const { normalizeContent } = require("./anthropic");
const { createBridgeError } = require("./errors");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      const fn = tool && (tool.function || tool);

      if (!fn || !fn.name) {
        return null;
      }

      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || fn.input_schema || {}
      };
    })
    .filter(Boolean);
}

function normalizeOpenAiMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.role === "tool") {
    return `[Tool result for ${message.tool_call_id || "unknown"}]\n${normalizeContent(
      message.content
    )}`;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls
      .map((call) => {
        const fn = call.function || {};
        return `[Assistant requested tool ${fn.name || "unknown"} id=${call.id || "unknown"}]\n${
          fn.arguments || "{}"
        }`;
      })
      .join("\n");
  }

  return normalizeContent(message.content);
}

function flattenOpenAiRequest(body) {
  const lines = [];
  const tools = normalizeToolDefinitions(body.tools);

  if (tools.length > 0) {
    lines.push("Available tools:");

    for (const tool of tools) {
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

  lines.push("Conversation:");

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    lines.push(`${String(message.role || "user").toUpperCase()}:`);
    lines.push(normalizeOpenAiMessage(message) || "[Empty]");
    lines.push("");
  }

  lines.push("Answer the latest user request directly.");
  return lines.join("\n").trim();
}

function toOpenAiToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input || {})
    }
  }));
}

function buildChatCompletionResponse(body, text, extras = {}) {
  const toolCalls = toOpenAiToolCalls(extras.toolCalls);
  const hasToolCalls = toolCalls.length > 0;

  return {
    id: extras.id || generateId("chatcmpl"),
    object: "chat.completion",
    created: extras.created || Math.floor(Date.now() / 1000),
    model: body.model || "accio-bridge",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || "",
          ...(hasToolCalls ? { tool_calls: toolCalls } : {})
        },
        finish_reason: hasToolCalls ? "tool_calls" : "stop"
      }
    ],
    usage: {
      prompt_tokens: extras.inputTokens || 0,
      completion_tokens: extras.outputTokens || 0,
      total_tokens: (extras.inputTokens || 0) + (extras.outputTokens || 0)
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

function buildChatCompletionChunk(body, delta, extras = {}) {
  return {
    id: extras.id || generateId("chatcmpl"),
    object: "chat.completion.chunk",
    created: extras.created || Math.floor(Date.now() / 1000),
    model: body.model || "accio-bridge",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: extras.finishReason || null
      }
    ]
  };
}

function buildOpenAiModelsResponse(models = null) {
  return {
    object: "list",
    data: Array.isArray(models) && models.length > 0
      ? models
      : [
          {
            id: "accio-bridge",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "accio"
          }
        ]
  };
}

function normalizeResponsesInputItems(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }

  if (!Array.isArray(input)) {
    return input ? [input] : [];
  }

  return input;
}

function normalizeResponseContentItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  if (item.type === "input_text" || item.type === "text") {
    return { type: "text", text: item.text || "" };
  }

  if (item.type === "input_image") {
    if (item.image_url) {
      return {
        type: "image_url",
        image_url: { url: item.image_url }
      };
    }

    if (item.file_data && item.file_data.data) {
      const mimeType = item.file_data.mime_type || "image/png";
      return {
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${item.file_data.data}` }
      };
    }
  }

  if (item.type === "output_text") {
    return { type: "text", text: item.text || "" };
  }

  return null;
}

function convertResponsesInputToOpenAiMessages(body) {
  const messages = [];

  if (body.instructions) {
    messages.push({ role: "system", content: String(body.instructions) });
  }

  for (const [index, item] of normalizeResponsesInputItems(body.input).entries()) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (!item || typeof item !== "object") {
      throw createBridgeError(400, `responses.input[${index}] is invalid`, "invalid_request_error");
    }

    const role = String(item.role || "user");
    const content = Array.isArray(item.content)
      ? item.content.map(normalizeResponseContentItem).filter(Boolean)
      : typeof item.content === "string"
        ? [{ type: "text", text: item.content }]
        : [];

    if (content.length === 0 && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    }

    if (content.length === 0) {
      throw createBridgeError(400, `responses.input[${index}] contains no supported content`, "invalid_request_error");
    }

    messages.push({ role, content });
  }

  return messages;
}

function buildResponsesApiResponse(body, text, extras = {}) {
  const toolCalls = Array.isArray(extras.toolCalls) ? extras.toolCalls : [];
  const outputContent = [];

  if (text || toolCalls.length === 0) {
    outputContent.push({
      type: "output_text",
      text: text || "",
      annotations: []
    });
  }

  for (const toolCall of toolCalls) {
    outputContent.push({
      type: "tool_call",
      id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input || {})
    });
  }

  return {
    id: extras.id || generateId("resp"),
    object: "response",
    created_at: extras.created || Math.floor(Date.now() / 1000),
    model: body.model || "accio-bridge",
    status: "completed",
    output: [
      {
        id: extras.messageId || generateId("msg"),
        type: "message",
        role: "assistant",
        content: outputContent
      }
    ],
    output_text: text || "",
    usage: {
      input_tokens: extras.inputTokens || 0,
      output_tokens: extras.outputTokens || 0,
      total_tokens: (extras.inputTokens || 0) + (extras.outputTokens || 0)
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

module.exports = {
  buildChatCompletionChunk,
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  buildResponsesApiResponse,
  convertResponsesInputToOpenAiMessages,
  flattenOpenAiRequest
};
