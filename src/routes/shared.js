"use strict";

const log = require("../logger");
const { writeSse } = require("../http");
const { errMsg } = require("../utils");

/* ── Request helpers ── */

function requestedAccountId(headers) {
  return headers["x-accio-account-id"] || headers["x-account-id"] || null;
}

function logRequest(req, message, protocol, meta = {}) {
  log.info(message, {
    requestId: req.bridgeContext && req.bridgeContext.requestId ? req.bridgeContext.requestId : null,
    protocol,
    ...meta
  });
}

function cacheHeaders(state) {
  return {
    "x-accio-cache": state
  };
}

function fallbackTransportName(fallbackClient) {
  return fallbackClient && fallbackClient.protocol === "anthropic"
    ? "external-anthropic"
    : "external-openai";
}

function applyBridgeRequestIdToDirectRequest(req, directRequest) {
  const bridgeRequestId = req && req.bridgeContext && req.bridgeContext.requestId
    ? String(req.bridgeContext.requestId).trim()
    : "";

  if (!bridgeRequestId || !directRequest || !directRequest.requestBody || typeof directRequest.requestBody !== "object") {
    return directRequest;
  }

  if (!directRequest.requestBody.requestId) {
    directRequest.requestBody.requestId = bridgeRequestId;
  }

  if (!directRequest.requestBody.messageId) {
    directRequest.requestBody.messageId = bridgeRequestId;
  }

  return directRequest;
}

/* ── Heartbeat ping management ── */

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Starts a heartbeat ping interval that keeps the SSE connection alive
 * while upstream is thinking.
 *
 * @param {object} res - HTTP response
 * @param {"anthropic"|"openai"} protocol - controls ping format
 * @returns {{ clear: () => void }}
 */
function startHeartbeat(res, protocol) {
  const intervalId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(intervalId);
      return;
    }

    if (res.headersSent) {
      if (protocol === "anthropic") {
        writeSse(res, "ping", {});
      } else {
        // OpenAI SSE format: comment line as keepalive (ignored by spec-compliant clients)
        res.write(": ping\n\n");
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    clear() {
      clearInterval(intervalId);
    }
  };
}

/* ── SSE error writing ── */

/**
 * Writes an SSE error event to the client when the stream was already started
 * but an error occurred mid-stream. This gives the client a clear signal
 * instead of a silent disconnect.
 *
 * @param {object} res - HTTP response
 * @param {Error} error - the error that occurred
 * @param {"anthropic"|"openai"} protocol - controls error format
 * @returns {boolean} true if error was written, false if stream was not started
 */
function writeSseError(res, error, protocol) {
  if (!res.headersSent || res.writableEnded || res.destroyed) {
    return false;
  }

  if (protocol === "anthropic") {
    writeSse(res, "error", {
      type: "error",
      error: {
        type: error.type || "api_error",
        message: error.message || "stream error"
      }
    });
  } else {
    res.write(`data: ${JSON.stringify({
      error: {
        type: error.type || "api_error",
        message: error.message || "stream error",
        code: error.status || null
      }
    })}\n\n`);
    res.write("data: [DONE]\n\n");
  }

  res.end();
  return true;
}

/* ── Usage token extraction ── */

/**
 * Extract resolved input/output token counts from a usage object,
 * falling back to estimation when usage data is unavailable.
 *
 * @param {object} usage - upstream usage object
 * @param {number} fallbackInputTokens - estimated input tokens
 * @param {string} outputText - text to estimate output tokens from
 * @param {function} estimateTokens - token estimation function
 * @returns {{ promptTokens: number, completionTokens: number }}
 */
function resolveUsageTokens(usage, fallbackInputTokens, outputText, estimateTokens) {
  const completionTokensRaw = usage && Number(usage.completion_tokens || usage.output_tokens || 0);
  const promptTokensRaw = usage && Number(usage.prompt_tokens || usage.input_tokens || 0);

  return {
    promptTokens: promptTokensRaw || fallbackInputTokens,
    completionTokens: completionTokensRaw || estimateTokens(outputText)
  };
}

module.exports = {
  applyBridgeRequestIdToDirectRequest,
  cacheHeaders,
  errMsg,
  fallbackTransportName,
  HEARTBEAT_INTERVAL_MS,
  logRequest,
  requestedAccountId,
  resolveUsageTokens,
  startHeartbeat,
  writeSseError
};
