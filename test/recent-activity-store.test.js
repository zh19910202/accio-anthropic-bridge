"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { RecentActivityStore } = require("../src/recent-activity-store");

describe("RecentActivityStore", () => {
  it("returns null when no activity recorded", () => {
    const store = new RecentActivityStore();
    assert.equal(store.get(), null);
  });

  it("records an entry and returns a copy", () => {
    const store = new RecentActivityStore();
    const entry = store.record({ accountId: "a1", model: "claude-opus-4-6" });
    assert.equal(entry.accountId, "a1");
    assert.equal(entry.model, "claude-opus-4-6");
    assert.ok(entry.recordedAt);

    const got = store.get();
    assert.deepEqual(got, entry);
    assert.notEqual(got, entry, "get() returns a copy");
  });

  it("uses provided recordedAt if present", () => {
    const store = new RecentActivityStore();
    const ts = "2025-01-01T00:00:00Z";
    const entry = store.record({ accountId: "a1", recordedAt: ts });
    assert.equal(entry.recordedAt, ts);
  });

  it("ignores invalid entries", () => {
    const store = new RecentActivityStore();
    assert.equal(store.record(null), null);
    assert.equal(store.record(undefined), null);
    assert.equal(store.record("string"), null);
    assert.equal(store.record(42), null);
    assert.equal(store.get(), null);
  });

  it("notifies subscribers on record", () => {
    const store = new RecentActivityStore();
    const received = [];
    store.subscribe((data) => received.push(data));

    store.record({ accountId: "a1" });
    assert.equal(received.length, 1);
    assert.equal(received[0].accountId, "a1");
  });

  it("unsubscribe removes the listener", () => {
    const store = new RecentActivityStore();
    const received = [];
    const unsub = store.subscribe((data) => received.push(data));

    store.record({ accountId: "a1" });
    assert.equal(received.length, 1);

    unsub();
    store.record({ accountId: "a2" });
    assert.equal(received.length, 1, "no more notifications after unsubscribe");
  });

  it("ignores non-function subscribers", () => {
    const store = new RecentActivityStore();
    const unsub = store.subscribe("not a function");
    assert.equal(typeof unsub, "function");
  });

  it("isolates listener errors", () => {
    const store = new RecentActivityStore();
    store.subscribe(() => { throw new Error("boom"); });
    const received = [];
    store.subscribe((data) => received.push(data));

    const entry = store.record({ accountId: "safe" });
    assert.equal(entry.accountId, "safe");
    assert.equal(received.length, 1, "second listener still called");
  });
});
