"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodexResponsesClient,
  buildHeadersForCredential,
  buildChatGptResponsesUrl,
  buildModelsUrl,
  buildResponsesUrl
} = require("../src/codex-responses");

test("buildResponsesUrl normalizes common baseUrl forms", () => {
  assert.equal(buildResponsesUrl("https://api.openai.com"), "https://api.openai.com/v1/responses");
  assert.equal(buildResponsesUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/responses");
  assert.equal(buildResponsesUrl("https://api.openai.com/v1/responses"), "https://api.openai.com/v1/responses");
});

test("buildChatGptResponsesUrl normalizes chatgpt codex endpoints", () => {
  assert.equal(buildChatGptResponsesUrl(), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildChatGptResponsesUrl("https://chatgpt.com"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildChatGptResponsesUrl("https://chatgpt.com/backend-api"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildChatGptResponsesUrl("https://chatgpt.com/backend-api/codex"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildChatGptResponsesUrl("https://api.openai.com/v1"), "https://chatgpt.com/backend-api/codex/responses");
});

test("buildModelsUrl normalizes common baseUrl forms", () => {
  assert.equal(buildModelsUrl("https://api.openai.com"), "https://api.openai.com/v1/models");
  assert.equal(buildModelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  assert.equal(buildModelsUrl("https://api.openai.com/v1/models"), "https://api.openai.com/v1/models");
});

test("buildHeadersForCredential supports opaque bundle headers and cookie", () => {
  const headers = buildHeadersForCredential({
    headers: {
      "x-test": "1"
    },
    cookie: "a=1",
    accessToken: "tok_123"
  }, "text/event-stream");

  assert.equal(headers.authorization, "Bearer tok_123");
  assert.equal(headers.cookie, "a=1");
  assert.equal(headers["x-test"], "1");
  assert.equal(headers.accept, "text/event-stream");
});

test("buildHeadersForCredential supports nested OpenAI auth JSON fields", () => {
  const headers = buildHeadersForCredential({
    OPENAI_API_KEY: "sk_from_env",
    tokens: {
      access_token: "tok_nested",
      account_id: "acct_nested"
    }
  });

  assert.equal(headers.authorization, "Bearer tok_nested");
  assert.equal(headers["chatgpt-account-id"], "acct_nested");
});

test("CodexResponsesClient completes SSE responses with text and tool calls", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential() {
        return {
          accountId: "codex_a",
          accountName: "Codex A",
          credentialBundle: {
            headers: {
              authorization: "Bearer opaque_token"
            }
          }
        };
      },
      recordFailure() {},
      clearFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.output_text.delta\n' +
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
              'event: response.output_item.done\n' +
              'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"lookup","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_1"}}\n\n' +
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","output":[{"id":"fc_1","type":"function_call","name":"lookup","arguments":"{\\"city\\":\\"Shanghai\\"}","call_id":"call_1"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.run({
    model: "gpt-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });

  assert.equal(seen[0].url, "https://api.openai.com/v1/responses");
  assert.equal(result.finalText, "hello");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_1",
      name: "lookup",
      input: { city: "Shanghai" }
    }
  ]);
  assert.equal(result.accountId, "codex_a");
});

test("CodexResponsesClient probes a specific account via models endpoint", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential(options = {}) {
        if (options.accountId !== "codex_probe") {
          return null;
        }
        return {
          accountId: "codex_probe",
          accountName: "Codex Probe",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            tokens: {
              access_token: "tok_probe",
              account_id: "acct_probe"
            }
          },
          chatGptAccountId: "acct_probe"
        };
      },
      clearFailure() {},
      recordFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-5" },
              { id: "gpt-5-codex" }
            ]
          });
        }
      };
    }
  });

  const result = await client.probeAccount("codex_probe");

  assert.equal(seen[0].url, "https://api.openai.com/v1/models");
  assert.equal(seen[0].options.method, "GET");
  assert.equal(seen[0].options.headers.authorization, "Bearer tok_probe");
  assert.equal(seen[0].options.headers["chatgpt-account-id"], "acct_probe");
  assert.equal(result.accountId, "codex_probe");
  assert.equal(result.modelCount, 2);
  assert.deepEqual(result.sampleModels, ["gpt-5", "gpt-5-codex"]);
});

