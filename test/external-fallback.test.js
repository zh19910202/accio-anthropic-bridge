"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_ANTHROPIC_VERSION,
  ExternalFallbackClient,
  ExternalFallbackPool,
  anthropicToFallbackMessages,
  normalizeFallbackTargets,
  openAiMessagesToResponsesInput,
  openAiToFallbackMessages,
  sanitizeAnthropicRequestBody,
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

test("ExternalFallbackClient eligibility allows anthropic tools for openai-compatible fallback while still rejecting images", () => {
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key",
    model: "gpt-fallback"
  });

  assert.equal(client.isEligibleAnthropic({ thinking: { type: "enabled" }, messages: [] }), true);
  assert.equal(client.isEligibleAnthropic({ tools: [{ name: "tool" }], messages: [] }), true);
  assert.equal(client.isEligibleAnthropic({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }), false);
  assert.equal(client.isEligibleOpenAi({ tools: [{ type: "function", function: { name: "tool" } }], messages: [] }), false);
  assert.equal(client.isEligibleOpenAi({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }), false);
  assert.equal(client.isEligibleOpenAi({ messages: [{ role: "user", content: "ok" }] }), true);
});

test("shouldFallbackToExternalProvider treats timeout-style aborts as retryable", () => {
  assert.equal(
    shouldFallbackToExternalProvider({ message: "The operation was aborted due to timeout" }),
    true
  );
  assert.equal(
    shouldFallbackToExternalProvider({ type: "api_timeout_error", message: "SSE stream idle timeout" }),
    true
  );
});

test("normalizeFallbackTargets preserves order and normalizes ids", () => {
  const targets = normalizeFallbackTargets([
    {
      name: "Primary",
      protocol: "anthropic",
      baseUrl: "https://a.example/v1/",
      apiKey: "k1",
      model: "m1",
      supportedModels: "claude-sonnet-4-5, claude-opus-4-6",
      reasoningEffort: "high"
    },
    { name: "Secondary", protocol: "openai", baseUrl: "https://b.example/v1", apiKey: "k2", model: "m2", enabled: false }
  ]);

  assert.equal(targets.length, 2);
  assert.equal(targets[0].name, "Primary");
  assert.equal(targets[0].protocol, "anthropic");
  assert.equal(targets[0].baseUrl, "https://a.example/v1");
  assert.equal(targets[0].reasoningEffort, "high");
  assert.deepEqual(targets[0].supportedModels, ["claude-sonnet-4-6", "claude-opus-4-6"]);
  assert.ok(targets[0].id);
});

test("ExternalFallbackPool prioritizes native model matches before protocol adaptation", () => {
  const pool = new ExternalFallbackPool({
    targets: [
      {
        id: "a",
        name: "A",
        protocol: "openai",
        baseUrl: "https://a.example/v1",
        apiKey: "k1",
        model: "gpt-5.4",
        supportedModels: ["gpt-5.4"]
      },
      {
        id: "b",
        name: "B",
        protocol: "anthropic",
        baseUrl: "https://b.example/v1",
        apiKey: "k2",
        model: "anthropic/claude-sonnet-4.6",
        supportedModels: ["claude-sonnet-4-6"]
      }
    ]
  });

  const anthropicCandidates = pool.getEligibleAnthropic({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    thinking: { type: "enabled" }
  });
  const openAiCandidates = pool.getEligibleOpenAi({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hi" }]
  });

  assert.deepEqual(anthropicCandidates.map((entry) => entry.target.id), ["b", "a"]);
  assert.deepEqual(openAiCandidates.map((entry) => entry.target.id), ["a", "b"]);
});

