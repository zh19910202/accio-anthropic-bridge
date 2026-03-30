"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionStore, resolveSessionBinding } = require("../src/session-store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-session-test-"));
}

test("SessionStore starts with empty state when no file exists", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));
  assert.deepEqual(store.state.sessions, {});
  assert.equal(store.getSummary().count, 0);
});

test("SessionStore set and get roundtrip", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  store.set("sess_1", "conv_1");
  const entry = store.get("sess_1");

  assert.equal(entry.conversationId, "conv_1");
  assert.ok(entry.updatedAt);
});

test("SessionStore get returns null for unknown session", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  assert.equal(store.get("unknown"), null);
  assert.equal(store.get(null), null);
  assert.equal(store.get(""), null);
});

test("SessionStore merge adds fields to existing entry", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  store.set("sess_1", "conv_1");
  store.merge("sess_1", { accountId: "acct_1" });

  const entry = store.get("sess_1");
  assert.equal(entry.conversationId, "conv_1");
  assert.equal(entry.accountId, "acct_1");
});

test("SessionStore merge returns null for invalid input", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  assert.equal(store.merge(null, { foo: "bar" }), null);
  assert.equal(store.merge("sess_1", null), null);
});

test("SessionStore bindAccount links account to session", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  store.set("sess_1", "conv_1");
  store.bindAccount("sess_1", { accountId: "acct_1", accountName: "primary" });

  const entry = store.get("sess_1");
  assert.equal(entry.accountId, "acct_1");
  assert.equal(entry.accountName, "primary");
});

test("SessionStore bindAccount returns null for invalid input", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  assert.equal(store.bindAccount(null, { accountId: "a" }), null);
  assert.equal(store.bindAccount("sess_1", {}), null);
});

test("SessionStore getSummary returns correct counts", () => {
  const dir = makeTempDir();
  const store = new SessionStore(path.join(dir, "sessions.json"));

  store.set("sess_1", "conv_1");
  store.set("sess_2", "conv_2");
  store.bindAccount("sess_1", { accountId: "acct_1" });

  const summary = store.getSummary();
  assert.equal(summary.count, 2);
  assert.equal(summary.accountBoundCount, 1);
  assert.equal(summary.conversationBoundCount, 2);
});

test("SessionStore persists and reloads state", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "sessions.json");

  const store1 = new SessionStore(filePath);
  store1.set("sess_1", "conv_1");
  store1.flushSync();

  const store2 = new SessionStore(filePath);
  const entry = store2.get("sess_1");
  assert.equal(entry.conversationId, "conv_1");
});

test("resolveSessionBinding extracts from headers", () => {
  const result = resolveSessionBinding(
    { "x-accio-conversation-id": "conv_1", "x-accio-session-id": "sess_1" },
    {},
    "anthropic"
  );
  assert.equal(result.conversationId, "conv_1");
  assert.equal(result.sessionId, "sess_1");
});

test("resolveSessionBinding extracts from body metadata", () => {
  const result = resolveSessionBinding(
    {},
    { metadata: { conversation_id: "conv_2", session_id: "sess_2" } },
    "anthropic"
  );
  assert.equal(result.conversationId, "conv_2");
  assert.equal(result.sessionId, "sess_2");
});

test("resolveSessionBinding extracts sessionId from x-session-id", () => {
  const result = resolveSessionBinding(
    { "x-session-id": "sess_3" },
    {},
    "openai"
  );
  assert.equal(result.sessionId, "sess_3");
});

test("resolveSessionBinding falls back to body.user for openai", () => {
  const result = resolveSessionBinding({}, { user: "user_123" }, "openai");
  assert.equal(result.sessionId, "user_123");
});

test("resolveSessionBinding returns nulls for empty input", () => {
  const result = resolveSessionBinding({}, {}, "anthropic");
  assert.equal(result.conversationId, null);
  assert.equal(result.sessionId, null);
});
