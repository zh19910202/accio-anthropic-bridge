"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const UUID_V4ISH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
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
  assert.match(request.requestBody.requestId, UUID_V4ISH_RE);
  assert.match(request.requestBody.messageId, UUID_V4ISH_RE);
  assert.equal(request.requestBody.iaiTag, "phoenix-desktop");
  assert.equal(request.requestBody.contents[1].parts[0].functionResponse.name, "shell_echo");
});

test("buildDirectRequestFromAnthropic rewrites Claude Code CLI system identity for direct upstream compatibility", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "claude-opus-4-6",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.85.351; cc_entrypoint=cli; cch=32200;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are an interactive agent that helps users with software engineering tasks." }
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
  });

  assert.match(request.requestBody.systemInstruction, /You are a Claude agent, built on Anthropic's Claude Agent SDK\./);
  assert.doesNotMatch(request.requestBody.systemInstruction, /official CLI for Claude/);
  assert.match(request.requestBody.systemInstruction, /software engineering tasks/);
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
  assert.match(request.requestBody.tools[0].parametersJson, /city/);
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
      assert.equal(error.details.upstream.request.endpoint, "/generateContent");
      assert.equal(error.details.upstream.request.resolvedProviderModel, "claude-opus-4-6");
      assert.deepEqual(error.details.upstream.request.bodyKeys, [
        "empid",
        "iai_tag",
        "message_id",
        "model",
        "request_id"
      ]);
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
      assert.equal(error.details.upstream.request.endpoint, "/generateContent");
      assert.equal(error.details.upstream.request.authSource, "env");
      assert.deepEqual(error.details.upstream.request.bodyKeys, [
        "empid",
        "iai_tag",
        "message_id",
        "model",
        "request_id"
      ]);
      return true;
    }
  );

  global.fetch = originalFetch;
});

test("DirectLlmClient sends app version metadata on generateContent requests", async () => {
  const calls = [];
  const client = new DirectLlmClient({
    authMode: "env",
    appVersion: "0.4.6",
    language: "zh",
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token: "token_primary",
          cookie: "cna%3Dcookie-cna",
          source: "env"
        };
      }
    },
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        async text() {
          return JSON.stringify({ message: "forced test failure" });
        }
      };
    }
  });

  await assert.rejects(
    () => client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } }),
    UpstreamHttpError
  );

  const generateCall = calls.find((entry) => entry.url.includes("/generateContent"));
  assert.ok(generateCall);
  assert.match(generateCall.url, /version=0\.4\.6/);
  assert.equal(generateCall.options.headers["x-app-version"], "0.4.6");
  assert.equal(generateCall.options.headers["x-cna"], "cookie-cna");
  assert.equal(generateCall.options.headers.cookie, "cna=cookie-cna");
});


test("extractThinkingConfigFromAnthropic preserves budget tokens", () => {
  const thinking = extractThinkingConfigFromAnthropic({
    thinking: { type: "enabled", budget_tokens: 2048 }
  });

  assert.deepEqual(thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(supportsThinkingForModel("claude-opus-4-6"), true);
  assert.equal(supportsThinkingForModel("claude-haiku-4-5"), false);
});

test("buildDirectRequestFromAnthropic omits unsupported thinking fields for current upstream", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "claude-opus-4-6",
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal("includeThoughts" in request.requestBody, false);
  assert.equal("thinkingBudget" in request.requestBody, false);
  assert.equal("thinking" in request.requestBody, false);
});

test("buildDirectRequestFromAnthropic caps max_output_tokens to current direct upstream limit", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "claude-opus-4-6",
    max_tokens: 64000,
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.requestBody.maxOutputTokens, 16384);
});

test("DirectLlmClient injects empid from authenticated account user", async () => {
  const seenBodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            data: [
              {
                provider: "claude",
                modelList: [{ modelName: "claude-opus-4-6", visible: true }]
              }
            ]
          };
        }
      };
    }

    if (String(url).includes("/generateContent")) {
      seenBodies.push(JSON.parse(options.body || "{}"));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error("Unexpected URL: " + url);
  };

  const client = new DirectLlmClient({
    authMode: "env",
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    requestTimeoutMs: 1000,
    fetchImpl,
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token: "token_123",
          source: "env",
          user: { id: "7083340315" }
        };
      }
    }
  });

  await client.run({
    model: "claude-opus-4-6",
    requestBody: { model: "claude-opus-4-6", contents: [{ role: "user", parts: [{ text: "hi" }] }] }
  });

  assert.equal(seenBodies.length, 1);
  assert.equal(seenBodies[0].empid, "7083340315");
  assert.equal(seenBodies[0].iai_tag, "phoenix-desktop");
  assert.match(seenBodies[0].message_id, UUID_V4ISH_RE);
});

