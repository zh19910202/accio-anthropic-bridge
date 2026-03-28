"use strict";

const { createBridgeError } = require("./errors");

function normalizeAnthropicContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [];
}

function validateAnthropicMessages(messages) {
  const knownToolIds = new Map();
  const toolRequests = [];
  const toolResults = [];

  for (const [messageIndex, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const role = String((message && message.role) || "user");

    for (const [blockIndex, block] of normalizeAnthropicContent(message && message.content).entries()) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "tool_use") {
        if (role !== "assistant") {
          throw createBridgeError(
            400,
            `anthropic.messages[${messageIndex}].content[${blockIndex}] tool_use must come from assistant`,
            "invalid_request_error"
          );
        }

        if (!block.id || !block.name) {
          throw createBridgeError(
            400,
            `anthropic.messages[${messageIndex}].content[${blockIndex}] tool_use requires id and name`,
            "invalid_request_error"
          );
        }

        knownToolIds.set(block.id, block.name);
        toolRequests.push({ id: block.id, name: block.name, input: block.input || {} });
      }

      if (block.type === "tool_result") {
        if (role !== "user") {
          throw createBridgeError(
            400,
            `anthropic.messages[${messageIndex}].content[${blockIndex}] tool_result must come from user`,
            "invalid_request_error"
          );
        }

        if (!block.tool_use_id) {
          throw createBridgeError(
            400,
            `anthropic.messages[${messageIndex}].content[${blockIndex}] tool_result requires tool_use_id`,
            "invalid_request_error"
          );
        }

        if (!knownToolIds.has(block.tool_use_id)) {
          throw createBridgeError(
            400,
            `anthropic.messages[${messageIndex}].content[${blockIndex}] tool_result references unknown tool_use_id ${block.tool_use_id}`,
            "invalid_request_error"
          );
        }

        toolResults.push({
          toolUseId: block.tool_use_id,
          name: knownToolIds.get(block.tool_use_id),
          content: block.content,
          isError: Boolean(block.is_error)
        });
      }
    }
  }

  return {
    toolRequests,
    toolResults,
    toolNameById: knownToolIds
  };
}

function validateOpenAiMessages(messages) {
  const knownToolIds = new Map();
  const toolRequests = [];
  const toolResults = [];

  for (const [messageIndex, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const role = String((message && message.role) || "user");

    if (role === "assistant") {
      for (const [callIndex, toolCall] of (Array.isArray(message && message.tool_calls) ? message.tool_calls : []).entries()) {
        const fn = toolCall && toolCall.function;

        if (!toolCall || !toolCall.id || !fn || !fn.name) {
          throw createBridgeError(
            400,
            `openai.messages[${messageIndex}].tool_calls[${callIndex}] requires id and function.name`,
            "invalid_request_error"
          );
        }

        knownToolIds.set(toolCall.id, fn.name);
        toolRequests.push({
          id: toolCall.id,
          name: fn.name,
          input: fn.arguments || "{}"
        });
      }
    }

    if (role === "tool") {
      if (!message.tool_call_id) {
        throw createBridgeError(
          400,
          `openai.messages[${messageIndex}] role=tool requires tool_call_id`,
          "invalid_request_error"
        );
      }

      if (!knownToolIds.has(message.tool_call_id)) {
        throw createBridgeError(
          400,
          `openai.messages[${messageIndex}] references unknown tool_call_id ${message.tool_call_id}`,
          "invalid_request_error"
        );
      }

      toolResults.push({
        toolUseId: message.tool_call_id,
        name: knownToolIds.get(message.tool_call_id),
        content: message.content,
        isError: false
      });
    }
  }

  return {
    toolRequests,
    toolResults,
    toolNameById: knownToolIds
  };
}

module.exports = {
  normalizeAnthropicContent,
  validateAnthropicMessages,
  validateOpenAiMessages
};
