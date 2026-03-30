"use strict";

const fs = require("node:fs");

function parseEnvValue(raw) {
  const trimmed = raw.trim();

  if (!trimmed) {
    return "";
  }

  // Double-quoted: process escape sequences (shell-style)
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  // Single-quoted: literal value, no escape processing (POSIX shell semantics)
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(filePath) {
  let text;

  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = line.slice(equalsIndex + 1);
    process.env[key] = parseEnvValue(rawValue);
  }
}

module.exports = {
  loadEnvFile,
  parseEnvValue
};