test("DirectLlmClient normalizes legacy request_id to UUID before upstream call", async () => {
  const seenBodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            data: [
              {
                provider: "claude",
                modelList: [{ modelName: "claude-opus-4-6", visible: true }]
              }
            ]
          };
        }
      };
    }

    if (String(url).includes("/generateContent")) {
      seenBodies.push(JSON.parse(options.body || "{}"));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error("Unexpected URL: " + url);
  };

  const client = new DirectLlmClient({
    authMode: "env",
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    requestTimeoutMs: 1000,
    fetchImpl,
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token: "token_123",
          source: "env",
          user: { id: "7083340315" }
        };
      }
    }
  });

  await client.run({
    model: "claude-opus-4-6",
    requestBody: {
      model: "claude-opus-4-6",
      requestId: "anthropic-legacy-id",
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    }
  });

  assert.equal(seenBodies.length, 1);
  assert.match(seenBodies[0].request_id, UUID_V4ISH_RE);
  assert.notEqual(seenBodies[0].request_id, "anthropic-legacy-id");
  assert.match(seenBodies[0].message_id, UUID_V4ISH_RE);
});


test("DirectLlmClient resolves against gateway models and falls back to opus", async () => {
  const seenModels = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              {
                provider: 'openai',
                modelList: [
                  { modelName: 'gpt-5.4', visible: true }
                ]
              },
              {
                provider: 'claude',
                modelList: [
                  { modelName: 'claude-opus-4-6', visible: true }
                ]
              }
            ]
          };
        }
      };
    }

    if (String(url).includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenModels.push(body.model);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + url);
  };

  const client = new DirectLlmClient({
    authMode: 'env',
    authProvider: {
      resolveCredential() {
        return {
          accountId: 'acct_primary',
          token: 'token_123',
          source: 'env'
        };
      }
    },
    requestTimeoutMs: 1000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const first = await client.run({ model: 'gpt-5.4', requestBody: { model: 'gpt-5.4' } });
  const second = await client.run({ model: 'missing-model', requestBody: { model: 'missing-model' } });

  assert.equal(first.resolvedProviderModel, 'gpt-5.4');
  assert.equal(second.resolvedProviderModel, 'claude-opus-4-6');
  assert.deepEqual(seenModels, ['gpt-5.4', 'claude-opus-4-6']);
});


test("DirectLlmClient skips a saturated account before generateContent when another account is available", async () => {
  const seen = [];
  const decisions = [];
  const invalidUntilById = new Map();
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has("acct_full")) {
        return {
          accountId: "acct_full",
          accountName: "Full",
          token: "token_full",
          cookie: "cna=full-cna",
          source: "accounts-file"
        };
      }

      if (!excluded.has("acct_ok")) {
        return {
          accountId: "acct_ok",
          accountName: "Okay",
          token: "token_ok",
          cookie: "cna=ok-cna",
          source: "accounts-file"
        };
      }

      return null;
    },
    listCredentials() {
      return [
        {
          accountId: "acct_full",
          accountName: "Full",
          token: "token_full",
          cookie: "cna=full-cna",
          source: "accounts-file"
        },
        {
          accountId: "acct_ok",
          accountName: "Okay",
          token: "token_ok",
          cookie: "cna=ok-cna",
          source: "accounts-file"
        }
      ];
    },
    isAccountUsable(accountId) {
      return (invalidUntilById.get(accountId) || 0) <= Date.now();
    },
    invalidateAccountUntil(accountId, untilMs) {
      invalidUntilById.set(accountId, Number(untilMs || 0));
    }
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('/api/entitlement/quota')) {
      const parsed = new URL(value);
      const token = parsed.searchParams.get('accessToken');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: token === 'token_full' || token === 'token_full_new' ? 100 : 20,
              refreshCountdownSeconds: 3600
            }
          };
        }
      };
    }

    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              { provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }
            ]
          };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seen.push(body.token);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{\"content\":{\"parts\":[{\"text\":\"ok\"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const result = await client.run(
    { model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } },
    { onDecision(event) { decisions.push(event); } }
  );

  assert.equal(result.accountId, 'acct_ok');
  assert.deepEqual(seen, ['token_ok']);
  assert.ok(decisions.some((event) => event.type === 'account_failover' && event.accountId === 'acct_full' && /quota precheck skipped/.test(event.reason || '')));
});

