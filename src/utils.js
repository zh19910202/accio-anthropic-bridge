"use strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely extract an error message string from any error-like value.
 * Centralises the `error && error.message ? error.message : String(error)`
 * pattern that was previously duplicated 50+ times across the codebase.
 */
function errMsg(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = { delay, errMsg };
