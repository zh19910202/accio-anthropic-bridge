"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DirectLlmClient,
  UpstreamHttpError,
  UpstreamSseError,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi,
  extractThinkingConfigFromAnthropic,
  mapRequestedModel,
  supportsThinkingForModel
} = require("../src/direct-llm");

test("mapRequestedModel uses external alias config", () => {
  assert.equal(mapRequestedModel("gpt-5"), "claude-opus-4-6");
  assert.equal(mapRequestedModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(mapRequestedModel("custom-model"), "custom-model");
});

test("buildDirectRequestFromAnthropic maps tool_result and aliased model", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "shell_echo", input: { text: "hi" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "hi" }]
      }
    ]
  });

  assert.equal(request.model, "claude-opus-4-6");
  assert.equal(request.requestBody.model, "claude-opus-4-6");
  assert.equal(request.requestBody.contents[1].parts[0].function_response.name, "shell_echo");
});

test("buildDirectRequestFromOpenAi maps tools into declarations", () => {
  const request = buildDirectRequestFromOpenAi({
    model: "claude-opus-4-6",
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.requestBody.tools[0].name, "lookup_weather");
  assert.match(request.requestBody.tools[0].parameters_json, /city/);
});

test("UpstreamHttpError preserves upstream status and sanitizes token", async () => {
  const originalFetch = global.fetch;
  const token = "s3c2db98-secret-token";

  global.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    async text() {
      return JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: `quota exceeded for ${token}`
        }
      });
    }
  });

  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token,
          source: "env"
        };
      }
    },
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm"
  });

  await assert.rejects(
    () => client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } }),
    (error) => {
      assert.ok(error instanceof UpstreamHttpError);
      assert.equal(error.status, 429);
      assert.equal(error.type, "rate_limit_error");
      assert.match(error.message, /quota exceeded/);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.equal(error.details.upstream.status, 429);
      assert.doesNotMatch(JSON.stringify(error.details), /secret-token/);
      return true;
    }
  );

  global.fetch = originalFetch;
});

test("DirectLlmClient converts SSE logical errors into structured upstream errors", async () => {
  const originalFetch = global.fetch;
  const token = "invalid_test_token";

  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data:{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n\n'
          )
        );
        controller.close();
      }
    })
  });

  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token,
          source: "env"
        };
      },
      invalidateAccount() {}
    },
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm"
  });

  await assert.rejects(
    () => client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } }),
    (error) => {
      assert.ok(error instanceof UpstreamSseError);
      assert.equal(error.status, 401);
      assert.equal(error.type, "authentication_error");
      assert.equal(error.message, "unauthorized");
      assert.equal(error.details.upstream.status, 200);
      assert.equal(error.details.upstream.body.error_code, "402");
      return true;
    }
  );

  global.fetch = originalFetch;
});


test("extractThinkingConfigFromAnthropic preserves budget tokens", () => {
  const thinking = extractThinkingConfigFromAnthropic({
    thinking: { type: "enabled", budget_tokens: 2048 }
  });

  assert.deepEqual(thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(supportsThinkingForModel("claude-opus-4-6"), true);
  assert.equal(supportsThinkingForModel("claude-haiku-4-5"), false);
});
