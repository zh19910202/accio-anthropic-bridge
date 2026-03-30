"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const log = require("./logger");
const { delay } = require("./utils");

const execFileAsync = promisify(execFile);

function parseFlag(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeAppName(appPath) {
  const base = path.basename(String(appPath || "Accio.app"));
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

async function isProcessRunningByName(processName) {
  if (!processName) {
    return false;
  }

  try {
    await execFileAsync("pgrep", ["-x", processName]);
    return true;
  } catch {
    return false;
  }
}

function extractAccessToken(payload) {
  const url = payload && payload.data && payload.data.phoenix && payload.data.phoenix.url;

  if (!url) {
    return null;
  }

  try {
    return new URL(url).searchParams.get("accessToken");
  } catch {
    return null;
  }
}

class GatewayManager {
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || "http://127.0.0.1:4097").replace(/\/$/, "");
    this.appPath = String(config.appPath || "/Applications/Accio.app");
    this.platform = config.platform || process.platform;
    this.autostartEnabled = parseFlag(config.autostartEnabled, this.platform === "darwin");
    this.waitMs = Number(config.waitMs || 20000);
    this.pollMs = Number(config.pollMs || 500);
    this.fetchImpl = config.fetchImpl || fetch;
    this.launchAppImpl = config.launchAppImpl || ((ctx) => this.defaultLaunchApp(ctx));
    this.processCheckImpl = config.processCheckImpl || isProcessRunningByName;
    this._launchPromise = null;
    this._launchedByManager = false;
  }

  async requestJson(pathname, timeoutMs = 4000) {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(
        `Gateway request failed for ${pathname}: ${response.status} ${response.statusText}`
      );
    }

    return payload;
  }

  async readWsStatus() {
    return this.requestJson("/debug/auth/ws-status");
  }

  async readAuthStatus() {
    return this.requestJson("/auth/status");
  }

  async probe() {
    try {
      const payload = await this.readWsStatus();
      const token = extractAccessToken(payload);

      return {
        reachable: true,
        token,
        authenticated: Boolean(token)
      };
    } catch (error) {
      return {
        reachable: false,
        authenticated: false,
        token: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async defaultLaunchApp(context) {
    const { appPath } = context;

    if (this.platform === "darwin") {
      const args = String(appPath).endsWith(".app") ? [appPath] : ["-a", appPath];
      await execFileAsync("open", args);
      return;
    }

    if (this.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", appPath]);
      return;
    }

    throw new Error(`Automatic Accio launch is not implemented for platform ${this.platform}`);
  }

  async verifyAppStarted() {
    if (this.platform !== "darwin") {
      return true;
    }

    const processName = normalizeAppName(this.appPath);
    const startedAt = Date.now();

    while (Date.now() - startedAt < 5000) {
      if (await this.processCheckImpl(processName)) {
        return true;
      }

      await delay(250);
    }

    throw new Error(
      `Accio launch command returned but no ${processName} process appeared. The current shell session may not be allowed to start GUI apps.`
    );
  }

  async ensureStarted() {
    if (!this.autostartEnabled) {
      throw new Error("Accio local gateway is unavailable and autostart is disabled");
    }

    if (!this._launchPromise) {
      this._launchPromise = (async () => {
        log.info("starting Accio application for gateway auth", {
          appPath: this.appPath,
          platform: this.platform
        });
        await this.launchAppImpl({ appPath: this.appPath, platform: this.platform });
        await this.verifyAppStarted();
        this._launchedByManager = true;
        return true;
      })().catch((error) => {
        this._launchedByManager = false;
        throw error;
      });
    }

    try {
      return await this._launchPromise;
    } finally {
      this._launchPromise = null;
    }
  }

  async waitForGatewayToken() {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < this.waitMs) {
      try {
        const payload = await this.readWsStatus();
        const token = extractAccessToken(payload);

        if (token) {
          return {
            token,
            payload
          };
        }

        lastError = new Error("Accio gateway is reachable but no access token is available yet");
      } catch (error) {
        lastError = error;
      }

      await delay(this.pollMs);
    }

    try {
      const auth = await this.readAuthStatus();
      const authenticated = Boolean(auth && auth.authenticated);
      const userId = auth && auth.user && auth.user.id ? String(auth.user.id) : null;

      if (!authenticated) {
        throw new Error("Accio started but is not logged in. Please complete login once and retry.");
      }

      throw new Error(
        `Accio gateway became reachable but access token could not be extracted for account ${userId || "unknown"}`
      );
    } catch (authError) {
      if (authError instanceof Error && authError.message && !/fetch failed/i.test(authError.message)) {
        throw authError;
      }

      const reason =
        lastError instanceof Error && lastError.message
          ? lastError.message
          : "gateway never became reachable";

      throw new Error(
        `Timed out waiting for Accio local gateway at ${this.baseUrl} after launching ${this.appPath}: ${reason}`
      );
    }
  }

  async resolveAccessToken(options = {}) {
    const allowAutostart = options.allowAutostart !== false;

    try {
      const payload = await this.readWsStatus();
      const token = extractAccessToken(payload);

      if (token) {
        return {
          token,
          source: "gateway",
          launchedApp: false,
          quitAfterCapture: false,
          payload
        };
      }
    } catch (error) {
      if (!allowAutostart) {
        throw error;
      }
    }

    if (!allowAutostart) {
      throw new Error("Accio gateway is reachable but no access token is available");
    }

    await this.ensureStarted();
    const result = await this.waitForGatewayToken();

    return {
      token: result.token,
      source: "gateway",
      launchedApp: true,
      quitAfterCapture: false,
      payload: result.payload
    };
  }

  getSummary() {
    return {
      baseUrl: this.baseUrl,
      autostartEnabled: this.autostartEnabled,
      appPath: this.appPath,
      appExists: this.platform === "darwin" ? fs.existsSync(this.appPath) : null,
      waitMs: this.waitMs,
      pollMs: this.pollMs,
      platform: this.platform
    };
  }
}

module.exports = {
  GatewayManager,
  extractAccessToken,
  normalizeAppName,
  parseFlag
};
