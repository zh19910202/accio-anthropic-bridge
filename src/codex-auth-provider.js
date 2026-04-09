"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { atomicWriteFileSync } = require("./accounts-file");
const log = require("./logger");

const INVALIDATION_MS = 5 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

function pickFirst(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      return String(v);
    }
  }
  return null;
}

function normalizeStrategy(strategy) {
  const value = String(strategy || "round_robin").trim().toLowerCase();
  return ["round_robin", "random", "fixed"].includes(value) ? value : "round_robin";
}

function parseJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function mergeCredentialBundle(existingBundle, incomingBundle) {
  if (!incomingBundle || typeof incomingBundle !== "object") {
    return existingBundle && typeof existingBundle === "object" ? { ...existingBundle } : {};
  }

  const existing = existingBundle && typeof existingBundle === "object" ? existingBundle : {};
  const next = {
    ...existing,
    ...incomingBundle
  };

  if (
    existing.tokens && typeof existing.tokens === "object" &&
    incomingBundle.tokens && typeof incomingBundle.tokens === "object"
  ) {
    next.tokens = {
      ...existing.tokens,
      ...incomingBundle.tokens
    };
  }

  if (
    existing.headers && typeof existing.headers === "object" &&
    incomingBundle.headers && typeof incomingBundle.headers === "object"
  ) {
    next.headers = {
      ...existing.headers,
      ...incomingBundle.headers
    };
  }

  if (
    existing.additionalHeaders && typeof existing.additionalHeaders === "object" &&
    incomingBundle.additionalHeaders && typeof incomingBundle.additionalHeaders === "object"
  ) {
    next.additionalHeaders = {
      ...existing.additionalHeaders,
      ...incomingBundle.additionalHeaders
    };
  }

  return next;
}

class CodexAuthProvider {
  constructor(config = {}) {
    this.config = config;
    this.strategy = normalizeStrategy(config.codexAuthStrategy || "round_robin");
    this._rrIndex = 0;
    this._invalidAccounts = new Map();
    this._lastFailures = new Map();
    this._fileCache = null;
    this._saveTimer = null;
    this._pendingWrite = Promise.resolve();
    this.loadState();
  }

  _resolveAccountsPath() {
    return path.resolve(
      this.config.codexAccountsPath || path.join(process.cwd(), "config", "codex-accounts.json")
    );
  }

