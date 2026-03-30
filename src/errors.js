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

function classifyErrorType(statusCode, error) {
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return "invalid_request_error";
  }

  if (statusCode === 401 || statusCode === 403) {
    return "authentication_error";
  }

  if (statusCode === 404) {
    return "not_found_error";
  }

  if (statusCode === 408) {
    return "timeout_error";
  }

  if (statusCode === 429) {
    return "rate_limit_error";
  }

  if (statusCode === 501) {
    return "unsupported_error";
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 529) {
    return "overloaded_error";
  }

  if (
    error &&
    /timed out|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed/i.test(
      String(error.message || error)
    )
  ) {
    return "api_connection_error";
  }

  return "api_error";
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
  return /timed out|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed|gateway is unavailable|Unable to resolve Accio access token/i.test(
    message
  );
}

function shouldFailoverAccount(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || 0);
  const type = String(error.type || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  if (status === 401 || status === 403 || status === 429 || status === 503 || status === 529) {
    return true;
  }

  return (
    type === "authentication_error" ||
    type === "rate_limit_error" ||
    type === "overloaded_error" ||
    /quota|unauthorized|provider unavailable|rate limit|overloaded/.test(message)
  );
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
  resolveResultError,
  shouldFailoverAccount,
  shouldFallbackToLocalTransport
};
