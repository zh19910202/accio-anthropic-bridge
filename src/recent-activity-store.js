"use strict";

class RecentActivityStore {
  constructor() {
    this.lastSuccess = null;
    this.listeners = new Set();
  }

  record(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    this.lastSuccess = {
      ...entry,
      recordedAt: entry.recordedAt || new Date().toISOString()
    };

    for (const listener of this.listeners) {
      try {
        listener(this.get());
      } catch {
        // Ignore listener errors so request handling stays isolated.
      }
    }

    return this.lastSuccess;
  }

  get() {
    return this.lastSuccess ? { ...this.lastSuccess } : null;
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear() {
    this.listeners.clear();
    this.lastSuccess = null;
  }
}

module.exports = {
  RecentActivityStore
};
