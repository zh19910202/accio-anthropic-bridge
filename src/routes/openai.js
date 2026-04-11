"use strict";

const { estimateTokens } = require("../anthropic");
const { buildDirectRequestFromOpenAi } = require("../direct-llm");
const { createBridgeError } = require("../errors");
const { openAiMessagesToResponsesInput, shouldFallbackToExternalProvider } = require("../external-fallback");
const { writeJson } = require("../http");
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
  sessionHeaders,
  shouldUseDirectTransport,
  usageCompletionTokens,
  usagePromptTokens
} = require("../bridge-core");
const { setTraceRequest, setTraceResponse, updateTrace } = require("../debug-traces");
const { generateId } = require("../id");
const {
  applyBridgeRequestIdToDirectRequest,
  cacheHeaders,
  errMsg,
  fallbackTransportName,
  logRequest: logRequestShared,
  requestedAccountId,
  resolveUsageTokens,
  startHeartbeat,
  writeSseError
} = require("./shared");
const { resolveSessionBinding } = require("../session-store");

function logRequest(req, message, meta = {}) {
  return logRequestShared(req, message, "openai", meta);
}

function fallbackCandidatesForOpenAi(fallbackPool, body) {
  if (!fallbackPool || typeof fallbackPool.getEligibleOpenAi !== "function") {
    return [];
  }

  return fallbackPool.getEligibleOpenAi(body);
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
  const request = applyBridgeRequestIdToDirectRequest(req, buildDirectRequestFromOpenAi(body));
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

  /* ── Heartbeat: keeps connection alive while upstream is thinking ── */
  const heartbeat = stream ? startHeartbeat(res, "openai") : null;

  let result;
  try {
    result = await directClient.run(request, {
      accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
      stickyAccountId: storedSession?.accountId ?? null,
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
  } catch (error) {
    if (stream && writeSseError(res, error, "openai")) {
      return;
    }

    throw error;
  } finally {
    if (heartbeat) {
      heartbeat.clear();
    }
  }

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

function normalizeResponsesTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const fn = tool && (tool.function || tool);

      if (!fn || !fn.name) {
        return null;
      }

      return {
        type: "function",
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || fn.input_schema || {}
      };
    })
    .filter(Boolean);
}

function buildResponsesBodyFromChat(body) {
  return {
    model: body.model,
    input: openAiMessagesToResponsesInput(Array.isArray(body.messages) ? body.messages : []),
    tools: normalizeResponsesTools(body.tools),
    temperature: body.temperature,
    max_output_tokens: body.max_tokens || body.max_completion_tokens,
    stop: body.stop,
    user: body.user,
    metadata: body.metadata,
    stream: body.stream === true
  };
}