test("DirectLlmClient cools down a saturated account until refresh time instead of rechecking every request", async () => {
  const quotaRequests = [];
  const invalidUntilById = new Map();
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      const candidates = [
        {
          accountId: 'acct_full',
          accountName: 'Full',
          token: 'token_full',
          cookie: 'cna=full-cna',
          source: 'accounts-file'
        },
        {
          accountId: 'acct_ok',
          accountName: 'Okay',
          token: 'token_ok',
          cookie: 'cna=ok-cna',
          source: 'accounts-file'
        }
      ];

      return candidates.find((candidate) => {
        const invalidUntil = invalidUntilById.get(candidate.accountId) || 0;
        return !excluded.has(candidate.accountId) && invalidUntil <= Date.now();
      }) || null;
    },
    listCredentials() {
      return [
        {
          accountId: 'acct_full',
          accountName: 'Full',
          token: 'token_full',
          cookie: 'cna=full-cna',
          source: 'accounts-file'
        },
        {
          accountId: 'acct_ok',
          accountName: 'Okay',
          token: 'token_ok',
          cookie: 'cna=ok-cna',
          source: 'accounts-file'
        }
      ].filter((candidate) => (invalidUntilById.get(candidate.accountId) || 0) <= Date.now());
    },
    isAccountUsable(accountId) {
      return (invalidUntilById.get(accountId) || 0) <= Date.now();
    },
    invalidateAccountUntil(accountId, untilMs) {
      invalidUntilById.set(accountId, Number(untilMs || 0));
    }
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('/api/entitlement/quota')) {
      const parsed = new URL(value);
      const token = parsed.searchParams.get('accessToken');
      quotaRequests.push(token);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: token === 'token_full' ? 100 : 20,
              refreshCountdownSeconds: 3600
            }
          };
        }
      };
    }

    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              { provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }
            ]
          };
        }
      };
    }

    if (value.includes('/generateContent')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  await client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } });
  await client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } });

  assert.equal(quotaRequests.filter((token) => token === 'token_full').length, 1);
  assert.ok(quotaRequests.filter((token) => token === 'token_ok').length >= 1);
  assert.ok((invalidUntilById.get('acct_full') || 0) > Date.now());
});

test("DirectLlmClient standby refresh syncs quota probe failures back to auth provider", async () => {
  const failures = [];
  const invalidations = [];
  const authProvider = {
    listCredentials() {
      return [
        {
          accountId: 'acct_blocked',
          accountName: 'Blocked',
          token: 'token_blocked',
          cookie: 'cna=blocked-cna',
          source: 'accounts-file'
        }
      ];
    },
    getConfiguredAccounts() {
      return [
        {
          id: 'acct_blocked',
          name: 'Blocked',
          accessToken: 'token_blocked',
          cookie: 'cna=blocked-cna',
          source: 'accounts-file',
          enabled: true
        }
      ];
    },
    isAccountUsable() {
      return true;
    },
    getInvalidUntil() {
      return null;
    },
    getLastFailure() {
      return null;
    },
    recordFailure(accountId, error) {
      failures.push({ accountId, reason: error.message || String(error) });
    },
    invalidateAccountUntil(accountId, untilMs, reason) {
      invalidations.push({ accountId, untilMs, reason });
    },
    clearFailure() {},
    clearInvalidation() {}
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    accountStandbyRefreshMs: 10000,
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/entitlement/quota')) {
        throw new Error('Quota request failed: user blocked');
      }

      throw new Error('Unexpected URL: ' + value);
    }
  });

  const prepared = await client.refreshPreparedCredentials();

  assert.deepEqual(prepared, []);
  assert.deepEqual(failures, [
    {
      accountId: 'acct_blocked',
      reason: 'Quota request failed: user blocked'
    }
  ]);
  assert.equal(invalidations.length, 1);
  assert.equal(invalidations[0].accountId, 'acct_blocked');
  assert.match(String(invalidations[0].reason || ''), /user blocked/);
  assert.ok(Number(invalidations[0].untilMs) > Date.now());
  assert.equal(client._standbyCooldownCredentials.length, 1);
  assert.match(String(client._standbyCooldownCredentials[0].reason || ''), /user blocked/);
});

test("DirectLlmClient standby refresh clears stale auth-provider failures after a successful quota probe", async () => {
  const clearedFailures = [];
  const clearedInvalidations = [];
  const authProvider = {
    listCredentials() {
      return [
        {
          accountId: 'acct_recovered',
          accountName: 'Recovered',
          token: 'token_recovered',
          cookie: 'cna=recovered-cna',
          source: 'accounts-file'
        }
      ];
    },
    getConfiguredAccounts() {
      return [
        {
          id: 'acct_recovered',
          name: 'Recovered',
          accessToken: 'token_recovered',
          cookie: 'cna=recovered-cna',
          source: 'accounts-file',
          enabled: true
        }
      ];
    },
    isAccountUsable() {
      return true;
    },
    getInvalidUntil() {
      return null;
    },
    getLastFailure() {
      return {
        at: '2026-04-09T10:00:00.000Z',
        reason: 'blocked by sentinel rate limit'
      };
    },
    recordFailure() {},
    invalidateAccountUntil() {},
    clearFailure(accountId) {
      clearedFailures.push(accountId);
    },
    clearInvalidation(accountId) {
      clearedInvalidations.push(accountId);
    }
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/entitlement/quota')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: {
                usagePercent: 12,
                refreshCountdownSeconds: 1800
              }
            };
          }
        };
      }

      throw new Error('Unexpected URL: ' + value);
    }
  });

  const prepared = await client.refreshPreparedCredentials();

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].accountId, 'acct_recovered');
  assert.deepEqual(clearedFailures, ['acct_recovered']);
  assert.deepEqual(clearedInvalidations, ['acct_recovered']);
});

