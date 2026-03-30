"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeRequestedModel } = require("../src/model");
const { generateId } = require("../src/id");
const { delay } = require("../src/utils");

describe("normalizeRequestedModel", () => {
  it("returns null for empty string", () => {
    assert.equal(normalizeRequestedModel(""), null);
  });

  it("returns null for null/undefined", () => {
    assert.equal(normalizeRequestedModel(null), null);
    assert.equal(normalizeRequestedModel(undefined), null);
  });

  it("returns null for reserved aliases", () => {
    assert.equal(normalizeRequestedModel("accio-bridge"), null);
    assert.equal(normalizeRequestedModel("auto"), null);
    assert.equal(normalizeRequestedModel("default"), null);
  });

  it("returns trimmed model name for valid input", () => {
    assert.equal(normalizeRequestedModel("claude-opus-4-6"), "claude-opus-4-6");
    assert.equal(normalizeRequestedModel("  gpt-4  "), "gpt-4");
  });

  it("preserves case", () => {
    assert.equal(normalizeRequestedModel("Claude-Opus"), "Claude-Opus");
  });
});

describe("generateId", () => {
  it("returns string starting with prefix", () => {
    const id = generateId("msg");
    assert.ok(id.startsWith("msg_"), `Expected msg_ prefix, got: ${id}`);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId("x")));
    assert.equal(ids.size, 100);
  });

  it("suffix is 24 hex chars", () => {
    const id = generateId("test");
    const suffix = id.slice("test_".length);
    assert.equal(suffix.length, 24);
    assert.match(suffix, /^[0-9a-f]{24}$/);
  });
});

describe("delay", () => {
  it("resolves after the specified time", async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });

  it("returns a Promise", () => {
    const result = delay(0);
    assert.ok(result instanceof Promise);
    return result;
  });
});
