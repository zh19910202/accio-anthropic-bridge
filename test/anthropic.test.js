"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionStore } = require("../src/session-store");
const {
  buildMessageResponse,
  estimateTokens,
  flattenAnthropicRequest,
  normalizeContent,
  normalizeSystemPrompt
} = require("../src/anthropic");
const { handleMessagesRequest, selectAnthropicTransport } = require("../src/routes/anthropic");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-anthropic-route-test-"));
}

function createMockReq(body, headers = {}) {
  const req = new Readable({ read() {} });
  req.headers = { "content-type": "application/json", ...headers };
  req.bridgeContext = { requestId: "test-anthropic-req-1", bodyParser: { maxBytes: 1024 * 1024 } };
  process.nextTick(() => {
    req.push(JSON.stringify(body));
    req.push(null);
  });
  return req;
}

function createMockRes() {
  return {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    _statusCode: null,
    _headers: {},
    _chunks: [],
    writeHead(statusCode, headers) {
      this._statusCode = statusCode;
      this._headers = { ...this._headers, ...headers };
      this.headersSent = true;
    },
    write(chunk) {
      this._chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    },
    end(data) {
      if (data) {
        this._chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
      }
      this.writableEnded = true;
    }
  };
}

function createMockClient(overrides = {}) {
  return {
    config: { defaultMaxOutputTokens: 0, transportMode: "auto", ...overrides.config },
    hasReadyAccounts: overrides.hasReadyAccounts || (() => true)
  };
}

function createMockSessionStore() {
  const dir = makeTempDir();
  return new SessionStore(path.join(dir, "sessions.json"));
}

const BASIC_ANTHROPIC_BODY = {
  model: "claude-opus-4-6",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  stream: false
};

test("normalizeSystemPrompt handles string and text blocks", () => {
  assert.equal(normalizeSystemPrompt("system text"), "system text");
  assert.equal(
    normalizeSystemPrompt([
      { type: "text", text: "alpha" },
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } }
    ]),
    "alpha\n[Unsupported system block: image]"
  );
});

test("normalizeContent handles tool use and tool result blocks", () => {
  const normalized = normalizeContent([
    { type: "text", text: "hello" },
    { type: "tool_use", id: "tool_1", name: "lookup", input: { q: "weather" } },
    { type: "tool_result", tool_use_id: "tool_1", content: "sunny" }
  ]);

  assert.match(normalized, /hello/);
  assert.match(normalized, /Assistant requested tool lookup id=tool_1/);
  assert.match(normalized, /Tool result for tool_1/);
});

test("flattenAnthropicRequest includes system, tools and conversation", () => {
  const flattened = flattenAnthropicRequest({
    system: [{ type: "text", text: "be concise" }],
    tools: [
      {
        name: "shell_echo",
        description: "Echo text",
        input_schema: { type: "object", properties: { text: { type: "string" } } }
      }
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }] }]
  });

  assert.match(flattened, /^System:/);
  assert.match(flattened, /Available tools:/);
  assert.match(flattened, /Conversation:/);
  assert.match(flattened, /USER:/);
});

test("estimateTokens gives higher weight to CJK than ASCII", () => {
  assert.ok(estimateTokens("你好世界") > estimateTokens("abcd"));
});

test("buildMessageResponse emits tool_use blocks and stop reason", () => {
  const response = buildMessageResponse(
    { model: "accio-bridge" },
    "",
    {
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: [{ id: "call_1", name: "shell_echo", input: { text: "hi" } }],
      toolResults: [{ tool_use_id: "call_1", content: "hi" }]
    }
  );

  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.content[0].type, "tool_use");
  assert.deepEqual(response.accio.tool_results, [{ tool_use_id: "call_1", content: "hi" }]);
});

test("selectAnthropicTransport prefers external fallback over local-ws when thinking needs direct transport", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "claude-sonnet-4-6",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: { config: { transportMode: "auto" } },
    directAllowed: false,
    fallbackPool: {
      getEligibleAnthropic() {
        return [{
          target: { id: "a" },
          client: { protocol: "anthropic" }
        }];
      }
    },
    thinking: { type: "enabled" }
  });

  assert.equal(decision.transportSelected, "external-anthropic");
  assert.equal(decision.useExternalFallback, true);
  assert.equal(decision.unsupportedThinking, false);
});

test("selectAnthropicTransport marks thinking unsupported when neither direct nor external anthropic fallback is available", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "claude-sonnet-4-6",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: { config: { transportMode: "auto" } },
    directAllowed: false,
    fallbackPool: null,
    thinking: { type: "enabled" }
  });

  assert.equal(decision.transportSelected, "unsupported");
  assert.equal(decision.useExternalFallback, false);
  assert.equal(decision.unsupportedThinking, true);
});

