"use strict";

const crypto = require("node:crypto");

const log = require("../logger");
const {
  buildErrorResponse,
  buildMessageResponse,
  estimateTokens,
  flattenAnthropicRequest
} = require("../anthropic");
const {
  buildDirectRequestFromAnthropic,
  extractThinkingConfigFromAnthropic,
  supportsThinkingForModel
} = require("../direct-llm");
const { classifyErrorType, createBridgeError, resolveResultError, shouldFallbackToLocalTransport } = require("../errors");
const { CORS_HEADERS, writeJson, writeSse } = require("../http");
const { readJsonBody } = require("../middleware/body-parser");
const { AnthropicStreamWriter } = require("../stream/anthropic-sse");
const { validateAnthropicMessages } = require("../tooling");
const {
  executeBridgeQuery,
  sessionHeaders,
  shouldUseDirectTransport,
  usageCompletionTokens,
  usagePromptTokens
} = require("../bridge-core");
const { resolveSessionBinding } = require("../session-store");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function requestedAccountId(headers) {
  return headers["x-accio-account-id"] || headers["x-account-id"] || null;
}

function logRequest(req, message, meta = {}) {
  log.info(message, {
    requestId: req.bridgeContext && req.bridgeContext.requestId ? req.bridgeContext.requestId : null,
    protocol: "anthropic",
    ...meta
  });
}

