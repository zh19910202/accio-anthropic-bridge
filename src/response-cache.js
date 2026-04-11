"use strict";

const crypto = require("node:crypto");

function stableSerialize(value) {
  if (value == null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      break;
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

const DEFAULT_MAX_ENTRIES = 128;
const PROBABILISTIC_PURGE_RATE = 0.05;  // ~5% chance on miss to reclaim expired entries

class ResponseCache {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 0);
    this.maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
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
      // Probabilistic cleanup (~5% chance) to reclaim memory from expired entries
      if (this.store.size > 0 && Math.random() < PROBABILISTIC_PURGE_RATE) {
        this._purgeExpired();
      }
      return null;
    }

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  _purgeExpired() {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(k);
      }
    }
  }

  _evictIfNeeded() {
    if (this.store.size <= this.maxEntries) {
      return;
    }

    this._purgeExpired();

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  set(key, value) {
    if (!this.isEnabled() || !key || value == null) {
      return;
    }

    this.store.set(key, {
      createdAt: Date.now(),
      value
    });

    this._evictIfNeeded();
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
