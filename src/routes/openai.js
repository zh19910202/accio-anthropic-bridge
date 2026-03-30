"use strict";

const { buildErrorResponse, estimateTokens } = require("../anthropic");
const { buildDirectRequestFromOpenAi } = require("../direct-llm");
const {
  classifyErrorType,
  createBridgeError,
  resolveResultError,
  shouldFallbackToLocalTransport
} = require("../errors");
const { writeJson } = require("../http");
const log = require("../logger");
const { readJsonBody } = require("../middleware/body-parser");
const {
  applyOpenAiDefaults,
  applyResponsesDefaults,
  canCacheOpenAiRequest,
  canCacheResponsesRequest
} = require("../request-defaults");
const {
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  buildResponsesApiResponse,
  convertResponsesInputToOpenAiMessages,
  flattenOpenAiRequest
} = require("../openai");
const { buildCacheKey } = require("../response-cache");
const { OpenAiStreamWriter } = require("../stream/openai-sse");
const { ResponsesStreamWriter } = require("../stream/responses-sse");
const { validateOpenAiMessages } = require("../tooling");
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
    protocol: "openai",
    ...meta
  });
}

function cacheHeaders(state) {
  return {
    "x-accio-cache": state
  };
}

function buildOpenAiCacheKey(req, body, binding, protocol = "openai") {
  return buildCacheKey({
    protocol,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    accountId: requestedAccountId(req.headers) || null,
    body
  });
}

