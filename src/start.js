"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { main: initEnv } = require("../scripts/init-env");

const envPath = process.env.ACCIO_ENV_PATH
  ? path.resolve(process.env.ACCIO_ENV_PATH)
  : path.resolve(__dirname, "..", ".env");

async function main() {
  if (!fs.existsSync(envPath)) {
    process.stdout.write(".env not found, running setup...\n");
    await initEnv();
  }

  require("./bootstrap");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
