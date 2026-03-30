"use strict";

const { CORS_HEADERS, writeSse } = require("../http");
const { generateId } = require("../id");

class AnthropicStreamWriter {
  constructor({ estimateTokens, inputTokens, body, res, conversationId, sessionId, id }) {
    this.estimateTokens = estimateTokens;
    this.inputTokens = inputTokens;
    this.body = body;
    this.res = res;
    this.conversationId = conversationId || "";
    this.sessionId = sessionId || "";
    this.id = id || generateId("msg");
    this.started = false;
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

    writeSse(this.res, "message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.body.model || "accio-bridge",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 0
        }
      }
    });

    writeSse(this.res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: ""
      }
    });

    this.started = true;
  }

  writeRaw(event, data) {
    this.start();
    writeSse(this.res, event, data);
  }

  writeTextDelta(text) {
    if (!text) {
      return;
    }

    this.start();
    writeSse(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text
      }
    });
  }

  writeToolCalls(toolCalls) {
    this.start();

    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];

      writeSse(this.res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: {}
        }
      });

      writeSse(this.res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(toolCall.input || {})
        }
      });

      writeSse(this.res, "content_block_stop", {
        type: "content_block_stop",
        index
      });
    }
  }

  finishToolUse(promptTokens, completionTokens) {
    writeSse(this.res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null
      },
      usage: {
        output_tokens: completionTokens
      }
    });

    writeSse(this.res, "message_stop", {
      type: "message_stop",
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens
      }
    });

    this.res.end();
  }

  finishEndTurn(outputText, inputTokens = this.inputTokens) {
    writeSse(this.res, "content_block_stop", {
      type: "content_block_stop",
      index: 0
    });

    writeSse(this.res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null
      },
      usage: {
        output_tokens: this.estimateTokens(outputText)
      }
    });

    writeSse(this.res, "message_stop", {
      type: "message_stop",
      usage: {
        input_tokens: inputTokens,
        output_tokens: this.estimateTokens(outputText)
      }
    });

    this.res.end();
  }

  end() {
    this.res.end();
  }
}

module.exports = {
  AnthropicStreamWriter
};