test("CodexResponsesClient falls back to responses probe when models scope is missing", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential(options = {}) {
        if (options.accountId !== "codex_scope_fallback") {
          return null;
        }
        return {
          accountId: "codex_scope_fallback",
          accountName: "Codex Scope Fallback",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            tokens: {
              access_token: "tok_probe",
              account_id: "acct_probe"
            }
          },
          chatGptAccountId: "acct_probe"
        };
      },
      clearFailure() {},
      recordFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      if (String(url).endsWith("/models")) {
        return {
          ok: false,
          status: 403,
          async text() {
            return JSON.stringify({
              error: {
                message: "Missing scopes: api.model.read"
              }
            });
          }
        };
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: "resp_probe",
            object: "response",
            model: "gpt-5",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 1,
              output_tokens: 1
            }
          });
        }
      };
    }
  });

  const result = await client.probeAccount("codex_scope_fallback");

  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "https://api.openai.com/v1/models");
  assert.equal(seen[1].url, "https://api.openai.com/v1/responses");
  assert.equal(seen[1].options.method, "POST");
  assert.equal(result.probeTransport, "responses");
  assert.equal(result.verifiedModel, "gpt-5.4");
});

test("CodexResponsesClient skips models probe for chatgpt auth credentials", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential(options = {}) {
        if (options.accountId !== "codex_chatgpt") {
          return null;
        }
        return {
          accountId: "codex_chatgpt",
          accountName: "Codex ChatGPT",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            auth_mode: "chatgpt",
            tokens: {
              access_token: "tok_probe",
              account_id: "acct_probe"
            }
          },
          chatGptAccountId: "acct_probe"
        };
      },
      clearFailure() {},
      recordFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_probe","model":"gpt-5.4","output":[]}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.probeAccount("codex_chatgpt");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(seen[0].options.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(seen[0].options.headers.originator, "codex_cli_rs");
  assert.equal(seen[0].options.headers["chatgpt-account-id"], "acct_probe");
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    model: "gpt-5.4",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "ping"
          }
        ]
      }
    ],
    instructions: "",
    store: false,
    stream: true
  });
  assert.equal(result.probeTransport, "responses");
  assert.equal(result.transportMode, "chatgpt");
  assert.equal(result.requestBaseUrl, "https://api.openai.com/v1");
});

test("CodexResponsesClient sends chatgpt auth traffic to codex backend path", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential() {
        return {
          accountId: "codex_chatgpt_run",
          accountName: "Codex ChatGPT Run",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            auth_mode: "chatgpt",
            tokens: {
              access_token: "tok_run",
              account_id: "acct_run"
            }
          },
          chatGptAccountId: "acct_run"
        };
      },
      recordFailure() {},
      clearFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","output":[]}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  const result = await client.run({
    model: "gpt-5.4",
    input: "ping"
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(seen[0].options.headers.authorization, "Bearer tok_run");
  assert.equal(seen[0].options.headers["chatgpt-account-id"], "acct_run");
  assert.equal(seen[0].options.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(seen[0].options.headers.originator, "codex_cli_rs");
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    model: "gpt-5.4",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "ping"
          }
        ]
      }
    ],
    instructions: "",
    store: false,
    stream: true
  });
  assert.equal(result.accountId, "codex_chatgpt_run");
});

test("CodexResponsesClient maps gpt-5.4-codex to gpt-5.4 for chatgpt auth accounts", async () => {
  const seen = [];
  let decision = null;
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential() {
        return {
          accountId: "codex_chatgpt_alias",
          accountName: "Codex ChatGPT Alias",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            auth_mode: "chatgpt",
            tokens: {
              access_token: "tok_alias",
              account_id: "acct_alias"
            }
          },
          chatGptAccountId: "acct_alias"
        };
      },
      recordFailure() {},
      clearFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_alias","model":"gpt-5.4","output":[]}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  await client.run({
    model: "gpt-5.4-codex",
    input: "ping"
  }, {
    onDecision(event) {
      decision = event;
    }
  });

  assert.equal(JSON.parse(seen[0].options.body).model, "gpt-5.4");
  assert.equal(decision.resolvedProviderModel, "gpt-5.4");
});

test("CodexResponsesClient strips unsupported standard responses fields for chatgpt auth accounts", async () => {
  const seen = [];
  const client = new CodexResponsesClient({
    authProvider: {
      resolveCredential() {
        return {
          accountId: "codex_chatgpt_clean",
          accountName: "Codex ChatGPT Clean",
          baseUrl: "https://api.openai.com/v1",
          credentialBundle: {
            auth_mode: "chatgpt",
            tokens: {
              access_token: "tok_clean",
              account_id: "acct_clean"
            }
          },
          chatGptAccountId: "acct_clean"
        };
      },
      recordFailure() {},
      clearFailure() {}
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"id":"resp_clean","model":"gpt-5.4","output":[]}}\n\n'
            ));
            controller.close();
          }
        })
      };
    }
  });

  await client.run({
    model: "gpt-5.4",
    input: "ping",
    metadata: { a: 1 },
    user: "user_123",
    stop: ["END"],
    stream: false
  });

  const payload = JSON.parse(seen[0].options.body);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "metadata"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "user"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "stop"), false);
});
