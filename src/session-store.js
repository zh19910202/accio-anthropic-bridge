"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { atomicWriteFileSync } = require("./accounts-file");
const log = require("./logger");
const { errMsg } = require("./utils");

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_WAIT_MS = 5000;  // Upper bound to prevent indefinite deferral under high load

class SessionStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
    this.state = { sessions: {} };
    this._saveTimer = null;
    this._maxWaitTimer = null;
    this._pendingWrite = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(text);

      if (parsed && typeof parsed === "object") {
        this.state.sessions = parsed.sessions || {};
      }
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        log.debug("session store load skipped", {
          path: this.filePath,
          error: error.message || String(error)
        });
      }
    }

    this._purgeExpired();
  }

  _parseUpdatedAt(entry) {
    if (!entry || !entry.updatedAt) {
      return 0;
    }
    // Support both numeric timestamps and ISO strings (backward compat)
    return typeof entry.updatedAt === "number" ? entry.updatedAt : Date.parse(entry.updatedAt) || 0;
  }

  _purgeExpired() {
    const now = Date.now();
    const sessions = this.state.sessions;
    let changed = false;

    for (const key of Object.keys(sessions)) {
      const entry = sessions[key];

      if (!entry || !entry.updatedAt) {
        delete sessions[key];
        changed = true;
        continue;
      }

      if (now - this._parseUpdatedAt(entry) > this.maxAgeMs) {
        delete sessions[key];
        changed = true;
      }
    }

    if (changed) {
      this._scheduleSave();
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
        log.warn("session store async save failed", {
          path: this.filePath,
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
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  _saveSync() {
    try {
      atomicWriteFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      log.warn("session store sync flush failed", {
        path: this.filePath,
        error: errMsg(error)
      });
    }
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

  _isExpired(entry) {
    return entry && entry.updatedAt && Date.now() - this._parseUpdatedAt(entry) > this.maxAgeMs;
  }

  get(sessionId) {
    if (!sessionId) {
      return null;
    }

    const entry = this.state.sessions[sessionId];

    if (!entry) {
      return null;
    }

    if (this._isExpired(entry)) {
      delete this.state.sessions[sessionId];
      this.save();
      return null;
    }

    if (!entry.conversationId && !entry.accountId && !entry.accountName) {
      return null;
    }

    return entry;
  }

  merge(sessionId, extras = {}) {
    if (!sessionId || !extras || typeof extras !== "object") {
      return null;
    }

    const previous = this.state.sessions[sessionId] || {};
    const entry = {
      ...previous,
      ...extras,
      updatedAt: Date.now()
    };

    this.state.sessions[sessionId] = entry;
    this.save();
    return entry;
  }

  set(sessionId, conversationId, extras = {}) {
    if (!sessionId) {
      return null;
    }

    return this.merge(sessionId, {
      ...extras,
      conversationId: conversationId || extras.conversationId || (this.state.sessions[sessionId] || {}).conversationId || null
    });
  }

  bindAccount(sessionId, account = {}) {
    if (!sessionId || !account || (!account.accountId && !account.accountName)) {
      return null;
    }

    return this.merge(sessionId, {
      accountId: account.accountId || null,
      accountName: account.accountName || account.accountId || null
    });
  }

  getSummary() {
    const sessions = Object.values(this.state.sessions || {});
    return {
      count: sessions.length,
      accountBoundCount: sessions.filter((entry) => entry && entry.accountId).length,
      conversationBoundCount: sessions.filter((entry) => entry && entry.conversationId).length,
      maxAgeMs: this.maxAgeMs,
      path: this.filePath
    };
  }
}

function readNested(object, keys) {
  let current = object;

  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function resolveSessionBinding(headers, body, protocol) {
  return {
    conversationId:
      headers["x-accio-conversation-id"] ||
      readNested(body, ["metadata", "conversation_id"]) ||
      body.conversation_id ||
      null,
    sessionId:
      headers["x-accio-session-id"] ||
      headers["x-session-id"] ||
      readNested(body, ["metadata", "accio_session_id"]) ||
      readNested(body, ["metadata", "session_id"]) ||
      body.session_id ||
      (protocol === "openai" ? body.user || null : null)
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  SessionStore,
  resolveSessionBinding
};