test("ExternalFallbackPool keeps configured priority when no native model supplier matches", () => {
  const pool = new ExternalFallbackPool({
    targets: [
      { id: "a", name: "A", protocol: "openai", baseUrl: "https://a.example/v1", apiKey: "k1", model: "gpt-5.4", supportedModels: ["gpt-5.4"] },
      { id: "b", name: "B", protocol: "anthropic", baseUrl: "https://b.example/v1", apiKey: "k2", model: "anthropic/claude-sonnet-4.6", supportedModels: ["claude-sonnet-4-6"] }
    ]
  });

  const candidates = pool.getEligibleAnthropic({
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
  });

  assert.deepEqual(candidates.map((entry) => entry.target.id), ["a", "b"]);
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

test("ExternalFallbackClient maps anthropic tools into openai chat completions payload", async () => {
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
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "lookup", input: { q: "hi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "done" }] }] }
    ],
    tools: [
      {
        name: "lookup",
        description: "Lookup something",
        input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
      }
    ],
    tool_choice: { type: "tool", name: "lookup" },
    max_tokens: 123
  });

  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.model, "gpt-5.4");
  assert.equal(payload.tools[0].function.name, "lookup");
  assert.equal(payload.tools[0].function.parameters.required[0], "q");
  assert.equal(payload.tool_choice.function.name, "lookup");
  assert.equal(payload.messages[1].tool_calls[0].function.name, "lookup");
  assert.equal(payload.messages[2].role, "tool");
  assert.equal(payload.messages[2].tool_call_id, "tool_1");
  assert.equal(payload.messages[2].content, "done");
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

test("ExternalFallbackClient falls back to responses endpoint when chat completions is unsupported", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    reasoningEffort: "high",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });

      if (String(url).endsWith("/chat/completions")) {
        return {
          ok: false,
          status: 500,
          async json() {
            return {
              error: {
                message: "codex channel: /v1/chat/completions endpoint not supported",
                type: "new_api_error"
              }
            };
          }
        };
      }

      if (String(url).endsWith("/responses")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'event: response.output_text.delta\n' +
                'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
                'event: response.completed\n' +
                'data: {"type":"response.completed","response":{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
              ));
              controller.close();
            }
          })
        };
      }

      throw new Error("Unexpected URL: " + url);
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    thinking: { type: "enabled" },
    max_tokens: 32
  });

  assert.equal(result.text, "ok");
  assert.equal(result.model, "gpt-5.4");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(seen[0].url, "https://fallback.example/v1/chat/completions");
  assert.equal(seen[1].url, "https://fallback.example/v1/responses");
  const payload = JSON.parse(seen[1].options.body);
  assert.equal(payload.stream, true);
  assert.equal(payload.metadata, undefined);
  assert.equal(payload.reasoning.effort, "high");
  assert.equal(payload.input[0].content[0].type, "input_text");
});

test("openAiMessagesToResponsesInput preserves tool call history for responses api", () => {
  const input = openAiMessagesToResponsesInput([
    { role: "system", content: "system rule" },
    { role: "user", content: "check weather" },
    {
      role: "assistant",
      content: "Calling tool",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: "{\"city\":\"Shanghai\"}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_123",
      content: "Sunny"
    }
  ]);

  assert.deepEqual(input, [
    {
      role: "system",
      content: [{ type: "input_text", text: "system rule" }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "check weather" }]
    },
    {
      role: "assistant",
      content: [{ type: "input_text", text: "Calling tool" }]
    },
    {
      type: "function_call",
      call_id: "call_123",
      name: "lookup_weather",
      arguments: "{\"city\":\"Shanghai\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: "Sunny"
    }
  ]);
});

test("ExternalFallbackClient extracts responses api function calls when completing anthropic request", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    openaiApiStyle: "responses",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.output_item.added\n' +
              'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_weather","name":"lookup_weather"},"output_index":0,"sequence_number":1}\n\n' +
              'event: response.function_call_arguments.done\n' +
              'data: {"type":"response.function_call_arguments.done","arguments":"{\\"city\\":\\"Shanghai\\"}","item_id":"fc_1","output_index":0,"sequence_number":2}\n\n' +
              'event: response.output_item.done\n' +
              'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_weather","name":"lookup_weather"},"output_index":0,"sequence_number":3}\n\n' +
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-5.4","output":[{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_weather","name":"lookup_weather"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "lookup_weather", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup_weather" },
    max_tokens: 32
  });

  assert.equal(seen[0].url, "https://fallback.example/v1/responses");
  const payload = JSON.parse(seen[0].options.body);
  assert.equal(payload.input[0].role, "user");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_weather",
      name: "lookup_weather",
      input: { city: "Shanghai" }
    }
  ]);
});

test("ExternalFallbackClient extracts responses api function calls even without response.completed", async () => {
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    openaiApiStyle: "responses",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.output_item.added\n' +
            'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_weather","name":"lookup_weather"},"output_index":0,"sequence_number":1}\n\n' +
            'event: response.output_item.done\n' +
            'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_weather","name":"lookup_weather"},"output_index":0,"sequence_number":2}\n\n'
          ));
          controller.close();
        }
      })
    })
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "lookup_weather", input_schema: { type: "object" } }],
    max_tokens: 32
  });

  assert.deepEqual(result.toolCalls, [
    {
      id: "call_weather",
      name: "lookup_weather",
      input: { city: "Shanghai" }
    }
  ]);
});

