"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { atomicWriteFileSync } = require("./accounts-file");
const log = require("./logger");
const { errMsg } = require("./utils");

const INVALIDATION_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_WAIT_MS = 5000;      // Upper bound to prevent indefinite deferral
const STAT_CACHE_WINDOW_MS = 1000;  // Avoid redundant statSync in rapid failover loops

function normalizeStrategy(strategy) {
  const value = String(strategy || "round_robin").trim().toLowerCase();
  return ["round_robin", "random", "fixed"].includes(value) ? value : "round_robin";
}

function parseJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

class BaseAuthProvider {
  /**
   * @param {object} config
   * @param {string} logPrefix - log prefix, e.g. "auth provider" or "codex auth provider"
   */
  constructor(config, logPrefix) {
    this.config = config;
    this._logPrefix = logPrefix || "auth provider";
    this._rrIndex = 0;
    this._invalidAccounts = new Map();
    this._lastFailures = new Map();
    this._fileCache = null;
    this._saveTimer = null;
    this._maxWaitTimer = null;
    this._pendingWrite = Promise.resolve();
  }

  // --- Abstract-like methods (subclasses MUST override) ---

  /** @returns {string} resolved path to accounts JSON file */
  _resolveAccountsPath() {
    throw new Error("_resolveAccountsPath() must be overridden");
  }

  /** @returns {string} resolved path to state JSON file */
  _resolveStatePath() {
    throw new Error("_resolveStatePath() must be overridden");
  }

  /**
   * Normalize a raw account object into a canonical internal shape.
   * @param {object} account
   * @param {number} index
   * @returns {object|null}
   */
  _normalizeAccount(account, index) {
    throw new Error("_normalizeAccount() must be overridden");
  }

  // --- State persistence ---

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
        log.debug(this._logPrefix + " state load skipped", {
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

  _doSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;

    clearTimeout(this._maxWaitTimer);
    this._maxWaitTimer = null;

    this._pendingWrite = this._pendingWrite
      .then(() => this._saveAsync())
      .catch((error) => {
        log.warn(this._logPrefix + " async save failed", {
          path: this._resolveStatePath(),
          error: errMsg(error)
        });
      });
  }

  _scheduleSave() {
    // Schedule max-wait timer on first trigger — ensures save happens
    // within SAVE_MAX_WAIT_MS even under sustained high-frequency updates.
    if (!this._maxWaitTimer) {
      this._maxWaitTimer = setTimeout(() => this._doSave(), SAVE_MAX_WAIT_MS);
    }

    // Reset debounce timer on each call
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._doSave(), SAVE_DEBOUNCE_MS);
  }

  async _saveAsync() {
    const statePath = this._resolveStatePath();
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, JSON.stringify(this._serializeState(), null, 2));
  }

  _saveSync() {
    const statePath = this._resolveStatePath();

    try {
      atomicWriteFileSync(statePath, JSON.stringify(this._serializeState(), null, 2));
    } catch (error) {
      log.warn(this._logPrefix + " sync flush failed", {
        path: statePath,
        error: errMsg(error)
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
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    clearTimeout(this._maxWaitTimer);
    this._maxWaitTimer = null;

    this._saveSync();
  }

  // --- Account invalidation ---

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
      reason: errMsg(error)
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

  // --- Account usability ---

  _isAccountUsable(account) {
    if (!account || !account.enabled) {
      return false;
    }

    // Subclass-specific token/credential check
    if (!this._hasValidCredential(account)) {
      return false;
    }

    // Expiry check — subclass may override _isExpiredButRefreshable
    if (account.expiresAt && account.expiresAt <= Date.now() && !this._isExpiredButRefreshable(account)) {
      return false;
    }

    const invalidUntil = this.getInvalidUntil(account.id) || 0;
    return invalidUntil <= Date.now();
  }

  /**
   * Check whether account has a valid credential (token / bundle).
   * Subclasses override to check their specific credential shape.
   */
  _hasValidCredential(account) {
    return !!account.accessToken;
  }

  /**
   * Whether an expired account can still be used (e.g. has refreshToken).
   * Default: false. CodexAuthProvider overrides to return true when refreshToken exists.
   */
  _isExpiredButRefreshable(_account) {
    return false;
  }

  isAccountUsable(accountId) {
    const account = this.getConfiguredAccounts().find((item) => item.id === String(accountId));
    return this._isAccountUsable(account);
  }

  // --- File loading ---

  _loadFileAccounts() {
    const filePath = this._resolveAccountsPath();

    try {
      // Time-window cache: skip statSync entirely if last read was < 1s ago.
      // This avoids redundant syscalls during rapid failover loops where
      // getAuthToken → listCredentials → getConfiguredAccounts is called
      // multiple times per second.
      const now = Date.now();
      if (this._fileCache && this._fileCache.filePath === filePath && this._fileCache.readAt && now - this._fileCache.readAt < STAT_CACHE_WINDOW_MS) {
        return this._fileCache.result;
      }

      let mtimeMs = 0;

      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch (_) {
        // file may not exist yet
      }

      if (this._fileCache && this._fileCache.filePath === filePath && this._fileCache.mtimeMs === mtimeMs && mtimeMs > 0) {
        this._fileCache.readAt = now;
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

      this._fileCache = { filePath, mtimeMs, result, readAt: Date.now() };
      return result;
    } catch (error) {
      this._fileCache = null;

      if (error && error.code !== "ENOENT") {
        log.debug(this._logPrefix + " file load failed", {
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

  // --- Account ordering ---

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

  // --- Credential mapping (subclasses override) ---

  _mapAccountToCredential(account) {
    throw new Error("_mapAccountToCredential() must be overridden");
  }

  // --- Listing & resolution ---

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
      !this._activeAccount &&
      normalizeStrategy(this._fileStrategy || this.strategy) === "round_robin"
    ) {
      const allUsable = this.getConfiguredAccounts().filter((account) => this._isAccountUsable(account));
      const selectedIndex = allUsable.findIndex((account) => account.id === credential.accountId);
      if (selectedIndex >= 0) {
        this._rrIndex = (selectedIndex + 1) % Math.max(1, allUsable.length);
      }
    }

    return credential;
  }
}

module.exports = {
  BaseAuthProvider,
  normalizeStrategy,
  parseJsonFile,
  INVALIDATION_MS,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  STAT_CACHE_WINDOW_MS
};
