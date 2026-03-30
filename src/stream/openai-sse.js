"use strict";

const { buildChatCompletionChunk } = require("../openai");
const { CORS_HEADERS } = require("../http");
const { generateId } = require("../id");

class OpenAiStreamWriter {
  constructor({ body, res, created, id, conversationId, sessionId }) {
    this.body = body;
    this.res = res;
    this.created = created || Math.floor(Date.now() / 1000);
    this.id = id || generateId("chatcmpl");
    this.conversationId = conversationId || "";
    this.sessionId = sessionId || "";
    this.started = false;
    this.wroteAssistantRole = false;
  }

  start() {
    if (this.started || this.res.headersSent) {
      this.started = true;
      return;
    }

    this.res.writeHead(200, {
      ...CORS_HEADERS,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accio-conversation-id": this.conversationId,
      "x-accio-session-id": this.sessionId
    });
    this.started = true;
  }

  writeChunk(delta, extras = {}) {
    this.start();
    this.res.write(
      `data: ${JSON.stringify(
        buildChatCompletionChunk(this.body, delta, {
          created: this.created,
          id: this.id,
          ...extras
        })
      )}\n\n`
    );
  }

  ensureAssistantRole() {
    if (this.wroteAssistantRole) {
      return;
    }

    this.writeChunk({ role: "assistant" });
    this.wroteAssistantRole = true;
  }

  writeContent(content) {
    if (!content) {
      return;
    }

    this.ensureAssistantRole();
    this.writeChunk({ content });
  }

  writeToolCall(toolCall) {
    this.ensureAssistantRole();
    this.writeChunk({
      tool_calls: [
        {
          index: 0,
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input || {})
          }
        }
      ]
    });
  }

  finish(finishReason) {
    this.writeChunk({}, { finishReason });
    this.res.write("data: [DONE]\n\n");
    this.res.end();
  }
}

module.exports = {
  OpenAiStreamWriter
};
