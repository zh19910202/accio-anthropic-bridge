"use strict";

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
const { shouldFallbackToExternalProvider } = require("../external-fallback");
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
const { cacheHeaders, fallbackTransportName, logRequest: logRequestShared, requestedAccountId } = require("./shared");
const { resolveSessionBinding } = require("../session-store");

function logRequest(req, message, meta = {}) {
  return logRequestShared(req, message, "anthropic", meta);
}

function fallbackCandidatesForAnthropic(fallbackPool, body) {
  if (!fallbackPool || typeof fallbackPool.getEligibleAnthropic !== "function") {
    return [];
  }

  return fallbackPool.getEligibleAnthropic(body);
}

function selectAnthropicTransport({ body, client, directAllowed, fallbackPool, thinking }) {
  const fallbackCandidates = fallbackCandidatesForAnthropic(fallbackPool, body);
  const fallbackTransport = fallbackCandidates.length > 0
    ? fallbackTransportName(fallbackCandidates[0].client)
    : "external-openai";
  const externalEligible = fallbackCandidates.length > 0;

  if (directAllowed) {
    return {
      transportSelected: "direct-llm",
      directAllowed: true,
      useExternalFallback: false,
      unsupportedThinking: false
    };
  }

  if (thinking) {
    if (externalEligible) {
      return {
        transportSelected: fallbackTransport,
        directAllowed: false,
        useExternalFallback: true,
        unsupportedThinking: false
      };
    }

    return {
      transportSelected: "unsupported",
      directAllowed: false,
      useExternalFallback: false,
      unsupportedThinking: true
    };
  }

  return {
    transportSelected: "local-ws",
    directAllowed: false,
    useExternalFallback: false,
    unsupportedThinking: false
  };
}

function extractAnthropicPayloadText(payload) {
  const content = Array.isArray(payload && payload.content) ? payload.content : [];
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text") {
        return block.text || "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function relayExternalAnthropicPassThrough(body, req, res, fallbackClient, binding, cacheState = {}, error = null, phase = null) {
  const transport = fallbackTransportName(fallbackClient);

  logRequest(req, "anthropic fallback to external provider", {
    transportSelected: transport,
    fallbackReason: error && error.message ? error.message : null,
    phase,
    fallbackModel: fallbackClient.model || null
  });
  updateTrace(req, {
    bridge: {
      transportSelected: transport,
      fallbackModel: fallbackClient.model || null,
      fallbackProtocol: fallbackClient.protocol || null
    }
  });

  const upstream = await fallbackClient.requestAnthropicMessage(body);
  const status = Number(upstream.status || 200);
  const contentType = String(upstream.headers.get("content-type") || "application/json; charset=utf-8");
  const baseHeaders = sessionHeaders({ sessionId: binding.sessionId || null });

  if (body.stream === true && upstream.ok && /text\/event-stream/i.test(contentType)) {
    logRequest(req, "anthropic external fallback streaming passthrough", {
      transportSelected: transport,
      upstreamContentType: contentType,
      phase
    });

    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.writeHead(status, {
        ...CORS_HEADERS,
        ...baseHeaders,
        "content-type": contentType,
        "cache-control": upstream.headers.get("cache-control") || "no-cache",
        connection: upstream.headers.get("connection") || "keep-alive"
      });
    }

    setTraceResponse(req, res, status, null, {
      stream: true,
      fallbackTransport: transport
    });

    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (res.writableEnded || res.destroyed) {
          break;
        }
        res.write(chunk);
      }
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    return true;
  }

  const rawText = await upstream.text();
  let payload = null;

  if (/application\/json/i.test(contentType)) {
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = null;
    }
  }

  if (body.stream === true && upstream.ok && payload && typeof payload === "object") {
    const text = extractAnthropicPayloadText(payload);

    logRequest(req, "anthropic external fallback synthesized sse", {
      transportSelected: transport,
      upstreamContentType: contentType,
      phase,
      upstreamMessageId: payload && payload.id ? payload.id : null,
      synthesizedTextLength: text.length,
      synthesizedTextPreview: text ? text.slice(0, 120) : null
    });

    const writer = new AnthropicStreamWriter({
      estimateTokens,
      inputTokens: Number(payload && payload.usage && payload.usage.input_tokens) || estimateTokens(flattenAnthropicRequest(body)),
      body,
      res,
      id: payload && payload.id ? payload.id : generateId("msg"),
      sessionId: binding.sessionId || null
    });

    setTraceResponse(req, res, status, null, {
      stream: true,
      fallbackTransport: transport
    });

    if (text) {
      writer.writeTextDelta(text);
    } else {
      writer.start();
    }

    writer.finishEndTurn(text, Number(payload && payload.usage && payload.usage.input_tokens) || estimateTokens(flattenAnthropicRequest(body)));
    return true;
  }

  if (upstream.ok && cacheState.cacheKey && cacheState.responseCache && payload && typeof payload === "object") {
    cacheState.responseCache.set(cacheState.cacheKey, {
      statusCode: status,
      body: payload,
      headers: baseHeaders
    });
  }

  setTraceResponse(req, res, status, payload, {
    cacheState: upstream.ok && cacheState.cacheKey ? "miss" : null,
    fallbackTransport: transport
  });

  if (payload && typeof payload === "object") {
    writeJson(res, status, payload, {
      ...baseHeaders,
      ...(upstream.ok ? cacheHeaders("miss") : {})
    });
    return true;
  }

  if (!res.headersSent && !res.writableEnded && !res.destroyed) {
    res.writeHead(status, {
      ...CORS_HEADERS,
      ...baseHeaders,
      "content-type": contentType
    });
  }

  if (!res.writableEnded && !res.destroyed) {
    res.end(rawText);
  }
  return true;
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


