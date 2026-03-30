"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyErrorType,
  createBridgeError,
  shouldFailoverAccount,
  shouldFallbackToLocalTransport
} = require("../src/errors");

test("classifyErrorType maps status codes to error types", () => {
  assert.equal(classifyErrorType(400), "invalid_request_error");
  assert.equal(classifyErrorType(413), "invalid_request_error");
  assert.equal(classifyErrorType(422), "invalid_request_error");
  assert.equal(classifyErrorType(401), "authentication_error");
  assert.equal(classifyErrorType(403), "authentication_error");
  assert.equal(classifyErrorType(404), "not_found_error");
  assert.equal(classifyErrorType(408), "timeout_error");
  assert.equal(classifyErrorType(429), "rate_limit_error");
  assert.equal(classifyErrorType(502), "overloaded_error");
  assert.equal(classifyErrorType(503), "overloaded_error");
  assert.equal(classifyErrorType(504), "overloaded_error");
  assert.equal(classifyErrorType(200), "api_error");
  assert.equal(classifyErrorType(0), "api_error");
});

test("classifyErrorType detects connection errors from message", () => {
  assert.equal(classifyErrorType(0, new Error("connection timed out")), "api_connection_error");
  assert.equal(classifyErrorType(0, new Error("ECONNREFUSED")), "api_connection_error");
  assert.equal(classifyErrorType(0, new Error("ECONNRESET")), "api_connection_error");
  assert.equal(classifyErrorType(0, new Error("fetch failed")), "api_connection_error");
  assert.equal(classifyErrorType(0, new Error("WebSocket closed")), "api_connection_error");
  assert.equal(classifyErrorType(0, new Error("normal error")), "api_error");
});

test("createBridgeError creates error with correct properties", () => {
  const error = createBridgeError(429, "rate limited", "rate_limit_error");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "rate limited");
  assert.equal(error.status, 429);
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.details, undefined);
});

test("createBridgeError includes details when provided", () => {
  const details = { upstream: { status: 503 } };
  const error = createBridgeError(502, "overloaded", "overloaded_error", details);
  assert.deepEqual(error.details, details);
});

test("shouldFailoverAccount returns true for auth and rate limit errors", () => {
  assert.equal(shouldFailoverAccount({ status: 401 }), true);
  assert.equal(shouldFailoverAccount({ status: 403 }), true);
  assert.equal(shouldFailoverAccount({ status: 429 }), true);
  assert.equal(shouldFailoverAccount({ status: 503 }), true);
  assert.equal(shouldFailoverAccount({ status: 529 }), true);
  assert.equal(shouldFailoverAccount({ status: 200 }), false);
  assert.equal(shouldFailoverAccount({ status: 400 }), false);
  assert.equal(shouldFailoverAccount(null), false);
});

test("shouldFailoverAccount detects error types and messages", () => {
  assert.equal(shouldFailoverAccount({ type: "authentication_error" }), true);
  assert.equal(shouldFailoverAccount({ type: "rate_limit_error" }), true);
  assert.equal(shouldFailoverAccount({ type: "overloaded_error" }), true);
  assert.equal(shouldFailoverAccount({ type: "invalid_request_error" }), false);
  assert.equal(shouldFailoverAccount({ message: "quota exceeded" }), true);
  assert.equal(shouldFailoverAccount({ message: "unauthorized access" }), true);
  assert.equal(shouldFailoverAccount({ message: "rate limit hit" }), true);
  assert.equal(shouldFailoverAccount({ message: "provider unavailable" }), true);
  assert.equal(shouldFailoverAccount({ message: "normal response" }), false);
});

test("shouldFallbackToLocalTransport returns true for connection errors", () => {
  assert.equal(shouldFallbackToLocalTransport(null), true);
  assert.equal(shouldFallbackToLocalTransport(new Error("timed out")), true);
  assert.equal(shouldFallbackToLocalTransport(new Error("ECONNREFUSED")), true);
  assert.equal(shouldFallbackToLocalTransport(new Error("fetch failed")), true);
  assert.equal(shouldFallbackToLocalTransport(new Error("gateway is unavailable")), true);
  assert.equal(shouldFallbackToLocalTransport(new Error("Unable to resolve Accio access token")), true);
});

test("shouldFallbackToLocalTransport returns false for HTTP errors", () => {
  const httpError = new Error("bad request");
  httpError.status = 400;
  assert.equal(shouldFallbackToLocalTransport(httpError), false);

  const httpError500 = new Error("internal error");
  httpError500.status = 500;
  assert.equal(shouldFallbackToLocalTransport(httpError500), false);
});