  _resolveStatePath() {
    return path.resolve(
      this.config.codexAuthStatePath || path.join(process.cwd(), ".data", "codex-auth-provider-state.json")
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
        log.debug("codex auth provider state load skipped", {
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
          log.warn("codex auth provider async save failed", {
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

  _serializeState() {
    return {
      invalidAccounts: Object.fromEntries(this._invalidAccounts),
      lastFailures: Object.fromEntries(this._lastFailures)
    };
  }

  _saveSync() {
    try {
      const statePath = this._resolveStatePath();
      atomicWriteFileSync(statePath, JSON.stringify(this._serializeState(), null, 2));
    } catch (error) {
      log.warn("codex auth provider sync save failed", {
        path: this._resolveStatePath(),
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  save() {
    this._scheduleSave();
  }

  _normalizeAccount(account, index = 0) {
    if (!account || typeof account !== "object") {
      return null;
    }

    const id = String(account.id || account.accountId || account.name || `codex_${index + 1}`).trim();
    if (!id) {
      return null;
    }

    const bundle = account.credentialBundle && typeof account.credentialBundle === "object"
      ? account.credentialBundle
      : {};
    const bundleTokens = bundle.tokens && typeof bundle.tokens === "object"
      ? bundle.tokens
      : {};

    // 从顶层或 credentialBundle 中提取 token（兼容 camelCase 和 snake_case）
    const accessToken = pickFirst(
      account.accessToken,
      account.access_token,
      bundleTokens.access_token,
      bundleTokens.accessToken,
      bundle.accessToken,
      bundle.access_token
    );
    const refreshToken = pickFirst(
      account.refreshToken,
      account.refresh_token,
      bundleTokens.refresh_token,
      bundleTokens.refreshToken,
      bundle.refreshToken,
      bundle.refresh_token
    );

    let credentialBundle = Object.keys(bundle).length > 0 ? { ...bundle } : null;

    // 如果没有 credentialBundle 但有 accessToken，自动构建
    if (!credentialBundle && accessToken) {
      credentialBundle = { accessToken };
    }

    // 如果 credentialBundle 存在但没有 accessToken，同步进去
    if (credentialBundle && accessToken && !credentialBundle.accessToken && !credentialBundle.access_token) {
      credentialBundle = { ...credentialBundle, accessToken };
    }

    // 从 credentialBundle 中提取 ChatGPT account_id（用于 chatgpt-account-id 请求头）
    const chatGptAccountId = pickFirst(
      account.chatGptAccountId,
      account.chatgpt_account_id,
      account.account_id,
      bundleTokens.account_id,
      bundleTokens.accountId,
      bundle.account_id,
      bundle.accountId,
      bundle.chatgpt_account_id
    );
    const probeModel = pickFirst(
      account.probeModel,
      account.model,
      account.preferredModel,
      bundle.probeModel,
      bundle.defaultModel,
      bundle.model
    );
    const authMode = pickFirst(
      account.authMode,
      bundle.auth_mode,
      bundle.authMode
    );

    return {
      id,
      name: String(account.name || id),
      enabled: account.enabled !== false,
      priority: Number(account.priority || index + 1) || index + 1,
      source: account.source || "codex-file",
      baseUrl: account.baseUrl ? String(account.baseUrl) : null,
      credentialBundle,
      accessToken,
      refreshToken,
      expiresAt: Number(account.expiresAt || 0) || null,
      clientId: account.clientId ? String(account.clientId) : null,
      accountId: id,
      chatGptAccountId,
      probeModel,
      model: probeModel,
      authMode
    };
  }

  _loadFileAccounts() {
    const filePath = this._resolveAccountsPath();

    try {
      let mtimeMs = 0;

      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch (_) {
        // File may not exist yet.
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
        log.debug("codex auth provider file load failed", {
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

  _isAccountUsable(account) {
    if (!account || !account.enabled || !account.credentialBundle) {
      return false;
    }

    // 如果有 refreshToken，过期的 accessToken 仍可用（请求时刷新）
    if (account.expiresAt && account.expiresAt <= Date.now() && !account.refreshToken) {
      return false;
    }

    const invalidUntil = this.getInvalidUntil(account.id) || 0;
    return invalidUntil <= Date.now();
  }

  isAccountUsable(accountId) {
    const account = this.getConfiguredAccounts().find((item) => item.id === String(accountId));
    return this._isAccountUsable(account);
  }

  getConfiguredAccounts() {
    const fileState = this._loadFileAccounts();
    this._fileStrategy = fileState.strategy;
    this._activeAccount = fileState.activeAccount;
    return fileState.accounts;
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
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
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
      source: account.source || "codex-file",
      baseUrl: account.baseUrl || null,
      credentialBundle: account.credentialBundle || null,
      accessToken: account.accessToken || null,
      refreshToken: account.refreshToken || null,
      expiresAt: account.expiresAt || null,
      clientId: account.clientId || null,
      chatGptAccountId: account.chatGptAccountId || null,
      probeModel: account.probeModel || account.model || null,
      model: account.model || account.probeModel || null,
      authMode: account.authMode || null
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

  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    this._saveSync();
  }

  updateAccountToken(accountId, updates) {
    if (!accountId || !updates || typeof updates !== "object") {
      return;
    }

    const normalizedId = String(accountId);
    const filePath = this._resolveAccountsPath();

    try {
      const parsed = parseJsonFile(filePath);
      const rawAccounts = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.accounts)
          ? parsed.accounts
          : [];

      const updated = rawAccounts.map((account) => {
        const id = String(account.id || account.accountId || account.name || "");
        if (id !== normalizedId) {
          return account;
        }

        const next = { ...account };

        if (updates.accessToken) {
          next.accessToken = String(updates.accessToken);
        }

        if (updates.refreshToken) {
          next.refreshToken = String(updates.refreshToken);
        }

        if (Object.prototype.hasOwnProperty.call(updates, "expiresAt")) {
          next.expiresAt = Number(updates.expiresAt) || null;
        }

        if (updates.credentialBundle && typeof updates.credentialBundle === "object") {
          next.credentialBundle = mergeCredentialBundle(next.credentialBundle, updates.credentialBundle);
        }

        if (updates.clientId) {
          next.clientId = String(updates.clientId);
        }

        return next;
      });

      const output = Array.isArray(parsed) ? updated : { ...parsed, accounts: updated };
      atomicWriteFileSync(filePath, JSON.stringify(output, null, 2) + "\n", "utf8");

      this._fileCache = null;
      log.info("codex account token updated", { accountId: normalizedId });
    } catch (error) {
      log.warn("codex account token update failed", {
        accountId: normalizedId,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  getSummary() {
    const fileState = this._loadFileAccounts();
    return {
      strategy: normalizeStrategy(fileState.strategy || this.strategy),
      accountsPath: fileState.filePath,
      activeAccount: fileState.activeAccount,
      fileAccounts: fileState.accounts.map((account) => account.id),
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
  CodexAuthProvider,
  normalizeStrategy
};
