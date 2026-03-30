"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CORS_HEADERS, writeJson, writeSse } = require("../src/http");

describe("CORS_HEADERS", () => {
  it("is frozen", () => {
    assert.ok(Object.isFrozen(CORS_HEADERS));
  });

  it("contains required CORS keys", () => {
    assert.ok(CORS_HEADERS["access-control-allow-origin"]);
    assert.ok(CORS_HEADERS["access-control-allow-headers"]);
    assert.ok(CORS_HEADERS["access-control-allow-methods"]);
  });
});

describe("writeJson", () => {
  it("writes JSON response with correct headers", () => {
    const headers = {};
    let endedPayload = null;
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead(status, h) {
        this._status = status;
        Object.assign(headers, h);
      },
      end(payload) {
        endedPayload = payload;
      }
    };

    const result = writeJson(res, 200, { ok: true });
    assert.equal(result, true);
    assert.equal(res._status, 200);
    assert.ok(headers["content-type"].startsWith("application/json"));
    assert.ok(headers["access-control-allow-origin"]);
    assert.deepEqual(JSON.parse(endedPayload), { ok: true });
  });

  it("merges extra headers", () => {
    const headers = {};
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead(_, h) { Object.assign(headers, h); },
      end() {}
    };

    writeJson(res, 201, { id: 1 }, { "x-custom": "yes" });
    assert.equal(headers["x-custom"], "yes");
  });

  it("returns false for null res", () => {
    assert.equal(writeJson(null, 200, {}), false);
  });

  it("returns false when writableEnded", () => {
    const res = { writableEnded: true };
    assert.equal(writeJson(res, 200, {}), false);
  });

  it("returns false when destroyed", () => {
    const res = { destroyed: true };
    assert.equal(writeJson(res, 200, {}), false);
  });

  it("returns false when headers already sent", () => {
    let ended = false;
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: true,
      end() { ended = true; }
    };

    assert.equal(writeJson(res, 200, {}), false);
    assert.equal(ended, true, "should still call res.end()");
  });
});

describe("writeSse", () => {
  it("writes SSE event format", () => {
    const chunks = [];
    const res = {
      write(chunk) { chunks.push(chunk); }
    };

    writeSse(res, "message", { text: "hello" });
    assert.equal(chunks[0], "event: message\n");
    assert.equal(chunks[1], 'data: {"text":"hello"}\n\n');
  });
});