async function runDirectAnthropic(body, req, res, directClient, sessionStore, storedSession) {
  const binding = resolveSessionBinding(req.headers, body, "anthropic");
  const request = buildDirectRequestFromAnthropic(body);
  const inputTokens = estimateTokens(flattenAnthropicRequest(body));
  const stream = body.stream === true;
  const streamId = generateId("msg");
  let writer = null;
  let wroteRawClaudeStream = false;
  let wroteSyntheticText = false;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new AnthropicStreamWriter({
        estimateTokens,
        inputTokens,
        body,
        res,
        id: options.id || streamId,
        conversationId: options.conversationId,
        sessionId: options.sessionId || binding.sessionId
      });
    }

    return writer;
  };

  const result = await directClient.run(request, {
    accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
    stickyAccountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    onDecision(event) {
      logRequest(req, "anthropic direct decision", {
        event: event.type,
        accountId: event.accountId || null,
        accountName: event.accountName || null,
        authSource: event.authSource || null,
        resolvedProviderModel: event.resolvedProviderModel || request.model,
        thinking: event.thinking || null,
        reason: event.reason || null,
        status: event.status || null
      });
    },
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "claude_raw") {
        if (!res.headersSent) {
          res.writeHead(200, {
            ...CORS_HEADERS,
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            ...sessionHeaders({ sessionId: binding.sessionId })
          });
        }

        wroteRawClaudeStream = true;
        writeSse(res, event.raw.type || "message", event.raw);
        return;
      }

      if (wroteRawClaudeStream) {
        return;
      }

      if (event.type === "text_delta" && event.text) {
        wroteSyntheticText = true;
        getWriter().writeTextDelta(event.text);
      }
    }
  });

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      protocol: "anthropic",
      requestedModel: body.model || null,
      normalizedModel: request.model,
      accountId: result.accountId || null,
      accountName: result.accountName || result.accountId || null,
      lastTransport: "direct-llm"
    });
  }

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens = usageCompletionTokens(result.usage) || estimateTokens(result.finalText);

  if (stream) {
    if (wroteRawClaudeStream) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const streamWriter = getWriter({ id: result.id || streamId });

    if (!wroteSyntheticText && result.finalText) {
      streamWriter.writeTextDelta(result.finalText);
    }

    if (toolCalls.length > 0) {
      streamWriter.writeToolCalls(toolCalls);
      streamWriter.finishToolUse(promptTokens, completionTokens);
      return;
    }

    streamWriter.finishEndTurn(result.finalText, promptTokens);
    return;
  }

  writeJson(
    res,
    200,
    buildMessageResponse(body, result.finalText, {
      id: result.id || streamId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      sessionId: binding.sessionId,
      stopReason: result.stopReason,
      toolCalls,
      toolResults: [],
      accountId: result.accountId,
      accountName: result.accountName
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
}

async function handleMessagesRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser);
  validateAnthropicMessages(body.messages);

  const binding = resolveSessionBinding(req.headers, body, "anthropic");
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const directRequest = buildDirectRequestFromAnthropic(body);
  const thinking = extractThinkingConfigFromAnthropic(body);

  logRequest(req, "anthropic request parsed", {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    thinkingRequested: Boolean(thinking),
    thinkingBudgetTokens: thinking && thinking.budget_tokens ? thinking.budget_tokens : null
  });

  if (thinking && !supportsThinkingForModel(directRequest.model)) {
    throw createBridgeError(400, `Model ${directRequest.model} does not support thinking`, "invalid_request_error");
  }

  const directAllowed = await shouldUseDirectTransport(client, directClient);
  logRequest(req, "anthropic transport selected", {
    transportSelected: directAllowed ? "direct-llm" : "local-ws",
    configuredTransport: client.config.transportMode,
    requestedModel: body.model || null,
    normalizedModel: directRequest.model
  });

  if (thinking && !directAllowed) {
    throw createBridgeError(501, "Thinking mode is only supported through direct-llm transport", "unsupported_error");
  }

  if (directAllowed) {
    try {
      await runDirectAnthropic(body, req, res, directClient, sessionStore, storedSession);
      return;
    } catch (error) {
      const shouldFallback = client.config.transportMode !== "direct-llm" && !thinking && shouldFallbackToLocalTransport(error);
      logRequest(req, shouldFallback ? "anthropic fallback to local-ws" : "anthropic direct failed without fallback", {
        transportSelected: shouldFallback ? "local-ws" : "direct-llm",
        fallbackReason: shouldFallback ? error.message : null,
        error: error && error.message ? error.message : String(error)
      });

      if (!shouldFallback) {
        throw error;
      }
    }
  }

  const prompt = flattenAnthropicRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  let streamStarted = false;
  const streamId = generateId("msg");
  let writer = null;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new AnthropicStreamWriter({
        estimateTokens,
        inputTokens,
        body,
        res,
        id: options.id || streamId,
        conversationId: options.conversationId,
        sessionId: options.sessionId
      });
    }

    return writer;
  };

  const result = await executeBridgeQuery({
    body,
    client,
    prompt,
    protocol: "anthropic",
    req,
    sessionStore,
    onEvent(event) {
      if (!stream || event.type !== "append") {
        return;
      }

      if (!streamStarted) {
        streamStarted = true;
      }

      if (event.delta) {
        getWriter({ id: streamId }).writeTextDelta(event.delta);
      }
    }
  });

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      requestedModel: body.model || null,
      normalizedModel: directRequest.model,
      lastTransport: "local-ws"
    });
  }

  const finalText = result.finalText || (result.channelResponse && result.channelResponse.content) || "";
  const { errorCode, errorMessage } = resolveResultError(result);

  if (stream) {
    if (errorCode) {
      if (!res.headersSent) {
        writeJson(
          res,
          Number(errorCode),
          buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
          sessionHeaders(result)
        );
      }
      return;
    }

    const streamWriter = getWriter({
      conversationId: result.conversationId,
      id: result.messageId || streamId,
      sessionId: result.sessionId
    });

    if (!streamStarted && finalText) {
      streamWriter.writeTextDelta(finalText);
    }

    streamWriter.finishEndTurn(finalText, inputTokens);
    return;
  }

  if (errorCode) {
    writeJson(
      res,
      Number(errorCode),
      buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
      sessionHeaders(result)
    );
    return;
  }

  writeJson(
    res,
    200,
    buildMessageResponse(body, finalText, {
      conversationId: result.conversationId,
      id: result.messageId || generateId("msg"),
      inputTokens,
      outputTokens: estimateTokens(finalText),
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
      accountName: storedSession && storedSession.accountName ? storedSession.accountName : null
    }),
    sessionHeaders(result)
  );
}

async function handleCountTokens(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser);
  const prompt = flattenAnthropicRequest(body);
  writeJson(res, 200, {
    input_tokens: estimateTokens(prompt)
  });
}

module.exports = {
  handleCountTokens,
  handleMessagesRequest
};
