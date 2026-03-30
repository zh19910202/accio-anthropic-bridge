"use strict";

const crypto = require("node:crypto");

function stableSerialize(value) {
  if (value == null) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function buildCacheKey(parts) {
  return crypto.createHash("sha256").update(stableSerialize(parts)).digest("hex");
}

class ResponseCache {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 0);
    this.maxEntries = Number(options.maxEntries || 128);
    this.store = new Map();
  }

  isEnabled() {
    return this.ttlMs > 0;
  }

  get(key) {
    if (!this.isEnabled() || !key) {
      return null;
    }

    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key, value) {
    if (!this.isEnabled() || !key || value == null) {
      return;
    }

    this.store.set(key, {
      createdAt: Date.now(),
      value
    });

    while (this.store.size > this.maxEntries) {
      let expiredKey = null;

      for (const [k, entry] of this.store) {
        if (Date.now() - entry.createdAt > this.ttlMs) {
          expiredKey = k;
          break;
        }
      }

      if (expiredKey) {
        this.store.delete(expiredKey);
      } else {
        const oldestKey = this.store.keys().next().value;
        this.store.delete(oldestKey);
      }
    }
  }

  getSummary() {
    return {
      enabled: this.isEnabled(),
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      size: this.store.size
    };
  }
}

module.exports = {
  ResponseCache,
  buildCacheKey,
  stableSerialize
};
