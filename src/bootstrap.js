"use strict";

const path = require("node:path");
const { loadEnvFile } = require("./env-file");

const envPath = process.env.ACCIO_ENV_PATH
  ? path.resolve(process.env.ACCIO_ENV_PATH)
  : path.resolve(__dirname, "..", ".env");

loadEnvFile(envPath);

require("./server");