test("selectAnthropicTransport routes thinking requests to external openai fallback when direct model does not support thinking", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "gpt-5.4",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: { config: { transportMode: "auto" } },
    directAllowed: true,
    directThinkingSupported: false,
    fallbackPool: {
      getEligibleAnthropic() {
        return [{
          target: { id: "openai-fallback" },
          client: { protocol: "openai" }
        }];
      }
    },
    thinking: { type: "enabled" }
  });

  assert.equal(decision.transportSelected, "external-openai");
  assert.equal(decision.useExternalFallback, true);
  assert.equal(decision.unsupportedThinking, false);
});

test("selectAnthropicTransport skips direct-llm when no accounts ready and external fallback available", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: {
      config: { transportMode: "auto" },
      hasReadyAccounts() { return false; }
    },
    directAllowed: true,
    fallbackPool: {
      getEligibleAnthropic() {
        return [{
          target: { id: "ext" },
          client: { protocol: "openai" }
        }];
      }
    },
    thinking: null
  });

  assert.equal(decision.transportSelected, "external-openai");
  assert.equal(decision.useExternalFallback, true);
  assert.equal(decision.directAllowed, true, "directAllowed preserved for retry path");
});

test("selectAnthropicTransport uses direct-llm when accounts are ready", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: {
      config: { transportMode: "auto" },
      hasReadyAccounts() { return true; }
    },
    directAllowed: true,
    fallbackPool: {
      getEligibleAnthropic() {
        return [{
          target: { id: "ext" },
          client: { protocol: "openai" }
        }];
      }
    },
    thinking: null
  });

  assert.equal(decision.transportSelected, "direct-llm");
  assert.equal(decision.useExternalFallback, false);
});

test("selectAnthropicTransport skips direct-llm for thinking when no accounts ready", () => {
  const decision = selectAnthropicTransport({
    body: {
      model: "claude-opus-4-6",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    },
    client: {
      config: { transportMode: "auto" },
      hasReadyAccounts() { return false; }
    },
    directAllowed: true,
    directThinkingSupported: true,
    fallbackPool: {
      getEligibleAnthropic() {
        return [{
          target: { id: "ext" },
          client: { protocol: "anthropic" }
        }];
      }
    },
    thinking: { type: "enabled" }
  });

  assert.equal(decision.transportSelected, "external-anthropic");
  assert.equal(decision.useExternalFallback, true);
  assert.equal(decision.directAllowed, true);
});

test("handleMessagesRequest falls back before direct attempt when no accounts are ready", async () => {
  const req = createMockReq(BASIC_ANTHROPIC_BODY);
  const res = createMockRes();
  const client = createMockClient({ hasReadyAccounts: () => false });
  let directCalls = 0;
  let fallbackCalls = 0;
  const directClient = {
    isAvailable: () => true,
    run: async () => {
      directCalls += 1;
      throw new Error("direct should not run when no accounts are ready");
    }
  };
  const fallbackPool = {
    getEligibleAnthropic() {
      return [{
        client: {
          protocol: "openai",
          model: "fallback-claude",
          completeAnthropic: async () => {
            fallbackCalls += 1;
            return {
              text: "fallback response",
              usage: { input_tokens: 10, output_tokens: 5 }
            };
          }
        }
      }];
    }
  };
  const sessionStore = createMockSessionStore();

  await handleMessagesRequest(req, res, client, directClient, fallbackPool, sessionStore, null);

  assert.equal(directCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(res._statusCode, 200);
  const responseBody = JSON.parse(res._chunks.join(""));
  assert.equal(responseBody.content[0].text, "fallback response");
});

test("handleMessagesRequest does not fall back after direct attempt has already started", async () => {
  const req = createMockReq(BASIC_ANTHROPIC_BODY);
  const res = createMockRes();
  const client = createMockClient({ hasReadyAccounts: () => true });
  const directError = Object.assign(new Error("content risk rejected"), {
    status: 400,
    type: "invalid_request_error"
  });
  let fallbackCalls = 0;
  const directClient = {
    isAvailable: () => true,
    run: async () => {
      throw directError;
    }
  };
  const fallbackPool = {
    getEligibleAnthropic() {
      return [{
        client: {
          protocol: "openai",
          model: "fallback-claude",
          completeAnthropic: async () => {
            fallbackCalls += 1;
            return {
              text: "fallback response",
              usage: { input_tokens: 10, output_tokens: 5 }
            };
          }
        }
      }];
    }
  };
  const sessionStore = createMockSessionStore();

  await assert.rejects(
    () => handleMessagesRequest(req, res, client, directClient, fallbackPool, sessionStore, null),
    (error) => error === directError
  );

  assert.equal(fallbackCalls, 0);
  assert.equal(res._statusCode, null);
  assert.equal(res._chunks.length, 0);
});