async function runDirectOpenAi(body, req, res, directClient, sessionStore, storedSession, cacheState = {}) {
  const binding = resolveSessionBinding(req.headers, body, "openai");
  const request = buildDirectRequestFromOpenAi(body);
  const inputTokens = estimateTokens(flattenOpenAiRequest(body));
  const stream = body.stream === true;
  const chunkId = generateId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const emittedToolCallIds = new Set();
  let wroteContent = false;
  const writer = new OpenAiStreamWriter({
    body,
    res,
    created,
    id: chunkId,
    sessionId: binding.sessionId
  });

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

      logRequest(req, "openai direct decision", {
        event: event.type,
        accountId: event.accountId || null,
        accountName: event.accountName || null,
        authSource: event.authSource || null,
        resolvedProviderModel: event.resolvedProviderModel || request.model,
        reason: event.reason || null,
        status: event.status || null
      });
    },
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "text_delta" && event.text) {
        wroteContent = true;
        writer.writeContent(event.text);
      }

      if (event.type === "tool_call" && event.toolCall && !emittedToolCallIds.has(event.toolCall.id)) {
        emittedToolCallIds.add(event.toolCall.id);
        writer.writeToolCall(event.toolCall);
      }
    }
  });

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      protocol: "openai",
      requestedModel: body.model || null,
      normalizedModel: request.model,
      accountId: result.accountId || null,
      accountName: result.accountName || result.accountId || null,
      lastTransport: "direct-llm"
    });
  }

  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens = usageCompletionTokens(result.usage) || estimateTokens(result.finalText);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

  if (stream) {
    writer.ensureAssistantRole();

    if (!wroteContent && result.finalText) {
      writer.writeContent(result.finalText);
    }

    for (const toolCall of toolCalls) {
      if (emittedToolCallIds.has(toolCall.id)) {
        continue;
      }

      writer.writeToolCall(toolCall);
    }

    setTraceResponse(req, res, 200, null, {
      stream: true,
      cacheState: cacheState.cacheKey ? "miss" : null
    });
    writer.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
    return;
  }

  const responseBody = buildChatCompletionResponse(body, result.finalText, {
    created,
    id: result.id || chunkId,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    sessionId: binding.sessionId,
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

async function executeOpenAiNonStreaming(body, req, client, directClient, sessionStore) {
  validateOpenAiMessages(body.messages);

  const binding = resolveSessionBinding(req.headers, body, "openai");
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const directRequest = buildDirectRequestFromOpenAi(body);

  logRequest(req, "openai request parsed", {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens)
  });
  updateTrace(req, {
    bridge: {
      requestedModel: body.model || null,
      normalizedModel: directRequest.model,
      resolvedProviderModel: directRequest.model,
      sessionId: binding.sessionId || null,
      conversationId: binding.conversationId || null,
      sessionBindingHit: Boolean(storedSession),
      accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
      accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
      defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens)
    }
  });

  if (await shouldUseDirectTransport(client, directClient)) {
    const result = await directClient.run(directRequest, {
      accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
      stickyAccountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
      onDecision(event) {
        updateTrace(req, {
          bridge: {
            transportSelected: "direct-llm",
            resolvedProviderModel: event.resolvedProviderModel || directRequest.model,
            accountId: event.accountId || null,
            accountName: event.accountName || null,
            authSource: event.authSource || null
          }
        });

        logRequest(req, "openai direct decision", {
          event: event.type,
          accountId: event.accountId || null,
          accountName: event.accountName || null,
          authSource: event.authSource || null,
          resolvedProviderModel: event.resolvedProviderModel || directRequest.model,
          reason: event.reason || null,
          status: event.status || null
        });
      }
    });

    if (binding.sessionId) {
      sessionStore.merge(binding.sessionId, {
        protocol: "openai",
        requestedModel: body.model || null,
        normalizedModel: directRequest.model,
        accountId: result.accountId || null,
        accountName: result.accountName || result.accountId || null,
        lastTransport: "direct-llm"
      });
    }

    return {
      finalText: result.finalText,
      inputTokens: usagePromptTokens(result.usage) || estimateTokens(flattenOpenAiRequest(body)),
      outputTokens: usageCompletionTokens(result.usage) || estimateTokens(result.finalText),
      toolCalls: result.toolCalls || [],
      toolResults: [],
      sessionId: binding.sessionId,
      accountId: result.accountId || null,
      accountName: result.accountName || null,
      conversationId: null,
      messageId: result.id || null
    };
  }

  updateTrace(req, {
    bridge: {
      transportSelected: "local-ws"
    }
  });

  const prompt = flattenOpenAiRequest(body);
  const inputTokens = estimateTokens(prompt);
  const result = await executeBridgeQuery({
    body,
    client,
    prompt,
    protocol: "openai",
    req,
    sessionStore,
    onEvent() {}
  });
  const finalText = result.finalText || (result.channelResponse && result.channelResponse.content) || "";
  const { errorCode, errorMessage } = resolveResultError(result);

  if (errorCode) {
    throw createBridgeError(Number(errorCode), errorMessage, classifyErrorType(Number(errorCode)));
  }

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      requestedModel: body.model || null,
      normalizedModel: directRequest.model,
      lastTransport: "local-ws"
    });
  }

  return {
    finalText,
    inputTokens,
    outputTokens: estimateTokens(finalText),
    toolCalls: result.toolCalls || [],
    toolResults: result.toolResults || [],
    sessionId: result.sessionId,
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    conversationId: result.conversationId,
    messageId: result.messageId || null
  };
}

