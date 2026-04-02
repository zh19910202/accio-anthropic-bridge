"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const log = require("./logger");

const INVALIDATION_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

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
    this._fileCache = null;
    this._saveTimer = null;
    this._pendingWrite = Promise.resolve();
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

  loadState() {
    const statePath = this._resolveStatePath();

    try {
      const text = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(text);
      const invalidAccounts = parsed && typeof parsed.invalidAccounts === "object"
        ? parsed.invalidAccounts
        : {};
      const lastFailures = parsed && typeof parsed.lastFailures === "object"
        ? parsed.lastFailures
        : {};

      this._invalidAccounts = new Map(
        Object.entries(invalidAccounts)
          .map(([accountId, until]) => [String(accountId), Number(until) || 0])
          .filter(([, until]) => Number.isFinite(until) && until > 0)
      );
      this._lastFailures = new Map(
        Object.entries(lastFailures)
          .filter(([, value]) => value && typeof value === "object")
          .map(([accountId, value]) => [String(accountId), value])
      );
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        log.debug("auth provider state load skipped", {
          path: statePath,
          error: error.message || String(error)
        });
      }
    }

    this._purgeExpiredInvalidations();
  }

  _purgeExpiredInvalidations() {
    const now = Date.now();
    let changed = false;

    for (const [accountId, until] of this._invalidAccounts.entries()) {
      if (!Number.isFinite(until) || until <= now) {
        this._invalidAccounts.delete(accountId);
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }
  }

  _scheduleSave() {
    if (this._saveTimer) {
      return;
    }

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._pendingWrite = this._pendingWrite
        .then(() => this._saveAsync())
        .catch((error) => {
          log.warn("auth provider async save failed", {
            path: this._resolveStatePath(),
            error: error && error.message ? error.message : String(error)
          });
        });
    }, SAVE_DEBOUNCE_MS);
  }

  async _saveAsync() {
    const statePath = this._resolveStatePath();
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, JSON.stringify(this._serializeState(), null, 2));
  }

  _saveSync() {
    const statePath = this._resolveStatePath();

    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(this._serializeState(), null, 2));
    } catch (error) {
      log.warn("auth provider sync flush failed", {
        path: statePath,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  _serializeState() {
    return {
      invalidAccounts: Object.fromEntries(this._invalidAccounts),
      lastFailures: Object.fromEntries(this._lastFailures)
    };
  }

  save() {
    this._scheduleSave();
  }

  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    this._saveSync();
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

  _loadFileAccounts() {
    const filePath = this._resolveAccountsPath();

    try {
      let mtimeMs = 0;

      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch (_) {
        // file may not exist yet
      }

      if (this._fileCache && this._fileCache.filePath === filePath && this._fileCache.mtimeMs === mtimeMs && mtimeMs > 0) {
        return this._fileCache.result;
      }

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

      const result = {
        strategy,
        activeAccount,
        accounts,
        filePath,
        ok: true
      };

      this._fileCache = { filePath, mtimeMs, result };
      return result;
    } catch (error) {
      this._fileCache = null;

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
    if (!accountId) {
      return null;
    }

    const normalizedId = String(accountId);
    const invalidUntil = this._invalidAccounts.get(normalizedId) || 0;

    if (invalidUntil > Date.now()) {
      return invalidUntil;
    }

    if (invalidUntil) {
      this._invalidAccounts.delete(normalizedId);
      this.save();
    }

    return null;
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

    const invalidUntil = this.getInvalidUntil(account.id) || 0;
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

  _orderAccounts(accounts, options = {}) {
    const requestedAccountId = options.accountId ? String(options.accountId) : null;
    const stickyAccountId = options.stickyAccountId ? String(options.stickyAccountId) : null;
    const activeAccount = options.activeAccount ? String(options.activeAccount) : null;

    if (requestedAccountId) {
      const requested = accounts.find((account) => account.id === requestedAccountId || account.name === requestedAccountId);
      return requested ? [requested] : [];
    }

    if (stickyAccountId) {
      const sticky = accounts.find((account) => account.id === stickyAccountId || account.name === stickyAccountId);

      if (sticky) {
        return [sticky, ...accounts.filter((account) => account.id !== sticky.id)];
      }
    }

    if (activeAccount) {
      const active = accounts.find((account) => account.id === activeAccount || account.name === activeAccount);

      if (active) {
        return [active, ...accounts.filter((account) => account.id !== active.id)];
      }
    }

    if (accounts.length === 0) {
      return [];
    }

    const strategy = normalizeStrategy(this._fileStrategy || this.strategy);

    if (strategy === "fixed") {
      return [...accounts];
    }

    if (strategy === "random") {
      const shuffled = [...accounts];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }

    const startIndex = this._rrIndex % accounts.length;
    return [
      ...accounts.slice(startIndex),
      ...accounts.slice(0, startIndex)
    ];
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

  listCredentials(options = {}) {
    const excludeIds = new Set(Array.isArray(options.excludeIds) ? options.excludeIds.map(String) : []);
    const candidates = this.getConfiguredAccounts().filter(
      (account) => this._isAccountUsable(account) && !excludeIds.has(account.id)
    );

    return this._orderAccounts(candidates, {
      accountId: options.accountId,
      stickyAccountId: options.stickyAccountId,
      activeAccount: this._activeAccount
    }).map((account) => this._mapAccountToCredential(account)).filter(Boolean);
  }

  resolveCredential(options = {}) {
    const credentials = this.listCredentials(options);
    const credential = credentials[0] || null;

    if (
      credential &&
      !options.accountId &&
      !options.stickyAccountId &&
      !(Array.isArray(options.excludeIds) && options.excludeIds.length > 0) &&
      !this._activeAccount &&
      normalizeStrategy(this._fileStrategy || this.strategy) === "round_robin"
    ) {
      const accountCount = Math.max(1, this.getConfiguredAccounts().filter((account) => this._isAccountUsable(account)).length);
      this._rrIndex = (this._rrIndex + 1) % accountCount;
    }

    return credential;
  }

  invalidateAccount(accountId, reason = null, untilMs = null) {
    if (!accountId) {
      return;
    }

    if (untilMs != null && Number.isFinite(Number(untilMs)) && Number(untilMs) <= Date.now()) {
      this._invalidAccounts.delete(String(accountId));
      this.save();
      return;
    }

    const defaultUntil = Date.now() + INVALIDATION_MS;
    const nextUntil = untilMs != null && Number.isFinite(Number(untilMs)) ? Number(untilMs) : defaultUntil;

    this._invalidAccounts.set(String(accountId), nextUntil);

    if (reason) {
      this._lastFailures.set(String(accountId), {
        at: new Date().toISOString(),
        reason: String(reason)
      });
    }

    this.save();
  }

  invalidateAccountUntil(accountId, untilMs, reason = null) {
    this.invalidateAccount(accountId, reason, untilMs);
  }

  recordFailure(accountId, error) {
    if (!accountId) {
      return;
    }

    this._lastFailures.set(String(accountId), {
      at: new Date().toISOString(),
      reason: error && error.message ? error.message : String(error)
    });
    this.save();
  }

  clearFailure(accountId) {
    if (!accountId) {
      return;
    }

    this._lastFailures.delete(String(accountId));
    this.save();
  }

  clearInvalidation(accountId) {
    if (!accountId) {
      return;
    }

    this._invalidAccounts.delete(String(accountId));
    this.save();
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
