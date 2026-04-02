"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { AuthProvider } = require("../src/auth-provider");

test("AuthProvider loads file accounts and rotates round robin", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      accounts: [
        { id: "acct_a", accessToken: "token_a", enabled: true },
        { id: "acct_b", accessToken: "token_b", enabled: true }
      ]
    })
  );

  const provider = new AuthProvider({ authMode: "file", accountsPath: filePath });

  assert.equal(provider.resolveCredential().accountId, "acct_a");
  assert.equal(provider.resolveCredential().accountId, "acct_b");
});

test("AuthProvider falls back to env in auto mode when file has no usable accounts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      accounts: [{ id: "acct_disabled", accessToken: "token_x", enabled: false }]
    })
  );

  const provider = new AuthProvider({
    authMode: "auto",
    accountsPath: filePath,
    accessToken: "env_token",
    envAccountId: "env_acct"
  });

  const credential = provider.resolveCredential();
  assert.equal(credential.accountId, "env_acct");
  assert.equal(credential.source, "env");
});

test("AuthProvider invalidates accounts temporarily", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "fixed",
      accounts: [{ id: "acct_a", accessToken: "token_a", enabled: true }]
    })
  );

  const provider = new AuthProvider({ authMode: "file", accountsPath: filePath });
  provider.invalidateAccount("acct_a");

  assert.equal(provider.resolveCredential(), null);

  provider.clearInvalidation("acct_a");
  assert.equal(provider.resolveCredential().accountId, "acct_a");
});

test("AuthProvider invalidates account until a specific refresh time", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "fixed",
      accounts: [{ id: "acct_a", accessToken: "token_a", enabled: true }]
    })
  );

  const provider = new AuthProvider({ authMode: "file", accountsPath: filePath });
  provider.invalidateAccountUntil("acct_a", Date.now() + 60 * 1000, "quota refresh pending");

  assert.equal(provider.resolveCredential(), null);

  provider.invalidateAccountUntil("acct_a", Date.now() - 1000, "expired window");
  assert.equal(provider.resolveCredential().accountId, "acct_a");
});

test("AuthProvider persists invalidation cooldown across restart", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");
  const statePath = path.join(tempDir, "auth-provider-state.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "fixed",
      accounts: [{ id: "acct_a", accessToken: "token_a", enabled: true }]
    })
  );

  const provider = new AuthProvider({
    authMode: "file",
    accountsPath: filePath,
    authStatePath: statePath
  });

  provider.invalidateAccountUntil("acct_a", Date.now() + 60 * 1000, "quota refresh pending");
  provider.flushSync();

  const restarted = new AuthProvider({
    authMode: "file",
    accountsPath: filePath,
    authStatePath: statePath
  });

  assert.equal(restarted.resolveCredential(), null);
  assert.ok(restarted.getInvalidUntil("acct_a"));
});

test("AuthProvider drops expired persisted invalidation on load", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");
  const statePath = path.join(tempDir, "auth-provider-state.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "fixed",
      accounts: [{ id: "acct_a", accessToken: "token_a", enabled: true }]
    })
  );

  fs.writeFileSync(
    statePath,
    JSON.stringify({
      invalidAccounts: { acct_a: Date.now() - 1000 },
      lastFailures: {
        acct_a: {
          at: new Date().toISOString(),
          reason: "expired"
        }
      }
    })
  );

  const provider = new AuthProvider({
    authMode: "file",
    accountsPath: filePath,
    authStatePath: statePath
  });

  assert.equal(provider.resolveCredential().accountId, "acct_a");
  assert.equal(provider.getInvalidUntil("acct_a"), null);
});


test("AuthProvider prefers activeAccount over round robin", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      activeAccount: "acct_b",
      accounts: [
        { id: "acct_a", name: "acct_a", accessToken: "token_a", enabled: true, priority: 2 },
        { id: "acct_b", name: "acct_b", accessToken: "token_b", enabled: true, priority: 1 }
      ]
    })
  );

  const provider = new AuthProvider({ authMode: "file", accountsPath: filePath });
  assert.equal(provider.resolveCredential().accountId, "acct_b");
});

test("AuthProvider lists usable credentials in current rotation order without consuming it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-auth-provider-"));
  const filePath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      strategy: "round_robin",
      accounts: [
        { id: "acct_a", accessToken: "token_a", enabled: true, priority: 1 },
        { id: "acct_b", accessToken: "token_b", enabled: true, priority: 2 },
        { id: "acct_c", accessToken: "token_c", enabled: true, priority: 3 }
      ]
    })
  );

  const provider = new AuthProvider({ authMode: "file", accountsPath: filePath });
  assert.equal(provider.resolveCredential().accountId, "acct_a");
  assert.deepEqual(
    provider.listCredentials().map((item) => item.accountId),
    ["acct_b", "acct_c", "acct_a"]
  );
  assert.equal(provider.resolveCredential().accountId, "acct_b");
});
