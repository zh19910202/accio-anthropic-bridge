"use strict";

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
const {
  classifyErrorType,
  createBridgeError,
  resolveResultError,
  shouldFallbackToLocalTransport
} = require("../errors");
const { CORS_HEADERS, writeJson, writeSse } = require("../http");
const { readJsonBody } = require("../middleware/body-parser");
const { applyAnthropicDefaults, canCacheAnthropicRequest } = require("../request-defaults");
const { buildCacheKey } = require("../response-cache");
const { AnthropicStreamWriter } = require("../stream/anthropic-sse");
const { validateAnthropicMessages } = require("../tooling");
const {
  executeBridgeQuery,
  sessionHeaders,
  shouldUseDirectTransport,
  usageCompletionTokens,
  usagePromptTokens
} = require("../bridge-core");
const { setTraceRequest, setTraceResponse, updateTrace } = require("../debug-traces");
const { generateId } = require("../id");
const { resolveSessionBinding } = require("../session-store");

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

function cacheHeaders(state) {
  return {
    "x-accio-cache": state
  };
}

function buildAnthropicCacheKey(req, body, binding) {
  return buildCacheKey({
    protocol: "anthropic",
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    accountId: requestedAccountId(req.headers) || null,
    body
  });
}

async function runDirectAnthropic(body, req, res, directClient, sessionStore, storedSession, cacheState = {}) {
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
      updateTrace(req, {
        bridge: {
          transportSelected: "direct-llm",
          resolvedProviderModel: event.resolvedProviderModel || request.model,
          accountId: event.accountId || null,
          accountName: event.accountName || null,
          authSource: event.authSource || null
        }
      });

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
      setTraceResponse(req, res, 200, null, {
        stream: true,
        cacheState: cacheState.cacheKey ? "miss" : null
      });
      streamWriter.writeToolCalls(toolCalls);
      streamWriter.finishToolUse(promptTokens, completionTokens);
      return;
    }

    setTraceResponse(req, res, 200, null, {
      stream: true,
      cacheState: cacheState.cacheKey ? "miss" : null
    });
    streamWriter.finishEndTurn(result.finalText, promptTokens);
    return;
  }

  const responseBody = buildMessageResponse(body, result.finalText, {
    id: result.id || streamId,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    sessionId: binding.sessionId,
    stopReason: result.stopReason,
    toolCalls,
    toolResults: [],
    accountId: result.accountId,
    accountName: result.accountName
  });
  const baseHeaders = sessionHeaders({ sessionId: binding.sessionId });

  if (cacheState.cacheKey && cacheState.responseCache) {
    cacheState.responseCache.set(cacheState.cacheKey, {
      statusCode: 200,
      body: responseBody,
      headers: baseHeaders
    });
  }

  setTraceResponse(req, res, 200, responseBody, {
    cacheState: cacheState.cacheKey ? "miss" : null
  });
  writeJson(res, 200, responseBody, { ...baseHeaders, ...cacheHeaders("miss") });
}

async function handleMessagesRequest(req, res, client, directClient, sessionStore, responseCache) {
  const body = applyAnthropicDefaults(
    await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser),
    client.config
  );
  validateAnthropicMessages(body.messages);

  const binding = resolveSessionBinding(req.headers, body, "anthropic");
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const directRequest = buildDirectRequestFromAnthropic(body);
  const thinking = extractThinkingConfigFromAnthropic(body);
  const cacheEligible = canCacheAnthropicRequest(body);
  const cacheKey = cacheEligible ? buildAnthropicCacheKey(req, body, binding) : null;

  setTraceRequest(req, "anthropic", body, {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    thinkingRequested: Boolean(thinking),
    thinkingBudgetTokens: thinking && thinking.budget_tokens ? thinking.budget_tokens : null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

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
    thinkingBudgetTokens: thinking && thinking.budget_tokens ? thinking.budget_tokens : null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

  if (cacheKey && responseCache) {
    const cached = responseCache.get(cacheKey);

    if (cached) {
      logRequest(req, "anthropic response cache hit", { cacheKey });
      setTraceResponse(req, res, cached.statusCode, cached.body, { cacheState: "hit" });
      writeJson(res, cached.statusCode, cached.body, { ...cached.headers, ...cacheHeaders("hit") });
      return;
    }
  }

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
  updateTrace(req, {
    bridge: {
      transportSelected: directAllowed ? "direct-llm" : "local-ws"
    }
  });

  if (thinking && !directAllowed) {
    throw createBridgeError(501, "Thinking mode is only supported through direct-llm transport", "unsupported_error");
  }

  if (directAllowed) {
    try {
      await runDirectAnthropic(body, req, res, directClient, sessionStore, storedSession, {
        cacheKey,
        responseCache
      });
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
        const errorBody = buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode)));
        setTraceResponse(req, res, Number(errorCode), errorBody, { stream: true });
        writeJson(
          res,
          Number(errorCode),
          errorBody,
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

    setTraceResponse(req, res, 200, null, { stream: true });
    streamWriter.finishEndTurn(finalText, inputTokens);
    return;
  }

  if (errorCode) {
    const errorBody = buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode)));
    setTraceResponse(req, res, Number(errorCode), errorBody);
    writeJson(
      res,
      Number(errorCode),
      errorBody,
      sessionHeaders(result)
    );
    return;
  }

  const responseBody = buildMessageResponse(body, finalText, {
    conversationId: result.conversationId,
    id: result.messageId || generateId("msg"),
    inputTokens,
    outputTokens: estimateTokens(finalText),
    sessionId: result.sessionId,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null
  });
  const baseHeaders = sessionHeaders(result);

  if (cacheKey && responseCache) {
    responseCache.set(cacheKey, {
      statusCode: 200,
      body: responseBody,
      headers: baseHeaders
    });
  }

  setTraceResponse(req, res, 200, responseBody, {
    cacheState: cacheKey ? "miss" : null
  });
  writeJson(res, 200, responseBody, { ...baseHeaders, ...cacheHeaders("miss") });
}

async function handleCountTokens(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser);
  const prompt = flattenAnthropicRequest(body);
  const responseBody = {
    input_tokens: estimateTokens(prompt)
  };

  setTraceRequest(req, "anthropic", body, {
    endpoint: "count_tokens"
  });
  setTraceResponse(req, res, 200, responseBody);
  writeJson(res, 200, responseBody);
}

module.exports = {
  handleCountTokens,
  handleMessagesRequest
};
