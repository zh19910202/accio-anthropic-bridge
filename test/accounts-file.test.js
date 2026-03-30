"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadAccountsFile,
  findStoredAccountAuthPayload,
  writeAccountToFile
} = require("../src/accounts-file");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-accounts-test-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

test("loadAccountsFile returns empty defaults when file does not exist", () => {
  const dir = makeTempDir();
  const result = loadAccountsFile(path.join(dir, "nonexistent.json"));
  assert.deepEqual(result.accounts, []);
  assert.equal(result.strategy, "round_robin");
  assert.equal(result.activeAccount, null);
});

test("loadAccountsFile loads array-format accounts file", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");
  writeJson(filePath, [
    { id: "acct_1", accessToken: "token_1", enabled: true }
  ]);

  const result = loadAccountsFile(filePath);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].id, "acct_1");
  assert.equal(result.strategy, "round_robin");
});

test("loadAccountsFile loads object-format accounts file", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");
  writeJson(filePath, {
    strategy: "random",
    activeAccount: "acct_2",
    accounts: [
      { id: "acct_1", accessToken: "token_1" },
      { id: "acct_2", accessToken: "token_2" }
    ]
  });

  const result = loadAccountsFile(filePath);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.strategy, "random");
  assert.equal(result.activeAccount, "acct_2");
});

test("loadAccountsFile throws on malformed JSON", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");
  fs.writeFileSync(filePath, "{ invalid json");

  assert.throws(() => loadAccountsFile(filePath));
});

test("writeAccountToFile creates new file and writes account", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  writeAccountToFile(filePath, "acct_1", "token_1");

  const result = loadAccountsFile(filePath);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].id, "acct_1");
  assert.equal(result.accounts[0].accessToken, "token_1");
  assert.equal(result.accounts[0].enabled, true);
});

test("writeAccountToFile updates existing account", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  writeAccountToFile(filePath, "acct_1", "token_v1");
  writeAccountToFile(filePath, "acct_1", "token_v2");

  const result = loadAccountsFile(filePath);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accessToken, "token_v2");
});

test("writeAccountToFile preserves other accounts", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  writeJson(filePath, {
    strategy: "round_robin",
    accounts: [{ id: "acct_1", accessToken: "token_1" }]
  });

  writeAccountToFile(filePath, "acct_2", "token_2");

  const result = loadAccountsFile(filePath);
  assert.equal(result.accounts.length, 2);
});

test("writeAccountToFile preserves strategy and activeAccount", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  writeJson(filePath, {
    strategy: "random",
    activeAccount: "acct_1",
    accounts: [{ id: "acct_1", accessToken: "token_1" }]
  });

  writeAccountToFile(filePath, "acct_2", "token_2");

  const result = loadAccountsFile(filePath);
  assert.equal(result.strategy, "random");
  assert.equal(result.activeAccount, "acct_1");
});

test("findStoredAccountAuthPayload returns null when no match", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  const result = findStoredAccountAuthPayload(filePath, { accountId: "nonexistent" });
  assert.equal(result, null);
});

test("findStoredAccountAuthPayload returns null when no lookup criteria", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");

  const result = findStoredAccountAuthPayload(filePath, {});
  assert.equal(result, null);
});

test("findStoredAccountAuthPayload finds account by id and returns auth payload", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "accounts.json");
  writeJson(filePath, {
    accounts: [{
      id: "acct_1",
      accessToken: "access_tok_value",
      refreshToken: "refresh_tok_value",
      expiresAtRaw: "1800000000"
    }]
  });

  const result = findStoredAccountAuthPayload(filePath, { accountId: "acct_1" });
  assert.ok(result);
  assert.equal(result.accessToken, "access_tok_value");
  assert.equal(result.refreshToken, "refresh_tok_value");
});
