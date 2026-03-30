#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const { loadEnvFile } = require("../src/env-file");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");
loadEnvFile(process.env.ACCIO_ENV_PATH ? path.resolve(process.env.ACCIO_ENV_PATH) : path.join(REPO_ROOT, ".env"));

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

async function main() {
  const port = Number(env("PORT", "8082"));
  const url = `http://127.0.0.1:${port}/admin`;

  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }

  process.stdout.write(`${url}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