test("ExternalFallbackClient extracts openai tool calls when completing anthropic request", async () => {
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "key_123",
    model: "gpt-5.4",
    protocol: "openai",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "lookup",
                      arguments: "{\"q\":\"hello\"}"
                    }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7 }
        };
      }
    })
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    max_tokens: 32
  });

  assert.equal(result.text, "");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_1",
      name: "lookup",
      input: { q: "hello" }
    }
  ]);
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
  assert.equal(payload.messages[0].content, "hello");
});

test("ExternalFallbackClient retries native anthropic completion with streaming when upstream requires it for long requests", async () => {
  const seen = [];
  let attempt = 0;
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "anthropic_key",
    model: "claude-opus-4-6",
    protocol: "anthropic",
    anthropicVersion: "2023-06-01",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      attempt += 1;

      if (attempt === 1) {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          async json() {
            return {
              error: {
                message: "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
                type: "proxy_error"
              }
            };
          },
          clone() {
            return {
              async json() {
                return {
                  error: {
                    message: "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
                    type: "proxy_error"
                  }
                };
              }
            };
          }
        };
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_streamed","type":"message","role":"assistant","model":"claude-opus-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0}}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed ok"}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
            controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n'));
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "adaptive" },
    max_tokens: 64000
  });

  assert.equal(result.text, "streamed ok");
  assert.equal(result.raw.id, "msg_streamed");
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[0].options.body).stream, false);
  assert.equal(JSON.parse(seen[1].options.body).stream, true);
});

test("ExternalFallbackClient preserves structured anthropic payload when retrying native streaming-required requests", async () => {
  const seen = [];
  let attempt = 0;
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1",
    apiKey: "anthropic_key",
    model: "claude-opus-4-6",
    protocol: "anthropic",
    anthropicVersion: "2023-06-01",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      attempt += 1;

      if (attempt === 1) {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          async json() {
            return {
              error: {
                message: "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
                type: "proxy_error"
              }
            };
          },
          clone() {
            return {
              async json() {
                return {
                  error: {
                    message: "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
                    type: "proxy_error"
                  }
                };
              }
            };
          }
        };
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_streamed_tool","type":"message","role":"assistant","model":"claude-opus-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":0}}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
            controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n'));
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          }
        })
      };
    }
  });

  await client.completeAnthropic({
    system: [{ type: "text", text: "system prompt" }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: "lookup" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { keyword: "张三" } },
          { type: "text", text: "我先查一下" }
        ]
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "结果：张三" }] },
          { type: "text", text: "继续" }
        ]
      }
    ],
    max_tokens: 64000
  });

  assert.equal(seen.length, 2);

  const firstPayload = JSON.parse(seen[0].options.body);
  const secondPayload = JSON.parse(seen[1].options.body);

  assert.equal(firstPayload.stream, false);
  assert.equal(secondPayload.stream, true);
  assert.equal(firstPayload.messages[0].content[0].type, "tool_use");
  assert.equal(firstPayload.messages[0].content[0].name, "lookup");
  assert.equal(firstPayload.messages[1].content[0].type, "tool_result");
  assert.equal(firstPayload.tools[0].name, "lookup");
  assert.equal(firstPayload.tool_choice.name, "lookup");
  assert.equal(secondPayload.messages[0].content[0].type, "tool_use");
  assert.equal(secondPayload.messages[1].content[0].type, "tool_result");
  assert.equal(secondPayload.tools[0].name, "lookup");
  assert.equal(secondPayload.tool_choice.name, "lookup");
});

