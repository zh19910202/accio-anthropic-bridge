"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadAccountsFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return { strategy: "round_robin", activeAccount: null, accounts: parsed };
    }

    return {
      strategy: parsed && parsed.strategy ? parsed.strategy : "round_robin",
      activeAccount: parsed && parsed.activeAccount ? parsed.activeAccount : null,
      accounts: parsed && Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { strategy: "round_robin", activeAccount: null, accounts: [] };
    }

    throw error;
  }
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    const text = typeof value === "string" ? value.trim() : value;

    if (text === "") {
      continue;
    }

    return value;
  }

  return null;
}

function matchesAccountCandidate(account, candidates) {
  const values = new Set([
    account && account.id ? String(account.id) : "",
    account && account.accountId ? String(account.accountId) : "",
    account && account.name ? String(account.name) : "",
    account && account.user && account.user.id ? String(account.user.id) : ""
  ].filter(Boolean));

  return candidates.some((candidate) => values.has(candidate));
}

function buildStoredAuthPayload(account) {
  if (!account || typeof account !== "object") {
    return null;
  }

  const accessToken = pickFirstNonEmpty(account.accessToken);
  const refreshToken = pickFirstNonEmpty(account.refreshToken);
  const expiresAtRaw = pickFirstNonEmpty(account.expiresAtRaw, account.expiresAt ? String(Math.floor(Number(account.expiresAt) / 1000)) : null);
  const expiresAtMs = Number(account.expiresAt || 0) || (expiresAtRaw ? Number(expiresAtRaw) * 1000 : 0) || null;
  const cookie = pickFirstNonEmpty(account.cookie);

  if (!accessToken || !refreshToken || !expiresAtRaw) {
    return null;
  }

  return {
    accessToken: String(accessToken),
    refreshToken: String(refreshToken),
    expiresAtRaw: String(expiresAtRaw),
    expiresAtMs,
    cookie: cookie ? String(cookie) : null,
    user: account.user && typeof account.user === "object" ? account.user : null,
    source: account.source ? String(account.source) : "accounts-file",
    capturedAt: account.authCapturedAt ? String(account.authCapturedAt) : null
  };
}

function findStoredAccountAuthPayload(filePath, lookup = {}) {
  const state = loadAccountsFile(filePath);
  const candidates = [
    lookup.alias,
    lookup.accountId,
    lookup.userId,
    lookup.name
  ].filter(Boolean).map((value) => String(value));

  if (candidates.length === 0) {
    return null;
  }

  const account = state.accounts.find((entry) => matchesAccountCandidate(entry, candidates));
  return buildStoredAuthPayload(account);
}

function writeAccountToFile(filePath, accountId, accessToken, extras = {}) {
  const resolvedPath = path.resolve(filePath);
  const state = loadAccountsFile(resolvedPath);
  const normalizedId = String(accountId);
  const user = extras && extras.user && typeof extras.user === "object" ? extras.user : null;
  const userId = user && user.id ? String(user.id) : normalizedId;
  const userName = user && user.name ? String(user.name) : normalizedId;
  const existingAccount = state.accounts.find((account) => String(account.id || account.accountId) === normalizedId) || null;
  const accounts = state.accounts.filter((account) => String(account.id || account.accountId) !== normalizedId);
  const authPayload = extras && extras.authPayload && typeof extras.authPayload === "object" ? extras.authPayload : null;
  const storedRefreshToken = pickFirstNonEmpty(authPayload && authPayload.refreshToken, extras.refreshToken, existingAccount && existingAccount.refreshToken);
  const storedExpiresAtRaw = pickFirstNonEmpty(authPayload && authPayload.expiresAtRaw, extras.expiresAtRaw, existingAccount && existingAccount.expiresAtRaw);
  const storedCookie = pickFirstNonEmpty(authPayload && authPayload.cookie, extras.cookie, existingAccount && existingAccount.cookie);
  const storedAuthCapturedAt = pickFirstNonEmpty(authPayload && authPayload.capturedAt, extras.authCapturedAt, existingAccount && existingAccount.authCapturedAt);

  const nextAccount = {
    ...(existingAccount && typeof existingAccount === "object" ? existingAccount : {}),
    id: normalizedId,
    name: userName,
    accountId: userId,
    accessToken: String(accessToken),
    enabled: true,
    expiresAt: extras && extras.expiresAtMs ? Number(extras.expiresAtMs) : Number(existingAccount && existingAccount.expiresAt || 0) || null,
    source: extras && extras.source ? String(extras.source) : existingAccount && existingAccount.source ? String(existingAccount.source) : "gateway-capture",
    user
  };

  if (storedRefreshToken) {
    nextAccount.refreshToken = String(storedRefreshToken);
  }

  if (storedExpiresAtRaw) {
    nextAccount.expiresAtRaw = String(storedExpiresAtRaw);
  }

  if (storedCookie) {
    nextAccount.cookie = String(storedCookie);
  }

  if (storedAuthCapturedAt) {
    nextAccount.authCapturedAt = String(storedAuthCapturedAt);
  }

  accounts.push(nextAccount);

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(
    resolvedPath,
    JSON.stringify({ strategy: state.strategy, activeAccount: state.activeAccount, accounts }, null, 2) + "\n",
    "utf8"
  );

  return resolvedPath;
}

function removeAccountFromFile(filePath, lookup = {}) {
  const resolvedPath = path.resolve(filePath);
  const state = loadAccountsFile(resolvedPath);
  const candidates = [
    lookup.alias,
    lookup.accountId,
    lookup.userId,
    lookup.name
  ].filter(Boolean).map((value) => String(value));

  if (candidates.length === 0) {
    return {
      removed: false,
      path: resolvedPath,
      removedAccounts: []
    };
  }

  const removedAccounts = state.accounts.filter((account) => matchesAccountCandidate(account, candidates));
  if (removedAccounts.length === 0) {
    return {
      removed: false,
      path: resolvedPath,
      removedAccounts: []
    };
  }

  const nextAccounts = state.accounts.filter((account) => !matchesAccountCandidate(account, candidates));
  const removedIds = new Set(removedAccounts.map((account) => String(account && (account.id || account.accountId || ""))).filter(Boolean));
  const nextActiveAccount = state.activeAccount && removedIds.has(String(state.activeAccount))
    ? null
    : state.activeAccount;

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(
    resolvedPath,
    JSON.stringify({ strategy: state.strategy, activeAccount: nextActiveAccount, accounts: nextAccounts }, null, 2) + "\n",
    "utf8"
  );

  return {
    removed: true,
    path: resolvedPath,
    removedAccounts: removedAccounts.map((account) => ({
      id: account && account.id ? String(account.id) : null,
      accountId: account && account.accountId ? String(account.accountId) : null,
      name: account && account.name ? String(account.name) : null
    }))
  };
}

module.exports = {
  loadAccountsFile,
  findStoredAccountAuthPayload,
  writeAccountToFile,
  removeAccountFromFile
};
