"use strict";

const fs = require("node:fs");
const path = require("node:path");

const log = require("./logger");

const INVALIDATION_MS = 5 * 60 * 1000;

function normalizeMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  return ["auto", "gateway", "env", "file"].includes(value) ? value : "auto";
}

function normalizeStrategy(strategy) {
  const value = String(strategy || "round_robin").trim().toLowerCase();
  return ["round_robin", "random", "fixed"].includes(value) ? value : "round_robin";
}

function parseJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

class AuthProvider {
  constructor(config) {
    this.config = config;
    this.mode = normalizeMode(config.authMode);
    this.strategy = normalizeStrategy(config.authStrategy);
    this._rrIndex = 0;
    this._invalidAccounts = new Map();
    this._lastFailures = new Map();
  }

  _resolveAccountsPath() {
    return path.resolve(this.config.accountsPath || path.join(process.cwd(), "config", "accounts.json"));
  }

  _resolveToken(account) {
    if (account.accessToken) {
      return String(account.accessToken);
    }

    if (account.tokenFile) {
      try {
        return String(fs.readFileSync(path.resolve(account.tokenFile), "utf8")).trim();
      } catch (error) {
        log.debug("auth provider token file load failed", {
          tokenFile: account.tokenFile,
          error: error && error.message ? error.message : String(error)
        });
      }
    }

    if (account.envKey && process.env[account.envKey]) {
      return String(process.env[account.envKey]).trim();
    }

    return "";
  }

  _normalizeAccount(account, index = 0) {
    if (!account || typeof account !== "object") {
      return null;
    }

    const accessToken = this._resolveToken(account);
    const id = String(account.id || account.accountId || account.name || `acct_${index + 1}`);

    return {
      id,
      name: String(account.name || id),
      accessToken,
      enabled: account.enabled !== false,
      expiresAt: Number(account.expiresAt || 0) || null,
      source: account.source || "file",
      priority: Number(account.priority || index + 1) || index + 1,
      authMode: account.authMode || null,
      baseUrl: account.baseUrl || null,
      transportOverride: account.transportOverride || null,
      accountId: String(account.accountId || id)
    };
  }

