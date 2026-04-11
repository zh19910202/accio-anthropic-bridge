"use strict";

const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type,authorization,x-api-key,anthropic-version,x-accio-session-id,x-accio-conversation-id,x-session-id,x-accio-account-id,x-account-id,x-request-id",
  "access-control-allow-methods": "GET,POST,OPTIONS"
});

const ADMIN_CORS_HEADERS = Object.freeze({
  "access-control-allow-methods": "GET,POST,OPTIONS"
});

function writeJson(res, statusCode, body, extraHeaders = {}) {
  if (!res || res.writableEnded || res.destroyed) {
    return false;
  }

  const payload = JSON.stringify(body);

  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // Ignore secondary stream shutdown failures.
    }
    return false;
  }

  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
  return true;
}

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  // Single write reduces syscalls on unbuffered streams.
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = {
  CORS_HEADERS,
  ADMIN_CORS_HEADERS,
  writeJson,
  writeSse
};
