"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { maskSecret, sanitizeValue, sanitizeHeaders, truncateString } = require("../src/redaction");

test("maskSecret masks non-string and empty values", () => {
  assert.equal(maskSecret(null), "***");
  assert.equal(maskSecret(undefined), "***");
  assert.equal(maskSecret(123), "***");
  assert.equal(maskSecret(""), "***");
});

test("maskSecret shows first 8 chars for long strings", () => {
  assert.equal(maskSecret("sk-ant-api03-longtoken123456"), "sk-ant-a***");
});

test("maskSecret masks short strings entirely", () => {
  assert.equal(maskSecret("short"), "***");
});

test("truncateString returns value unchanged when within limit", () => {
  assert.equal(truncateString("hello", 100), "hello");
});

test("truncateString truncates and notes char count", () => {
  const result = truncateString("abcdefghij", 5);
  assert.ok(result.startsWith("abcde"));
  assert.match(result, /truncated 5 chars/);
});

test("truncateString passes through non-string values", () => {
  assert.equal(truncateString(42, 5), 42);
  assert.equal(truncateString(null, 5), null);
});

test("sanitizeValue passes through null and primitives", () => {
  assert.equal(sanitizeValue(null), null);
  assert.equal(sanitizeValue(undefined), undefined);
  assert.equal(sanitizeValue(42), 42);
  assert.equal(sanitizeValue(true), true);
});

test("sanitizeValue masks sensitive keys in objects", () => {
  const result = sanitizeValue({
    authorization: "Bearer secret-token-12345",
    "content-type": "application/json"
  });
  assert.ok(result.authorization.includes("***"));
  assert.equal(result["content-type"], "application/json");
});

test("sanitizeValue handles nested objects with sensitive keys", () => {
  const result = sanitizeValue({
    config: {
      token: "super-secret-long-token",
      name: "test"
    }
  });
  assert.ok(result.config.token.includes("***"));
  assert.equal(result.config.name, "test");
});

test("sanitizeValue processes arrays", () => {
  const result = sanitizeValue([{ token: "long-secret-value" }, { name: "ok" }]);
  assert.equal(result.length, 2);
  assert.ok(result[0].token.includes("***"));
  assert.equal(result[1].name, "ok");
});

test("sanitizeHeaders masks sensitive headers", () => {
  const result = sanitizeHeaders({
    authorization: "Bearer secret-token",
    "x-api-key": "sk-ant-1234567890",
    "content-type": "application/json",
    cookie: "session=abc123"
  });

  assert.ok(result.authorization.includes("***"));
  assert.ok(result["x-api-key"].includes("***"));
  assert.equal(result["content-type"], "application/json");
  assert.ok(result.cookie.includes("***"));
});

test("sanitizeHeaders handles array header values", () => {
  const result = sanitizeHeaders({
    "set-cookie": ["session=abc", "csrf=xyz"]
  });
  assert.ok(result["set-cookie"].includes("***"));
});

test("sanitizeHeaders handles null and non-object input", () => {
  assert.deepEqual(sanitizeHeaders(null), {});
  assert.deepEqual(sanitizeHeaders("string"), {});
});
