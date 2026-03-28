"use strict";

const crypto = require("node:crypto");

const { buildErrorResponse, estimateTokens } = require("../anthropic");
const { buildDirectRequestFromOpenAi } = require("../direct-llm");
const { classifyErrorType, createBridgeError, resolveResultError, shouldFallbackToLocalTransport } = require("../errors");
const { writeJson } = require("../http");
const log = require("../logger");
const { readJsonBody } = require("../middleware/body-parser");
const {
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  buildResponsesApiResponse,
  convertResponsesInputToOpenAiMessages,
  flattenOpenAiRequest
} = require("../openai");
const { OpenAiStreamWriter } = require("../stream/openai-sse");
const { validateOpenAiMessages } = require("../tooling");
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
    protocol: "openai",
    ...meta
  });
}

async function runDirectOpenAi(body, req, res, directClient, sessionStore, storedSession) {
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

    streamWriter.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
    return;
  }

  writeJson(
    res,
    200,
    buildChatCompletionResponse(body, result.finalText, {
      created,
      id: result.id || chunkId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      sessionId: binding.sessionId,
      toolCalls,
      toolResults: [],
      accountId: result.accountId,
      accountName: result.accountName
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
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
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null
  });

  if (await shouldUseDirectTransport(client, directClient)) {
    const result = await directClient.run(directRequest, {
      accountId: requestedAccountId(req.headers) || (storedSession && storedSession.accountId) || null,
      stickyAccountId: storedSession && storedSession.accountId ? storedSession.accountId : null,
      onDecision(event) {
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

async function handleChatCompletionsRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser);
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
    accountName: storedSession && storedSession.accountName ? storedSession.accountName : null
  });

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectOpenAi(body, req, res, directClient, sessionStore, storedSession);
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
        writeJson(
          res,
          Number(errorCode),
          buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
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

    writer.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
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
    buildChatCompletionResponse(body, finalText, {
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
    }),
    sessionHeaders(result)
  );
}

async function handleResponsesRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser);

  if (body.stream === true) {
    throw createBridgeError(501, "/v1/responses streaming is not implemented yet", "unsupported_error");
  }

  const chatBody = {
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
  };

  const result = await executeOpenAiNonStreaming(chatBody, req, client, directClient, sessionStore);

  writeJson(
    res,
    200,
    buildResponsesApiResponse(body, result.finalText, {
      conversationId: result.conversationId,
      messageId: result.messageId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      accountId: result.accountId,
      accountName: result.accountName
    }),
    sessionHeaders(result)
  );
}

async function handleModelsRequest(req, res, modelsRegistry) {
  const models = await modelsRegistry.listModels();
  writeJson(res, 200, buildOpenAiModelsResponse(models));
}

module.exports = {
  handleChatCompletionsRequest,
  handleModelsRequest,
  handleResponsesRequest
};
