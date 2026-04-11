"use strict";

const crypto = require("node:crypto");

const ID_SUFFIX_LENGTH = 24;

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, ID_SUFFIX_LENGTH)}`;
}

module.exports = { generateId };
