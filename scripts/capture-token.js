"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadEnvFile } = require("../src/env-file");
const { GatewayManager } = require("../src/gateway-manager");
const { discoverAccioAppPath } = require("../src/discovery");

const REPO_ROOT = path.resolve(__dirname, "..");

loadEnvFile(path.join(REPO_ROOT, ".env"));

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function parseArgs(argv) {
  const args = {
    writeFile: argv.includes("--write-file"),
    json: argv.includes("--json"),
    accountId: env("ACCIO_AUTH_ACCOUNT_ID", env("ACCIO_ACCOUNT_ID", "captured-gateway"))
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--account-id" && argv[index + 1]) {
      args.accountId = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function maskToken(token) {
  if (!token) {
    return "***";
  }

  return token.length > 8 ? `${token.slice(0, 8)}***` : "***";
}

function loadAccountsFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return { strategy: "round_robin", accounts: parsed };
    }

    return {
      strategy: parsed && parsed.strategy ? parsed.strategy : "round_robin",
      accounts: parsed && Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { strategy: "round_robin", accounts: [] };
    }

    throw error;
  }
}

function writeAccountToFile(filePath, accountId, accessToken) {
  const state = loadAccountsFile(filePath);
  const accounts = state.accounts.filter((account) => String(account.id || account.accountId) !== accountId);

  accounts.push({
    id: accountId,
    accessToken,
    enabled: true,
    source: "gateway-capture"
  });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ strategy: state.strategy, accounts }, null, 2) + "\n",
    "utf8"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountsPath = path.resolve(env("ACCIO_ACCOUNTS_CONFIG_PATH", env("ACCIO_ACCOUNTS_PATH", path.join(REPO_ROOT, "config", "accounts.json"))));
  const manager = new GatewayManager({
    baseUrl: env("ACCIO_BASE_URL", "http://127.0.0.1:4097"),
    appPath: discoverAccioAppPath(env("ACCIO_APP_PATH", "")),
    autostartEnabled: env("ACCIO_GATEWAY_AUTOSTART", "1"),
    waitMs: Number(env("ACCIO_GATEWAY_WAIT_MS", "20000")),
    pollMs: Number(env("ACCIO_GATEWAY_POLL_MS", "500"))
  });
  const result = await manager.resolveAccessToken({ allowAutostart: true });

  if (args.writeFile) {
    writeAccountToFile(accountsPath, args.accountId, result.token);
  }

  const output = {
    ok: true,
    accountId: args.accountId,
    accountsPath: args.writeFile ? accountsPath : null,
    gateway: manager.getSummary(),
    launchedApp: result.launchedApp,
    quitAfterCapture: false,
    tokenPreview: maskToken(result.token)
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Captured Accio access token for ${args.accountId}: ${maskToken(result.token)}\n`);

  if (args.writeFile) {
    process.stdout.write(`Updated ${accountsPath}\n`);
  }

  if (!args.writeFile) {
    process.stdout.write("Re-run with --write-file to persist it into ACCIO_ACCOUNTS_CONFIG_PATH.\n");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
