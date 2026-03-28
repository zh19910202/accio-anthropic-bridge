"use strict";

const { createBridgeError } = require("../errors");

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 30 * 1000;

function readJsonBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_BODY_READ_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      req.destroy();
      reject(createBridgeError(408, `Request body read timed out after ${timeoutMs}ms`, "timeout_error"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      req.removeAllListeners("aborted");
    };

    req.on("aborted", () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(createBridgeError(400, "Request body was aborted by the client", "invalid_request_error"));
    });

    req.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        settled = true;
        cleanup();
        req.destroy();
        reject(createBridgeError(413, `Request body exceeds ${maxBytes} bytes`, "invalid_request_error"));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      const text = Buffer.concat(chunks).toString("utf8").trim();

      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(createBridgeError(400, `Invalid JSON body: ${error.message}`, "invalid_request_error"));
      }
    });
  });
}

module.exports = {
  DEFAULT_BODY_READ_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody
};
