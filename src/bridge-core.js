"use strict";

const { extractAccioToolCalls } = require("./anthropic");
const { resolveSessionBinding } = require("./session-store");

function conversationTitleFromPrompt(prompt) {
  const normalized = String(prompt || "").replace(/\s+/g, " ").trim();
  return (normalized || "Bridge Request").slice(0, 48);
}

function sessionHeaders(extras = {}) {
  const headers = {};

  if (extras.conversationId) {
    headers["x-accio-conversation-id"] = extras.conversationId;
  }

  if (extras.sessionId) {
    headers["x-accio-session-id"] = extras.sessionId;
  }

  return headers;
}

function usagePromptTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  return Number(usage.promptTokenCount || usage.prompt_token_count || usage.input_tokens || 0);
}

function usageCompletionTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  return Number(usage.candidatesTokenCount || usage.candidates_token_count || usage.output_tokens || 0);
}

async function executeBridgeQuery({ body, client, prompt, req, sessionStore, protocol, onEvent }) {
  const binding = resolveSessionBinding(req.headers, body, protocol);
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const conversationId = binding.conversationId || (storedSession && storedSession.conversationId);
  const result = await client.executeQuery({
    conversationId,
    model: body.model,
    onEvent,
    query: prompt,
    title: conversationTitleFromPrompt(prompt),
    workspacePath: client.config.workspacePath
  });

  if (binding.sessionId) {
    sessionStore.set(binding.sessionId, result.conversationId, {
      protocol,
      requestedModel: body.model || null,
      lastTransport: "local-ws",
      accountId: storedSession?.accountId ?? null,
      accountName: storedSession?.accountName ?? null
    });
  }

  return {
    ...result,
    sessionId: binding.sessionId,
    sessionBindingHit: Boolean(storedSession && storedSession.conversationId),
    storedSession,
    toolCalls:
      Array.isArray(result.toolCalls) && result.toolCalls.length > 0
        ? result.toolCalls
        : extractAccioToolCalls(result),
    toolResults: result.toolResults || []
  };
}

async function shouldUseDirectTransport(client, directClient) {
  if (client && client.config && client.config.transportMode === "local-ws") {
    return false;
  }

  return directClient.isAvailable();
}

module.exports = {
  conversationTitleFromPrompt,
  executeBridgeQuery,
  sessionHeaders,
  shouldUseDirectTransport,
  usageCompletionTokens,
  usagePromptTokens
};