async function runCodexChatCompletions(body, req, res, codexClient, sessionStore, cacheState = {}) {
  const binding = resolveSessionBinding(req.headers, body, "openai");
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const responsesBody = buildResponsesBodyFromChat(body);
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
  let result;
  try {
    result = await codexClient.run(responsesBody, {
      accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
      stickyAccountId: storedSession?.accountId ?? null,
      onDecision(event) {
        updateTrace(req, {
          bridge: {
            theme: "codex",
            transportSelected: "codex-responses",
            resolvedProviderModel: event.resolvedProviderModel || body.model || null,
            accountId: event.accountId || null,
            accountName: event.accountName || null,
            authSource: event.authSource || null
          }
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
  } catch (error) {
    if (stream && writeSseError(res, error, "openai")) {
      return;
    }

    throw error;
  }

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      protocol: "openai",
      requestedModel: body.model || null,
      normalizedModel: body.model || null,
      accountId: result.accountId || null,
      accountName: result.accountName || result.accountId || null,
      lastTransport: "codex-responses"
    });
  }

  const inputTokens = usagePromptTokens(result.usage) || estimateTokens(flattenOpenAiRequest(body));
  const outputTokens = usageCompletionTokens(result.usage) || estimateTokens(result.finalText);
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
    inputTokens,
    outputTokens,
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
  const directRequest = applyBridgeRequestIdToDirectRequest(req, buildDirectRequestFromOpenAi(body));

  const parsedMeta = {
    requestedModel: body.model || null,
    normalizedModel: directRequest.model,
    resolvedProviderModel: directRequest.model,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession?.accountId ?? null,
    accountName: storedSession?.accountName ?? null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens)
  };

  logRequest(req, "openai request parsed", parsedMeta);
  updateTrace(req, { bridge: parsedMeta });

  if (await shouldUseDirectTransport(client, directClient)) {
    const result = await directClient.run(directRequest, {
      accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
      stickyAccountId: storedSession?.accountId ?? null,
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

  throw createBridgeError(503, "direct-llm unavailable and local-ws transport has been disabled", "service_unavailable_error");
}


async function tryExternalFallbackOpenAi(body, req, res, fallbackPool, binding, directRequest, cacheState = {}, error = null, phase = null) {
  const candidates = fallbackCandidatesForOpenAi(fallbackPool, body);
  if (candidates.length === 0 || !shouldFallbackToExternalProvider(error)) {
    return false;
  }

  let lastError = null;
  for (const entry of candidates) {
    const fallbackClient = entry.client;
    try {
      const transport = fallbackTransportName(fallbackClient);

      logRequest(req, "openai fallback to external provider", {
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

      const created = Math.floor(Date.now() / 1000);
      const chunkId = generateId("chatcmpl");
      const result = await fallbackClient.completeOpenAi(body);
      const { promptTokens, completionTokens: outputTokens } = resolveUsageTokens(
        result.usage,
        estimateTokens(flattenOpenAiRequest(body)),
        result.text,
        estimateTokens
      );
      const baseHeaders = sessionHeaders({ sessionId: binding.sessionId || null });

      if (body.stream === true) {
        const writer = new OpenAiStreamWriter({
          body,
          res,
          created,
          id: chunkId,
          sessionId: binding.sessionId || null
        });
        writer.ensureAssistantRole();
        if (result.text) {
          writer.writeContent(result.text);
        }
        setTraceResponse(req, res, 200, null, { stream: true, fallbackTransport: transport });
        writer.finish("stop");
        return true;
      }

      const responseBody = buildChatCompletionResponse(body, result.text || "", {
        created,
        id: chunkId,
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
      logRequest(req, "openai fallback candidate failed", {
        transportSelected: fallbackTransportName(fallbackClient),
        fallbackModel: fallbackClient.model || null,
        fallbackProtocol: fallbackClient.protocol || null,
        phase,
        status: candidateError && candidateError.status ? candidateError.status : null,
        type: candidateError && candidateError.type ? candidateError.type : null,
        error: errMsg(candidateError)
      });
      lastError = candidateError;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return false;
}

async function handleChatCompletionsRequest(req, res, client, codexClient, fallbackPool, sessionStore, responseCache) {
  const body = applyOpenAiDefaults(
    await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser),
    client.config
  );
  validateOpenAiMessages(body.messages);

  const binding = resolveSessionBinding(req.headers, body, "openai");
  const cacheEligible = canCacheOpenAiRequest(body);
  const cacheKey = cacheEligible ? buildOpenAiCacheKey(req, body, binding, "openai-chat") : null;
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const responsesBody = buildResponsesBodyFromChat(body);

  const requestMeta = {
    requestedModel: body.model || null,
    normalizedModel: body.model || null,
    resolvedProviderModel: body.model || null,
    sessionId: binding.sessionId || null,
    conversationId: binding.conversationId || null,
    sessionBindingHit: Boolean(storedSession),
    accountId: storedSession?.accountId ?? null,
    accountName: storedSession?.accountName ?? null,
    defaultMaxTokensApplied: Boolean(body.metadata && body.metadata.accio_default_max_tokens),
    cacheEligible
  };

  setTraceRequest(req, "openai", body, { ...requestMeta, theme: "codex" });
  logRequest(req, "openai request parsed", requestMeta);

  if (cacheKey && responseCache) {
    const cached = responseCache.get(cacheKey);

    if (cached) {
      logRequest(req, "openai response cache hit", { cacheKey, endpoint: "chat.completions" });
      setTraceResponse(req, res, cached.statusCode, cached.body, { cacheState: "hit" });
      writeJson(res, cached.statusCode, cached.body, { ...cached.headers, ...cacheHeaders("hit") });
      return;
    }
  }

  if (codexClient && codexClient.isAvailable()) {
    try {
      await runCodexChatCompletions(body, req, res, codexClient, sessionStore, {
        cacheKey,
        responseCache
      });
      return;
    } catch (error) {
      logRequest(req, "openai direct failed without local-ws fallback", {
        transportSelected: "codex-responses",
        error: errMsg(error)
      });

      if (await tryExternalFallbackOpenAi(body, req, res, fallbackPool, binding, responsesBody, {
        cacheKey,
        responseCache
      }, error, "codex-responses")) {
        return;
      }

      throw error;
    }
  }

  if (await tryExternalFallbackOpenAi(body, req, res, fallbackPool, binding, responsesBody, {
    cacheKey,
    responseCache
  }, createBridgeError(503, "Codex Responses unavailable and no same-theme fallback succeeded", "service_unavailable_error"), "codex-unavailable")) {
    return;
  }

  throw createBridgeError(503, "Codex Responses unavailable and no same-theme fallback succeeded", "service_unavailable_error");
}

async function tryExternalFallbackResponses(body, chatBody, req, res, fallbackPool, binding, cacheState = {}, error = null, phase = null) {
  const candidates = fallbackCandidatesForOpenAi(fallbackPool, chatBody);
  if (candidates.length === 0 || !shouldFallbackToExternalProvider(error)) {
    return false;
  }

  let lastError = null;
  for (const entry of candidates) {
    const fallbackClient = entry.client;

    try {
      const transport = fallbackTransportName(fallbackClient);
      logRequest(req, "responses fallback to external provider", {
        transportSelected: transport,
        fallbackReason: error && error.message ? error.message : null,
        phase,
        fallbackModel: fallbackClient.model || null
      });
      updateTrace(req, {
        bridge: {
          theme: "codex",
          transportSelected: transport,
          fallbackModel: fallbackClient.model || null,
          fallbackProtocol: fallbackClient.protocol || null
        }
      });

      const result = await fallbackClient.completeOpenAi(chatBody);
      const { promptTokens, completionTokens: outputTokens } = resolveUsageTokens(
        result.usage,
        estimateTokens(flattenOpenAiRequest(chatBody)),
        result.text,
        estimateTokens
      );
      const baseHeaders = sessionHeaders({ sessionId: binding.sessionId || null });

      if (body.stream === true) {
        const writer = new ResponsesStreamWriter({
          body,
          res,
          conversationId: null,
          sessionId: binding.sessionId || null,
          messageId: null
        });
        setTraceResponse(req, res, 200, null, { stream: true, fallbackTransport: transport });
        writer.finish({
          text: result.text || "",
          conversationId: null,
          messageId: null,
          inputTokens: promptTokens,
          outputTokens,
          sessionId: binding.sessionId || null,
          toolCalls: result.toolCalls || [],
          toolResults: [],
          accountId: null,
          accountName: null
        });
        return true;
      }

      const responseBody = buildResponsesApiResponse(body, result.text || "", {
        inputTokens: promptTokens,
        outputTokens,
        sessionId: binding.sessionId || null,
        toolCalls: result.toolCalls || [],
        toolResults: []
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

async function handleResponsesRequest(req, res, client, codexClient, fallbackPool, sessionStore, responseCache) {
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
    cacheEligible,
    theme: "codex"
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

  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;

  let result;
  try {
    result = await codexClient.run(body, {
      accountId: requestedAccountId(req.headers) || null,
      stickyAccountId: storedSession?.accountId ?? null,
      onDecision(event) {
        updateTrace(req, {
          bridge: {
            theme: "codex",
            transportSelected: "codex-responses",
            resolvedProviderModel: event.resolvedProviderModel || body.model || null,
            accountId: event.accountId || null,
            accountName: event.accountName || null,
            authSource: event.authSource || null
          }
        });
      }
    });
  } catch (error) {
    if (await tryExternalFallbackResponses(body, chatBody, req, res, fallbackPool, binding, {
      cacheKey,
      responseCache
    }, error, "codex-responses")) {
      return;
    }

    throw error;
  }

  if (binding.sessionId) {
    sessionStore.merge(binding.sessionId, {
      protocol: "openai",
      requestedModel: body.model || null,
      normalizedModel: body.model || null,
      accountId: result.accountId || null,
      accountName: result.accountName || result.accountId || null,
      lastTransport: "codex-responses"
    });
  }

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
