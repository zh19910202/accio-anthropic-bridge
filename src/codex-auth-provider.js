"use strict";

const path = require("node:path");

const { atomicWriteFileSync } = require("./accounts-file");
const log = require("./logger");
const { BaseAuthProvider, normalizeStrategy, parseJsonFile } = require("./base-auth-provider");

function pickFirst(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      return String(v);
    }
  }
  return null;
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

class CodexAuthProvider extends BaseAuthProvider {
  constructor(config = {}) {
    super(config, "codex auth provider");
    this.strategy = normalizeStrategy(config.codexAuthStrategy || "round_robin");
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

  _hasValidCredential(account) {
    return !!account.credentialBundle;
  }

  _isExpiredButRefreshable(account) {
    return !!account.refreshToken;
  }

  getConfiguredAccounts() {
    const fileState = this._loadFileAccounts();
    this._fileStrategy = fileState.strategy;
    this._activeAccount = fileState.activeAccount;
    return fileState.accounts;
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
