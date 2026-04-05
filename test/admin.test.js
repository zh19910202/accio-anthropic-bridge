"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { __private__ } = require("../src/routes/admin");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-admin-test-"));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("buildCodexAuthorizeUrl emits expected OpenAI OAuth parameters", () => {
  const url = new URL(__private__.buildCodexAuthorizeUrl("state_123", "challenge_456"));

  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("state"), "state_123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge_456");
});

test("parseCodexAuthorizationInput parses full callback URL", () => {
  const parsed = __private__.parseCodexAuthorizationInput("http://localhost:1455/auth/callback?code=abc123&scope=openid&state=state_123");

  assert.equal(parsed.code, "abc123");
  assert.equal(parsed.state, "state_123");
});

test("extractOpenAiAccountIdFromJwt reads chatgpt account id", () => {
  const token = makeJwt({
    email: "demo@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123"
    }
  });

  assert.equal(__private__.extractOpenAiAccountIdFromJwt(token), "acct_123");
});

test("finalizeCodexOAuthFlow upserts same OpenAI account by account_id even if remark changes", async () => {
  const dir = makeTempDir();
  const codexAccountsPath = path.join(dir, "codex-accounts.json");
  fs.writeFileSync(codexAccountsPath, JSON.stringify({
    strategy: "manual",
    activeAccount: null,
    accounts: [
      {
        id: "acct_123",
        name: "旧备注",
        enabled: true,
        priority: 1,
        source: "codex-openai-oauth",
        credentialBundle: {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "old_access",
            refresh_token: "old_refresh",
            account_id: "acct_123"
          }
        }
      }
    ]
  }, null, 2) + "\n", "utf8");

  const originalFetch = global.fetch;
  const accessToken = makeJwt({
    email: "demo@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123"
    }
  });

  global.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        access_token: accessToken,
        refresh_token: "new_refresh_token",
        expires_in: 3600,
        client_id: "client_test"
      });
    }
  });

  try {
    const result = await __private__.finalizeCodexOAuthFlow(
      {
        state: "state_123",
        verifier: "verifier_123",
        account: {
          name: "旧备注",
          model: "gpt-5.4"
        }
      },
      {
        code: "code_123",
        state: "state_123"
      },
      {
        codexAccountsPath
      },
      {
        name: "新备注"
      }
    );

    const saved = JSON.parse(fs.readFileSync(codexAccountsPath, "utf8"));
    assert.equal(saved.accounts.length, 1);
    assert.equal(saved.accounts[0].id, "acct_123");
    assert.equal(saved.accounts[0].name, "新备注");
    assert.equal(saved.accounts[0].credentialBundle.tokens.account_id, "acct_123");
    assert.equal(saved.accounts[0].credentialBundle.tokens.refresh_token, "new_refresh_token");
    assert.equal(result.accountId, "acct_123");
    assert.match(result.note, /新备注/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("syncSnapshotAccountState clears stale cooldown after quota recovers", () => {
  const invalidUntilById = new Map([["acct_1", Date.now() + 15 * 60 * 1000]]);
  const lastFailureById = new Map([["acct_1", { at: new Date().toISOString(), reason: "quota refresh pending" }]]);
  const authProvider = {
    getInvalidUntil(accountId) {
      return invalidUntilById.get(accountId) || 0;
    },
    invalidateAccountUntil(accountId, untilMs, reason) {
      invalidUntilById.set(accountId, Number(untilMs || 0));
      lastFailureById.set(accountId, { at: new Date().toISOString(), reason: String(reason || "") });
    },
    getLastFailure(accountId) {
      return lastFailureById.get(accountId) || null;
    },
    clearInvalidation(accountId) {
      invalidUntilById.delete(accountId);
    },
    clearFailure(accountId) {
      lastFailureById.delete(accountId);
    }
  };

  const snapshot = {
    alias: "acct-1",
    accountState: {
      id: "acct_1",
      invalidUntil: invalidUntilById.get("acct_1"),
      lastFailure: lastFailureById.get("acct_1")
    },
    quota: {
      available: true,
      usagePercent: 18,
      refreshCountdownSeconds: 120,
      checkedAt: new Date().toISOString()
    }
  };

  const result = __private__.syncSnapshotAccountState(authProvider, snapshot);

  assert.equal(result.accountState.invalidUntil, 0);
  assert.equal(result.accountState.lastFailure, null);
});

test("requestQuotaViaUpstream sends decoded cookie header for account-specific quota requests", async () => {
  const originalFetch = global.fetch;
  const seen = [];

  global.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), headers: options.headers || {} });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            usagePercent: 7,
            refreshCountdownSeconds: 321
          }
        });
      }
    };
  };

  try {
    const result = await __private__.requestQuotaViaUpstream(
      {
        directLlmBaseUrl: "https://example.test/api/adk/llm",
        accioHome: "/tmp/accio-missing",
        language: "zh"
      },
      {
        accessToken: "shared_token",
        cookie: "cna%3Dcookie-cna%3B%20session%3Dacct-2"
      }
    );

    assert.equal(result.usagePercent, 7);
    assert.equal(result.refreshCountdownSeconds, 321);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/entitlement\/quota\?/);
    assert.equal(seen[0].headers["x-cna"], "cookie-cna");
    assert.equal(seen[0].headers.cookie, "cna=cookie-cna; session=acct-2");
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveSnapshotQuotaForAdmin keeps inactive snapshot quota isolated from current live account", async () => {
  const dir = makeTempDir();
  const persisted = {
    available: true,
    usagePercent: 61,
    refreshCountdownSeconds: 1234,
    checkedAt: "2026-03-30T11:00:00.000Z",
    source: "snapshot-cache",
    error: null,
    stale: false
  };

  __private__.writeSnapshotQuotaState(dir, persisted);

  const result = await __private__.resolveSnapshotQuotaForAdmin(
    { directLlmBaseUrl: "https://example.test/api/adk/llm" },
    { alias: "acct_cached", dir, gatewayUser: { id: "acct_cached" } },
    { accessToken: "shared_token", cookie: "cna%3Dcookie-cna" },
    { isCurrentGatewayAccount: false }
  );

  assert.equal(result.usagePercent, 61);
  assert.equal(result.refreshCountdownSeconds, 1234);
  assert.equal(result.stale, true);
  assert.equal(result.source, "snapshot-cache");
});

test("hasSnapshotArtifactState returns true for full login-slot snapshots", () => {
  assert.equal(
    __private__.hasSnapshotArtifactState({
      metadata: {
        artifacts: [
          { relativePath: "credentials.enc" },
          { relativePath: "Local Storage" },
          { relativePath: "Session Storage" }
        ]
      }
    }),
    true
  );
});

test("hasSnapshotArtifactState returns false for legacy auth-callback-only snapshots", () => {
  assert.equal(
    __private__.hasSnapshotArtifactState({
      metadata: {
        artifacts: [
          { relativePath: "credentials.json" }
        ]
      }
    }),
    false
  );
});