async function handleChatCompletionsRequest(req, res, client, directClient, sessionStore, responseCache) {
  const body = applyOpenAiDefaults(
    await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser),
    client.config
  );
  validateOpenAiMessages(body.messages);

  const binding = resolveSessionBinding(req.headers, body, "openai");
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const directRequest = buildDirectRequestFromOpenAi(body);
  const cacheEligible = canCacheOpenAiRequest(body);
  const cacheKey = cacheEligible ? buildOpenAiCacheKey(req, body, binding, "openai-chat") : null;

  setTraceRequest(req, "openai", body, {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

  logRequest(req, "openai request parsed", {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

  if (cacheKey && responseCache) {
    const cached = responseCache.get(cacheKey);

    if (cached) {
      logRequest(req, "openai response cache hit", { cacheKey, endpoint: "chat.completions" });
      setTraceResponse(req, res, cached.statusCode, cached.body, { cacheState: "hit" });
      writeJson(res, cached.statusCode, cached.body, { ...cached.headers, ...cacheHeaders("hit") });
      return;
    }
  }

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectOpenAi(body, req, res, directClient, sessionStore, storedSession, {
        cacheKey,
        responseCache
      });
      return;
    } catch (error) {
      const shouldFallback = client.config.transportMode !== "direct-llm" && shouldFallbackToLocalTransport(error);
      logRequest(req, shouldFallback ? "openai fallback to local-ws" : "openai direct failed without fallback", {
        transportSelected: shouldFallback ? "local-ws" : "direct-llm",
        fallbackReason: shouldFallback ? error.message : null,
        error: error && error.message ? error.message : String(error)
      });

      if (!shouldFallback) {
        throw error;
      }
    }
  }

  const prompt = flattenOpenAiRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  const chunkId = generateId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let wroteContent = false;
  let writer = null;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new OpenAiStreamWriter({
        body,
        res,
        created,
        id: chunkId,
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
    protocol: "openai",
    req,
    sessionStore,
    onEvent(event) {
      if (!stream || event.type !== "append") {
        return;
      }

      if (event.delta) {
        wroteContent = true;
        getWriter().writeContent(event.delta);
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
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

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

    const streamWriter = getWriter(result);
    streamWriter.ensureAssistantRole();

    if (!wroteContent && finalText) {
      streamWriter.writeContent(finalText);
    }

    setTraceResponse(req, res, 200, null, { stream: true });
    streamWriter.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
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

  const responseBody = buildChatCompletionResponse(body, finalText, {
    conversationId: result.conversationId,
    created,
    id: chunkId,
    inputTokens,
    outputTokens: estimateTokens(finalText),
    sessionId: result.sessionId,
    toolCalls,
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

async function handleResponsesRequest(req, res, client, directClient, sessionStore, responseCache) {
  const body = applyResponsesDefaults(
    await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser),
    client.config
  );

  const stream = body.stream === true;

  const chatBody = applyOpenAiDefaults(
    {
      model: body.model,
      messages: convertResponsesInputToOpenAiMessages(body),
      tools: Array.isArray(body.tools) ? body.tools : [],
      temperature: body.temperature,
      max_tokens: body.max_output_tokens || body.max_tokens,
      stop: body.stop,
      user: body.user,
      metadata: body.metadata,
      session_id: body.session_id,
      conversation_id: body.conversation_id
    },
    client.config
  );
  const binding = resolveSessionBinding(req.headers, chatBody, "openai");
  const cacheEligible = canCacheResponsesRequest(body);
  const cacheKey = cacheEligible ? buildOpenAiCacheKey(req, body, binding, "openai-responses") : null;

  setTraceRequest(req, "openai-responses", body, {
    requestedModel: body.model || null,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

  logRequest(req, "responses request parsed", {
    requestedModel: body.model || null,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  });

  if (cacheKey && responseCache) {
    const cached = responseCache.get(cacheKey);

    if (cached) {
      logRequest(req, "openai response cache hit", { cacheKey, endpoint: "responses" });
      setTraceResponse(req, res, cached.statusCode, cached.body, { cacheState: "hit" });
      writeJson(res, cached.statusCode, cached.body, { ...cached.headers, ...cacheHeaders("hit") });
      return;
    }
  }

  const result = await executeOpenAiNonStreaming(chatBody, req, client, directClient, sessionStore);

  if (stream) {
    const writer = new ResponsesStreamWriter({
      body,
      res,
      conversationId: result.conversationId,
      sessionId: result.sessionId,
      messageId: result.messageId
    });

    setTraceResponse(req, res, 200, null, { stream: true });
    writer.finish({
      text: result.finalText,
      conversationId: result.conversationId,
      messageId: result.messageId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      accountId: result.accountId,
      accountName: result.accountName
    });
    return;
  }

  const responseBody = buildResponsesApiResponse(body, result.finalText, {
    conversationId: result.conversationId,
    messageId: result.messageId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    sessionId: result.sessionId,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    accountId: result.accountId,
    accountName: result.accountName
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

async function handleModelsRequest(req, res, modelsRegistry) {
  const models = await modelsRegistry.listModels();
  const responseBody = buildOpenAiModelsResponse(models);

  setTraceRequest(req, "openai", null, {
    endpoint: "models"
  });
  setTraceResponse(req, res, 200, responseBody);
  writeJson(res, 200, responseBody);
}

module.exports = {
  handleChatCompletionsRequest,
  handleModelsRequest,
  handleResponsesRequest
};
