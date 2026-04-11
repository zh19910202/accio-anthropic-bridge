"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || "info"] || LEVELS.info;
const MAX_LOG_ENTRIES = Number(process.env.LOG_BUFFER_MAX || 400) || 400;
const listeners = new Set();
let sequence = 0;

// Ring buffer — avoids splice() O(n) cost on every overflow eviction.
const ring = new Array(MAX_LOG_ENTRIES);
let ringHead = 0;
let ringSize = 0;
/**
 * LOG_TIMEZONE: timezone offset in hours (e.g. "8" for UTC+8, "-5" for UTC-5).
 * Defaults to 8 (China Standard Time) for backward compatibility.
 */
const TIMEZONE_OFFSET_HOURS = Number(process.env.LOG_TIMEZONE || 8) || 0;
const TIMEZONE_OFFSET_MINUTES = TIMEZONE_OFFSET_HOURS * 60;
const TIMEZONE_LABEL = (() => {
  const sign = TIMEZONE_OFFSET_HOURS >= 0 ? "+" : "-";
  const absHours = Math.abs(Math.floor(TIMEZONE_OFFSET_HOURS));
  const absMinutes = Math.abs(Math.round((TIMEZONE_OFFSET_HOURS % 1) * 60));
  return `${sign}${String(absHours).padStart(2, "0")}:${String(absMinutes).padStart(2, "0")}`;
})();

function padNumber(value, size = 2) {
  return String(value).padStart(size, "0");
}

function formatTimestamp(value = Date.now()) {
  const shifted = new Date(value + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${padNumber(shifted.getUTCMonth() + 1)}-${padNumber(shifted.getUTCDate())}T${padNumber(shifted.getUTCHours())}:${padNumber(shifted.getUTCMinutes())}:${padNumber(shifted.getUTCSeconds())}.${padNumber(shifted.getUTCMilliseconds(), 3)}${TIMEZONE_LABEL}`;
}

function cloneEntry(entry) {
  if (!entry) {
    return entry;
  }

  // Shallow copy is safe for log entries — extra fields are plain value types
  // or already-frozen strings from the caller.  Only deep-clone actual objects.
  const clone = { seq: entry.seq, ts: entry.ts, level: entry.level, msg: entry.msg };
  for (const key of Object.keys(entry)) {
    if (key !== "seq" && key !== "ts" && key !== "level" && key !== "msg") {
      const val = entry[key];
      clone[key] = val && typeof val === "object" ? JSON.parse(JSON.stringify(val)) : val;
    }
  }
  return clone;
}

function recordEntry(entry) {
  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % MAX_LOG_ENTRIES;
  if (ringSize < MAX_LOG_ENTRIES) {
    ringSize += 1;
  }

  // Only deep-clone when subscribers exist — avoids unnecessary GC pressure
  // on the hot logging path when no admin SSE clients are connected.
  if (listeners.size > 0) {
    const cloned = cloneEntry(entry);
    for (const listener of listeners) {
      try {
        listener(cloned);
      } catch {
        // Ignore listener failures to avoid affecting the main log path.
      }
    }
  }
}

function log(level, message, meta = {}) {
  const numericLevel = LEVELS[level] || LEVELS.info;

  if (numericLevel < minLevel) {
    return;
  }

  const entry = {
    seq: ++sequence,
    ts: formatTimestamp(),
    level,
    msg: message,
    ...meta
  };
  const stream = numericLevel >= LEVELS.error ? process.stderr : process.stdout;

  recordEntry(entry);
  stream.write(JSON.stringify(entry) + "\n");
}

module.exports = {
  debug: (msg, meta) => log("debug", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
  getEntries(limit = MAX_LOG_ENTRIES) {
    const size = Math.max(1, Math.min(Number(limit) || MAX_LOG_ENTRIES, ringSize));
    const result = new Array(size);
    const start = ringSize < MAX_LOG_ENTRIES
      ? size < ringSize ? ringSize - size : 0
      : (ringHead - size + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
    for (let i = 0; i < size; i++) {
      result[i] = cloneEntry(ring[(start + i) % MAX_LOG_ENTRIES]);
    }
    return result;
  },
  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
};