  _loadFileAccounts() {
    const filePath = this._resolveAccountsPath();

    try {
      const parsed = parseJsonFile(filePath);
      const rawAccounts = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.accounts)
          ? parsed.accounts
          : [];
      const strategy = Array.isArray(parsed) ? this.strategy : normalizeStrategy(parsed && parsed.strategy);
      const activeAccount = Array.isArray(parsed) ? null : parsed && parsed.activeAccount ? String(parsed.activeAccount) : null;
      const accounts = rawAccounts
        .map((account, index) => this._normalizeAccount(account, index))
        .filter(Boolean)
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

      return {
        strategy,
        activeAccount,
        accounts,
        filePath,
        ok: true
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        log.debug("auth provider file load failed", {
          filePath,
          error: error.message || String(error)
        });
      }

      return {
        strategy: this.strategy,
        activeAccount: null,
        accounts: [],
        filePath,
        ok: false
      };
    }
  }

  _loadEnvAccounts() {
    const accessToken = String(this.config.accessToken || "").trim();

    if (!accessToken) {
      return [];
    }

    return [
      {
        id: String(this.config.envAccountId || "env-default"),
        name: String(this.config.envAccountId || "env-default"),
        accessToken,
        enabled: true,
        expiresAt: Number(this.config.accessTokenExpiresAt || 0) || null,
        source: "env",
        priority: 1,
        authMode: "env",
        baseUrl: null,
        transportOverride: null,
        accountId: String(this.config.envAccountId || "env-default")
      }
    ];
  }

  getInvalidUntil(accountId) {
    return this._invalidAccounts.get(String(accountId)) || null;
  }

  getLastFailure(accountId) {
    return this._lastFailures.get(String(accountId)) || null;
  }

  isAccountUsable(accountId) {
    const account = this.getConfiguredAccounts().find((item) => item.id === String(accountId));
    return this._isAccountUsable(account);
  }

  _isAccountUsable(account) {
    if (!account || !account.enabled || !account.accessToken) {
      return false;
    }

    if (account.expiresAt && account.expiresAt <= Date.now()) {
      return false;
    }

    const invalidUntil = this._invalidAccounts.get(account.id) || 0;
    return invalidUntil <= Date.now();
  }

  getConfiguredAccounts() {
    const fileState = this._loadFileAccounts();
    const envAccounts = this._loadEnvAccounts();

    if (this.mode === "file") {
      this._fileStrategy = fileState.strategy;
      this._activeAccount = fileState.activeAccount;
      return fileState.accounts;
    }

    if (this.mode === "env") {
      this._fileStrategy = this.strategy;
      this._activeAccount = null;
      return envAccounts;
    }

    this._fileStrategy = fileState.strategy;
    this._activeAccount = fileState.activeAccount;
    return [...fileState.accounts, ...envAccounts];
  }

  _pickAccount(accounts, options = {}) {
    const requestedAccountId = options.accountId ? String(options.accountId) : null;
    const stickyAccountId = options.stickyAccountId ? String(options.stickyAccountId) : null;
    const activeAccount = options.activeAccount ? String(options.activeAccount) : null;

    if (requestedAccountId) {
      return accounts.find((account) => account.id === requestedAccountId || account.name === requestedAccountId) || null;
    }

    if (stickyAccountId) {
      const sticky = accounts.find((account) => account.id === stickyAccountId || account.name === stickyAccountId);

      if (sticky) {
        return sticky;
      }
    }

    if (activeAccount) {
      const active = accounts.find((account) => account.id === activeAccount || account.name === activeAccount);

      if (active) {
        return active;
      }
    }

    if (accounts.length === 0) {
      return null;
    }

    const strategy = normalizeStrategy(this._fileStrategy || this.strategy);

    if (strategy === "fixed") {
      return accounts[0];
    }

    if (strategy === "random") {
      return accounts[Math.floor(Math.random() * accounts.length)] || null;
    }

    const account = accounts[this._rrIndex % accounts.length] || null;
    this._rrIndex = (this._rrIndex + 1) % Math.max(1, accounts.length);
    return account;
  }

  resolveCredential(options = {}) {
    const excludeIds = new Set(Array.isArray(options.excludeIds) ? options.excludeIds.map(String) : []);
    const candidates = this.getConfiguredAccounts().filter(
      (account) => this._isAccountUsable(account) && !excludeIds.has(account.id)
    );
    const account = this._pickAccount(candidates, {
      accountId: options.accountId,
      stickyAccountId: options.stickyAccountId,
      activeAccount: this._activeAccount
    });

    return account
      ? {
          accountId: account.id,
          accountName: account.name,
          token: account.accessToken,
          source: account.source,
          transportOverride: account.transportOverride || null,
          baseUrl: account.baseUrl || null
        }
      : null;
  }

  invalidateAccount(accountId, reason = null) {
    if (!accountId) {
      return;
    }

    this._invalidAccounts.set(String(accountId), Date.now() + INVALIDATION_MS);

    if (reason) {
      this._lastFailures.set(String(accountId), {
        at: new Date().toISOString(),
        reason: String(reason)
      });
    }
  }

  recordFailure(accountId, error) {
    if (!accountId) {
      return;
    }

    this._lastFailures.set(String(accountId), {
      at: new Date().toISOString(),
      reason: error && error.message ? error.message : String(error)
    });
  }

  clearFailure(accountId) {
    if (!accountId) {
      return;
    }

    this._lastFailures.delete(String(accountId));
  }

  clearInvalidation(accountId) {
    if (!accountId) {
      return;
    }

    this._invalidAccounts.delete(String(accountId));
  }

  getSummary() {
    const fileState = this._loadFileAccounts();
    const envAccounts = this._loadEnvAccounts();

    return {
      mode: this.mode,
      strategy: normalizeStrategy(fileState.strategy || this.strategy),
      accountsPath: fileState.filePath,
      activeAccount: fileState.activeAccount,
      fileAccounts: fileState.accounts.map((account) => account.id),
      envAccounts: envAccounts.map((account) => account.id),
      activeExternalAccounts: this.getConfiguredAccounts()
        .filter((account) => this._isAccountUsable(account))
        .map((account) => account.id),
      lastFailures: Object.fromEntries(this._lastFailures),
      invalidAccounts: Object.fromEntries(this._invalidAccounts)
    };
  }
}

module.exports = {
  AuthProvider,
  normalizeMode,
  normalizeStrategy
};