test("ExternalFallbackClient retries Anthropic auth with Bearer and remembers the working mode", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example",
    apiKey: "anthropic_key",
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
    fetchImpl: async (url, options = {}) => {
      seen.push({
        url: String(url),
        headers: options.headers
      });

      if (options.headers["x-api-key"]) {
        return {
          ok: false,
          status: 401,
          headers: new Headers({ "content-type": "application/json" }),
          async json() {
            return { error: { message: "Unauthorized", type: "auth_error" } };
          },
          clone() {
            return {
              async json() {
                return { error: { message: "Unauthorized", type: "auth_error" } };
              }
            };
          }
        };
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
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

  const first = await client.completeAnthropic({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64
  });
  const second = await client.completeAnthropic({
    messages: [{ role: "user", content: "hello again" }],
    max_tokens: 64
  });

  assert.equal(first.text, "anthropic fallback ok");
  assert.equal(second.text, "anthropic fallback ok");
  assert.equal(seen[0].headers["x-api-key"], "anthropic_key");
  assert.equal(seen[1].headers.authorization, "Bearer anthropic_key");
  assert.equal(seen[2].headers.authorization, "Bearer anthropic_key");
});

test("ExternalFallbackClient skips html portal responses and continues to /v1/messages", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example",
    apiKey: "anthropic_key",
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), headers: options.headers });
      if (String(url) === "https://fallback.example/messages") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          async text() {
            return "<html>portal</html>";
          }
        };
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async json() {
          return {
            id: "msg_456",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok via v1" }],
            usage: { input_tokens: 3, output_tokens: 2 }
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: "msg_456",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok via v1" }],
                usage: { input_tokens: 3, output_tokens: 2 }
              };
            }
          };
        }
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32
  });

  assert.equal(result.text, "ok via v1");
  assert.deepEqual(seen.map((entry) => entry.url), [
    "https://fallback.example/messages",
    "https://fallback.example/v1/messages"
  ]);
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

test("ExternalFallbackClient requestAnthropicMessage preserves incoming anthropic beta headers like context-1m", async () => {
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

  await client.requestAnthropicMessage(
    {
      model: "should-be-overridden",
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "keep 1m" }] }]
    },
    {
      requestHeaders: {
        "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07"
      }
    }
  );

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].options.headers["anthropic-beta"],
    "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
  );
});

test("sanitizeAnthropicRequestBody strips thinking blocks and normalizes tool_reference tool results", () => {
  const sanitized = sanitizeAnthropicRequestBody({
    model: "claude-sonnet-4-6",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", signature: "sig_1" },
          { type: "tool_use", id: "tool_1", name: "WebFetch", input: { url: "https://example.com" } }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: [{ type: "tool_reference", tool_name: "WebFetch" }]
          },
          { type: "text", text: "continue" }
        ]
      }
    ]
  });

  assert.deepEqual(sanitized.messages, [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "WebFetch", input: { url: "https://example.com" } }]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "{\"type\":\"tool_reference\",\"tool_name\":\"WebFetch\"}"
        },
        { type: "text", text: "continue" }
      ]
    }
  ]);
});

test("ExternalFallbackClient requestAnthropicMessage sanitizes unsupported anthropic history blocks", async () => {
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
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden", signature: "sig_1" },
          { type: "tool_use", id: "tool_1", name: "WebFetch", input: { url: "https://example.com" } }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: [{ type: "tool_reference", tool_name: "WebFetch" }]
          }
        ]
      }
    ]
  });

  const payload = JSON.parse(seen[0].options.body);
  assert.deepEqual(payload.messages, [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_1", name: "WebFetch", input: { url: "https://example.com" } }]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "{\"type\":\"tool_reference\",\"tool_name\":\"WebFetch\"}"
        }
      ]
    }
  ]);
});

test("ExternalFallbackClient accepts anthropic baseUrl ending with /v1", async () => {
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
        async json() {
          return {
            id: "msg_v1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }]
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: "msg_v1",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok" }]
              };
            }
          };
        }
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 32
  });

  assert.equal(result.text, "ok");
  assert.equal(seen[0].url, "https://fallback.example/v1/messages");
});

test("ExternalFallbackClient completeAnthropic preserves incoming anthropic beta headers for native anthropic fallback", async () => {
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
        async json() {
          return {
            id: "msg_v1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }]
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: "msg_v1",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok" }]
              };
            }
          };
        }
      };
    }
  });

  await client.completeAnthropic(
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 32
    },
    {
      requestHeaders: {
        "anthropic-beta": "context-1m-2025-08-07,claude-code-20250219"
      }
    }
  );

  assert.equal(
    seen[0].options.headers["anthropic-beta"],
    "context-1m-2025-08-07,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
  );
});

test("ExternalFallbackClient accepts anthropic baseUrl ending with full /messages endpoint", async () => {
  const seen = [];
  const client = new ExternalFallbackClient({
    baseUrl: "https://fallback.example/v1/messages",
    apiKey: "anthropic_key",
    model: "claude-opus-4-1",
    protocol: "anthropic",
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        async json() {
          return {
            id: "msg_endpoint",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }]
          };
        },
        clone() {
          return {
            async json() {
              return {
                id: "msg_endpoint",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok" }]
              };
            }
          };
        }
      };
    }
  });

  const result = await client.completeAnthropic({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 32
  });

  assert.equal(result.text, "ok");
  assert.equal(seen[0].url, "https://fallback.example/v1/messages");
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
