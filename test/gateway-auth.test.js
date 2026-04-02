"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGatewayAuthCallbackQuery,
  extractAuthCallbackPayloadFromSearchParams,
  deriveUpstreamGatewayBaseUrl,
  refreshAuthPayloadViaUpstream,
  waitForGatewayAuthenticatedUser
} = require("../src/gateway-auth");

test("buildGatewayAuthCallbackQuery includes optional state only when requested", () => {
  const payload = {
    accessToken: "access_1",
    refreshToken: "refresh_1",
    expiresAtRaw: "1777563533",
    cookie: "cna%3Dcookie-cna",
    state: "flow_123"
  };

  const withoutState = new URLSearchParams(buildGatewayAuthCallbackQuery(payload));
  const withState = new URLSearchParams(buildGatewayAuthCallbackQuery(payload, { includeState: true }));

  assert.equal(withoutState.get("state"), null);
  assert.equal(withState.get("state"), "flow_123");
  assert.equal(withState.get("accessToken"), "access_1");
});

test("extractAuthCallbackPayloadFromSearchParams validates and normalizes callback params", () => {
  const params = new URLSearchParams({
    accessToken: " access_1 ",
    refreshToken: " refresh_1 ",
    expiresAt: "1777563533",
    cookie: "cna%3Dcookie-cna",
    state: " flow_123 "
  });

  const payload = extractAuthCallbackPayloadFromSearchParams(params);

  assert.equal(payload.accessToken, "access_1");
  assert.equal(payload.refreshToken, "refresh_1");
  assert.equal(payload.expiresAtRaw, "1777563533");
  assert.equal(payload.expiresAtMs, 1777563533000);
  assert.equal(payload.cookie, "cna%3Dcookie-cna");
  assert.equal(payload.state, "flow_123");
  assert.equal(payload.source, "gateway-auth-callback");
});

test("deriveUpstreamGatewayBaseUrl accepts direct-llm and admin style config", () => {
  assert.equal(
    deriveUpstreamGatewayBaseUrl({ upstreamBaseUrl: "https://example.test/api/adk/llm" }),
    "https://example.test"
  );
  assert.equal(
    deriveUpstreamGatewayBaseUrl({ directLlmBaseUrl: "https://example-admin.test/api/adk/llm" }),
    "https://example-admin.test"
  );
});

test("refreshAuthPayloadViaUpstream reuses shared fetch logic and preserves auth context", async () => {
  const calls = [];
  const refreshed = await refreshAuthPayloadViaUpstream(
    {
      directLlmBaseUrl: "https://example.test/api/adk/llm",
      language: "zh"
    },
    {
      accessToken: "old_access",
      refreshToken: "old_refresh",
      cookie: "cna%3Dcookie-cna",
      user: { id: "user_1", name: "River" }
    },
    {
      utdid: "utdid_1",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              success: true,
              data: {
                accessToken: "new_access",
                refreshToken: "new_refresh",
                expiresAt: "1777563533",
                userId: "user_1"
              }
            });
          }
        };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/api/auth/refresh_token");
  assert.equal(calls[0].options.headers["x-cna"], "cookie-cna");
  assert.equal(refreshed.accessToken, "new_access");
  assert.equal(refreshed.refreshToken, "new_refresh");
  assert.equal(refreshed.expiresAtRaw, "1777563533");
  assert.equal(refreshed.expiresAtMs, 1777563533000);
  assert.deepEqual(refreshed.user, { id: "user_1", name: "River" });
});

test("waitForGatewayAuthenticatedUser polls until expected user appears", async () => {
  const states = [
    { reachable: false, authenticated: false, user: null },
    { reachable: true, authenticated: true, user: { id: "user_a" } },
    { reachable: true, authenticated: true, user: { id: "user_b" } }
  ];
  let index = 0;

  const result = await waitForGatewayAuthenticatedUser(
    async () => {
      const current = states[Math.min(index, states.length - 1)];
      index += 1;
      return current;
    },
    "user_b",
    100,
    1
  );

  assert.equal(result.user.id, "user_b");
});
