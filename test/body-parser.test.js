"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { readJsonBody } = require("../src/middleware/body-parser");

function makeRequest(body) {
  const req = new PassThrough();
  process.nextTick(() => {
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
  return req;
}

test("readJsonBody parses valid JSON", async () => {
  const body = await readJsonBody(makeRequest('{"ok":true}'), { maxBytes: 32, timeoutMs: 50 });
  assert.deepEqual(body, { ok: true });
});

test("readJsonBody rejects oversized payloads", async () => {
  await assert.rejects(
    () => readJsonBody(makeRequest('{"long":"1234567890"}'), { maxBytes: 8, timeoutMs: 50 }),
    (error) => error && error.status === 413
  );
});