test("DirectLlmClient replays auth callback before using the next file account after quota failover", async () => {
  const seenTokens = [];
  let currentGatewayUserId = 'user_full';
  const invalidUntilById = new Map();
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has('acct_full')) {
        return {
          accountId: 'acct_full',
          accountName: 'Full',
          token: 'token_full',
          refreshToken: 'refresh_full',
          cookie: 'cna=full-cna',
          user: { id: 'user_full', name: 'Full' },
          source: 'accounts-file'
        };
      }

      if (!excluded.has('acct_ok')) {
        return {
          accountId: 'acct_ok',
          accountName: 'Okay',
          token: 'token_ok',
          refreshToken: 'refresh_ok',
          cookie: 'cna=ok-cna',
          user: { id: 'user_ok', name: 'Okay' },
          source: 'accounts-file'
        };
      }

      return null;
    },
    listCredentials() {
      return [
        {
          accountId: 'acct_full',
          accountName: 'Full',
          token: 'token_full',
          refreshToken: 'refresh_full',
          cookie: 'cna=full-cna',
          user: { id: 'user_full', name: 'Full' },
          source: 'accounts-file'
        },
        {
          accountId: 'acct_ok',
          accountName: 'Okay',
          token: 'token_ok',
          refreshToken: 'refresh_ok',
          cookie: 'cna=ok-cna',
          user: { id: 'user_ok', name: 'Okay' },
          source: 'accounts-file'
        }
      ].filter((candidate) => (invalidUntilById.get(candidate.accountId) || 0) <= Date.now());
    },
    isAccountUsable(accountId) {
      return (invalidUntilById.get(accountId) || 0) <= Date.now();
    },
    invalidateAccountUntil(accountId, untilMs) {
      invalidUntilById.set(accountId, Number(untilMs || 0));
    },
    recordFailure() {},
    invalidateAccount() {},
    clearFailure() {},
    clearInvalidation() {}
  };

  const gatewayManager = {
    baseUrl: 'http://127.0.0.1:4097',
    ensureStarted: async () => {},
    waitMs: 2000,
    pollMs: 10
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);

    if (value.endsWith('/auth/status')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            authenticated: true,
            user: currentGatewayUserId ? { id: currentGatewayUserId, name: currentGatewayUserId } : null
          };
        }
      };
    }

    if (value.endsWith('/auth/logout')) {
      currentGatewayUserId = '';
      return {
        ok: true,
        status: 200,
        async text() {
          return '{}';
        }
      };
    }

    if (value.includes('/auth/callback?')) {
      const parsed = new URL(value);
      const refreshToken = parsed.searchParams.get('refreshToken');
      currentGatewayUserId = refreshToken === 'refresh_ok_new' ? 'user_ok' : 'user_full';
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async text() {
          return 'ok';
        }
      };
    }

    if (value.includes('/api/auth/refresh_token')) {
      const body = JSON.parse(options.body || '{}');
      const isOkAccount = body.refreshToken === 'refresh_ok' || body.refreshToken === 'refresh_ok_new';
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              accessToken: isOkAccount ? 'token_ok_new' : 'token_full_new',
              refreshToken: isOkAccount ? 'refresh_ok_new' : 'refresh_full_new',
              expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
              userId: isOkAccount ? 'user_ok' : 'user_full'
            }
          });
        }
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      const parsed = new URL(value);
      const token = parsed.searchParams.get('accessToken');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: token === 'token_full' || token === 'token_full_new' ? 100 : 20,
              refreshCountdownSeconds: 3600
            }
          };
        }
      };
    }

    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              { provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }
            ]
          };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenTokens.push(body.token);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    gatewayManager,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const result = await client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } });

  assert.equal(result.accountId, 'acct_ok');
  assert.deepEqual(seenTokens, ['token_ok_new']);
});

test("DirectLlmClient uses prepared standby queue during failover instead of re-resolving candidates", async () => {
  let resolveCalls = 0;
  const authProvider = {
    resolveCredential() {
      resolveCalls++;
      return {
        accountId: "acct_full",
        accountName: "Full",
        token: "token_full",
        source: "accounts-file"
      };
    },
    isAccountUsable(accountId) {
      return accountId === "acct_ok";
    }
  };

  const client = new DirectLlmClient({
    authMode: "file",
    authProvider,
    quotaPreflightEnabled: true,
    accountStandbyEnabled: true
  });

  client._preparedCredentials = [
    {
      accountId: "acct_ok",
      accountName: "Okay",
      token: "token_ok",
      refreshToken: "refresh_ok",
      cookie: "cna=ok-cna",
      user: { id: "user_ok", name: "Okay" },
      source: "accounts-file"
    }
  ];

  const credential = await client.getAuthToken({
    excludeIds: ["acct_full"]
  });

  assert.equal(credential.accountId, "acct_ok");
  assert.equal(resolveCalls, 0);
});

