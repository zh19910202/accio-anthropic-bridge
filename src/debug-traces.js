"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { sanitizeHeaders, sanitizeValue } = require("./redaction");
const log = require("./logger");

const INDEX_FILE = "index.json";

function clampInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : fallback;
}

function toIso(ts) {
  return new Date(ts || Date.now()).toISOString();
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sampleReasonFromTrace(trace) {
  if (trace && trace.forceCapture) {
    return "forced";
  }

  if (trace && Number(trace.statusCode) >= 400) {
    return "error";
  }

  return "sampled";
}

function ensureTraceContext(req) {
  if (!req.bridgeContext) {
    req.bridgeContext = {};
  }

  if (!req.bridgeContext.trace) {
    req.bridgeContext.trace = {
      request: {},
      response: {},
      bridge: {}
    };
  }

  return req.bridgeContext.trace;
}

function updateTrace(req, meta = {}) {
  const trace = ensureTraceContext(req);

  if (meta.protocol) {
    trace.protocol = meta.protocol;
  }

  if (meta.request) {
    trace.request = {
      ...trace.request,
      ...meta.request
    };
  }

  if (meta.response) {
    trace.response = {
      ...trace.response,
      ...meta.response
    };
  }

  if (meta.bridge) {
    trace.bridge = {
      ...trace.bridge,
      ...meta.bridge
    };
  }

  if (meta.error) {
    trace.error = meta.error;
  }

  if (meta.forceCapture === true) {
    trace.forceCapture = true;
  }

  return trace;
}

function setTraceRequest(req, protocol, body, bridge = {}) {
  return updateTrace(req, {
    protocol,
    forceCapture: String(req.headers["x-accio-debug-trace"] || "") === "1",
    request: {
      headers: req.headers,
      body
    },
    bridge
  });
}

function setTraceResponse(req, res, statusCode, body, meta = {}) {
  return updateTrace(req, {
    response: {
      statusCode,
      headers: res && typeof res.getHeaders === "function" ? res.getHeaders() : {},
      body,
      ...meta
    }
  });
}

function setTraceError(req, res, statusCode, error, details) {
  return updateTrace(req, {
    response: {
      statusCode,
      headers: res && typeof res.getHeaders === "function" ? res.getHeaders() : {}
    },
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: error && error.type ? error.type : null,
      details: details || (error && error.details ? error.details : null)
    }
  });
}

class DebugTraceStore {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.dirPath = path.resolve(options.dirPath || path.join(process.cwd(), ".data", "traces"));
    this.maxEntries = clampInteger(options.maxEntries, 200);
    this.maxStringLength = clampInteger(options.maxStringLength, 16 * 1024);
    this.sampleRate = Number.isFinite(Number(options.sampleRate))
      ? Math.max(0, Math.min(1, Number(options.sampleRate)))
      : 0;
    this.entries = [];
    this._recentTraces = new Map();

