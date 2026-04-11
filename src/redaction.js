"use strict";

const DEFAULT_MAX_STRING_LENGTH = 16 * 1024;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "cookie",
  "set-cookie",
  "cna",
  "x-utdid"
]);

/**
 * Core mask logic shared by maskSecret / maskToken.
 * Reveals up to 8 leading characters, then appends "***".
 */
function applyMask(value) {
  return value.length > 8 ? `${value.slice(0, 8)}***` : "***";
}

function maskSecret(value) {
  if (typeof value !== "string" || !value) {
    return "***";
  }

  return applyMask(value);
}

function truncateString(value, maxLength = DEFAULT_MAX_STRING_LENGTH) {
  if (typeof value !== "string") {
    return value;
  }

  if (!Number.isFinite(maxLength) || maxLength <= 0 || value.length <= maxLength) {
    return value;
  }

  const truncatedChars = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${truncatedChars} chars]`;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || "").trim().toLowerCase());
}

function sanitizeValue(value, options = {}) {
  const maxStringLength = Number(options.maxStringLength || DEFAULT_MAX_STRING_LENGTH);

  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value, maxStringLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (isSensitiveKey(key)) {
          return [key, maskSecret(typeof item === "string" ? item : JSON.stringify(item))];
        }

        return [key, sanitizeValue(item, options)];
      })
    );
  }

  return String(value);
}

function sanitizeHeaders(headers, options = {}) {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (Array.isArray(value)) {
        const normalized = value.map((item) => (typeof item === "string" ? item : String(item)));
        return [key, isSensitiveKey(key) ? maskSecret(normalized.join(",")) : sanitizeValue(normalized, options)];
      }

      if (isSensitiveKey(key)) {
        return [key, maskSecret(typeof value === "string" ? value : String(value))];
      }

      return [key, sanitizeValue(typeof value === "string" ? value : String(value), options)];
    })
  );
}

function maskToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  return applyMask(token);
}

module.exports = {
  DEFAULT_MAX_STRING_LENGTH,
  maskSecret,
  maskToken,
  sanitizeHeaders,
  sanitizeValue,
  truncateString
};