test("DirectLlmClient prefers prepared standby credential on normal path before resolving file accounts", async () => {
  let resolveCalls = 0;
  const authProvider = {
    resolveCredential() {
      resolveCalls++;
      return {
        accountId: "acct_active",
        accountName: "Active",
        token: "token_active",
        source: "accounts-file"
      };
    },
    isAccountUsable(accountId) {
      return accountId === "acct_ready" || accountId === "acct_active";
    }
  };

  const client = new DirectLlmClient({
    authMode: "file",
    authProvider,
    quotaPreflightEnabled: true,
    accountStandbyEnabled: true
  });

  client._preparedCredentials = [
    {
      accountId: "acct_ready",
      accountName: "Ready",
      token: "token_ready",
      refreshToken: "refresh_ready",
      cookie: "cna=ready-cna",
      user: { id: "user_ready", name: "Ready" },
      source: "accounts-file"
    }
  ];

  const credential = await client.getAuthToken();

  assert.equal(credential.accountId, "acct_ready");
  assert.equal(resolveCalls, 0);
});

test("DirectLlmClient keeps using the current serving account across requests when it remains healthy", async () => {
  let resolveCalls = 0;
  const seenTokens = [];
  const authProvider = {
    resolveCredential() {
      resolveCalls++;
      return resolveCalls === 1
        ? {
            accountId: "acct_a",
            accountName: "Account A",
            token: "token_a",
            source: "accounts-file"
          }
        : {
            accountId: "acct_b",
            accountName: "Account B",
            token: "token_b",
            source: "accounts-file"
          };
    },
    isAccountUsable() {
      return true;
    }
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);

    if (value.endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            data: [
              { provider: "claude", modelList: [{ modelName: "claude-opus-4-6", visible: true }] }
            ]
          };
        }
      };
    }

    if (value.includes("/generateContent")) {
      const body = JSON.parse(options.body || "{}");
      seenTokens.push(body.token);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error("Unexpected URL: " + value);
  };

  const client = new DirectLlmClient({
    authMode: "file",
    authProvider,
    quotaPreflightEnabled: false,
    requestTimeoutMs: 1000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: "http://127.0.0.1:4097",
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    fetchImpl
  });

  await client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } });
  await client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } });

  assert.equal(resolveCalls, 1);
  assert.deepEqual(seenTokens, ["token_a", "token_a"]);
  assert.equal(client.getStandbyState().currentAccountId, "acct_a");
});

test("DirectLlmClient refreshes standby queue on failover and does not fall back to direct traversal", async () => {
  let resolveCalls = 0;
  let listCalls = 0;
  const invalidated = [];
  const authProvider = {
    resolveCredential() {
      resolveCalls++;
      return {
        accountId: "acct_full",
        accountName: "Full",
        token: "token_full",
        source: "accounts-file"
      };
    },
    listCredentials() {
      listCalls++;
      return [
        {
          accountId: "acct_full",
          accountName: "Full",
          token: "token_full",
          source: "accounts-file"
        },
        {
          accountId: "acct_ok",
          accountName: "Okay",
          token: "token_ok",
          source: "accounts-file"
        }
      ];
    },
    isAccountUsable(accountId) {
      return !invalidated.find((item) => item.accountId === accountId);
    },
    invalidateAccountUntil(accountId, untilMs, reason) {
      invalidated.push({ accountId, untilMs, reason });
    }
  };

  const client = new DirectLlmClient({
    authMode: "file",
    authProvider,
    quotaPreflightEnabled: true,
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      const token = parsed.searchParams.get("accessToken");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: token === "token_full" ? 100 : 18,
              refreshCountdownSeconds: 600
            }
          };
        }
      };
    }
  });

  const credential = await client.getAuthToken({
    excludeIds: ["acct_full"]
  });

  assert.equal(credential.accountId, "acct_ok");
  assert.equal(resolveCalls, 0);
  assert.equal(listCalls, 1);
  assert.deepEqual(invalidated.map((item) => item.accountId), ["acct_full"]);
});

test("DirectLlmClient quota preflight sends the full cookie header for account-scoped quota", async () => {
  const seenHeaders = [];
  const client = new DirectLlmClient({
    authMode: "file",
    authProvider: {
      resolveCredential() {
        return null;
      }
    },
    quotaPreflightEnabled: true,
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm",
    fetchImpl: async (url, options = {}) => {
      seenHeaders.push(options.headers || {});
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: 12,
              refreshCountdownSeconds: 180
            }
          };
        }
      };
    }
  });

  const quota = await client.fetchQuotaStatus({
    accountId: "acct_cookie",
    token: "shared_token",
    cookie: "cna%3Dcookie-cna%3B%20session%3Dacct-1"
  });

  assert.equal(quota.available, true);
  assert.equal(seenHeaders.length, 1);
  assert.equal(seenHeaders[0]["x-cna"], "cookie-cna");
  assert.equal(seenHeaders[0].cookie, "cna=cookie-cna; session=acct-1");
});

