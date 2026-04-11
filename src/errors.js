"use strict";

const { safeJsonParse } = require("./jsonc");

function createBridgeError(status, message, type = "api_error", details = null) {
  const error = new Error(message);
  error.status = status;
  error.type = type;

  if (details) {
    error.details = details;
  }

  return error;
}

const STATUS_ERROR_TYPES = new Map([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [403, "authentication_error"],
  [404, "not_found_error"],
  [408, "timeout_error"],
  [413, "invalid_request_error"],
  [422, "invalid_request_error"],
  [429, "rate_limit_error"],
  [501, "unsupported_error"],
  [502, "overloaded_error"],
  [503, "overloaded_error"],
  [504, "overloaded_error"],
  [529, "overloaded_error"]
]);

const CONNECTION_ERROR_RE = /timed out|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed/i;
const TIMEOUT_RE = /timed out|timeout|aborted due to timeout/i;
const FALLBACK_LOCAL_RE = /timed out|timeout|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed|gateway is unavailable|Unable to resolve Accio access token/i;
const FAILOVER_MESSAGE_RE = /quota|unauthorized|provider unavailable|rate limit|overloaded|user not activated|not activated|user blocked|auth not pass|blocked by sentinel rate limit/;
const FAILOVER_TYPES = new Set(["authentication_error", "rate_limit_error", "overloaded_error"]);
const FAILOVER_STATUSES = new Set([401, 403, 408, 429, 503, 504, 529]);
const REQUEST_SCOPED_REJECTION_MESSAGE_RE = /content risk rejected/;

function classifyErrorType(statusCode, error) {
  const mapped = STATUS_ERROR_TYPES.get(statusCode);
  if (mapped) {
    return mapped;
  }

  if (error && CONNECTION_ERROR_RE.test(String(error.message || error))) {
    return "api_connection_error";
  }

  return "api_error";
}

function normalizeHttpStatusCode(statusCode, fallback = 500) {
  const normalized = Number(statusCode) || 0;
  if (normalized >= 100 && normalized <= 999) {
    return Math.trunc(normalized);
  }

  return Number(fallback) || 500;
}

function isTimeoutLikeError(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || 0);
  const type = String(error.type || "").toLowerCase();
  const message = String(error.message || error).toLowerCase();

  if (status === 408 || status === 504) {
    return true;
  }

  return (
    type === "timeout_error" ||
    type === "api_timeout_error" ||
    TIMEOUT_RE.test(message)
  );
}

function extractStructuredErrorMessage(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    return extractStructuredErrorMessage(parsed) || value;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (value.error && typeof value.error === "object") {
    if (typeof value.error.message === "string" && value.error.message.trim()) {
      return value.error.message.trim();
    }

    if (typeof value.error_message === "string" && value.error_message.trim()) {
      return value.error_message.trim();
    }
  }

  if (typeof value.error_message === "string" && value.error_message.trim()) {
    return value.error_message.trim();
  }

  if (typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }

  if (typeof value.msg === "string" && value.msg.trim()) {
    return value.msg.trim();
  }

  return null;
}

function shouldFallbackToLocalTransport(error) {
  if (!error) {
    return true;
  }

  if (Number(error.status)) {
    return false;
  }

  const message = String(error.message || error);
  return FALLBACK_LOCAL_RE.test(message);
}

function isRequestScopedRejection(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || "").toLowerCase();
  return REQUEST_SCOPED_REJECTION_MESSAGE_RE.test(message);
}

function shouldFailoverAccount(error) {
  if (!error) {
    return false;
  }

  if (isRequestScopedRejection(error)) {
    return false;
  }

  const status = Number(error.status || 0);
  const type = String(error.type || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  if (FAILOVER_STATUSES.has(status)) {
    return true;
  }

  if (isTimeoutLikeError(error)) {
    return true;
  }

  return FAILOVER_TYPES.has(type) || FAILOVER_MESSAGE_RE.test(message);
}

function shouldRecordAccountFailure(error) {
  return !isRequestScopedRejection(error);
}

function resolveResultError(result) {
  const metadata = (result.finalMessage && result.finalMessage.metadata) || {};
  const rawMessage =
    (result.channelResponse && result.channelResponse.content) ||
    metadata.rawError ||
    result.finalText ||
    "Unknown bridge error";

  return {
    errorCode: Number(metadata.errorCode || 0) || null,
    errorMessage: extractStructuredErrorMessage(rawMessage) || rawMessage
  };
}

module.exports = {
  classifyErrorType,
  createBridgeError,
  isRequestScopedRejection,
  isTimeoutLikeError,
  normalizeHttpStatusCode,
  resolveResultError,
  shouldRecordAccountFailure,
  shouldFailoverAccount,
  shouldFallbackToLocalTransport
};
