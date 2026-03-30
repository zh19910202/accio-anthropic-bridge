"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_ANTHROPIC_VERSION,
  ExternalFallbackClient,
  ExternalFallbackPool,
  anthropicToFallbackMessages,
  normalizeFallbackTargets,
  openAiToFallbackMessages,
  shouldFallbackToExternalProvider
} = require("../src/external-fallback");

test("anthropicToFallbackMessages preserves system and conversation text", () => {
  const messages = anthropicToFallbackMessages({
    system: [{ type: "text", text: "system rule" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] }
    ]
  });

  assert.deepEqual(messages, [
    { role: "system", content: "system rule" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" }
  ]);
});

test("openAiToFallbackMessages preserves plain text roles", () => {
  const messages = openAiToFallbackMessages({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] }
    ]
  });

  assert.deepEqual(messages, [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a" }
  ]);
});

test("ExternalFallbackClient eligibility rejects tools and images while allowing thinking for openai-compatible anthropic fallback", () => {
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key",
    model: "gpt-fallback"
  });

  assert.equal(client.isEligibleAnthropic({ thinking: { type: "enabled" }, messages: [] }), true);
  assert.equal(client.isEligibleAnthropic({ tools: [{ name: "tool" }], messages: [] }), false);
  assert.equal(client.isEligibleAnthropic({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }), false);
  assert.equal(client.isEligibleOpenAi({ tools: [{ type: "function", function: { name: "tool" } }], messages: [] }), false);
  assert.equal(client.isEligibleOpenAi({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }), false);
  assert.equal(client.isEligibleOpenAi({ messages: [{ role: "user", content: "ok" }] }), true);
});

test("normalizeFallbackTargets preserves order and normalizes ids", () => {
  const targets = normalizeFallbackTargets([
    { name: "Primary", protocol: "anthropic", baseUrl: "https://a.example/v1/", apiKey: "k1", model: "m1", reasoningEffort: "high" },
    { name: "Secondary", protocol: "openai", baseUrl: "https://b.example/v1", apiKey: "k2", model: "m2", enabled: false }
  ]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "Primary");
  assert.equal(targets[0].protocol, "anthropic");
  assert.equal(targets[0].baseUrl, "https://a.example/v1");
  assert.equal(targets[0].reasoningEffort, "high");
  assert.ok(targets[0].id);
});

test("ExternalFallbackPool returns eligible candidates in configured order", () => {
  const pool = new ExternalFallbackPool({
    targets: [
      { id: "a", name: "A", protocol: "openai", baseUrl: "https://a.example/v1", apiKey: "k1", model: "m1" },
      { id: "b", name: "B", protocol: "anthropic", baseUrl: "https://b.example/v1", apiKey: "k2", model: "m2" }
    ]
  });

  const anthropicCandidates = pool.getEligibleAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    thinking: { type: "enabled" }
  });
  const openAiCandidates = pool.getEligibleOpenAi({
    messages: [{ role: "user", content: "hi" }]
  });

  assert.deepEqual(anthropicCandidates.map((entry) => entry.target.id), ["a", "b"]);
  assert.deepEqual(openAiCandidates.map((entry) => entry.target.id), ["a", "b"]);
});

test("ExternalFallbackClient completes through OpenAI compatible endpoint", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-fallback",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: "fallback ok" } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 }
          };
        }
      };
    }
  });

  const result = await client.completeOpenAi({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 123,
    temperature: 0.2
  });

  assert.equal(result.text, "fallback ok");
  assert.equal(result.usage.prompt_tokens, 12);
  assert.equal(result.usage.completion_tokens, 7);
  assert.equal(seen[0].url, "https://fallback.example/v1/chat/completions");
  assert.match(String(seen[0].options.headers.authorization), /Bearer key_123/);
});

test("ExternalFallbackClient maps anthropic thinking to openai reasoning fields", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: "fallback ok" } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 }
          };
        }
      };
    }
  });

  await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    thinking: { type: "enabled", budget_tokens: 8192 },
    max_tokens: 123,
    temperature: 0.2
  });

  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.reasoning_effort, "high");
  assert.deepEqual(payload.reasoning, { effort: "high" });
});

test("ExternalFallbackClient uses configured default reasoning effort when anthropic thinking has no budget", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    reasoningEffort: "low",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: "fallback ok" } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 }
          };
        }
      };
    }
  });

  await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    thinking: { type: "enabled" },
    max_tokens: 123,
    temperature: 0.2
  });

  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.reasoning_effort, "low");
  assert.deepEqual(payload.reasoning, { effort: "low" });
});

