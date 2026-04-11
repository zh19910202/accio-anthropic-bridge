"use strict";

const { setActiveAccountInFile } = require("./accounts-file");
const log = require("./logger");
const { errMsg } = require("./utils");

const SYNC_DEBOUNCE_MS = 2000;

/**
 * Creates a subscriber that syncs the active account in the accounts file
 * whenever the most recent successful request used a different account.
 *
 * @param {{ accountsPath: string, codexAccountsPath: string }} config
 * @param {object} authProvider        - Claude AuthProvider
 * @param {object} codexAuthProvider   - Codex AuthProvider
 * @returns {(activity: object) => void}
 */
function createAccountSyncSubscriber(config, authProvider, codexAuthProvider) {
  const lastSyncedById = new Map();
  const timerById = new Map();

  return (activity) => {
    if (!activity || !activity.accountId || activity.authSource === "gateway") {
      return;
    }

    const nextAccountId = String(activity.accountId);
    const theme = String(activity.theme || "");
    const themeKey = theme || "claude";
    const targetAccountsPath = theme === "codex"
      ? config.codexAccountsPath
      : config.accountsPath;
    const targetProvider = theme === "codex" ? codexAuthProvider : authProvider;

    if (!targetAccountsPath) {
      return;
    }

    if (nextAccountId === lastSyncedById.get(themeKey)) {
      return;
    }

    const summary = targetProvider.getSummary();
    const currentActive = summary && summary.activeAccount ? String(summary.activeAccount) : null;

    if (nextAccountId === currentActive) {
      lastSyncedById.set(themeKey, nextAccountId);
      const currentTimer = timerById.get(themeKey);
      if (currentTimer) {
        clearTimeout(currentTimer);
        timerById.delete(themeKey);
      }
      return;
    }

    lastSyncedById.set(themeKey, nextAccountId);

    const existingTimer = timerById.get(themeKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const nextTimer = setTimeout(() => {
      timerById.delete(themeKey);

      try {
        setActiveAccountInFile(targetAccountsPath, nextAccountId);
        log.info("active account synced to serving account", {
          accountId: nextAccountId,
          theme: themeKey,
          previousActive: currentActive || null
        });
      } catch (error) {
        log.warn("failed to sync active account", {
          accountId: nextAccountId,
          error: errMsg(error)
        });
      }
    }, SYNC_DEBOUNCE_MS);
    timerById.set(themeKey, nextTimer);
  };
}

module.exports = { createAccountSyncSubscriber, SYNC_DEBOUNCE_MS };
