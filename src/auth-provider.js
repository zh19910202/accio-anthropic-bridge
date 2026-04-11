"use strict";

const fs = require("node:fs");
const path = require("node:path");

const log = require("./logger");
const { BaseAuthProvider, normalizeStrategy } = require("./base-auth-provider");
const { errMsg } = require("./utils");

function normalizeMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  return ["auto", "gateway", "env", "file"].includes(value) ? value : "auto";
}

class AuthProvider extends BaseAuthProvider {
  constructor(config) {
    super(config, "auth provider");
    this.mode = normalizeMode(config.authMode);
    this.strategy = normalizeStrategy(config.authStrategy);
    this.loadState();
  }

  _resolveAccountsPath() {
    return path.resolve(this.config.accountsPath || path.join(process.cwd(), "config", "accounts.json"));
  }

  _resolveStatePath() {
    return path.resolve(
      this.config.authStatePath || path.join(process.cwd(), ".data", "auth-provider-state.json")
    );
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
          error: errMsg(error)
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
      refreshToken: account.refreshToken ? String(account.refreshToken) : null,
      cookie: account.cookie ? String(account.cookie) : null,
      user: account.user && typeof account.user === "object" ? account.user : null,
      enabled: account.enabled !== false,
      expiresAt: Number(account.expiresAt || 0) || null,
      expiresAtRaw: account.expiresAtRaw ? String(account.expiresAtRaw) : null,
      source: account.source || "file",
      priority: Number(account.priority || index + 1) || index + 1,
      authMode: account.authMode || null,
      baseUrl: account.baseUrl || null,
      transportOverride: account.transportOverride || null,
      accountId: String(account.accountId || id)
    };
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

  _mapAccountToCredential(account) {
    if (!account) {
      return null;
    }

    return {
      accountId: account.id,
      accountName: account.name,
      token: account.accessToken,
      refreshToken: account.refreshToken || null,
      cookie: account.cookie || null,
      user: account.user || null,
      expiresAt: account.expiresAt || null,
      expiresAtRaw: account.expiresAtRaw || null,
      source: account.source,
      transportOverride: account.transportOverride || null,
      baseUrl: account.baseUrl || null
    };
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
      invalidAccounts: Object.fromEntries(this._invalidAccounts),
      authStatePath: this._resolveStatePath()
    };
  }
}

module.exports = {
  AuthProvider,
  normalizeMode,
  normalizeStrategy
};
