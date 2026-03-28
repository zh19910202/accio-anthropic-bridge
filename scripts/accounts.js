#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadEnvFile } = require("../src/env-file");
const { AuthProvider } = require("../src/auth-provider");
const { createConfig } = require("../src/runtime-config");

loadEnvFile(path.resolve(__dirname, "..", ".env"));

function readAccountsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { strategy: "round_robin", accounts: [] };
    }

    throw error;
  }
}

function writeAccountsFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  const command = process.argv[2] || "list";
  const extra = process.argv[3] || null;
  const config = createConfig();
  const provider = new AuthProvider(config);
  const filePath = path.resolve(config.accountsPath);

  if (command === "list") {
    printJson(provider.getSummary());
    return;
  }

  if (command === "probe") {
    printJson({
      ok: true,
      accounts: provider.getConfiguredAccounts().map((account) => ({
        id: account.id,
        name: account.name,
        enabled: account.enabled,
        priority: account.priority,
        source: account.source,
        hasToken: Boolean(account.accessToken),
        expired: Boolean(account.expiresAt && account.expiresAt <= Date.now()),
        transportOverride: account.transportOverride || null,
        usable: provider.isAccountUsable(account.id),
        invalidUntil: provider.getInvalidUntil(account.id),
        lastFailure: provider.getLastFailure(account.id)
      }))
    });
    return;
  }

  if (command === "validate") {
    const accounts = provider.getConfiguredAccounts();
    const usable = accounts.filter((account) => provider.isAccountUsable(account.id));
    printJson({
      ok: usable.length > 0,
      totalAccounts: accounts.length,
      usableAccounts: usable.map((account) => account.id),
      accountsPath: filePath
    });

    if (usable.length === 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "activate") {
    if (!extra) {
      throw new Error("Usage: npm run accounts:activate -- <account-id-or-name>");
    }

    const parsed = readAccountsFile(filePath);
    parsed.activeAccount = extra;
    writeAccountsFile(filePath, parsed);
    printJson({ ok: true, activeAccount: extra, accountsPath: filePath });
    return;
  }

  throw new Error(`Unknown accounts command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
