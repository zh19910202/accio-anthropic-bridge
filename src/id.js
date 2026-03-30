"use strict";

const crypto = require("node:crypto");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

module.exports = { generateId };
