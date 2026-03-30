"use strict";

const log = require("../logger");

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

module.exports = {
  cacheHeaders,
  fallbackTransportName,
  logRequest,
  requestedAccountId
};