async function tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, cacheState = {}, error = null, phase = null) {
  const candidates = fallbackCandidatesForAnthropic(fallbackPool, body);
  if (candidates.length === 0 || !shouldFallbackToExternalProvider(error)) {
    return false;
  }

  let lastError = null;
  for (const entry of candidates) {
    const fallbackClient = entry.client;
    try {
      if (fallbackClient.protocol === "anthropic") {
        return await relayExternalAnthropicPassThrough(body, req, res, fallbackClient, binding, cacheState, error, phase);
      }

      const transport = fallbackTransportName(fallbackClient);

      logRequest(req, "anthropic fallback to external provider", {
        transportSelected: transport,
        fallbackReason: error && error.message ? error.message : null,
        phase,
        fallbackModel: fallbackClient.model || null
      });
      updateTrace(req, {
        bridge: {
          transportSelected: transport,
          fallbackModel: fallbackClient.model || null,
          fallbackProtocol: fallbackClient.protocol || null
        }
      });

      const result = await fallbackClient.completeAnthropic(body);
      const inputTokens = estimateTokens(flattenAnthropicRequest(body));
      const outputTokens = result.usage && Number(result.usage.completion_tokens || result.usage.output_tokens || 0)
        ? Number(result.usage.completion_tokens || result.usage.output_tokens || 0)
        : estimateTokens(result.text);
      const promptTokens = result.usage && Number(result.usage.prompt_tokens || result.usage.input_tokens || 0)
        ? Number(result.usage.prompt_tokens || result.usage.input_tokens || 0)
        : inputTokens;
      const baseHeaders = sessionHeaders({ sessionId: binding.sessionId || null });

      if (binding.sessionId) {
        req.bridgeContext = req.bridgeContext || {};
      }

      if (body.stream === true) {
        const writer = new AnthropicStreamWriter({
          estimateTokens,
          inputTokens: promptTokens,
          body,
          res,
          id: generateId("msg"),
          sessionId: binding.sessionId || null
        });

        if (result.text) {
          writer.writeTextDelta(result.text);
        }

        setTraceResponse(req, res, 200, null, { stream: true, fallbackTransport: transport });
        writer.finishEndTurn(result.text || "", promptTokens);
        return true;
      }

      const responseBody = buildMessageResponse(body, result.text || "", {
        id: generateId("msg"),
        inputTokens: promptTokens,
        outputTokens,
        sessionId: binding.sessionId || null
      });

      if (cacheState.cacheKey && cacheState.responseCache) {
        cacheState.responseCache.set(cacheState.cacheKey, {
          statusCode: 200,
          body: responseBody,
          headers: baseHeaders
        });
      }

      setTraceResponse(req, res, 200, responseBody, {
        cacheState: cacheState.cacheKey ? "miss" : null,
        fallbackTransport: transport
      });
      writeJson(res, 200, responseBody, { ...baseHeaders, ...cacheHeaders("miss") });
      return true;
    } catch (candidateError) {
      lastError = candidateError;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return false;
}

async function handleMessagesRequest(req, res, client, directClient, fallbackPool, sessionStore, responseCache) {
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
  const transportDecision = selectAnthropicTransport({
    body,
    client,
    directAllowed,
    fallbackPool,
    thinking
  });
  logRequest(req, "anthropic transport selected", {
    transportSelected: transportDecision.transportSelected,
    configuredTransport: client.config.transportMode,
    requestedModel: body.model || null,
    normalizedModel: directRequest.model
  });
  updateTrace(req, {
    bridge: {
      transportSelected: transportDecision.transportSelected
    }
  });

  if (transportDecision.useExternalFallback) {
    await tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, {
      cacheKey,
      responseCache
    }, createBridgeError(429, "direct-llm unavailable for thinking; using external fallback", "rate_limit_error"), "direct-unavailable");
    return;
  }

  if (transportDecision.unsupportedThinking) {
    throw createBridgeError(501, "Thinking mode is only supported through direct-llm transport", "unsupported_error");
  }

  if (transportDecision.directAllowed) {
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
        if (await tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, {
          cacheKey,
          responseCache
        }, error, "direct-llm")) {
          return;
        }
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

  let result;
  try {
    result = await executeBridgeQuery({
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
  } catch (error) {
    if (await tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, {
      cacheKey,
      responseCache
    }, error, "local-ws")) {
      return;
    }
    throw error;
  }

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
      const logicalError = createBridgeError(Number(errorCode), errorMessage, classifyErrorType(Number(errorCode)));
      if (await tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, {
        cacheKey,
        responseCache
      }, logicalError, "local-ws-logical")) {
        return;
      }
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
    const logicalError = createBridgeError(Number(errorCode), errorMessage, classifyErrorType(Number(errorCode)));
    if (await tryExternalFallbackAnthropic(body, req, res, fallbackPool, binding, directRequest, {
      cacheKey,
      responseCache
    }, logicalError, "local-ws-logical")) {
      return;
    }
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
  handleMessagesRequest,
  selectAnthropicTransport
};
