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
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
});

test("buildDirectRequestFromAnthropic maps tool_result, aliased model and thinking", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "gpt-5",
    max_tokens: 512,
    thinking: {
      type: "enabled",
      budget_tokens: 256
    },
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
  assert.deepEqual(request.requestBody.thinking, {
    type: "enabled",
    budget_tokens: 256
  });
});

test("buildDirectRequestFromOpenAi maps tools into declarations and reasoning effort into thinking", () => {
  const request = buildDirectRequestFromOpenAi({
    model: "claude-opus-4-6",
    max_tokens: 1000,
    reasoning_effort: "high",
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
  assert.deepEqual(request.requestBody.thinking, {
    type: "enabled",
    budget_tokens: 800
  });
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
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              accessToken: body.refreshToken === 'refresh_ok' ? 'token_ok_new' : 'token_full_new',
              refreshToken: body.refreshToken === 'refresh_ok' ? 'refresh_ok_new' : 'refresh_full_new',
              expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
              userId: body.refreshToken === 'refresh_ok' ? 'user_ok' : 'user_full'
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
  assert.equal(currentGatewayUserId, 'user_ok');
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
