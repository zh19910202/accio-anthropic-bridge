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