test("DirectLlmClient cools down gateway auth after quota precheck and skips later direct attempts", async () => {
  let gatewayTokenRequests = 0;
  let quotaRequests = 0;
  let generateRequests = 0;

  const fetchImpl = async (url) => {
    const value = String(url);

    if (value.includes('/api/entitlement/quota')) {
      quotaRequests++;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              usagePercent: 100,
              refreshCountdownSeconds: 3600
            }
          };
        }
      };
    }

    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              { provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }
            ]
          };
        }
      };
    }

    if (value.includes('/generateContent')) {
      generateRequests++;
      throw new Error('generateContent should be skipped while gateway quota is exhausted');
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'auto',
    authProvider: {
      resolveCredential() {
        return null;
      }
    },
    gatewayManager: {
      async resolveAccessToken() {
        gatewayTokenRequests++;
        return {
          token: 'gateway_token',
          source: 'gateway'
        };
      }
    },
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  await assert.rejects(
    () => client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } }),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /gateway cooling down|quota exhausted/i);
      return true;
    }
  );

  await assert.rejects(
    () => client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } }),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /gateway cooling down|quota exhausted/i);
      return true;
    }
  );

  assert.equal(gatewayTokenRequests, 1);
  assert.equal(quotaRequests, 1);
  assert.equal(generateRequests, 0);
});

test("DirectLlmClient does not quota-skip an explicitly requested account", async () => {
  const seen = [];
  const authProvider = {
    resolveCredential(options = {}) {
      if (options.accountId === 'acct_full') {
        return {
          accountId: 'acct_full',
          accountName: 'Full',
          token: 'token_full',
          cookie: 'cna=full-cna',
          source: 'accounts-file'
        };
      }
      return null;
    }
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { data: [{ provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }] };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seen.push(body.token);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{\"content\":{\"parts\":[{\"text\":\"ok\"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      throw new Error('quota endpoint should not be called for explicit account');
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const result = await client.run({ model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } }, { accountId: 'acct_full' });

  assert.equal(result.accountId, 'acct_full');
  assert.deepEqual(seen, ['token_full']);
});

test("DirectLlmClient transparently retries a stream failure before any output is emitted", async () => {
  const decisions = [];
  const events = [];
  const seenTokens = [];
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has('acct_first')) {
        return {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        };
      }
      if (!excluded.has('acct_second')) {
        return {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        };
      }
      return null;
    },
    listCredentials() {
      return [
        {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        },
        {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        }
      ];
    },
    isAccountUsable() {
      return true;
    },
    recordFailure() {},
    invalidateAccount() {},
    clearFailure() {},
    clearInvalidation() {}
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { data: [{ provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }] };
        }
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: { usagePercent: 20, refreshCountdownSeconds: 3600 } };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenTokens.push(body.token);
      if (body.token === 'token_first') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data:{"error_code":"429","error_message":"quota exceeded"}\n\n'));
              controller.close();
            }
          })
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok from retry"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const result = await client.run(
    { model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } },
    {
      onDecision(event) {
        decisions.push(event);
      },
      onEvent(event) {
        events.push(event);
      }
    }
  );

  assert.equal(result.accountId, 'acct_second');
  assert.equal(result.finalText, 'ok from retry');
  assert.deepEqual(seenTokens, ['token_first', 'token_second']);
  assert.deepEqual(events, [{ type: 'text_delta', text: 'ok from retry' }]);
  assert.ok(decisions.some((event) => event.type === 'account_failover' && event.accountId === 'acct_first' && event.phase === 'stream' && event.responseStarted === false));
});

test("DirectLlmClient retries one timeout on the same account before failing over", async () => {
  const decisions = [];
  const seenTokens = [];
  const invalidations = [];
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has('acct_first')) {
        return {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        };
      }
      if (!excluded.has('acct_second')) {
        return {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        };
      }
      return null;
    },
    listCredentials() {
      return [
        {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        },
        {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        }
      ];
    },
    isAccountUsable() {
      return true;
    },
    recordFailure() {},
    invalidateAccount(accountId, reason) {
      invalidations.push({ accountId, reason });
    },
    clearFailure() {},
    clearInvalidation() {}
  };

  const fetchAttempts = new Map();
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { data: [{ provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }] };
        }
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: { usagePercent: 20, refreshCountdownSeconds: 3600 } };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      const token = body.token;
      seenTokens.push(token);
      const attempt = Number(fetchAttempts.get(token) || 0) + 1;
      fetchAttempts.set(token, attempt);

      if (token === 'token_first') {
        throw new Error('The operation was aborted due to timeout');
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok after timeout failover"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const result = await client.run(
    { model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } },
    {
      onDecision(event) {
        decisions.push(event);
      }
    }
  );

  assert.equal(result.accountId, 'acct_second');
  assert.equal(result.finalText, 'ok after timeout failover');
  assert.deepEqual(seenTokens, ['token_first', 'token_first', 'token_second']);
  assert.ok(decisions.some((event) => event.type === 'same_account_retry' && event.accountId === 'acct_first' && event.phase === 'fetch' && event.retryAttempt === 1));
  assert.ok(decisions.some((event) => event.type === 'account_failover' && event.accountId === 'acct_first' && event.phase === 'fetch' && event.responseStarted === false));
  assert.ok(invalidations.some((entry) => entry.accountId === 'acct_first' && /timeout/i.test(entry.reason)));
});

