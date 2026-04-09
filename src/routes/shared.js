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

module.exports = {
  applyBridgeRequestIdToDirectRequest,
  cacheHeaders,
  fallbackTransportName,
  logRequest,
  requestedAccountId
};
