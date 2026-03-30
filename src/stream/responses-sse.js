"use strict";

const { buildResponsesApiResponse } = require("../openai");
const { CORS_HEADERS } = require("../http");
const { generateId } = require("../id");

class ResponsesStreamWriter {
  constructor({ body, res, created, id, conversationId, sessionId, messageId }) {
    this.body = body;
    this.res = res;
    this.created = created || Math.floor(Date.now() / 1000);
    this.id = id || generateId("resp");
    this.conversationId = conversationId || "";
    this.sessionId = sessionId || "";
    this.messageId = messageId || generateId("msg");
    this.started = false;
    this.startedResponse = false;
    this.startedMessage = false;
    this.text = "";
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

  writeEvent(event, data) {
    this.start();
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  startResponse() {
    if (this.startedResponse) {
      return;
    }

    const response = {
      id: this.id,
      object: "response",
      created_at: this.created,
      model: this.body.model || "accio-bridge",
      status: "in_progress",
      output: [],
      output_text: ""
    };

    this.writeEvent("response.created", {
      type: "response.created",
      response
    });
    this.writeEvent("response.in_progress", {
      type: "response.in_progress",
      response
    });
    this.startedResponse = true;
  }

  ensureMessageItem() {
    if (this.startedMessage) {
      return;
    }

    this.startResponse();
    this.writeEvent("response.output_item.added", {
      type: "response.output_item.added",
      response_id: this.id,
      output_index: 0,
      item: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    });
    this.startedMessage = true;
  }

  writeTextDelta(text) {
    if (!text) {
      return;
    }

    this.ensureMessageItem();
    this.text += text;
    this.writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: this.id,
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }

  finish(extras = {}) {
    const finalText = typeof extras.text === "string" ? extras.text : this.text;
    const toolCalls = Array.isArray(extras.toolCalls) ? extras.toolCalls : [];
    let outputIndex = 0;

    this.startResponse();

    if ((finalText || toolCalls.length === 0) && !this.startedMessage) {
      this.ensureMessageItem();
    }

    if (finalText && this.text.length === 0) {
      this.writeTextDelta(finalText);
    }

    if (this.startedMessage) {
      this.writeEvent("response.output_text.done", {
        type: "response.output_text.done",
        response_id: this.id,
        item_id: this.messageId,
        output_index: outputIndex,
        content_index: 0,
        text: this.text
      });
      this.writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        response_id: this.id,
        output_index: outputIndex,
        item: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: this.text,
              annotations: []
            }
          ]
        }
      });
      outputIndex += 1;
    }

    for (const toolCall of toolCalls) {
      const item = {
        id: toolCall.id || generateId("call"),
        type: "tool_call",
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input || {}),
        status: "completed"
      };

      this.writeEvent("response.output_item.added", {
        type: "response.output_item.added",
        response_id: this.id,
        output_index: outputIndex,
        item
      });
      this.writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        response_id: this.id,
        output_index: outputIndex,
        item
      });
      outputIndex += 1;
    }

    const response = buildResponsesApiResponse(this.body, this.text, {
      id: this.id,
      created: this.created,
      messageId: this.messageId,
      status: "completed",
      ...extras
    });

    this.writeEvent("response.completed", {
      type: "response.completed",
      response
    });
    this.res.end();
    return response;
  }
}

module.exports = {
  ResponsesStreamWriter
};