test("DirectLlmClient does not transparently retry once stream output has started", async () => {
  const decisions = [];
  const events = [];
  const seenTokens = [];
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has('acct_first')) {
        return {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        };
      }
      if (!excluded.has('acct_second')) {
        return {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        };
      }
      return null;
    },
    recordFailure() {},
    invalidateAccount() {},
    clearFailure() {},
    clearInvalidation() {}
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { data: [{ provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }] };
        }
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: { usagePercent: 20, refreshCountdownSeconds: 3600 } };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenTokens.push(body.token);
      if (body.token === 'token_first') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"partial"}]}}\n\n'));
              controller.enqueue(new TextEncoder().encode('data:{"error_code":"429","error_message":"quota exceeded"}\n\n'));
              controller.close();
            }
          })
        };
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"should not happen"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  await assert.rejects(
    () => client.run(
      { model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } },
      {
        onDecision(event) {
          decisions.push(event);
        },
        onEvent(event) {
          events.push(event);
        }
      }
    ),
    (error) => {
      assert.ok(error instanceof UpstreamSseError);
      assert.equal(error.status, 429);
      return true;
    }
  );

  assert.deepEqual(seenTokens, ['token_first']);
  assert.deepEqual(events, [{ type: 'text_delta', text: 'partial' }]);
  assert.ok(decisions.some((event) => event.type === 'account_failover_blocked' && event.accountId === 'acct_first' && event.phase === 'stream' && event.responseStarted === true));
});

test("DirectLlmClient surfaces content risk rejection without poisoning the account pool", async () => {
  const decisions = [];
  const seenTokens = [];
  const invalidations = [];
  const failures = [];
  const authProvider = {
    resolveCredential(options = {}) {
      const excluded = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
      if (!excluded.has('acct_first')) {
        return {
          accountId: 'acct_first',
          accountName: 'First',
          token: 'token_first',
          cookie: 'cna=first-cna',
          source: 'accounts-file'
        };
      }
      if (!excluded.has('acct_second')) {
        return {
          accountId: 'acct_second',
          accountName: 'Second',
          token: 'token_second',
          cookie: 'cna=second-cna',
          source: 'accounts-file'
        };
      }
      return null;
    },
    recordFailure(accountId, error) {
      failures.push({ accountId, reason: error && error.message ? error.message : String(error) });
    },
    invalidateAccount(accountId, reason) {
      invalidations.push({ accountId, reason });
    },
    clearFailure() {},
    clearInvalidation() {}
  };

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return { data: [{ provider: 'claude', modelList: [{ modelName: 'claude-opus-4-6', visible: true }] }] };
        }
      };
    }

    if (value.includes('/api/entitlement/quota')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: { usagePercent: 20, refreshCountdownSeconds: 3600 } };
        }
      };
    }

    if (value.includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenTokens.push(body.token);
      if (body.token === 'token_first') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data:{"error_code":"400","error_message":"content risk rejected"}\n\n'));
              controller.close();
            }
          })
        };
      }

      throw new Error('Second account should not be attempted for request-scoped rejection');
    }

    throw new Error('Unexpected URL: ' + value);
  };

  const client = new DirectLlmClient({
    authMode: 'file',
    authProvider,
    requestTimeoutMs: 1000,
    quotaPreflightEnabled: true,
    quotaCacheTtlMs: 30000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  await assert.rejects(
    () => client.run(
      { model: 'claude-opus-4-6', requestBody: { model: 'claude-opus-4-6' } },
      {
        onDecision(event) {
          decisions.push(event);
        }
      }
    ),
    (error) => {
      assert.ok(error instanceof UpstreamSseError);
      assert.equal(error.status, 400);
      assert.equal(error.type, 'invalid_request_error');
      assert.equal(error.message, 'content risk rejected');
      return true;
    }
  );

  assert.deepEqual(seenTokens, ['token_first']);
  assert.equal(decisions.some((event) => event.type === 'account_failover'), false);
  assert.deepEqual(invalidations, []);
  assert.deepEqual(failures, []);
});


