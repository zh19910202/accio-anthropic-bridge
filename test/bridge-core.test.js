"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  conversationTitleFromPrompt,
  sessionHeaders,
  shouldUseDirectTransport,
  usagePromptTokens,
  usageCompletionTokens
} = require("../src/bridge-core");

describe("conversationTitleFromPrompt", () => {
  it("trims whitespace and truncates to 48 chars", () => {
    const result = conversationTitleFromPrompt("  hello   world  ");
    assert.equal(result, "hello world");
  });

  it("returns fallback for empty input", () => {
    assert.equal(conversationTitleFromPrompt(""), "Bridge Request");
    assert.equal(conversationTitleFromPrompt(null), "Bridge Request");
    assert.equal(conversationTitleFromPrompt(undefined), "Bridge Request");
  });

  it("truncates long prompts to 48 chars", () => {
    const long = "a".repeat(100);
    assert.equal(conversationTitleFromPrompt(long).length, 48);
  });
});

describe("sessionHeaders", () => {
  it("returns empty object for no extras", () => {
    assert.deepStrictEqual(sessionHeaders(), {});
    assert.deepStrictEqual(sessionHeaders({}), {});
  });

  it("includes conversation and session ids when provided", () => {
    const headers = sessionHeaders({ conversationId: "conv-1", sessionId: "sess-1" });
    assert.equal(headers["x-accio-conversation-id"], "conv-1");
    assert.equal(headers["x-accio-session-id"], "sess-1");
  });

  it("omits headers when ids are falsy", () => {
    const headers = sessionHeaders({ conversationId: null, sessionId: "" });
    assert.deepStrictEqual(headers, {});
  });
});

describe("usagePromptTokens", () => {
  it("extracts promptTokenCount", () => {
    assert.equal(usagePromptTokens({ promptTokenCount: 42 }), 42);
  });

  it("extracts prompt_token_count", () => {
    assert.equal(usagePromptTokens({ prompt_token_count: 100 }), 100);
  });

  it("extracts input_tokens", () => {
    assert.equal(usagePromptTokens({ input_tokens: 55 }), 55);
  });

  it("returns 0 for null/undefined", () => {
    assert.equal(usagePromptTokens(null), 0);
    assert.equal(usagePromptTokens(undefined), 0);
  });

  it("returns 0 when no matching key", () => {
    assert.equal(usagePromptTokens({ other: 10 }), 0);
  });
});

describe("usageCompletionTokens", () => {
  it("extracts candidatesTokenCount", () => {
    assert.equal(usageCompletionTokens({ candidatesTokenCount: 30 }), 30);
  });

  it("extracts candidates_token_count", () => {
    assert.equal(usageCompletionTokens({ candidates_token_count: 80 }), 80);
  });

  it("extracts output_tokens", () => {
    assert.equal(usageCompletionTokens({ output_tokens: 20 }), 20);
  });

  it("returns 0 for null/undefined", () => {
    assert.equal(usageCompletionTokens(null), 0);
    assert.equal(usageCompletionTokens(undefined), 0);
  });
});

describe("shouldUseDirectTransport", () => {
  it("returns false when transport mode is local-ws", async () => {
    const client = { config: { transportMode: "local-ws" } };
    const directClient = { isAvailable: () => true };
    assert.equal(await shouldUseDirectTransport(client, directClient), false);
  });

  it("returns directClient.isAvailable() when transport is not local-ws", async () => {
    const client = { config: { transportMode: "direct" } };
    assert.equal(await shouldUseDirectTransport(client, { isAvailable: () => true }), true);
    assert.equal(await shouldUseDirectTransport(client, { isAvailable: () => false }), false);
  });
});