    if (this.enabled) {
      fs.mkdirSync(this.dirPath, { recursive: true });
      this.entries = safeReadJson(path.join(this.dirPath, INDEX_FILE), []).filter(Boolean);
    }
  }

  getSummary() {
    return {
      enabled: this.enabled,
      dirPath: this.dirPath,
      count: this.entries.length,
      maxEntries: this.maxEntries,
      sampleRate: this.sampleRate,
      newestId: this.entries[0] ? this.entries[0].id : null,
      newestAt: this.entries[0] ? this.entries[0].ts : null
    };
  }

  list(limit = 20) {
    return this.entries.slice(0, clampInteger(limit, 20));
  }

  get(traceId) {
    if (!traceId) {
      return null;
    }

    if (this._recentTraces.has(traceId)) {
      return this._recentTraces.get(traceId);
    }

    const filePath = path.join(this.dirPath, `${traceId}.json`);
    return safeReadJson(filePath, null);
  }

  shouldCapture(trace) {
    if (!this.enabled || !trace || !trace.protocol) {
      return false;
    }

    if (trace.forceCapture) {
      return true;
    }

    if (Number(trace.statusCode || (trace.response && trace.response.statusCode) || 0) >= 400) {
      return true;
    }

    return this.sampleRate > 0 && Math.random() < this.sampleRate;
  }

  record(rawTrace) {
    if (!this.shouldCapture(rawTrace)) {
      return null;
    }

    const trace = this._sanitizeTrace(rawTrace);
    const summary = this._buildSummary(trace);
    const filePath = path.join(this.dirPath, `${trace.id}.json`);

    this.entries = [summary, ...this.entries.filter((entry) => entry.id !== summary.id)];

    const toRemove = [];

    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.pop();

      if (removed) {
        toRemove.push(path.join(this.dirPath, `${removed.id}.json`));
      }
    }

    const traceJson = JSON.stringify(trace, null, 2);
    const indexJson = JSON.stringify(this.entries, null, 2);

    this._recentTraces.set(trace.id, trace);
    while (this._recentTraces.size > this.maxEntries) {
      const firstKey = this._recentTraces.keys().next().value;
      this._recentTraces.delete(firstKey);
    }

    fsp.writeFile(filePath, traceJson).catch((error) => {
      log.warn("async trace write failed", { path: filePath, error: error.message || String(error) });
    });

    for (const removedPath of toRemove) {
      fsp.unlink(removedPath).catch(() => {});
    }

    fsp.writeFile(path.join(this.dirPath, INDEX_FILE), indexJson).catch((error) => {
      log.warn("async trace index write failed", { error: error.message || String(error) });
    });

    return summary;
  }

  buildReplay(traceId, baseUrl) {
    const trace = this.get(traceId);

    if (!trace) {
      return null;
    }

    const headers = trace.request && trace.request.headers ? trace.request.headers : {};
    const replayHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => {
        const normalized = String(key || "").toLowerCase();
        return normalized !== "host" && normalized !== "content-length";
      })
    );
    const body = trace.request && Object.prototype.hasOwnProperty.call(trace.request, "body")
      ? trace.request.body
      : null;
    const method = trace.method || "POST";
    const url = `${String(baseUrl || "").replace(/\/$/, "")}${trace.path}`;
    const segments = [`curl -sS -X ${method}`, shellQuote(url)];

    for (const [key, value] of Object.entries(replayHeaders)) {
      segments.push(`-H ${shellQuote(`${key}: ${Array.isArray(value) ? value.join(",") : value}`)}`);
    }

    if (body != null) {
      segments.push(`--data ${shellQuote(JSON.stringify(body))}`);
    }

    return {
      traceId,
      method,
      url,
      headers: replayHeaders,
      body,
      curl: segments.join(" "),
      replayable: !JSON.stringify(body || "").includes("[truncated ")
    };
  }

  _sanitizeTrace(trace) {
    return {
      id: trace.id,
      requestId: trace.requestId || null,
      ts: toIso(trace.ts),
      durationMs: Number(trace.durationMs || 0),
      method: trace.method || "POST",
      path: trace.path || "/",
      protocol: trace.protocol || null,
      statusCode: Number(trace.statusCode || (trace.response && trace.response.statusCode) || 0),
      sampleReason: sampleReasonFromTrace(trace),
      request: {
        headers: sanitizeHeaders(trace.request && trace.request.headers ? trace.request.headers : {}, {
          maxStringLength: this.maxStringLength
        }),
        body: sanitizeValue(trace.request && trace.request.body ? trace.request.body : null, {
          maxStringLength: this.maxStringLength
        })
      },
      response: {
        statusCode: Number(trace.response && trace.response.statusCode ? trace.response.statusCode : trace.statusCode || 0),
        headers: sanitizeHeaders(trace.response && trace.response.headers ? trace.response.headers : {}, {
          maxStringLength: this.maxStringLength
        }),
        body: sanitizeValue(trace.response && Object.prototype.hasOwnProperty.call(trace.response, "body") ? trace.response.body : null, {
          maxStringLength: this.maxStringLength
        }),
        stream: Boolean(trace.response && trace.response.stream),
        cacheState: trace.response && trace.response.cacheState ? trace.response.cacheState : null
      },
      bridge: sanitizeValue(trace.bridge || {}, {
        maxStringLength: this.maxStringLength
      }),
      error: sanitizeValue(trace.error || null, {
        maxStringLength: this.maxStringLength
      })
    };
  }

  _buildSummary(trace) {
    return {
      id: trace.id,
      requestId: trace.requestId,
      ts: trace.ts,
      method: trace.method,
      path: trace.path,
      protocol: trace.protocol,
      statusCode: trace.statusCode,
      sampleReason: trace.sampleReason,
      requestedModel: trace.bridge && trace.bridge.requestedModel ? trace.bridge.requestedModel : null,
      normalizedModel: trace.bridge && trace.bridge.normalizedModel ? trace.bridge.normalizedModel : null,
      transportSelected: trace.bridge && trace.bridge.transportSelected ? trace.bridge.transportSelected : null,
      accountId: trace.bridge && trace.bridge.accountId ? trace.bridge.accountId : null,
      cacheState: trace.response && trace.response.cacheState ? trace.response.cacheState : null,
      error: trace.error && trace.error.message ? trace.error.message : null
    };
  }
}

module.exports = {
  DebugTraceStore,
  setTraceError,
  setTraceRequest,
  setTraceResponse,
  updateTrace
};