test("_computeInvalidationUntilMs returns short cooldown for 401 auth errors", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: { resolveCredential() { return null; } },
    upstreamBaseUrl: "https://example.test"
  });

  const error401 = { status: 401, message: "unauthorized" };
  const until401 = client._computeInvalidationUntilMs(error401);
  const expected401 = Date.now() + 15 * 1000;
  assert.ok(until401 >= expected401 - 100 && until401 <= expected401 + 100,
    `401 should get ~15s cooldown, got ${until401 - Date.now()}ms`);

  const error403 = { status: 403, message: "forbidden" };
  const until403 = client._computeInvalidationUntilMs(error403);
  const expected403 = Date.now() + 15 * 1000;
  assert.ok(until403 >= expected403 - 100 && until403 <= expected403 + 100,
    `403 should get ~15s cooldown, got ${until403 - Date.now()}ms`);
});


test("_computeInvalidationUntilMs returns short cooldown for connection errors", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: { resolveCredential() { return null; } },
    upstreamBaseUrl: "https://example.test"
  });

  const connRefused = { status: 0, code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
  const untilRefused = client._computeInvalidationUntilMs(connRefused);
  const expected = Date.now() + 20 * 1000;
  assert.ok(untilRefused >= expected - 100 && untilRefused <= expected + 100,
    `ECONNREFUSED should get ~20s cooldown, got ${untilRefused - Date.now()}ms`);

  const fetchFailed = { message: "fetch failed" };
  const untilFetch = client._computeInvalidationUntilMs(fetchFailed);
  assert.ok(untilFetch >= expected - 200 && untilFetch <= expected + 200,
    `fetch failed should get ~20s cooldown`);
});


test("_computeInvalidationUntilMs still returns null for unknown errors (5min default)", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: { resolveCredential() { return null; } },
    upstreamBaseUrl: "https://example.test"
  });

  const unknownError = { status: 500, message: "internal server error" };
  const result = client._computeInvalidationUntilMs(unknownError);
  assert.equal(result, null, "unknown 500 errors should fall through to default 5min");
});


test("hasReadyAccounts returns true when current serving credential exists", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() { return []; },
      isAccountUsable() { return false; }
    },
    upstreamBaseUrl: "https://example.test"
  });

  // No serving credential → should check prepared and auth provider
  assert.equal(client.hasReadyAccounts(), false);

  // Set a serving credential
  client._currentServingCredential = { accountId: "test-acct" };
  assert.equal(client.hasReadyAccounts(), true);
});


test("hasReadyAccounts returns true when prepared credentials exist", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() { return []; },
      isAccountUsable() { return false; }
    },
    upstreamBaseUrl: "https://example.test"
  });

  client._preparedCredentials = [{ accountId: "prepared-acct" }];
  assert.equal(client.hasReadyAccounts(), true);
});


test("hasReadyAccounts falls back to auth provider usability check", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() {
        return [
          { accountId: "acct-1" },
          { accountId: "acct-2" }
        ];
      },
      isAccountUsable(id) { return id === "acct-2"; }
    },
    upstreamBaseUrl: "https://example.test"
  });

  assert.equal(client.hasReadyAccounts(), true);
});

test("hasReadyAccounts does not fall back to static usability after standby runtime state is known", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() {
        return [
          { accountId: "acct-1" },
          { accountId: "acct-2" }
        ];
      },
      isAccountUsable() { return true; }
    },
    accountStandbyEnabled: true,
    upstreamBaseUrl: "https://example.test"
  });

  client._preparedCredentialsAt = Date.now();
  client._preparedCredentials = [];
  client._standbyCooldownCredentials = [
    { accountId: "acct-1", nextCheckAt: new Date(Date.now() + 30_000).toISOString() }
  ];

  assert.equal(client.hasReadyAccounts(), false);
});


test("_nudgeStandbyLoop reschedules timer when pool is below target", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() { return []; }
    },
    upstreamBaseUrl: "https://example.test",
    accountStandbyEnabled: true,
    accountStandbyReadyTarget: 2
  });

  let timerSet = false;
  const mockRunRefresh = async () => { timerSet = true; };
  client._standbyRunRefresh = mockRunRefresh;
  client._standbyTimer = setTimeout(() => {}, 300000); // 5min timer
  client._preparedCredentials = []; // below target of 2

  client._nudgeStandbyLoop();

  // Old timer should be cancelled and new short timer set
  assert.ok(client._standbyTimer !== null, "new timer should be set");

  // Cleanup
  clearTimeout(client._standbyTimer);
});


test("_nudgeStandbyLoop does nothing when pool meets target", () => {
  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() { return null; },
      listCredentials() { return []; }
    },
    upstreamBaseUrl: "https://example.test",
    accountStandbyEnabled: true,
    accountStandbyReadyTarget: 1
  });

  const originalTimer = setTimeout(() => {}, 300000);
  const mockRunRefresh = async () => {};
  client._standbyRunRefresh = mockRunRefresh;
  client._standbyTimer = originalTimer;
  client._preparedCredentials = [{ accountId: "ready-acct" }]; // meets target

  client._nudgeStandbyLoop();

  // Timer should not have changed
  assert.equal(client._standbyTimer, originalTimer, "timer should remain unchanged");

  // Cleanup
  clearTimeout(originalTimer);
});
