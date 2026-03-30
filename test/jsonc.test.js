"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { parseJsonc, readJsonFile, safeJsonParse, stripJsonComments } = require("../src/jsonc");

describe("stripJsonComments", () => {
  it("passes through plain JSON unchanged", () => {
    const input = '{"a":1,"b":"hello"}';
    assert.equal(stripJsonComments(input), input);
  });

  it("strips single-line comments", () => {
    const input = '{"a":1 // comment\n,"b":2}';
    const result = stripJsonComments(input);
    assert.doesNotMatch(result, /\/\//);
    assert.match(result, /"b":2/);
  });

  it("strips block comments", () => {
    const input = '{"a":1 /* block comment */,"b":2}';
    const result = stripJsonComments(input);
    assert.doesNotMatch(result, /\/\*/);
    assert.match(result, /"b":2/);
  });

  it("preserves comment-like content inside strings", () => {
    const input = '{"url":"http://example.com"}';
    assert.equal(stripJsonComments(input), input);
  });

  it("preserves escaped quotes in strings", () => {
    const input = '{"a":"he said \\"hello\\""}';
    assert.equal(stripJsonComments(input), input);
  });

  it("handles multi-line block comments", () => {
    const input = '{"a":1,/* line1\nline2 */"b":2}';
    const result = stripJsonComments(input);
    assert.doesNotMatch(result, /line1/);
    assert.match(result, /"b":2/);
  });
});

describe("parseJsonc", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseJsonc('{"x":42}'), { x: 42 });
  });

  it("parses JSONC with comments", () => {
    const input = `{
      // This is a comment
      "key": "value" /* inline */
    }`;
    assert.deepEqual(parseJsonc(input), { key: "value" });
  });

  it("throws on invalid JSON after stripping comments", () => {
    assert.throws(() => parseJsonc("{invalid}"), SyntaxError);
  });

  it("handles null/undefined input as empty string", () => {
    assert.throws(() => parseJsonc(null));
    assert.throws(() => parseJsonc(undefined));
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON string", () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  });

  it("returns null fallback on invalid JSON", () => {
    assert.equal(safeJsonParse("bad json"), null);
  });

  it("returns custom fallback on invalid JSON", () => {
    assert.deepEqual(safeJsonParse("bad", []), []);
  });

  it("parses numbers and booleans", () => {
    assert.equal(safeJsonParse("42"), 42);
    assert.equal(safeJsonParse("true"), true);
  });
});

describe("readJsonFile", () => {
  it("reads and parses a JSON file", () => {
    const tmp = path.join(os.tmpdir(), `jsonc-test-${Date.now()}.json`);
    fs.writeFileSync(tmp, '{"hello":"world"}', "utf8");
    try {
      assert.deepEqual(readJsonFile(tmp), { hello: "world" });
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("reads and parses a JSONC file with comments", () => {
    const tmp = path.join(os.tmpdir(), `jsonc-test-${Date.now()}.jsonc`);
    fs.writeFileSync(tmp, '{"v":1 // comment\n}', "utf8");
    try {
      assert.deepEqual(readJsonFile(tmp, { jsonc: true }), { v: 1 });
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("throws when file does not exist", () => {
    assert.throws(() => readJsonFile("/nonexistent/path/file.json"));
  });
});