test("ExternalFallbackClient completes through Anthropic endpoint", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "anthropic_key",
    model: "claude-opus-4-1",
    protocol: "anthropic",
    anthropicVersion: "2023-06-01",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "anthropic fallback ok" }],
            usage: { input_tokens: 9, output_tokens: 5 }
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "anthropic fallback ok" }],
                usage: { input_tokens: 9, output_tokens: 5 }
              };
            }
          };
        }
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 256,
    temperature: 0.1
  });

  assert.equal(result.text, "anthropic fallback ok");
  assert.equal(result.usage.input_tokens, 9);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(seen[0].url, "https://fallback.example/v1/messages");
  assert.equal(seen[0].options.headers["x-api-key"], "anthropic_key");
  assert.equal(seen[0].options.headers["anthropic-version"], "2023-06-01");

  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.model, "claude-opus-4-1");
  assert.equal(payload.messages[0].content[0].text, "hello");
});

test("ExternalFallbackClient requestAnthropicMessage preserves body and overrides model", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "anthropic_key",
    model: "claude-opus-4-1",
    protocol: "anthropic",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async text() {
          return JSON.stringify({ ok: true });
        }
      };
    }
  });

  await client.requestAnthropicMessage({
    model: "should-be-overridden",
    stream: true,
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: [{ type: "text", text: "keep thinking" }] }]
  });

  assert.equal(seen[0].url, "https://fallback.example/v1/messages");
  assert.equal(seen[0].options.headers["anthropic-version"], DEFAULT_ANTHROPIC_VERSION);
  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.model, "claude-opus-4-1");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 2048 });
});

test("ExternalFallbackClient streaming anthropic request does not abort body read after header timeout is cleared", async () => {
  let seenSignal = null;
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "anthropic_key",
    model: "claude-opus-4-1",
    protocol: "anthropic",
    timeoutMs: 10,
    fetchImpl: async (url, options = {}) => {
      seenSignal = options.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
        async text() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          assert.equal(seenSignal.aborted, false);
          return "event: ping\\n\\ndata: ok\\n\\n";
        }
      };
    }
  });

  const response = await client.requestAnthropicMessage({
    model: "should-be-overridden",
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "keep streaming" }] }]
  });

  const body = await response.text();
  assert.match(body, /event: ping/);
});

test("ExternalFallbackClient anthropic mode accepts Anthropic payload passthrough", () => {
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key",
    model: "claude-opus-4-1",
    protocol: "anthropic"
  });

  assert.equal(client.isEligibleAnthropic({
    thinking: { type: "enabled", budget_tokens: 2048 },
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
  }), true);
});

test("ExternalFallbackClient retries Anthropic request on wrapped not-found payload and succeeds on /v1/messages", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'anthropic_key',
    model: 'glm-5.1',
    protocol: 'anthropic',
    fetchImpl: async (url, options = {}) => {
      seen.push(String(url));
      if (String(url).endsWith('/api/anthropic/messages')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          async json() {
            return { code: 500, msg: '404 NOT_FOUND', success: false };
          },
          clone() {
            return {
              async json() {
                return { code: 500, msg: '404 NOT_FOUND', success: false };
              }
            };
          }
        };
      }

      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            id: 'msg_ok',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'fallback ok' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: 'msg_ok',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'fallback ok' }],
                usage: { input_tokens: 1, output_tokens: 1 }
              };
            }
          };
        }
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32
  });

  assert.equal(result.text, 'fallback ok');
  assert.deepEqual(seen, [
    'https://open.bigmodel.cn/api/anthropic/messages',
    'https://open.bigmodel.cn/api/anthropic/v1/messages'
  ]);
});

test("ExternalFallbackClient remembers the working anthropic path after wrapped 404 fallback", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'anthropic_key',
    model: 'glm-5.1',
    protocol: 'anthropic',
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).endsWith('/api/anthropic/messages')) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          async json() {
            return { code: 500, msg: '404 NOT_FOUND', success: false };
          },
          clone() {
            return {
              async json() {
                return { code: 500, msg: '404 NOT_FOUND', success: false };
              }
            };
          }
        };
      }

      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return {
            id: 'msg_ok',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'fallback ok' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: 'msg_ok',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'fallback ok' }],
                usage: { input_tokens: 1, output_tokens: 1 }
              };
            }
          };
        }
      };
    }
  });

  await client.completeAnthropic({
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32
  });

  await client.completeAnthropic({
    messages: [{ role: 'user', content: 'hello again' }],
    max_tokens: 32
  });

  assert.deepEqual(seen, [
    'https://open.bigmodel.cn/api/anthropic/messages',
    'https://open.bigmodel.cn/api/anthropic/v1/messages',
    'https://open.bigmodel.cn/api/anthropic/v1/messages'
  ]);
});

test("shouldFallbackToExternalProvider matches quota and connection failures", () => {
  const quota = new Error("quota exceeded");
  quota.status = 429;
  quota.type = "rate_limit_error";
  assert.equal(shouldFallbackToExternalProvider(quota), true);

  const timeout = new Error("fetch failed");
  timeout.type = "api_connection_error";
  assert.equal(shouldFallbackToExternalProvider(timeout), true);

  const invalid = new Error("bad request");
  invalid.status = 400;
  invalid.type = "invalid_request_error";
  assert.equal(shouldFallbackToExternalProvider(invalid), false);
});
