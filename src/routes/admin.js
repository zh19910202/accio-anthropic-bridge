"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { readJsonBody } = require("../middleware/body-parser");
const { writeJson, writeSse, ADMIN_CORS_HEADERS } = require("../http");
const { readAccioUtdid, extractCnaFromCookie, normalizeCookieHeader } = require("../discovery");
const {
  buildGatewayAuthCallbackQuery,
  extractAuthCallbackPayloadFromSearchParams,
  deriveUpstreamGatewayBaseUrl,
  refreshAuthPayloadViaUpstream,
  waitForGatewayAuthenticatedUser
} = require("../gateway-auth");
const { parseEnvValue } = require("../env-file");
const {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot,
  deleteSnapshot,
  readSnapshotAuthPayload,
  writeSnapshotAuthPayload
} = require("../auth-state");
const { writeAccountToFile, findStoredAccountAuthPayload, setActiveAccountInFile, removeAccountFromFile } = require("../accounts-file");
const { ExternalFallbackClient, normalizeFallbackTarget, normalizeFallbackTargets, serializeFallbackTarget } = require("../external-fallback");
const { maskToken } = require("../redaction");
const log = require("../logger");

const execFileAsync = promisify(execFile);

const QUOTA_CACHE_TTL_MS = 15 * 1000;
const QUOTA_CACHE_MAX = 64;
const quotaCache = new Map();
const SNAPSHOT_QUOTA_FILE = "quota-state.json";

function createGuiLaunchEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function isQuotaPendingFailure(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "quota refresh pending" || /quota exhausted|quota precheck skipped/.test(text);
}

function getSnapshotQuotaStatePath(snapshotDir) {
  return path.join(String(snapshotDir || ""), SNAPSHOT_QUOTA_FILE);
}

function readSnapshotQuotaState(snapshotDir) {
  if (!snapshotDir) {
    return null;
  }

  try {
    const text = fs.readFileSync(getSnapshotQuotaStatePath(snapshotDir), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      available: parsed.available === true,
      usagePercent: typeof parsed.usagePercent === "number" ? parsed.usagePercent : null,
      refreshCountdownSeconds: typeof parsed.refreshCountdownSeconds === "number" ? parsed.refreshCountdownSeconds : null,
      checkedAt: parsed.checkedAt ? String(parsed.checkedAt) : null,
      source: parsed.source ? String(parsed.source) : null,
      error: parsed.error ? String(parsed.error) : null,
      stale: parsed.stale === true
    };
  } catch {
    return null;
  }
}

function writeSnapshotQuotaState(snapshotDir, quota) {
  if (!snapshotDir || !quota || typeof quota !== "object") {
    return;
  }

  const targetPath = getSnapshotQuotaStatePath(snapshotDir);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(quota, null, 2) + "\n", "utf8");
}

function quoteEnvValue(value) {
  const text = String(value == null ? "" : value);
  if (!text) {
    return "";
  }

  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) {
    return text;
  }

  return '"' + text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n") + '"';
}

function upsertEnvValues(filePath, values) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const index = line.indexOf("=");
    if (index <= 0) {
      return line;
    }

    const key = line.slice(0, index).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return line;
    }

    seen.add(key);
    return key + '=' + quoteEnvValue(values[key]);
  });

  for (const key of Object.keys(values)) {
    if (seen.has(key)) {
      continue;
    }
    nextLines.push(key + '=' + quoteEnvValue(values[key]));
  }

  fs.writeFileSync(filePath, nextLines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
}

function getFallbackSettings(config) {
  const targets = normalizeFallbackTargets(config.fallbackTargets || []);
  return {
    targets: targets.map((target) => serializeFallbackTarget(target))
  };
}

function applyFallbackSettings(config, fallbackPool, settings) {
  const targets = normalizeFallbackTargets(Array.isArray(settings.targets) ? settings.targets : []);
  const primary = targets[0] || normalizeFallbackTarget({}, 0);

  config.fallbackTargets = targets;
  config.fallbackOpenAiBaseUrl = primary.baseUrl;
  config.fallbackOpenAiApiKey = primary.apiKey;
  config.fallbackOpenAiModel = primary.model;
  config.fallbackOpenAiProtocol = primary.protocol;
  config.fallbackAnthropicVersion = primary.anthropicVersion;
  config.fallbackOpenAiTimeoutMs = primary.timeoutMs;

  process.env.ACCIO_FALLBACKS_JSON = JSON.stringify(targets);
  process.env.ACCIO_FALLBACK_OPENAI_BASE_URL = primary.baseUrl;
  process.env.ACCIO_FALLBACK_OPENAI_API_KEY = primary.apiKey;
  process.env.ACCIO_FALLBACK_OPENAI_MODEL = primary.model;
  process.env.ACCIO_FALLBACK_PROTOCOL = primary.protocol;
  process.env.ACCIO_FALLBACK_ANTHROPIC_VERSION = primary.anthropicVersion;
  process.env.ACCIO_FALLBACK_OPENAI_TIMEOUT_MS = String(primary.timeoutMs || 60000);

  if (fallbackPool && typeof fallbackPool.updateConfig === "function") {
    fallbackPool.updateConfig({ targets });
  }

  return { targets: targets.map((target) => serializeFallbackTarget(target)), normalizedTargets: targets };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSnapshotEntry(alias) {
  return listSnapshots().find((entry) => entry.alias === String(alias || "").trim()) || null;
}

function hasSnapshotArtifactState(snapshotEntry) {
  const artifacts = snapshotEntry && snapshotEntry.metadata && Array.isArray(snapshotEntry.metadata.artifacts)
    ? snapshotEntry.metadata.artifacts
    : [];

  if (artifacts.length === 0) {
    return false;
  }

  const names = new Set(
    artifacts
      .map((artifact) => artifact && artifact.relativePath ? String(artifact.relativePath) : "")
      .filter(Boolean)
  );

  return names.has("credentials.enc") || names.has("Local Storage") || names.has("Session Storage");
}

function hasReplayableAuthPayload(payload) {
  return Boolean(
    payload &&
    payload.accessToken &&
    payload.refreshToken &&
    (payload.expiresAtRaw || payload.expiresAtMs)
  );
}

function resolveSnapshotAuthPayload(alias, accountsPath) {
  const filePayload = readSnapshotAuthPayload(alias);

  if (filePayload) {
    return {
      payload: filePayload,
      source: "snapshot"
    };
  }

  const snapshotEntry = getSnapshotEntry(alias);
  const gatewayUser = snapshotEntry && snapshotEntry.metadata && snapshotEntry.metadata.gatewayUser
    ? snapshotEntry.metadata.gatewayUser
    : null;
  const storedPayload = findStoredAccountAuthPayload(accountsPath, {
    alias,
    accountId: gatewayUser && gatewayUser.id ? String(gatewayUser.id) : null,
    userId: gatewayUser && gatewayUser.id ? String(gatewayUser.id) : null,
    name: gatewayUser && gatewayUser.name ? String(gatewayUser.name) : null
  });

  if (!storedPayload) {
    return {
      payload: null,
      source: null
    };
  }

  return {
    payload: storedPayload,
    source: "accounts-file"
  };
}

function findMatchingConfiguredAccount(configuredAccounts, snapshot) {
  const alias = snapshot && snapshot.alias ? String(snapshot.alias) : "";
  const gatewayUserId = snapshot && snapshot.gatewayUser && snapshot.gatewayUser.id ? String(snapshot.gatewayUser.id) : "";
  const authPayloadUserId = snapshot && snapshot.authPayloadUser && snapshot.authPayloadUser.id ? String(snapshot.authPayloadUser.id) : "";
  const gatewayUserName = snapshot && snapshot.gatewayUser && snapshot.gatewayUser.name ? String(snapshot.gatewayUser.name) : "";
  const authPayloadUserName = snapshot && snapshot.authPayloadUser && snapshot.authPayloadUser.name ? String(snapshot.authPayloadUser.name) : "";

  if (alias) {
    const exactAliasMatch = configuredAccounts.find((account) => account && account.id && String(account.id) === alias);
    if (exactAliasMatch) {
      return exactAliasMatch;
    }
  }

  const userIds = new Set([gatewayUserId, authPayloadUserId].filter(Boolean));
  if (userIds.size > 0) {
    const exactUserMatch = configuredAccounts.find((account) => {
      const values = new Set([
        account && account.accountId ? String(account.accountId) : "",
        account && account.user && account.user.id ? String(account.user.id) : ""
      ].filter(Boolean));
      for (const candidate of userIds) {
        if (values.has(candidate)) {
          return true;
        }
      }
      return false;
    });
    if (exactUserMatch) {
      return exactUserMatch;
    }
  }

  const names = new Set([gatewayUserName, authPayloadUserName].filter(Boolean));
  if (names.size === 0) {
    return null;
  }

  const nameMatches = configuredAccounts.filter((account) => {
    const values = new Set([
      account && account.name ? String(account.name) : "",
      account && account.user && account.user.name ? String(account.user.name) : ""
    ].filter(Boolean));
    for (const candidate of names) {
      if (values.has(candidate)) {
        return true;
      }
    }
    return false;
  });

  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function requestGatewayJson(gatewayManager, pathname, options = {}) {
  const response = await fetch(`${gatewayManager.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs || 8000))
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function isGatewayConnectionError(error) {
  const message = error && error.message ? String(error.message) : String(error || "");
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(message);
}

async function waitForGatewayReachable(baseUrl, waitMs = 20000, pollMs = 500) {
  const deadline = Date.now() + waitMs;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState(baseUrl);
    lastGateway = gateway;

    if (gateway && gateway.reachable) {
      return gateway;
    }

    await delay(pollMs);
  }

  return lastGateway;
}

async function requestGatewayJsonWithAutostart(gatewayManager, pathname, options = {}) {
  try {
    return await requestGatewayJson(gatewayManager, pathname, options);
  } catch (error) {
    if (!isGatewayConnectionError(error)) {
      throw error;
    }

    log.warn("gateway request failed before autostart retry", {
      pathname,
      baseUrl: gatewayManager.baseUrl,
      error: error && error.message ? error.message : String(error)
    });

    await gatewayManager.ensureStarted();
    const gateway = await waitForGatewayReachable(
      gatewayManager.baseUrl,
      Number(gatewayManager.waitMs || 20000),
      Number(gatewayManager.pollMs || 500)
    );

    if (!gateway || !gateway.reachable) {
      const retryError = new Error(`Gateway did not become reachable after launching Accio for ${pathname}`);
      retryError.type = "gateway_unreachable";
      throw retryError;
    }

    return requestGatewayJson(gatewayManager, pathname, options);
  }
}

function buildBridgeBaseUrl(req, config) {
  const forwardedProto = req && req.headers && req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
    : "";
  const protocol = forwardedProto || "http";
  const host = req && req.headers && req.headers.host
    ? String(req.headers.host)
    : `127.0.0.1:${config.port}`;
  return `${protocol}://${host}`;
}

function buildAccountLoginCallbackUrl(req, config, flowId) {
  const url = new URL("/admin/api/accounts/callback", buildBridgeBaseUrl(req, config));
  url.searchParams.set("flowId", String(flowId));
  return url.toString();
}

function rewriteGatewayLoginUrl(loginUrl, callbackUrl) {
  if (!loginUrl) {
    return null;
  }

  const parsed = new URL(String(loginUrl));
  parsed.searchParams.set("return_url", callbackUrl);
  return parsed.toString();
}

const ACCIO_LOGIN_BASE_URL = "https://www.accio.com/login";

function buildDirectLoginUrl(callbackUrl) {
  const state = crypto.randomBytes(32).toString("hex");
  const url = new URL(ACCIO_LOGIN_BASE_URL);
  url.searchParams.set("return_url", callbackUrl);
  url.searchParams.set("state", state);
  return { loginUrl: url.toString(), state };
}

function buildQuotaCacheKey(alias, userId) {
  return `${String(alias || "")}:${String(userId || "")}`;
}

function persistResolvedAuthPayload(config, alias, authPayload) {
  if (!authPayload || !alias) {
    return;
  }

  try {
    writeSnapshotAuthPayload(alias, authPayload);
    writeAccountToFile(config.accountsPath, alias, authPayload.accessToken, {
      user: authPayload.user || null,
      expiresAtMs: authPayload.expiresAtMs || null,
      expiresAtRaw: authPayload.expiresAtRaw || null,
      source: authPayload.source || "gateway-auth-callback",
      authPayload
    });
  } catch (error) {
    log.warn("persist auth payload after quota refresh failed", {
      alias,
      error: error && error.message ? error.message : String(error)
    });
  }
}

async function requestQuotaViaUpstream(config, authPayload) {
  if (!authPayload || !authPayload.accessToken) {
    throw new Error("Missing accessToken for quota request");
  }

  const upstreamBaseUrl = deriveUpstreamGatewayBaseUrl(config);
  const utdid = readAccioUtdid(config.accioHome);
  const cna = extractCnaFromCookie(authPayload.cookie);
  const url = new URL("/api/entitlement/quota", upstreamBaseUrl);
  url.searchParams.set("accessToken", String(authPayload.accessToken));
  url.searchParams.set("utdid", utdid);
  url.searchParams.set("version", "0.0.0");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-language": config && config.language ? String(config.language) : "zh",
      "x-utdid": utdid,
      "x-app-version": "0.0.0",
      "x-os": process.platform,
      "x-cna": cna,
      cookie: normalizeCookieHeader(authPayload.cookie),
      accept: "application/json, text/plain, */*"
    },
    signal: AbortSignal.timeout(8000)
  });
  const responseText = await response.text();

  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(`Quota response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok || !payload || payload.success !== true || !payload.data) {
    const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    const error = new Error(`Quota request failed: ${message}`);
    error.status = response.status;
    throw error;
  }

  const usagePercent = Number(payload.data.usagePercent);
  const refreshCountdownSeconds = Number(payload.data.refreshCountdownSeconds);

  return {
    usagePercent: Number.isFinite(usagePercent) ? Math.min(100, Math.max(0, usagePercent)) : null,
    refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds) ? Math.max(0, Math.floor(refreshCountdownSeconds)) : null,
    checkedAt: new Date().toISOString(),
    source: "upstream-entitlement"
  };
}

async function resolveSnapshotQuota(config, snapshot, authPayload) {
  const gatewayUser = snapshot && snapshot.gatewayUser ? snapshot.gatewayUser : null;
  const userId = gatewayUser && gatewayUser.id ? String(gatewayUser.id) : "";
  const alias = snapshot && snapshot.alias ? String(snapshot.alias) : userId;
  const cacheKey = buildQuotaCacheKey(alias, userId);
  const cached = quotaCache.get(cacheKey);

  if (cached && Date.now() - cached.at < QUOTA_CACHE_TTL_MS) {
    return cached.value;
  }

  if (!authPayload || !authPayload.accessToken) {
    const value = {
      available: false,
      usagePercent: null,
      refreshCountdownSeconds: null,
      checkedAt: new Date().toISOString(),
      source: null,
      error: authPayload ? "missing_access_token" : "missing_auth_payload"
    };
    quotaCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  let resolvedAuthPayload = authPayload;
  const isExpired = resolvedAuthPayload.expiresAtMs && Number(resolvedAuthPayload.expiresAtMs) > 0 && Number(resolvedAuthPayload.expiresAtMs) <= Date.now();

  if (isExpired && resolvedAuthPayload.refreshToken) {
    resolvedAuthPayload = await refreshAuthPayloadViaUpstream(config, resolvedAuthPayload, { alias, reason: "quota_expired_token" });
    persistResolvedAuthPayload(config, alias, resolvedAuthPayload);
  }

  try {
    const quota = await requestQuotaViaUpstream(config, resolvedAuthPayload);
    const value = {
      available: true,
      usagePercent: quota.usagePercent,
      refreshCountdownSeconds: quota.refreshCountdownSeconds,
      checkedAt: quota.checkedAt,
      source: quota.source,
      error: null
    };
    quotaCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    const status = Number(error && error.status ? error.status : 0);

    if ((status === 401 || status === 403) && resolvedAuthPayload.refreshToken) {
      try {
        resolvedAuthPayload = await refreshAuthPayloadViaUpstream(config, resolvedAuthPayload, { alias, reason: "quota_retry_after_auth_failure" });
        persistResolvedAuthPayload(config, alias, resolvedAuthPayload);
        const quota = await requestQuotaViaUpstream(config, resolvedAuthPayload);
        const value = {
          available: true,
          usagePercent: quota.usagePercent,
          refreshCountdownSeconds: quota.refreshCountdownSeconds,
          checkedAt: quota.checkedAt,
          source: quota.source,
          error: null
        };
        quotaCache.set(cacheKey, { at: Date.now(), value });
        return value;
      } catch (retryError) {
        error = retryError;
      }
    }

    const value = {
      available: false,
      usagePercent: null,
      refreshCountdownSeconds: null,
      checkedAt: new Date().toISOString(),
      source: null,
      error: error && error.message ? String(error.message) : String(error)
    };
    quotaCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}

async function resolveSnapshotQuotaForAdmin(config, snapshot, authPayload, options = {}) {
  const isCurrentGatewayAccount = options.isCurrentGatewayAccount === true;
  const persistedQuota = readSnapshotQuotaState(snapshot && snapshot.dir ? snapshot.dir : null);

  if (!isCurrentGatewayAccount) {
    if (persistedQuota) {
      return {
        ...persistedQuota,
        stale: true
      };
    }

    return {
      available: false,
      usagePercent: null,
      refreshCountdownSeconds: null,
      checkedAt: null,
      source: null,
      error: "quota_unverified_for_inactive_account",
      stale: true
    };
  }

  const liveQuota = await resolveSnapshotQuota(config, snapshot, authPayload);
  writeSnapshotQuotaState(snapshot && snapshot.dir ? snapshot.dir : null, {
    ...liveQuota,
    stale: false
  });
  return {
    ...liveQuota,
    stale: false
  };
}

async function primeSnapshotQuotaState(config, snapshot, authPayload) {
  if (!snapshot || !snapshot.dir) {
    return null;
  }

  const liveQuota = await resolveSnapshotQuota(config, snapshot, authPayload);
  const persistedQuota = {
    ...liveQuota,
    stale: false
  };
  writeSnapshotQuotaState(snapshot.dir, persistedQuota);
  return persistedQuota;
}

function syncSnapshotAccountState(authProvider, snapshot) {
  const accountState = snapshot && snapshot.accountState ? snapshot.accountState : null;
  const quota = snapshot && snapshot.quota ? snapshot.quota : null;

  if (!accountState || !accountState.id) {
    return snapshot;
  }

  if (
    quota &&
    quota.available &&
    typeof quota.usagePercent === "number" &&
    quota.usagePercent >= 100 &&
    typeof quota.refreshCountdownSeconds === "number"
  ) {
    const checkedAtMs = Date.parse(quota.checkedAt || "") || Date.now();
    const refreshUntilMs = checkedAtMs + Math.max(0, Number(quota.refreshCountdownSeconds)) * 1000;
    const currentInvalidUntil = authProvider.getInvalidUntil(accountState.id) || 0;

    if (refreshUntilMs > currentInvalidUntil) {
      authProvider.invalidateAccountUntil(accountState.id, refreshUntilMs, "quota refresh pending");
    }
  } else if (
    quota &&
    quota.available &&
    typeof quota.usagePercent === "number" &&
    quota.usagePercent < 100
  ) {
    authProvider.clearInvalidation(accountState.id);
    const lastFailure = authProvider.getLastFailure(accountState.id);
    if (lastFailure && isQuotaPendingFailure(lastFailure.reason)) {
      authProvider.clearFailure(accountState.id);
    }
  }

  snapshot.accountState = {
    ...accountState,
    invalidUntil: authProvider.getInvalidUntil(accountState.id),
    lastFailure: authProvider.getLastFailure(accountState.id) || null
  };

  return snapshot;
}

async function requestGatewayText(gatewayManager, pathname, options = {}) {
  const response = await fetch(`${gatewayManager.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...(options.headers || {})
    },
    body: options.body || undefined,
    redirect: options.redirect || "manual",
    signal: AbortSignal.timeout(Number(options.timeoutMs || 15000))
  });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  return {
    status: response.status,
    text,
    location: response.headers.get("location") || null
  };
}

async function requestGatewayTextWithAutostart(gatewayManager, pathname, options = {}) {
  try {
    return await requestGatewayText(gatewayManager, pathname, options);
  } catch (error) {
    if (!isGatewayConnectionError(error)) {
      throw error;
    }

    log.warn("gateway text request failed before autostart retry", {
      pathname,
      baseUrl: gatewayManager.baseUrl,
      error: error && error.message ? error.message : String(error)
    });

    await gatewayManager.ensureStarted();
    const gateway = await waitForGatewayReachable(
      gatewayManager.baseUrl,
      Number(gatewayManager.waitMs || 20000),
      Number(gatewayManager.pollMs || 500)
    );

    if (!gateway || !gateway.reachable) {
      const retryError = new Error(`Gateway did not become reachable after launching Accio for ${pathname}`);
      retryError.type = "gateway_unreachable";
      throw retryError;
    }

    return requestGatewayText(gatewayManager, pathname, options);
  }
}

async function forwardGatewayAuthCallback(gatewayManager, payload, options = {}) {
  const query = buildGatewayAuthCallbackQuery(payload, options);
  return requestGatewayTextWithAutostart(gatewayManager, `/auth/callback?${query}`, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    },
    timeoutMs: Number(options.timeoutMs || 15000)
  });
}

function renderAccountCallbackPage(title, body, tone = "ok") {
  const accent = tone === "error" ? "#c43c3c" : "#1a8a5a";
  const accentSoft = tone === "error" ? "rgba(196,60,60,0.1)" : "rgba(26,138,90,0.1)";
  const icon = tone === "error" ? "\u274C" : "\u2705";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
body { margin: 0; background: linear-gradient(175deg, #faf8f5, #ede7df); color: #1a1816; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Noto Sans SC",sans-serif; display: grid; place-items: center; min-height: 100vh; -webkit-font-smoothing: antialiased; }
main { width: min(520px, calc(100vw - 32px)); background: rgba(255,254,252,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(24,22,20,0.08); border-radius: 22px; padding: 28px; box-shadow: 0 16px 48px rgba(56,40,28,0.1); animation: fadeSlideUp 0.5s ease-out; }
.icon { font-size: 36px; margin-bottom: 12px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: ${accentSoft}; color: ${accent}; letter-spacing: 0.1em; text-transform: uppercase; font-size: 11px; font-weight: 600; margin-bottom: 12px; }
h1 { margin: 0 0 10px; font-size: 26px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; }
p { margin: 0; color: #8a8279; font-size: 14px; line-height: 1.7; }
.countdown { margin-top: 16px; color: #8a8279; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="icon">${icon}</div>
  <div class="badge">Accio Bridge</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
  <div class="countdown">\u8FD9\u4E2A\u9875\u9762\u5C06\u5728 2 \u79D2\u540E\u81EA\u52A8\u5173\u95ED...</div>
</main>
<script>
setTimeout(() => { try { window.close(); } catch {} }, 2000);
</script>
</body>
</html>`;
}

async function openExternalUrl(url) {
  const target = String(url || "").trim();

  if (!target) {
    return false;
  }

  if (!/^https?:\/\//i.test(target)) {
    return false;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [target]);
    return true;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", target]);
    return true;
  }

  if (process.platform === "linux") {
    await execFileAsync("xdg-open", [target]);
    return true;
  }

  return false;
}

async function requestDesktopHelperLaunch(config) {
  const helperUrl = String(config.desktopHelperUrl || '').trim();

  if (!helperUrl) {
    return { ok: false, skipped: true, reason: 'desktop_helper_not_configured' };
  }

  const normalized = helperUrl.replace(/\/$/, '');
  const timeoutMs = Number(config.desktopHelperTimeoutMs || 15000);

  log.info('snapshot switch desktop helper begin', { helperUrl: normalized, timeoutMs });

  try {
    const response = await fetch(`${normalized}/launch-accio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'snapshot-switch' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error((payload && payload.error) || `Desktop helper launch failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    log.info('snapshot switch desktop helper launched', { helperUrl: normalized, payload });
    return { ok: true, helperUrl: normalized, payload };
  } catch (error) {
    log.warn('snapshot switch desktop helper failed', {
      helperUrl: normalized,
      error: error && error.message ? error.message : String(error)
    });
    return { ok: false, helperUrl: normalized, error: error && error.message ? error.message : String(error) };
  }
}


const ACCOUNT_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;
const PENDING_ACCOUNT_LOGIN_MAX = 32;
const pendingAccountLogins = new Map();

function extractGatewayUserId(gateway) {
  return gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";
}

function summarizeGatewayState(gateway) {
  return {
    reachable: Boolean(gateway && gateway.reachable),
    authenticated: Boolean(gateway && gateway.authenticated),
    userId: gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : null,
    userName: gateway && gateway.user && gateway.user.name ? String(gateway.user.name) : null,
    status: gateway && gateway.status != null ? gateway.status : null,
    error: gateway && gateway.error ? String(gateway.error) : null
  };
}

function prunePendingAccountLogins(now = Date.now()) {
  for (const [flowId, flow] of pendingAccountLogins.entries()) {
    if (now - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
      pendingAccountLogins.delete(flowId);
    }
  }
  // Evict oldest if over limit
  while (pendingAccountLogins.size > PENDING_ACCOUNT_LOGIN_MAX) {
    pendingAccountLogins.delete(pendingAccountLogins.keys().next().value);
  }
}

function createPendingAccountLogin(previousUserId, extras = {}) {
  prunePendingAccountLogins();
  const flow = {
    id: crypto.randomUUID(),
    previousUserId: previousUserId || "",
    preservedAlias: extras.preservedAlias || null,
    preservedKind: extras.preservedKind || null,
    preservedCapturedAt: extras.preservedCapturedAt || null,
    createdAtMs: Date.now()
  };
  pendingAccountLogins.set(flow.id, flow);
  return flow;
}

function getPendingAccountLogin(flowId) {
  prunePendingAccountLogins();
  return pendingAccountLogins.get(flowId) || null;
}

function deletePendingAccountLogin(flowId) {
  pendingAccountLogins.delete(flowId);
}

function logPendingAccountLoginState(flow, state, meta = {}) {
  if (!flow) {
    return;
  }

  if (flow.lastLoggedState === state) {
    return;
  }

  flow.lastLoggedState = state;
  log.info("account login flow state", {
    flowId: flow.id,
    previousUserId: flow.previousUserId || null,
    state,
    ...meta
  });
}

function deriveSnapshotAliasFromGatewayUser(user) {
  const userId = user && user.id ? String(user.id).trim() : "";
  const userName = user && user.name ? String(user.name).trim() : "";
  const normalizedName = userName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedUserId = userId.toLowerCase();

  if (normalizedName && userId && normalizedName !== normalizedUserId) {
    return `acct-${normalizedName}-${userId}`;
  }

  if (userId) {
    return `acct-${userId}`;
  }

  if (normalizedName) {
    return `acct-${normalizedName}`;
  }

  return `acct-${Date.now()}`;
}

function normalizeAccioProcessName(appPath) {
  const base = path.basename(String(appPath || "Accio.app"));
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

const { delay } = require("../utils");

function getGatewayPort(baseUrl) {
  try {
    const url = new URL(String(baseUrl || 'http://127.0.0.1:4097'));
    return url.port ? String(url.port) : (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return '4097';
  }
}

async function isGatewayPortListening(baseUrl) {
  const port = getGatewayPort(baseUrl);
  try {
    await execFileAsync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']);
    return true;
  } catch {
    return false;
  }
}

async function stopAccioForSnapshot(config, processName) {
  const appContentsPrefix = String(config.appPath || '').replace(/\.app\/?$/, '.app/Contents/');
  const baseUrl = config.baseUrl;

  log.info('snapshot switch stop begin', {
    appPath: config.appPath,
    processName,
    baseUrl,
    appContentsPrefix
  });

  if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', 'tell application id "com.accio.desktop" to quit']).catch(() => {});
    await delay(800);
    await execFileAsync('pkill', ['-x', processName]).catch(() => {});
    if (appContentsPrefix) {
      await execFileAsync('pkill', ['-f', appContentsPrefix]).catch(() => {});
    }
  } else if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/im', processName + '.exe', '/t', '/f']).catch(() => {});
  } else {
    await execFileAsync('pkill', ['-x', processName]).catch(() => {});
  }

  const deadline = Date.now() + 12000;
  let forced = false;

  while (Date.now() < deadline) {
    const listening = await isGatewayPortListening(baseUrl);
    if (!listening) {
      log.info('snapshot switch stop confirmed', { baseUrl, processName, forced });
      return { forced };
    }

    if (!forced && Date.now() + 4000 >= deadline) {
      forced = true;
      if (process.platform === 'darwin') {
        await execFileAsync('pkill', ['-9', '-x', processName]).catch(() => {});
        if (appContentsPrefix) {
          await execFileAsync('pkill', ['-9', '-f', appContentsPrefix]).catch(() => {});
        }
      } else if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/im', processName + '.exe', '/t', '/f']).catch(() => {});
      } else {
        await execFileAsync('pkill', ['-9', '-x', processName]).catch(() => {});
      }
    }

    await delay(400);
  }

  log.warn('snapshot switch stop timed out', { baseUrl, processName, forced });
  return { forced, timedOut: true };
}

async function startAccioForSnapshot(config, processName) {
  log.info('snapshot switch start begin', {
    appPath: config.appPath,
    baseUrl: config.baseUrl,
    processName
  });

  if (process.platform === 'darwin') {
    await execFileAsync('open', [config.appPath], {
      env: createGuiLaunchEnv()
    });
    return;
  }

  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', config.appPath]);
    return;
  }

  throw new Error('Automatic Accio restart is not implemented for this platform');
}

async function restartAccioForSnapshot(config, expectedUserId, options = {}) {
  const processName = normalizeAccioProcessName(config.appPath);
  const stopResult = options.stopResult || null;
  let desktopHelperLaunch = null;

  log.info("snapshot switch restart begin", {
    appPath: config.appPath,
    baseUrl: config.baseUrl,
    processName,
    expectedUserId: expectedUserId || null,
    preStopped: Boolean(stopResult)
  });

  await delay(800);

  try {
    await startAccioForSnapshot(config, processName);
  } catch (error) {
    log.warn('snapshot switch local start failed', {
      processName,
      error: error && error.message ? error.message : String(error)
    });
  }

  const deadline = Date.now() + 30000;
  const helperAttemptAt = Date.now() + 6000;
  let helperAttempted = false;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState(config.baseUrl);
    lastGateway = gateway;
    const currentUserId = extractGatewayUserId(gateway);

    log.debug("snapshot switch restart poll", {
      expectedUserId: expectedUserId || null,
      currentUserId: currentUserId || null,
      gateway: summarizeGatewayState(gateway),
      helperAttempted
    });

    if (gateway.reachable && (!expectedUserId || currentUserId === expectedUserId)) {
      log.info("snapshot switch restart matched", {
        expectedUserId: expectedUserId || null,
        currentUserId: currentUserId || null,
        gateway: summarizeGatewayState(gateway),
        stopResult,
        desktopHelperLaunch
      });
      return { gateway, matched: !expectedUserId || currentUserId === expectedUserId, stopResult, desktopHelperLaunch };
    }

    if (!helperAttempted && Date.now() >= helperAttemptAt) {
      helperAttempted = true;
      desktopHelperLaunch = await requestDesktopHelperLaunch(config);
    }

    await delay(500);
  }

  log.warn("snapshot switch restart timed out", {
    expectedUserId: expectedUserId || null,
    gateway: summarizeGatewayState(lastGateway),
    stopResult,
    desktopHelperLaunch
  });
  return { gateway: lastGateway, matched: false, stopResult, desktopHelperLaunch };
}


async function buildAdminState(config, authProvider, directClient, recentActivityStore) {
  const gateway = await readGatewayState(config.baseUrl);
  const storage = detectActiveStorage();
  const configuredAccounts = authProvider.getConfiguredAccounts();
  const authSummary = authProvider.getSummary();
  const activeAccountId = authSummary && authSummary.activeAccount ? String(authSummary.activeAccount) : "";
  const currentGatewayUserId = gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";
  const snapshotEntries = listSnapshots().map((entry) => {
    const resolvedAuth = resolveSnapshotAuthPayload(entry.alias, config.accountsPath);
    const storedAuthPayload = resolvedAuth.payload;
    const canActivate = hasReplayableAuthPayload(storedAuthPayload);
    const snapshotBase = {
      alias: entry.alias,
      kind: entry.kind,
      dir: entry.dir,
      capturedAt: entry.metadata && entry.metadata.capturedAt ? entry.metadata.capturedAt : null,
      gatewayUser: entry.metadata && entry.metadata.gatewayUser ? entry.metadata.gatewayUser : null,
      artifactCount: entry.metadata && Array.isArray(entry.metadata.artifacts) ? entry.metadata.artifacts.length : 0,
      hasFullAuthState: Boolean(entry.metadata && Array.isArray(entry.metadata.artifacts) && entry.metadata.artifacts.length > 1),
      canActivate,
      hasStoredAuthCallback: Boolean(storedAuthPayload),
      hasAuthCallback: Boolean(entry.hasAuthCallback || storedAuthPayload),
      authPayloadCapturedAt: entry.authPayloadCapturedAt || (storedAuthPayload && storedAuthPayload.capturedAt ? storedAuthPayload.capturedAt : null),
      authPayloadUser: entry.authPayloadUser || (storedAuthPayload && storedAuthPayload.user ? storedAuthPayload.user : null)
    };
    const matchedAccount = findMatchingConfiguredAccount(configuredAccounts, snapshotBase);

    return {
      storedAuthPayload,
      snapshot: {
        ...snapshotBase,
        accountState: matchedAccount
          ? {
              id: matchedAccount.id,
              invalidUntil: authProvider.getInvalidUntil(matchedAccount.id),
              lastFailure: authProvider.getLastFailure(matchedAccount.id) || null
            }
          : null
      }
    };
  });
  const snapshots = await Promise.all(snapshotEntries.map(async ({ snapshot, storedAuthPayload }) => ({
    ...snapshot,
    quota: await resolveSnapshotQuotaForAdmin(config, snapshot, storedAuthPayload, {
      isCurrentGatewayAccount: Boolean(
        currentGatewayUserId &&
        snapshot &&
        snapshot.gatewayUser &&
        String(snapshot.gatewayUser.id || "") === currentGatewayUserId
      ) || Boolean(
        activeAccountId &&
        snapshot &&
        snapshot.accountState &&
        String(snapshot.accountState.id || "") === activeAccountId
      )
    })
  })));
  const normalizedSnapshots = snapshots.map((snapshot) => syncSnapshotAccountState(authProvider, snapshot));
  const accounts = authProvider.getConfiguredAccounts().map((account) => ({
    id: account.id,
    name: account.name,
    source: account.source,
    enabled: account.enabled,
    hasToken: Boolean(account.accessToken),
    tokenPreview: maskToken(account.accessToken),
    expiresAt: account.expiresAt || null,
    invalidUntil: authProvider.getInvalidUntil(account.id),
    lastFailure: authProvider.getLastFailure(account.id) || null
  }));
  const activeSnapshots = activeAccountId
    ? normalizedSnapshots.filter((snapshot) => snapshot.accountState && String(snapshot.accountState.id || "") === activeAccountId)
    : [];
  const currentSnapshots = currentGatewayUserId
    ? normalizedSnapshots.filter((snapshot) => snapshot.gatewayUser && String(snapshot.gatewayUser.id || "") === currentGatewayUserId)
    : [];
  const currentSnapshotCandidates = activeSnapshots.length > 0 ? activeSnapshots : currentSnapshots;
  const currentSnapshot = currentSnapshotCandidates.length > 0
    ? currentSnapshotCandidates.slice().sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0]
    : null;
  const usableAccounts = accounts.filter((account) => {
    if (!account.enabled || !account.hasToken) {
      return false;
    }

    if (account.expiresAt && Number(account.expiresAt) <= Date.now()) {
      return false;
    }

    return !(account.invalidUntil && Number(account.invalidUntil) > Date.now());
  });
  const fileAccountIds = Array.isArray(authSummary.fileAccounts) ? authSummary.fileAccounts.map((value) => String(value)) : [];
  const envAccountIds = Array.isArray(authSummary.envAccounts) ? authSummary.envAccounts.map((value) => String(value)) : [];

  return {
    ok: true,
    bridge: {
      port: config.port,
      transportMode: config.transportMode,
      authMode: config.authMode,
      accountsPath: config.accountsPath,
      sessionStorePath: config.sessionStorePath,
      appPath: config.appPath,
      envPath: config.envPath || path.join(process.cwd(), ".env")
    },
    settings: {
      fallbacks: getFallbackSettings(config)
    },
    gateway,
    storage,
    snapshots: normalizedSnapshots,
    currentSnapshot,
    auth: authSummary,
    authRuntime: {
      accountsPath: config.accountsPath,
      totalAccounts: accounts.length,
      usableAccounts: usableAccounts.length,
      fileAccounts: fileAccountIds.length,
      usableFileAccounts: usableAccounts.filter((account) => fileAccountIds.includes(String(account.id))).length,
      envAccounts: envAccountIds.length,
      usableEnvAccounts: usableAccounts.filter((account) => envAccountIds.includes(String(account.id))).length,
      activeAccount: authSummary.activeAccount || null
    },
    accountStandby: directClient && typeof directClient.getStandbyState === "function"
      ? directClient.getStandbyState()
      : null,
    accounts,
    recentActivity: recentActivityStore && typeof recentActivityStore.get === "function"
      ? recentActivityStore.get()
      : null
  };
}

function writeHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    ...ADMIN_CORS_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html)
  });
  res.end(html);
}

function renderAdminPage(config) {
  const title = escapeHtml(`Accio Bridge Manager · ${config.port}`);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root {
  --bg: #f7f4f0;
  --panel: rgba(255,254,252,0.92);
  --panel-hover: rgba(255,254,252,1);
  --ink: #1a1816;
  --ink-secondary: #4a443e;
  --muted: #8a8279;
  --line: rgba(24,22,20,0.08);
  --line-strong: rgba(24,22,20,0.15);
  --accent: #c25a32;
  --accent-soft: rgba(194,90,50,0.1);
  --accent-deep: #a04428;
  --good: #1a8a5a;
  --good-soft: rgba(26,138,90,0.1);
  --warn: #b87a1a;
  --warn-soft: rgba(184,122,26,0.1);
  --bad: #c43c3c;
  --bad-soft: rgba(196,60,60,0.1);
  --shadow-sm: 0 2px 8px rgba(56,40,28,0.06);
  --shadow-md: 0 8px 24px rgba(56,40,28,0.08);
  --shadow-lg: 0 16px 48px rgba(56,40,28,0.1);
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 22px;
  --radius-xl: 28px;
  --transition-fast: 0.15s cubic-bezier(0.4,0,0.2,1);
  --transition-normal: 0.25s cubic-bezier(0.4,0,0.2,1);
}
* { box-sizing: border-box; margin: 0; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Noto Sans SC", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
  background: linear-gradient(175deg, #faf8f5 0%, #f2ede6 50%, #ede7df 100%);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; cursor: pointer; }

/* ── Animations ── */
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(26,138,90,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(26,138,90,0); }
}
@keyframes pulseWarn {
  0%, 100% { box-shadow: 0 0 0 0 rgba(184,122,26,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(184,122,26,0); }
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Shell ── */
.shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 16px 0 16px;
  display: grid;
  gap: 20px;
  animation: fadeSlideUp 0.5s ease-out;
}

/* ── Topbar ── */
.topbar {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(340px, 0.95fr);
  gap: 14px;
  align-items: start;
  margin-bottom: 12px;
}
.topbar.topbar-head {
  margin-bottom: 0;
}
.topbar.topbar-compact {
  grid-template-columns: 1fr;
}
.topbar.topbar-compact.statusActionsRow {
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 16px;
  align-items: stretch;
}
.titleBlock,
.statusCard,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.titleBlock {
  min-height: 0;
  padding: 18px 20px;
  animation: fadeSlideUp 0.4s ease-out;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 600;
}
.titleBlock h1 {
  margin: 10px 0 6px;
  font-size: clamp(24px, 2.6vw, 34px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.titleBlock p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  max-width: 44ch;
}

/* ── Status Card ── */
.statusCard {
  min-height: 0;
  padding: 14px 16px;
  animation: fadeSlideUp 0.5s ease-out 0.1s both;
}
.statusCard.statusCard-wide {
  width: 100%;
  height: 100%;
}
.statusHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.statusBadge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.8);
  border: 1px solid var(--line);
  font-size: 13px;
  font-weight: 500;
}
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.6);
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.btn-icon:hover {
  background: rgba(255,255,255,1);
  color: var(--ink);
  border-color: var(--line-strong);
}
.btn-icon.spinning {
  animation: spin 0.8s linear infinite;
  pointer-events: none;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
  transition: background var(--transition-normal);
}
.dot.good { background: var(--good); animation: pulse 2s ease-in-out infinite; }
.dot.warn { background: var(--warn); animation: pulseWarn 2s ease-in-out infinite; }
.dot.bad { background: var(--bad); }

/* ── StatusBadge Quota Mode ── */
.statusBadge {
  position: relative;
  overflow: hidden;
  z-index: 0;
  transition: border-color var(--transition-fast);
}
.statusBadge .badgeFill {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  z-index: -1;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(26,138,90,0.18) 0%, rgba(26,138,90,0.08) 100%);
  transition: width 0.8s cubic-bezier(0.4,0,0.2,1), background 0.4s ease;
  pointer-events: none;
}
.statusBadge .badgeFill[data-level="mid"] {
  background: linear-gradient(90deg, rgba(184,122,26,0.18) 0%, rgba(184,122,26,0.08) 100%);
}
.statusBadge .badgeFill[data-level="low"] {
  background: linear-gradient(90deg, rgba(224,104,72,0.22) 0%, rgba(196,60,60,0.10) 100%);
}
.statusBadge .badgeFill[data-level="empty"] {
  background: linear-gradient(90deg, rgba(196,60,60,0.22) 0%, rgba(196,60,60,0.10) 100%);
}
@keyframes quotaShimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes quotaPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.statusBadge.quota-active .badgeFill {
  background-size: 200% 100%;
  animation: quotaShimmer 3s ease-in-out infinite;
}
.statusBadge .badgeFill[data-level="low"],
.statusBadge .badgeFill[data-level="empty"] {
  animation: quotaPulse 2s ease-in-out infinite, quotaShimmer 3s ease-in-out infinite;
}
.statusBadge .badgeQuota {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--good);
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.statusBadge.quota-active .badgeQuota { opacity: 1; }
.statusBadge .badgeQuota[data-level="mid"] { color: var(--warn); }
.statusBadge .badgeQuota[data-level="low"],
.statusBadge .badgeQuota[data-level="empty"] { color: var(--bad); }
.kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.kvItem {
  min-width: 0;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(24,22,20,0.08);
  background: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.5);
}
.kvItem.full {
  grid-column: 1 / -1;
}
.kvKey {
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.kvValue {
  margin-top: 4px;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 600;
  word-break: break-word;
}
.kvValue.subtle {
  color: var(--ink-secondary);
  font-size: 12px;
  font-weight: 500;
}
.kvValue.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  font-weight: 500;
}

/* ── Action Panel (topbar slot) ── */
.actionPanel {
  padding: 16px 18px;
  animation: fadeSlideUp 0.4s ease-out 0.2s both;
  height: 100%;
}

/* ── Snapshot Panel (full-width) ── */
.snapshotPanel {
  padding: 16px 18px;
  animation: fadeSlideUp 0.4s ease-out 0.25s both;
}
.panel {
  padding: 16px 18px;
  animation: fadeSlideUp 0.4s ease-out 0.15s both;
}
.panel h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.panelSub {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

/* ── Action List ── */
.actionList {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.btn {
  position: relative;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  text-align: left;
  background: rgba(255,255,255,0.7);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: transform var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast), border-color var(--transition-fast);
}
.btn:hover {
  transform: translateY(-1px);
  background: rgba(255,255,255,0.95);
  box-shadow: var(--shadow-sm);
  border-color: var(--line-strong);
}
.btn:active {
  transform: translateY(0);
  box-shadow: none;
}
.btn.primary {
  background: linear-gradient(135deg, #d06840 0%, var(--accent) 50%, var(--accent-deep) 100%);
  color: #fff;
  border: none;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(194,90,50,0.25);
}
.btn.primary:hover {
  background: linear-gradient(135deg, #c25a32 0%, var(--accent-deep) 100%);
  box-shadow: 0 6px 20px rgba(194,90,50,0.3);
}
.btn.warn {
  background: var(--warn-soft);
  color: #7b4a0b;
  border-color: rgba(184,122,26,0.15);
}
.btn.warn:hover {
  background: rgba(184,122,26,0.15);
}
.btn.danger-confirm {
  background: var(--bad-soft);
  color: var(--bad);
  border-color: rgba(196,60,60,0.2);
  font-weight: 600;
}
.btn:disabled {
  opacity: .5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}
.btn.loading {
  color: transparent !important;
  pointer-events: none;
}
.btn.loading::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border: 2px solid rgba(0,0,0,0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.btn.primary.loading::after {
  border-color: rgba(255,255,255,0.3);
  border-top-color: #fff;
}

/* ── Messages ── */
.message {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  display: none;
  font-size: 12px;
  line-height: 1.5;
  position: relative;
  animation: slideIn 0.25s ease-out;
}
.message.show { display: flex; align-items: start; gap: 8px; }
.message .msg-icon { flex-shrink: 0; font-size: 14px; line-height: 1.55; }
.message .msg-text { flex: 1; }
.message .msg-close {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0 2px;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.5;
  color: inherit;
  line-height: 1;
}
.message .msg-close:hover { opacity: 1; }
.message.info { background: rgba(24,22,20,0.05); color: var(--ink-secondary); }
.message.ok { background: var(--good-soft); color: #145a3b; }
.message.warn { background: var(--warn-soft); color: #73470f; }
.message.error { background: var(--bad-soft); color: #771f1f; }

/* ── Section ── */
.sectionHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.sectionHeader > div:first-child {
  flex: 1;
  min-width: 0;
}
.sectionHeader > .btn {
  flex: 0 0 auto;
  width: auto;
  white-space: nowrap;
  align-self: flex-start;
  margin-top: 2px;
}

/* ── Snapshot List ── */
.list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: rgba(255,255,255,0.7);
  border: 1px solid var(--line);
  transition: all var(--transition-fast);
  position: relative;
  overflow: hidden;
}
.item::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: transparent;
  transition: background var(--transition-fast);
}
.item:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: var(--shadow-sm);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.item:active { transform: translateY(0); }
.item.current-item {
  border-color: rgba(26,138,90,0.3);
  background: rgba(26,138,90,0.04);
}
.item.current-item::before { background: var(--good); }
.itemAvatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-soft), rgba(194,90,50,0.2));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
  color: var(--accent-deep);
  flex-shrink: 0;
  margin-bottom: 8px;
  letter-spacing: -0.02em;
}
.item.current-item .itemAvatar {
  background: linear-gradient(135deg, var(--good-soft), rgba(26,138,90,0.2));
  color: var(--good);
}
.itemTitleRow {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.itemTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  word-break: break-all;
}
.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: rgba(24,22,20,0.06);
  color: var(--muted);
}
.pill.current {
  background: var(--good-soft);
  color: #145a3b;
}
.pill.warn {
  background: var(--warn-soft);
  color: #7b4a0b;
}
.pill.accent {
  background: var(--accent-soft);
  color: var(--accent-deep);
}
.itemMeta {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  margin-bottom: 2px;
}
.itemMeta.hint {
  color: var(--warn);
  font-style: italic;
}
.itemSpacer { flex: 1; }
.actionRow {
  display: flex;
  flex-direction: row;
  gap: 6px;
  margin-top: 10px;
}
.actionRow .btn {
  flex: 1;
  padding: 6px 8px;
  font-size: 11px;
  text-align: center;
  border-radius: var(--radius-sm);
}

/* ── Empty State ── */
.empty {
  padding: 20px 16px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--line-strong);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  background: rgba(255,255,255,0.4);
  text-align: center;
}
.empty-icon {
  display: block;
  font-size: 24px;
  margin-bottom: 6px;
  opacity: 0.5;
}

/* ── Side Notes ── */
.sideNotes {
  display: grid;
  gap: 6px;
}
.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: rgba(24,22,20,0.04);
  color: var(--ink-secondary);
  font-size: 11.5px;
  line-height: 1.55;
  border-left: 3px solid var(--line-strong);
}
.note code {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10.5px;
  background: rgba(24,22,20,0.08);
  padding: 0 3px;
  border-radius: 3px;
}
.note.note-info {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--ink-secondary);
}


.pageHeadWrap {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding: 10px 0 12px;
}
.tabbar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 999px;
  background: rgba(255,255,255,0.9);
  border: 1px solid var(--line);
  box-shadow: 0 8px 18px rgba(24,22,20,0.06);
  width: fit-content;
  margin: 0 auto;
  justify-self: center;
}
.tabBtn {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 10px 16px;
  border-radius: 999px;
  font: inherit;
  font-weight: 700;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}
.tabBtn:hover {
  color: var(--ink);
  transform: translateY(-1px);
}
.tabBtn.active {
  background: var(--accent);
  color: #fff7f1;
  box-shadow: 0 10px 20px rgba(194,90,50,0.22);
}
.tabPanel {
  display: none;
  animation: panelFade 180ms ease;
}
.tabPanel.active {
  display: block;
}
.topbar.tabScopedHidden {
  display: none;
}
.logsPanel {
  display: grid;
  gap: 14px;
  max-width: 920px;
}
.logsToolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.logsMeta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 12px;
}
.logsActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.logsViewport {
  min-height: 420px;
  max-height: 68vh;
  overflow: auto;
  border-radius: 16px;
  border: 1px solid rgba(24,22,20,0.08);
  background: #14110f;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}
.logEmpty {
  padding: 22px 20px;
  color: rgba(255,255,255,0.58);
  font-size: 12px;
}
.logList {
  display: grid;
}
.logEntry {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-family: ui-monospace, "SF Mono", monospace;
  color: rgba(255,255,255,0.92);
}
.logEntry:last-child {
  border-bottom: 0;
}
.logEntry[data-level="debug"] {
  color: rgba(177,197,255,0.86);
}
.logEntry[data-level="info"] {
  color: rgba(240,236,228,0.92);
}
.logEntry[data-level="warn"] {
  color: #ffd37d;
}
.logEntry[data-level="error"] {
  color: #ff9d9d;
}
.logEntryHead {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  line-height: 1.5;
}
.logLevel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  color: inherit;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
}
.logTs,
.logRequestId {
  color: rgba(255,255,255,0.58);
}
.logMsg {
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.logMeta {
  font-size: 11px;
  line-height: 1.6;
  color: rgba(255,255,255,0.72);
  white-space: pre-wrap;
  word-break: break-word;
}
@keyframes panelFade {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.settingsPanel {
  display: grid;
  gap: 16px;
  max-width: 920px;
}
.settingsToolbar {
  display: flex;
  justify-content: flex-start;
}
.settingsGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.fallbackTargets {
  display: grid;
  gap: 12px;
}
.fallbackCard {
  display: grid;
  gap: 0;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.82);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: box-shadow 160ms ease, border-color 160ms ease;
}
.fallbackCard:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--line-strong);
}
.fallbackCardHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  background: linear-gradient(to right, rgba(194,90,50,0.04), transparent);
  border-bottom: 1px solid var(--line);
}
.fallbackCard[data-enabled="false"] .fallbackCardHeader {
  background: linear-gradient(to right, rgba(24,22,20,0.03), transparent);
}
.fallbackCardTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.fallbackCardIndex {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.fallbackCard[data-enabled="false"] .fallbackCardIndex {
  background: var(--muted);
}
.fallbackCardTitle strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}
.fallbackCardMeta {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.fallbackCardActions {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
  flex-shrink: 0;
}
.fallbackCardActions .btn {
  width: auto;
  padding: 5px 10px;
  font-size: 12px;
  height: auto;
}
.fallbackCardBody {
  padding: 16px;
  overflow: hidden;
}
.fallbackCard[data-collapsed="true"] .fallbackCardBody {
  display: none;
}
/* 折叠按钮 */
.fallbackCollapseBtn {
  background: none;
  border: none;
  padding: 0 6px;
  cursor: pointer;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 200ms ease, color 200ms ease;
  flex-shrink: 0;
}
.fallbackCollapseBtn:hover {
  color: var(--ink);
}
.fallbackCard[data-collapsed="true"] .fallbackCollapseBtn {
  transform: rotate(-90deg);
}
/* iOS-style toggle switch */
.toggleRow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  user-select: none;
  color: var(--ink-secondary);
  font-size: 12px;
  font-weight: 500;
}
.toggleRow input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: rgba(24,22,20,0.18);
  border: none;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition: background 200ms ease;
  margin: 0;
}
.toggleRow input[type="checkbox"]::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  top: 2px;
  left: 2px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  transition: transform 200ms cubic-bezier(0.4,0,0.2,1);
}
.toggleRow input[type="checkbox"]:checked {
  background: var(--good);
}
.toggleRow input[type="checkbox"]:checked::after {
  transform: translateX(12px);
}
.field {
  display: grid;
  gap: 8px;
}
.inputWrap {
  position: relative;
}
.field.wide {
  grid-column: 1 / -1;
}
.field label {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-secondary);
  letter-spacing: 0.02em;
}
.field input,
.field select {
  width: 100%;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.78);
  color: var(--ink);
  border-radius: 14px;
  min-height: 50px;
  padding: 12px 14px;
  font: inherit;
  transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
}
.inputWrap input {
  padding-right: 52px;
}
.field select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 44px;
  background-image:
    linear-gradient(45deg, transparent 50%, rgba(24,22,20,0.72) 50%),
    linear-gradient(135deg, rgba(24,22,20,0.72) 50%, transparent 50%);
  background-position:
    calc(100% - 22px) calc(50% - 3px),
    calc(100% - 16px) calc(50% - 3px);
  background-size: 6px 6px, 6px 6px;
  background-repeat: no-repeat;
  cursor: pointer;
}
.inputToggle {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: rgba(24,22,20,0.05);
  color: var(--muted);
  font-size: 15px;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}
.inputToggle:hover {
  background: rgba(24,22,20,0.08);
  color: var(--ink);
}
.inputToggle:focus {
  outline: none;
  box-shadow: 0 0 0 4px rgba(194,90,50,0.12);
  color: var(--ink);
}
.field input:focus,
.field select:focus {
  outline: none;
  border-color: rgba(194,90,50,0.45);
  box-shadow: 0 0 0 4px rgba(194,90,50,0.12);
  background: #fff;
}
.fieldHint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.settingsTips {
  display: grid;
  gap: 0;
  border-radius: 12px;
  border: 1px solid var(--line);
  overflow: hidden;
  background: rgba(255,255,255,0.55);
}
.settingsTip {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--ink-secondary);
  line-height: 1.55;
  border-bottom: 1px solid var(--line);
}
.settingsTip:last-child { border-bottom: none; }
.settingsTip code {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  background: rgba(24,22,20,0.07);
  padding: 0 4px;
  border-radius: 4px;
}
.settingsTipIcon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1.6;
}
.settingsFooter {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settingsActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.settingsActions .btn {
  width: auto;
  flex-shrink: 0;
}
.settingsActions .message {
  flex: 1;
  min-width: 0;
  margin: 0;
  margin-right: auto;
}
.settingsMeta {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.miniStat {
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255,255,255,0.72);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
}
.miniStatIcon {
  font-size: 16px;
  flex-shrink: 0;
  opacity: 0.6;
}
.miniStatBody { min-width: 0; }
.miniStatLabel {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.miniStatValue {
  margin-top: 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 720px) {
  .settingsGrid,
  .settingsMeta {
    grid-template-columns: 1fr;
  }

  .tabbar {
    width: 100%;
    justify-content: center;
  }

  .tabBtn {
    flex: 1;
    text-align: center;
  }
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(24,22,20,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(24,22,20,0.25); }

/* ── Responsive ── */
@media (max-width: 980px) {
  .topbar,
  .statusActionsRow {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .shell {
    width: min(100vw, calc(100vw - 20px));
    padding-top: 10px;
    padding-bottom: 18px;
  }
  .kv {
    grid-template-columns: 1fr;
  }
  .kvItem.full {
    grid-column: auto;
  }
  .list {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}
</style>
</head>
<body>
<div class="pageHeadWrap">
  <nav class="tabbar" aria-label="\u63A7\u5236\u53F0\u5206\u533A">
    <button class="tabBtn active" type="button" data-tab="accounts">\u8D26\u53F7\u7BA1\u7406</button>
    <button class="tabBtn" type="button" data-tab="settings">\u4E0A\u6E38\u914D\u7F6E</button>
    <button class="tabBtn" type="button" data-tab="logs">\u65E5\u5FD7</button>
  </nav>
</div>
<div class="shell">
  <section class="topbar topbar-head topbar-compact statusActionsRow" id="primary-topbar">
    <aside class="statusCard statusCard-wide">
      <div class="statusHeader">
        <div class="statusBadge" id="status-badge"><span class="badgeFill" id="badge-fill"></span><span class="dot" id="gateway-dot"></span><span id="gateway-summary">\u6B63\u5728\u68C0\u67E5 Bridge \u72B6\u6001</span><span class="badgeQuota" id="badge-quota"></span></div>
        <button class="btn-icon" id="refresh-btn" title="\u5237\u65B0\u72B6\u6001">\u21BB</button>
      </div>
      <div class="kv" id="overview-kv"></div>
    </aside>
    <aside class="panel actionPanel">
      <h2>\u8D26\u53F7\u64CD\u4F5C</h2>
      <div class="panelSub">\u901A\u8FC7 bridge \u76F4\u63A5\u65B0\u589E\u8D26\u53F7\u3002\u767B\u5F55\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u8BB0\u5F55\u5230\u5217\u8868\u3002</div>
      <div class="actionList">
        <button class="btn primary" id="account-login-btn">\uFF0B \u6DFB\u52A0\u8D26\u53F7\u767B\u5F55</button>
        <button class="btn" id="cancel-account-login-btn" style="display:none">\u653E\u5F03\u672C\u6B21\u767B\u5F55</button>
      </div>
      <div id="action-message" class="message info"></div>
    </aside>
  </section>
  <section class="tabPanel active" data-tab-panel="accounts">
    <section class="panel snapshotPanel">
      <div class="sectionHeader">
        <div>
          <h2>\u5DF2\u8BB0\u5F55\u8D26\u53F7</h2>
          <div class="panelSub">\u672C\u5730\u5DF2\u4FDD\u5B58\u7684 Accio \u767B\u5F55\u8EAB\u4EFD\u3002\u201C\u5207\u6362\u201D\u4F1A\u5C1D\u8BD5\u5C06\u5B83\u8BBE\u4E3A\u5F53\u524D\u6FC0\u6D3B\u8D26\u53F7\u3002</div>
        </div>
      </div>
      <div class="list" id="snapshot-list"></div>
    </section>
  </section>

  <section class="tabPanel" data-tab-panel="settings">
    <section class="panel settingsPanel">
      <div class="sectionHeader">
        <div>
          <h2>\u5916\u90E8\u4E0A\u6E38\u6E20\u9053</h2>
          <div class="panelSub">\u53F7\u6C60\u548C\u672C\u5730\u94FE\u8DEF\u5747\u4E0D\u53EF\u7528\u65F6\uFF0Cbridge \u4F1A\u6309\u4F18\u5148\u7EA7\u4F9D\u6B21\u5C1D\u8BD5\u4EE5\u4E0B\u5916\u90E8\u6E20\u9053\u3002\u652F\u6301 OpenAI compatible \u548C Anthropic Messages \u6DF7\u7528\u3002</div>
        </div>
        <button class="btn" id="add-fallback-target-btn">+ \u65B0\u589E\u6E20\u9053</button>
      </div>

      <div class="settingsMeta">
        <div class="miniStat">
          <span class="miniStatIcon">\uD83D\uDD17</span>
          <div class="miniStatBody">
            <div class="miniStatLabel">\u6E20\u9053\u6982\u89C8</div>
            <div class="miniStatValue" id="fallback-status">\u672A\u914D\u7F6E</div>
          </div>
        </div>
        <div class="miniStat">
          <span class="miniStatIcon">\uD83D\uDCC4</span>
          <div class="miniStatBody">
            <div class="miniStatLabel">\u5199\u5165\u6587\u4EF6</div>
            <div class="miniStatValue" id="fallback-env-path">.env</div>
          </div>
        </div>
      </div>

      <div class="fallbackTargets" id="fallback-targets"></div>
      <div class="empty" id="fallback-empty" style="display:none"><span class="empty-icon">\uD83D\uDCE1</span>\u6682\u65E0\u5916\u90E8\u4E0A\u6E38\u6E20\u9053\u3002\u70B9\u51FB\u300C\u65B0\u589E\u6E20\u9053\u300D\u5F00\u59CB\u914D\u7F6E\u3002</div>

      <div class="settingsFooter">
        <div class="settingsActions">
          <button class="btn primary" id="save-fallback-config-btn">\u4FDD\u5B58\u6E20\u9053\u914D\u7F6E</button>
          <button class="btn" id="reload-fallback-config-btn">\u91CD\u65B0\u8F7D\u5165</button>
          <div id="config-message" class="message info"></div>
        </div>
        <div class="settingsTips">
          <div class="settingsTip"><span class="settingsTipIcon">\uD83D\uDCBE</span>\u4FDD\u5B58\u540E\u5199\u5165 bridge \u6839\u76EE\u5F55 .env\uFF0C\u5E76\u7ACB\u5373\u5E94\u7528\u5230\u5F53\u524D\u8FDB\u7A0B\u3002</div>
          <div class="settingsTip"><span class="settingsTipIcon">\uD83D\uDD17</span>OpenAI \u534F\u8BAE\u586B\u5230 <code>/v1</code>\uFF1BAnthropic \u534F\u8BAE\u586B\u5230\u63D0\u4F9B <code>/messages</code> \u7684\u6839\u524D\u7F00\u3002</div>
          <div class="settingsTip"><span class="settingsTipIcon">\uD83D\uDD3C</span>\u5217\u8868\u987A\u5E8F\u5C31\u662F\u5140\u5E95\u5C1D\u8BD5\u987A\u5E8F\uFF0C\u53EF\u7528\u300C\u4E0A\u79FB / \u4E0B\u79FB\u300D\u8C03\u6574\u3002</div>
          <div class="settingsTip"><span class="settingsTipIcon">\u2728</span>Anthropic \u6E20\u9053\u9002\u5408 Claude Code \u7B49\u539F\u751F\u5BA2\u6237\u7AEF\u900F\u4F20\uFF0C\u8BED\u4E49\u4FDD\u7559\u66F4\u5B8C\u6574\u3002</div>
        </div>
        <div class="sideNotes">
          <div class="note">\uD83D\uDEA8 \u4EC5\u5F53 direct-llm \u56E0 quota / auth / timeout / 5xx \u5931\u8D25\u65F6\uFF0Cbridge \u624D\u4F1A\u542F\u7528\u8FD9\u4E2A\u5140\u5E95\u4E0A\u6E38\u3002</div>
          <div class="note">\uD83D\uDCA1 Anthropic \u6E20\u9053\u4F1A\u5C06 <code>/v1/messages</code> \u76F4\u63A5\u900F\u4F20\u5230\u5916\u90E8 Anthropic \u4E0A\u6E38\uFF0C\u5C3D\u91CF\u4FDD\u7559 Claude Code \u539F\u59CB\u8BF7\u6C42\u8BED\u4E49\u3002</div>
        </div>
      </div>
    </section>
  </section>

  <section class="tabPanel" data-tab-panel="logs">
    <section class="panel logsPanel">
      <div class="logsToolbar">
        <div>
          <h2>运行日志</h2>
          <div class="panelSub">复用 bridge 当前进程日志，展示最近日志并实时追加。</div>
        </div>
        <div class="logsActions">
          <button class="btn" id="refresh-logs-btn">刷新日志</button>
          <button class="btn" id="toggle-log-follow-btn">自动滚动：开</button>
        </div>
      </div>
      <div class="logsMeta">
        <span id="log-count">0 条</span>
        <span id="log-status">等待日志加载</span>
      </div>
      <div class="logsViewport" id="logs-viewport">
        <div class="logEmpty" id="logs-empty">当前还没有可展示的日志。</div>
        <div class="logList" id="logs-list"></div>
      </div>
    </section>
  </section>
</div>
<script>
const els = {
  primaryTopbar: document.getElementById('primary-topbar'),
  gatewayDot: document.getElementById('gateway-dot'),
  gatewaySummary: document.getElementById('gateway-summary'),
  overviewKv: document.getElementById('overview-kv'),
  snapshotList: document.getElementById('snapshot-list'),
  actionMessage: document.getElementById('action-message'),
  configMessage: document.getElementById('config-message'),
  refreshBtn: document.getElementById('refresh-btn'),
  accountLoginBtn: document.getElementById('account-login-btn'),
  cancelAccountLoginBtn: document.getElementById('cancel-account-login-btn'),
  addFallbackTargetBtn: document.getElementById('add-fallback-target-btn'),
  saveFallbackConfigBtn: document.getElementById('save-fallback-config-btn'),
  reloadFallbackConfigBtn: document.getElementById('reload-fallback-config-btn'),
  fallbackTargets: document.getElementById('fallback-targets'),
  fallbackEmpty: document.getElementById('fallback-empty'),
  fallbackStatus: document.getElementById('fallback-status'),
  fallbackEnvPath: document.getElementById('fallback-env-path'),
  refreshLogsBtn: document.getElementById('refresh-logs-btn'),
  toggleLogFollowBtn: document.getElementById('toggle-log-follow-btn'),
  logCount: document.getElementById('log-count'),
  logStatus: document.getElementById('log-status'),
  logsViewport: document.getElementById('logs-viewport'),
  logsEmpty: document.getElementById('logs-empty'),
  logsList: document.getElementById('logs-list')
};
const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));
const desktopBridge = typeof window !== 'undefined' && window.accioBridgeDesktop ? window.accioBridgeDesktop : null;
const isElectronShell = String(navigator.userAgent || '').includes('Electron/') || Boolean(desktopBridge);
let messageTimer = null;
let configMessageTimer = null;
let currentTab = 'accounts';
let refreshInFlight = null;
let stateStream = null;
let fallbackDraft = [];
let logEntries = [];
let logsLoaded = false;
let refreshLogsInFlight = null;
let logFollow = true;
let latestLogSeq = 0;
const cancelledLoginFlows = new Set();
const MAX_RENDERED_LOGS = 300;
const MSG_ICONS = { info: 'ℹ️', ok: '✅', warn: '⚠️', error: '❌' };
function setScopedMessage(target, type, text, scope) {
  if (!target) {
    return;
  }

  if (scope === 'config') {
    if (configMessageTimer) { clearTimeout(configMessageTimer); configMessageTimer = null; }
  } else if (messageTimer) {
    clearTimeout(messageTimer);
    messageTimer = null;
  }

  target.className = 'message show ' + type;
  target.innerHTML = '<span class="msg-icon">' + (MSG_ICONS[type] || '') + '</span><span class="msg-text">' + escapeInline(text) + '</span><button class="msg-close" onclick="' + (scope === 'config' ? 'clearConfigMessage()' : 'clearMessage()') + '">×</button>';
  if (type === 'ok') {
    const timer = setTimeout(function() { scope === 'config' ? clearConfigMessage() : clearMessage(); }, 6000);
    if (scope === 'config') {
      configMessageTimer = timer;
    } else {
      messageTimer = timer;
    }
  }
}
function setMessage(type, text) {
  setScopedMessage(els.actionMessage, type, text, 'action');
}
function clearMessage() {
  if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
  els.actionMessage.className = 'message info';
  els.actionMessage.innerHTML = '';
}
function setConfigMessage(type, text) {
  setScopedMessage(els.configMessage, type, text, 'config');
}
function clearConfigMessage() {
  if (configMessageTimer) { clearTimeout(configMessageTimer); configMessageTimer = null; }
  if (!els.configMessage) {
    return;
  }
  els.configMessage.className = 'message info';
  els.configMessage.innerHTML = '';
}
function switchTab(tab) {
  const active = ['accounts', 'settings', 'logs'].includes(String(tab)) ? String(tab) : 'accounts';
  currentTab = active;
  tabButtons.forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-tab') === active);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === active);
  });
  if (els.primaryTopbar) {
    const hideTopbar = active !== 'accounts';
    els.primaryTopbar.classList.toggle('tabScopedHidden', hideTopbar);
    els.primaryTopbar.setAttribute('aria-hidden', hideTopbar ? 'true' : 'false');
  }
  try { localStorage.setItem('accio-admin-tab', active); } catch (_) {}
  if (active === 'logs' && !logsLoaded) {
    refreshLogs().catch((error) => {
      setLogStatus((error && error.message) || String(error));
    });
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || payload.error || 'Request failed');
  return payload;
}
function formatTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
function bridgeBadgeState(data) {
  const runtime = data && data.authRuntime ? data.authRuntime : null;
  if (!runtime) {
    return ['warn', 'Bridge 状态未知'];
  }

  const activeAccountId = runtime.activeAccount ? String(runtime.activeAccount) : '';
  const usableAccounts = Number(runtime.usableAccounts || 0);
  const totalAccounts = Number(runtime.totalAccounts || 0);

  if (activeAccountId && usableAccounts > 0) {
    return ['good', 'Bridge 已就绪 · 默认 ' + activeAccountId];
  }

  if (usableAccounts > 0) {
    return ['good', 'Bridge 已加载 ' + usableAccounts + ' 个可用账号'];
  }

  if (totalAccounts > 0) {
    return ['warn', '已记录 ' + totalAccounts + ' 个账号，但暂无可用账号'];
  }

  return ['bad', 'Bridge 暂无可用账号'];
}
function describeRecentActivity(activity) {
  if (!activity || !activity.transportSelected) {
    return '暂无最近请求';
  }

  const transport = String(activity.transportSelected);
  const model = activity.fallbackModel || activity.resolvedProviderModel || activity.requestedModel || 'unknown';
  const accountLabel = activity.accountName || activity.accountId || null;

  if (transport === 'external-anthropic') {
    return '外部 Anthropic · ' + model;
  }

  if (transport === 'external-openai') {
    return '外部 OpenAI · ' + model;
  }

  if (transport === 'local-ws') {
    return 'Accio local-ws · ' + model;
  }

  if (transport === 'direct-llm') {
    if (accountLabel) {
      return '号池直连 · ' + accountLabel + ' · ' + model;
    }

    return 'Bridge 直连 · ' + model;
  }

  return model && model !== 'unknown'
    ? (transport + ' · ' + model)
    : transport;
}
function recentActivityBadge(activity, data) {
  if (!activity || !activity.transportSelected) {
    return bridgeBadgeState(data);
  }

  const transport = String(activity.transportSelected);
  const summary = '最近出口 · ' + describeRecentActivity(activity);

  if (transport === 'external-anthropic' || transport === 'external-openai') {
    return ['warn', summary];
  }

  return ['good', summary];
}
function describeBridgeCompact(data) {
  const runtime = data && data.authRuntime ? data.authRuntime : null;
  const bridge = data && data.bridge ? data.bridge : null;
  const parts = [];

  if (bridge && bridge.transportMode) {
    parts.push('出口 ' + String(bridge.transportMode));
  }

  if (bridge && bridge.authMode) {
    parts.push('鉴权 ' + String(bridge.authMode));
  }

  if (runtime) {
    parts.push('可用 ' + String(runtime.usableAccounts || 0) + ' 个');
  }
  return parts.length > 0 ? parts.join(' · ') : '未知';
}
function describeRecentActivityCompact(activity) {
  if (!activity || !activity.transportSelected) {
    return '暂无最近请求';
  }

  const route = describeRecentActivity(activity);
  const time = activity.recordedAt ? formatTime(activity.recordedAt) : '';
  return time ? (route + ' · ' + time) : route;
}
function describeAuthPoolCompact(data) {
  const runtime = data && data.authRuntime ? data.authRuntime : null;
  if (!runtime) {
    return '未知';
  }

  const parts = [
    '已加载 ' + String(runtime.totalAccounts || 0) + ' 个',
    '可用 ' + String(runtime.usableAccounts || 0) + ' 个'
  ];

  if ((runtime.fileAccounts || 0) > 0 || (runtime.envAccounts || 0) > 0) {
    parts.push('文件 ' + String(runtime.fileAccounts || 0) + ' / 环境 ' + String(runtime.envAccounts || 0));
  }

  return parts.join(' · ');
}
function describeActiveAccountCompact(data) {
  const activeAccountId = data && data.authRuntime && data.authRuntime.activeAccount
    ? String(data.authRuntime.activeAccount)
    : '';
  if (!activeAccountId) {
    return '未设置';
  }

  const snapshots = Array.isArray(data && data.snapshots) ? data.snapshots : [];
  const activeSnapshot = snapshots.find((snapshot) => snapshot
    && snapshot.accountState
    && String(snapshot.accountState.id || '') === activeAccountId) || null;
  const user = activeSnapshot && activeSnapshot.gatewayUser ? activeSnapshot.gatewayUser : null;
  const userName = user && user.name ? String(user.name) : '';

  return userName && userName !== activeAccountId
    ? (userName + ' · ' + activeAccountId)
    : activeAccountId;
}
function describeStandbyCompact(data) {
  const standby = data && data.accountStandby ? data.accountStandby : null;
  if (!standby || standby.enabled === false) {
    return '已关闭';
  }

  const readyCount = Number(standby.readyCount != null ? standby.readyCount : standby.candidateCount || 0);
  const cooldownCount = Number(standby.cooldownCount || 0);
  const refreshedAt = standby.refreshedAt ? formatTime(standby.refreshedAt) : '';

  if (readyCount > 0) {
    const nextLabel = standby.nextAccountName || standby.nextAccountId || '未知账号';
    const parts = ['下一个 ' + nextLabel, '就绪 ' + readyCount + ' 个'];
    if (cooldownCount > 0) {
      parts.push('冷却 ' + cooldownCount + ' 个');
    }
    if (refreshedAt) {
      parts.push(refreshedAt);
    }
    return parts.join(' · ');
  }

  if (cooldownCount > 0) {
    const nextRecoverLabel = standby.nextRecoverAccountName || standby.nextRecoverAccountId || '未知账号';
    const nextRecoverAt = standby.nextRecoverAt ? formatTime(standby.nextRecoverAt) : '';
    return ['冷却中 ' + cooldownCount + ' 个', '最快 ' + nextRecoverLabel, nextRecoverAt].filter(Boolean).join(' · ');
  }

  return standby.lastError
    ? ('空队列 · ' + String(standby.lastError))
    : '空队列';
}
function simplifySnapshotAliasLabel(alias) {
  const text = String(alias || '').trim();
  if (!text) {
    return '';
  }

  const repeatedId = text.match(/^acct-([A-Za-z0-9._-]+)-\\1$/);
  if (repeatedId && repeatedId[1]) {
    return repeatedId[1];
  }

  const plainId = text.match(/^acct-([A-Za-z0-9._-]+)$/);
  if (plainId && plainId[1]) {
    return plainId[1];
  }

  return text;
}
function describeRecentAuthCompact(activity) {
  if (!activity || !activity.transportSelected) {
    return '暂无最近认证';
  }

  const transport = String(activity.transportSelected || '');
  const authSource = activity.authSource ? String(activity.authSource) : '';
  const accountLabel = activity.accountName || activity.accountId || '';

  if (transport === 'direct-llm') {
    if (accountLabel) {
      if (authSource === 'env') {
        return 'env · ' + accountLabel;
      }

      return 'file-credential · ' + accountLabel;
    }

    if (authSource && accountLabel) {
      return authSource + ' · ' + accountLabel;
    }

    if (authSource) {
      return authSource;
    }

    return 'direct-llm';
  }

  if (transport === 'external-anthropic' || transport === 'external-openai') {
    const provider = activity.fallbackProtocol ? String(activity.fallbackProtocol) : transport.replace(/^external-/, '');
    const model = activity.fallbackModel || activity.resolvedProviderModel || activity.requestedModel || 'unknown';
    return 'external · ' + provider + ' · ' + model;
  }

  if (transport === 'local-ws') {
    return 'local-ws';
  }

  return transport;
}
function renderKv(target, rows) {
  const fullWidthKeys = new Set(['账号文件', '当前快照', '运行环境']);
  target.innerHTML = rows.map(([k, v]) => {
    const key = String(k || '');
    const value = String(v || '—');
    const full = fullWidthKeys.has(key);
    const mono = key === '账号文件' || value.includes('/') || value.includes('127.0.0.1:');
    const subtle = value === '暂无最近请求' || value === '暂无最近鉴权' || value === '—' || value === '未知';
    return '<div class="kvItem' + (full ? ' full' : '') + '">'
      + '<div class="kvKey">' + escapeInline(key) + '</div>'
      + '<div class="kvValue' + (mono ? ' mono' : '') + (subtle ? ' subtle' : '') + '">' + escapeInline(value) + '</div>'
      + '</div>';
  }).join('');
}
function formatCountdown(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return '未知';
  }

  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? (hours + ' 小时 ' + minutes + ' 分钟') : (hours + ' 小时');
  }

  return minutes > 0 ? (minutes + ' 分钟') : (total + ' 秒');
}
function escapeInline(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function setLogStatus(text) {
  if (els.logStatus) {
    els.logStatus.textContent = text || '';
  }
}
function updateLogMeta() {
  if (els.logCount) {
    els.logCount.textContent = String(logEntries.length) + ' 条';
  }
  if (els.toggleLogFollowBtn) {
    els.toggleLogFollowBtn.textContent = '自动滚动：' + (logFollow ? '开' : '关');
  }
}
function scrollLogsToBottom() {
  if (!els.logsViewport || !logFollow) {
    return;
  }
  els.logsViewport.scrollTop = els.logsViewport.scrollHeight;
}
function formatLogMeta(entry) {
  const meta = { ...entry };
  delete meta.seq;
  delete meta.ts;
  delete meta.level;
  delete meta.msg;
  delete meta.requestId;

  const keys = Object.keys(meta);
  if (keys.length === 0) {
    return '';
  }

  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return keys.map((key) => key + ': ' + String(meta[key])).join('\\n');
  }
}
function renderLogEntry(entry) {
  const requestId = entry && entry.requestId ? String(entry.requestId) : '';
  const metaText = formatLogMeta(entry);
  const level = entry && entry.level ? String(entry.level).toLowerCase() : 'info';
  return '<article class="logEntry" data-level="' + escapeInline(level) + '" data-seq="' + escapeInline(String(entry && entry.seq ? entry.seq : '')) + '">'
    + '<div class="logEntryHead">'
    + '<span class="logLevel">' + escapeInline(level) + '</span>'
    + '<span class="logTs">' + escapeInline(formatTime(entry && entry.ts ? entry.ts : '')) + '</span>'
    + (requestId ? '<span class="logRequestId">' + escapeInline(requestId) + '</span>' : '')
    + '</div>'
    + '<div class="logMsg">' + escapeInline(entry && entry.msg ? entry.msg : '') + '</div>'
    + (metaText ? '<pre class="logMeta">' + escapeInline(metaText) + '</pre>' : '')
    + '</article>';
}
function renderLogs() {
  if (!els.logsList || !els.logsEmpty) {
    return;
  }
  els.logsList.innerHTML = logEntries.map((entry) => renderLogEntry(entry)).join('');
  els.logsEmpty.style.display = logEntries.length === 0 ? '' : 'none';
  updateLogMeta();
  requestAnimationFrame(() => scrollLogsToBottom());
}
function replaceLogEntries(entries) {
  const nextEntries = Array.isArray(entries) ? entries.slice(-MAX_RENDERED_LOGS) : [];
  logEntries = nextEntries;
  latestLogSeq = nextEntries.reduce((max, entry) => {
    const seq = Number(entry && entry.seq ? entry.seq : 0);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
  renderLogs();
}
function appendLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return;
  }

  const seq = Number(entry.seq || 0);
  if (Number.isFinite(seq) && seq > 0) {
    if (logEntries.some((item) => Number(item && item.seq ? item.seq : 0) === seq)) {
      return;
    }
    latestLogSeq = Math.max(latestLogSeq, seq);
  }

  logEntries = logEntries.concat([entry]).slice(-MAX_RENDERED_LOGS);
  renderLogs();
}
async function refreshLogs() {
  if (!refreshLogsInFlight) {
    setLogStatus('正在加载日志...');
    refreshLogsInFlight = (async () => {
      const payload = await api('/admin/api/logs?limit=' + MAX_RENDERED_LOGS);
      const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
      replaceLogEntries(entries);
      logsLoaded = true;
      setLogStatus(entries.length > 0 ? ('最近刷新：' + formatTime(new Date().toISOString())) : '当前还没有可展示的日志');
      return payload;
    })();
  }

  try {
    return await refreshLogsInFlight;
  } finally {
    refreshLogsInFlight = null;
  }
}
function createFallbackDraftTarget(index) {
  return {
    id: 'draft_' + Date.now().toString(36) + '_' + index,
    name: '渠道 ' + (index + 1),
    enabled: true,
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    supportedModels: '',
    reasoningEffort: '',
    anthropicVersion: '2023-06-01',
    timeoutMs: 60000
  };
}
function normalizeFallbackDraftTarget(target, index) {
  const rawProtocol = String(target && target.protocol ? target.protocol : '').toLowerCase();
  const rawApiStyle = String(target && target.openaiApiStyle ? target.openaiApiStyle : '').toLowerCase();
  const normalizedProtocol = ['openai', 'openai-chat-completions', 'openai-responses', 'anthropic'].includes(rawProtocol)
    ? rawProtocol
    : 'openai';
  const protocol = normalizedProtocol === 'openai' && rawApiStyle === 'responses'
    ? 'openai-responses'
    : (normalizedProtocol === 'openai' && rawApiStyle === 'chat_completions'
      ? 'openai-chat-completions'
      : normalizedProtocol);

  return {
    id: String(target && target.id ? target.id : ('draft_' + index)),
    name: String(target && target.name ? target.name : ('渠道 ' + (index + 1))).trim() || ('渠道 ' + (index + 1)),
    enabled: target && target.enabled !== false,
    protocol,
    baseUrl: String(target && target.baseUrl ? target.baseUrl : ''),
    apiKey: String(target && target.apiKey ? target.apiKey : ''),
    model: String(target && target.model ? target.model : ''),
    supportedModels: Array.isArray(target && target.supportedModels)
      ? target.supportedModels.join(', ')
      : String(target && target.supportedModels ? target.supportedModels : ''),
    reasoningEffort: ['low', 'medium', 'high'].includes(String(target && target.reasoningEffort ? target.reasoningEffort : '').toLowerCase())
      ? String(target.reasoningEffort).toLowerCase()
      : '',
    anthropicVersion: String(target && target.anthropicVersion ? target.anthropicVersion : '2023-06-01'),
    timeoutMs: Number(target && target.timeoutMs ? target.timeoutMs : 60000) || 60000
  };
}
function collectFallbackDraft() {
  if (!els.fallbackTargets) {
    return [];
  }

  return Array.from(els.fallbackTargets.querySelectorAll('[data-fallback-item]')).map((item, index) => normalizeFallbackDraftTarget({
    id: item.getAttribute('data-fallback-id') || ('draft_' + index),
    name: item.querySelector('[data-field=\"name\"]') ? item.querySelector('[data-field=\"name\"]').value.trim() : '',
    enabled: item.querySelector('[data-field=\"enabled\"]') ? item.querySelector('[data-field=\"enabled\"]').checked : true,
    protocol: item.querySelector('[data-field=\"protocol\"]') ? item.querySelector('[data-field=\"protocol\"]').value : 'openai',
    baseUrl: item.querySelector('[data-field=\"baseUrl\"]') ? item.querySelector('[data-field=\"baseUrl\"]').value.trim() : '',
    apiKey: item.querySelector('[data-field=\"apiKey\"]') ? item.querySelector('[data-field=\"apiKey\"]').value.trim() : '',
    model: item.querySelector('[data-field=\"model\"]') ? item.querySelector('[data-field=\"model\"]').value.trim() : '',
    supportedModels: item.querySelector('[data-field=\"supportedModels\"]') ? item.querySelector('[data-field=\"supportedModels\"]').value.trim() : '',
    reasoningEffort: item.querySelector('[data-field=\"reasoningEffort\"]') ? item.querySelector('[data-field=\"reasoningEffort\"]').value : '',
    anthropicVersion: item.querySelector('[data-field=\"anthropicVersion\"]') ? item.querySelector('[data-field=\"anthropicVersion\"]').value.trim() : '2023-06-01',
    timeoutMs: item.querySelector('[data-field=\"timeoutMs\"]') ? Number(item.querySelector('[data-field=\"timeoutMs\"]').value || 60000) : 60000
  }, index));
}
function renderFallbackTargets() {
  if (!els.fallbackTargets || !els.fallbackEmpty) {
    return;
  }

  // 记录当前已展开的卡片，其余默认折叠
  const expandedIds = new Set();
  if (els.fallbackTargets) {
    els.fallbackTargets.querySelectorAll('[data-fallback-item]:not([data-collapsed="true"])').forEach((el) => {
      const id = el.getAttribute('data-fallback-id');
      if (id) expandedIds.add(id);
    });
  }

  const targets = Array.isArray(fallbackDraft) ? fallbackDraft : [];
  els.fallbackEmpty.style.display = targets.length === 0 ? '' : 'none';
  els.fallbackTargets.innerHTML = targets.map((target, index) => {
    const protocolLabel = target.protocol === 'anthropic'
      ? 'Anthropic Messages'
      : (target.protocol === 'openai-chat-completions'
        ? 'OpenAI Chat Completions'
        : (target.protocol === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI Auto'));
    const enabledAttr = target.enabled ? 'true' : 'false';
    // 默认折叠，只有已明确展开过的保持展开
    const collapsed = expandedIds.has(target.id) ? '' : ' data-collapsed="true"';
    return '<section class="fallbackCard" data-fallback-item data-fallback-id="' + escapeInline(target.id) + '" data-enabled="' + enabledAttr + '"' + collapsed + '>'
      + '<div class="fallbackCardHeader" data-toggle-collapse="' + escapeInline(target.id) + '" style="cursor:pointer">'
      + '<span class="fallbackCardIndex">' + (index + 1) + '</span>'
      + '<div class="fallbackCardTitle">'
      + '<strong>' + escapeInline(target.name || ('渠道 ' + (index + 1))) + '</strong>'
      + '<span class="pill ' + (target.enabled ? 'current' : 'warn') + '">' + (target.enabled ? '启用' : '停用') + '</span>'
      + '<span class="fallbackCardMeta">' + protocolLabel + ' · 优先级 ' + (index + 1) + '</span>'
      + '</div>'
      + '<div class="fallbackCardActions">'
      + '<label class="toggleRow" title="参与兜底顺序"><input data-field="enabled" type="checkbox"' + (target.enabled ? ' checked' : '') + ' /><span>' + (target.enabled ? '启用' : '停用') + '</span></label>'
      + '<button class="btn" type="button" data-move-up-fallback="' + escapeInline(target.id) + '"' + (index === 0 ? ' disabled' : '') + '>↑ 上移</button>'
      + '<button class="btn" type="button" data-move-down-fallback="' + escapeInline(target.id) + '"' + (index === targets.length - 1 ? ' disabled' : '') + '>↓ 下移</button>'
      + '<button class="btn" type="button" data-test-fallback="' + escapeInline(target.id) + '">⚡ 测试</button>'
      + '<button class="btn warn" type="button" data-delete-fallback="' + escapeInline(target.id) + '">✕ 删除</button>'
      + '<button class="fallbackCollapseBtn" type="button" data-collapse-fallback="' + escapeInline(target.id) + '" title="折叠/展开">▼</button>'
      + '</div>'
      + '</div>'
      + '<div class="fallbackCardBody">'
      + '<div class="settingsGrid">'
      + '<div class="field"><label>名称</label><input data-field="name" type="text" value="' + escapeInline(target.name) + '" placeholder="渠道 1" autocomplete="off" /></div>'
      + '<div class="field"><label>协议</label><select data-field="protocol"><option value="openai"' + (target.protocol === 'openai' ? ' selected' : '') + '>OpenAI Auto</option><option value="openai-chat-completions"' + (target.protocol === 'openai-chat-completions' ? ' selected' : '') + '>OpenAI Chat Completions</option><option value="openai-responses"' + (target.protocol === 'openai-responses' ? ' selected' : '') + '>OpenAI Responses</option><option value="anthropic"' + (target.protocol === 'anthropic' ? ' selected' : '') + '>Anthropic Messages</option></select></div>'
      + '<div class="field wide"><label>Base URL</label><input data-field="baseUrl" type="text" value="' + escapeInline(target.baseUrl) + '" placeholder="https://your-upstream-host/v1" autocomplete="off" /></div>'
      + '<div class="field wide"><label>API Key</label><div class="inputWrap"><input data-field="apiKey" type="password" value="' + escapeInline(target.apiKey) + '" placeholder="sk-..." autocomplete="off" autocapitalize="off" spellcheck="false" /><button class="inputToggle" type="button" data-toggle-secret="' + escapeInline(target.id) + '" aria-label="显示 API Key" title="显示或隐藏 API Key">👁</button></div></div>'
      + '<div class="field"><label>Model</label><input data-field="model" type="text" value="' + escapeInline(target.model) + '" placeholder="gpt-4.1-mini" autocomplete="off" /></div>'
      + '<div class="field wide"><label>供应模型</label><input data-field="supportedModels" type="text" value="' + escapeInline(target.supportedModels) + '" placeholder="claude-sonnet-4-6, gpt-5.4" autocomplete="off" /></div>'
      + '<div class="field"><label>默认推理级别</label><select data-field="reasoningEffort"><option value=""' + (!target.reasoningEffort ? ' selected' : '') + '>自动</option><option value="low"' + (target.reasoningEffort === 'low' ? ' selected' : '') + '>low</option><option value="medium"' + (target.reasoningEffort === 'medium' ? ' selected' : '') + '>medium</option><option value="high"' + (target.reasoningEffort === 'high' ? ' selected' : '') + '>high</option></select></div>'
      + '<div class="field"><label>Anthropic Version</label><input data-field="anthropicVersion" type="text" value="' + escapeInline(target.anthropicVersion || '2023-06-01') + '" placeholder="2023-06-01" autocomplete="off" /></div>'
      + '<div class="field"><label>Timeout (ms)</label><input data-field="timeoutMs" type="number" min="1000" step="1000" value="' + escapeInline(String(target.timeoutMs || 60000)) + '" /></div>'
      + '</div>'
      + '</div>'
      + '</section>';
  }).join('');
}
function renderSettings(data) {
  const targets = data && data.settings && data.settings.fallbacks && Array.isArray(data.settings.fallbacks.targets)
    ? data.settings.fallbacks.targets
    : [];
  fallbackDraft = targets.map((target, index) => normalizeFallbackDraftTarget(target, index));
  renderFallbackTargets();
  const enabledTargets = fallbackDraft.filter((target) => target.enabled !== false && target.baseUrl && target.apiKey && target.model);
  if (els.fallbackStatus) els.fallbackStatus.textContent = enabledTargets.length > 0
    ? ('已配置 ' + enabledTargets.length + ' 条 · 首选 ' + (enabledTargets[0].name || enabledTargets[0].model || 'external-upstream'))
    : '未配置';
  if (els.fallbackEnvPath) els.fallbackEnvPath.textContent = data && data.bridge && data.bridge.envPath ? data.bridge.envPath : '.env';
}

function renderSnapshots(data) {
  const snapshots = data.snapshots || [];
  const currentUserId = data.gateway && data.gateway.user && data.gateway.user.id ? String(data.gateway.user.id) : '';
  const activeAccountId = data && data.authRuntime && data.authRuntime.activeAccount ? String(data.authRuntime.activeAccount) : '';
  const standby = data && data.accountStandby ? data.accountStandby : null;
  const standbyByAccountId = new Map(
    [
      ...(Array.isArray(standby && standby.candidates) ? standby.candidates : []),
      ...(Array.isArray(standby && standby.cooldownCandidates) ? standby.cooldownCandidates : [])
    ]
      .filter((item) => item && item.accountId)
      .map((item) => [String(item.accountId), item])
  );
  if (snapshots.length === 0) {
    els.snapshotList.innerHTML = '<div class="empty"><span class="empty-icon">📋</span>还没有已记录账号。点击左侧"添加账号登录"完成第一个 Accio 登录吧！</div>';
    return;
  }

  els.snapshotList.innerHTML = snapshots.map((item) => {
    const userId = item.gatewayUser && item.gatewayUser.id ? String(item.gatewayUser.id) : '';
    const userName = item.gatewayUser && item.gatewayUser.name ? String(item.gatewayUser.name) : '';
    const aliasText = item.alias ? String(item.alias) : '';
    const aliasDisplay = simplifySnapshotAliasLabel(aliasText);
    const sameIdentityLabel = userName && userId && userName === userId;
    const displayName = userName || userId || aliasDisplay || item.alias;
    const subLabel = userName && userId && !sameIdentityLabel ? userId : '';
    const redundantAlias = Boolean(aliasText && (
      (userId && (
        aliasText === ('acct-' + userId) ||
        aliasText === ('acct-' + userId + '-' + userId)
      )) ||
      aliasText === displayName ||
      aliasDisplay === displayName
    ));
    const avatarChar = displayName ? displayName.charAt(0).toUpperCase() : '?';
    const accountState = item.accountState || null;
    const current = currentUserId && userId && currentUserId === userId;
    const active = activeAccountId && accountState && String(accountState.id || '') === activeAccountId;
    const itemClass = current || active ? 'item current-item' : 'item';
    const statusPill = item.hasFullAuthState && item.hasAuthCallback
      ? '<span class="pill current">完整</span>'
      : (!item.hasFullAuthState ? '<span class="pill warn">轻量凭证</span>' : '<span class="pill warn">仅文件</span>');
    const canActivate = item.canActivate !== false;
    const quota = item.quota || null;
    const quotaStatus = quota && quota.available && typeof quota.usagePercent === 'number'
      ? ('已用 ' + Math.round(quota.usagePercent) + '%')
      : (quota && quota.error === 'missing_auth_payload'
        ? '未知（缺少完整凭证）'
        : (quota && quota.error === 'quota_unverified_for_inactive_account'
          ? '待验证'
          : '未知'));
    const refreshStatus = quota && quota.available && typeof quota.refreshCountdownSeconds === 'number'
      ? formatCountdown(quota.refreshCountdownSeconds)
      : '未知';
    const quotaMeta = quota && quota.checkedAt
      ? ((quota.stale ? '上次确认：' : '实时更新：') + formatTime(quota.checkedAt))
      : (quota && quota.stale ? '未切换到该账号，未做实时查询' : '');
    const cooling = accountState && typeof accountState.invalidUntil === 'number' && accountState.invalidUntil > Date.now();
    const cooldownSeconds = cooling ? Math.max(0, Math.ceil((accountState.invalidUntil - Date.now()) / 1000)) : 0;
    const standbyEntry = accountState && accountState.id ? standbyByAccountId.get(String(accountState.id)) : null;
    const standbyStatus = accountState
      ? (
          standbyEntry && standbyEntry.nextCheckAt
            ? ('冷却中，预计 ' + formatTime(standbyEntry.nextCheckAt) + ' 恢复')
            : standbyEntry
            ? ('已就位 #' + String(standbyEntry.order || 1))
            : (cooling ? ('冷却中，约 ' + formatCountdown(cooldownSeconds) + ' 后恢复') : '待下一轮预检')
        )
      : '未关联账号条目';
    const lastFailure = standbyEntry && standbyEntry.reason
      ? escapeInline(standbyEntry.reason)
      : (accountState && accountState.lastFailure && accountState.lastFailure.reason
        ? escapeInline(accountState.lastFailure.reason)
        : '')
    ;
    const standbyMeta = standbyEntry && standbyEntry.quotaCheckedAt
      ? (
          standbyEntry.nextCheckAt
            ? ('上次检查于 ' + formatTime(standbyEntry.quotaCheckedAt))
            : ('预检于 ' + formatTime(standbyEntry.quotaCheckedAt))
        )
      : '';
    return '<div class="' + itemClass + '">'
      + '<div class="itemAvatar">' + avatarChar + '</div>'
      + '<div class="itemTitleRow">'
      + '<h3 class="itemTitle">' + displayName + '</h3>'
      + (current ? '<span class="pill current">当前</span>' : '')
      + (active ? '<span class="pill current">默认</span>' : '')
      + statusPill
      + '</div>'
      + (subLabel ? '<div class="itemMeta">' + subLabel + '</div>' : '')
      + (!redundantAlias ? '<div class="itemMeta">' + item.alias + '</div>' : '')
      + (active ? '<div class="itemMeta">Bridge 默认账号：后续额度请求将优先使用该账号</div>' : '')
      + '<div class="itemMeta">' + formatTime(item.capturedAt) + ' &middot; ' + String(item.artifactCount || 0) + ' 个文件</div>'
      + '<div class="itemMeta">额度状态：' + quotaStatus + '</div>'
      + '<div class="itemMeta">刷新时间：' + refreshStatus + '</div>'
      + (quotaMeta ? '<div class="itemMeta hint">' + quotaMeta + '</div>' : '')
      + '<div class="itemMeta">等待区：' + standbyStatus + '</div>'
      + (standbyMeta ? '<div class="itemMeta hint">' + standbyMeta + '</div>' : '')
      + (cooling ? '<div class="itemMeta">恢复时间：' + formatTime(accountState.invalidUntil) + '</div>' : '')
      + (lastFailure ? '<div class="itemMeta hint">最近失败：' + lastFailure + '</div>' : '')
      + (!item.hasAuthCallback ? '<div class="itemMeta hint">缺少原生回调，建议重新登录</div>' : '')
      + (!canActivate ? '<div class="itemMeta hint">该快照缺少完整登录槽位，不能直接切换。</div>' : '')
      + '<div class="itemSpacer"></div>'
      + '<div class="actionRow"><button class="btn" data-activate-snapshot="' + item.alias + '"' + (canActivate ? '' : ' disabled title="请重新登录该账号后重新保存"') + '>' + (canActivate ? '切换' : '需补全') + '</button><button class="btn" data-delete-snapshot="' + item.alias + '">删除</button></div>'
      + '</div>';
  }).join('');
}
function renderQuotaBar(data) {
  const badge = document.getElementById('status-badge');
  const fill = document.getElementById('badge-fill');
  const quotaSpan = document.getElementById('badge-quota');
  if (!badge || !fill || !quotaSpan) return;

  const activity = data && data.recentActivity ? data.recentActivity : null;
  const isDirectLlm = activity && activity.transportSelected === 'direct-llm';
  const snapshot = data && data.currentSnapshot ? data.currentSnapshot : null;
  const quota = snapshot && snapshot.quota && snapshot.quota.available ? snapshot.quota : null;

  if (!isDirectLlm || !quota || typeof quota.usagePercent !== 'number') {
    badge.classList.remove('quota-active');
    fill.style.width = '0%';
    fill.removeAttribute('data-level');
    quotaSpan.textContent = '';
    return;
  }

  const used = Math.min(100, Math.max(0, quota.usagePercent));
  const remaining = 100 - used;
  let level = 'full';
  if (remaining <= 0) level = 'empty';
  else if (remaining <= 15) level = 'low';
  else if (remaining <= 40) level = 'mid';

  fill.style.width = remaining + '%';
  if (level === 'full') { fill.removeAttribute('data-level'); }
  else { fill.setAttribute('data-level', level); }

  quotaSpan.textContent = Math.round(remaining) + '%';
  if (level === 'full') { quotaSpan.removeAttribute('data-level'); }
  else { quotaSpan.setAttribute('data-level', level); }

  badge.classList.add('quota-active');
}
function renderState(data, options = {}) {
  const recentActivity = data && data.recentActivity ? data.recentActivity : null;
  const [dotClass, summary] = recentActivityBadge(recentActivity, data);
  els.gatewayDot.className = 'dot ' + dotClass;
  els.gatewaySummary.textContent = summary;
  renderQuotaBar(data);
  renderKv(els.overviewKv, [
    ['最近请求', describeRecentActivityCompact(recentActivity)],
    ['等待区', describeStandbyCompact(data)],
    ['默认账号', describeActiveAccountCompact(data)],
    ['账号池', describeAuthPoolCompact(data)],
    ['Bridge 状态', describeBridgeCompact(data)]
  ]);
  renderSnapshots(data);
  if (options.allowSettings !== false) {
    renderSettings(data);
  }
}
async function refreshState(message) {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const payload = await api('/admin/api/state?fresh=1');
      renderState(payload);
      return payload;
    })();
  }

  try {
    const payload = await refreshInFlight;
    if (message) setMessage('ok', message);
    return payload;
  } finally {
    refreshInFlight = null;
  }
}
async function withAction(button, fn) {
  const prev = button.textContent;
  button.disabled = true;
  button.classList.add('loading');
  try { await fn(); } finally { button.disabled = false; button.classList.remove('loading'); button.textContent = prev; }
}

async function sendDesktopCommand(command, params = {}) {
  if (!isElectronShell) {
    return false;
  }

  if (desktopBridge && command === 'launch-accio' && typeof desktopBridge.launchAccio === 'function') {
    await desktopBridge.launchAccio(params);
    return true;
  }

  const search = new URLSearchParams(params);
  const target = 'accio-bridge://' + command + (search.toString() ? ('?' + search.toString()) : '');
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

async function waitForGatewayUser(expectedUserId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    const payload = await api('/admin/api/state');
    lastState = payload;
    renderState(payload);

    const currentUserId = payload && payload.gateway && payload.gateway.user && payload.gateway.user.id
      ? String(payload.gateway.user.id)
      : '';

    if (currentUserId && (!expectedUserId || currentUserId === String(expectedUserId))) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return lastState;
}

let activeLoginFlowId = null;

function setAccountLoginPendingState(pending) {
  if (els.accountLoginBtn) {
    els.accountLoginBtn.disabled = Boolean(pending);
    els.accountLoginBtn.classList.toggle('loading', Boolean(pending));
    els.accountLoginBtn.textContent = pending ? '等待登录完成...' : '\uFF0B 添加账号登录';
  }

  if (els.cancelAccountLoginBtn) {
    els.cancelAccountLoginBtn.style.display = pending ? '' : 'none';
    els.cancelAccountLoginBtn.disabled = false;
    els.cancelAccountLoginBtn.classList.remove('loading');
  }
}

async function pollAccountLogin(flowId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastState = '';
  let refreshCountdown = 0;
  while (Date.now() < deadline) {
    const payload = await api('/admin/api/accounts/login-status?flowId=' + encodeURIComponent(flowId));

    if (payload.gatewayState) {
      const currentText = payload.gatewayState.userId
        ? (payload.gatewayState.userId + (payload.gatewayState.userName ? ' (' + payload.gatewayState.userName + ')' : ''))
        : (payload.gatewayState.authenticated ? '已登录但未返回用户ID' : '未登录');
      renderKv(els.overviewKv, [
        ['当前识别账号', currentText],
        ['已记录账号', els.snapshotList.children ? (String(els.snapshotList.children.length) + ' 个已记录快照') : '—'],
        ['登录进度', payload.message || '等待登录完成']
      ]);
    }

    if (payload.completed) {
      return payload;
    }

    if (payload.state && payload.state !== lastState) {
      const detail = payload.currentUserId ? (' 当前识别账号: ' + payload.currentUserId) : '';
      setMessage(payload.state === 'waiting_new_account' ? 'warn' : 'info', (payload.message || '等待登录状态更新。') + detail);
      lastState = payload.state;
    }

    refreshCountdown += 1;
    if (refreshCountdown >= 3) {
      refreshCountdown = 0;
      refreshState().catch(() => {});
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('等待新账号登录超时。');
}

async function observeAccountLogin(flowId) {
  try {
    const result = await pollAccountLogin(flowId);
    await refreshState();
    if (result && result.state === 'login_failed') {
      setMessage('error', result.note || '桥接层未能完成账号接管。');
    } else if (result && result.state === 'same_account_returned') {
      setMessage('warn', result.note || '你登录回了当前账号，没有新增账号。');
    } else {
      setMessage('ok', (result && result.note) || ('新账号已记录：' + ((result && result.alias) || 'acct-auto')));
    }
  } catch (error) {
    if (!cancelledLoginFlows.has(flowId)) {
      setMessage('error', error && error.message ? error.message : String(error));
    }
  } finally {
    cancelledLoginFlows.delete(flowId);
    if (activeLoginFlowId === flowId) {
      activeLoginFlowId = null;
      setAccountLoginPendingState(false);
    }
  }
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    switchTab(button.getAttribute('data-tab'));
    if (currentTab === 'accounts') {
      refreshState().catch(() => {});
    }
  });
});

function connectStateStream() {
  if (typeof EventSource === 'undefined') {
    return;
  }

  if (stateStream) {
    stateStream.close();
  }

  stateStream = new EventSource('/admin/api/events');
  stateStream.addEventListener('state', (event) => {
    try {
      const payload = JSON.parse(event.data);
      renderState(payload, { allowSettings: currentTab !== 'settings' });
    } catch (_) {}
  });
  stateStream.addEventListener('state_error', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (currentTab === 'accounts') {
        setMessage('error', (payload && payload.message) || '状态流更新失败。');
      }
    } catch (_) {}
  });
  stateStream.addEventListener('log', (event) => {
    try {
      const payload = JSON.parse(event.data);
      appendLogEntry(payload);
      logsLoaded = true;
      setLogStatus('实时日志流已连接');
    } catch (_) {}
  });
}

els.refreshBtn.addEventListener('click', async () => {
  els.refreshBtn.classList.add('spinning');
  clearMessage();
  try { await refreshState('界面状态已刷新。'); } catch (e) { setMessage('error', e.message || String(e)); }
  els.refreshBtn.classList.remove('spinning');
});
if (els.refreshLogsBtn) {
  els.refreshLogsBtn.addEventListener('click', () => withAction(els.refreshLogsBtn, async () => {
    await refreshLogs();
  }).catch((error) => {
    setLogStatus((error && error.message) || String(error));
  }));
}
if (els.toggleLogFollowBtn) {
  els.toggleLogFollowBtn.addEventListener('click', () => {
    logFollow = !logFollow;
    updateLogMeta();
    if (logFollow) {
      requestAnimationFrame(() => scrollLogsToBottom());
    }
  });
}
els.accountLoginBtn.addEventListener('click', async () => {
  if (activeLoginFlowId) {
    setMessage('info', '当前已有一个账号登录流程在等待完成。你可以继续完成登录，或点击“放弃本次登录”。');
    return;
  }

  clearMessage();
  setAccountLoginPendingState(true);

  try {
    const payload = await api('/admin/api/accounts/login', { method: 'POST', body: {} });
    if (!payload.loginUrl) {
      throw new Error('未收到登录链接。');
    }

    activeLoginFlowId = payload.flowId;
    const preservedNote = payload.preservedAlias
      ? (' 当前账号快照已预先记录/刷新：' + payload.preservedAlias + '。')
      : '';
    setMessage(payload.loginOpened ? 'info' : 'warn', (payload.loginOpened
      ? '已在本机打开 Accio 登录页。完成新账号登录后，系统会自动记录到列表；如果不继续，可以点击“放弃本次登录”。'
      : '登录流程已创建，但本机未能自动打开登录页，请手动使用返回的链接完成登录；如果不继续，可以点击“放弃本次登录”。') + preservedNote);
    observeAccountLogin(payload.flowId);
  } catch (error) {
    activeLoginFlowId = null;
    setAccountLoginPendingState(false);
    setMessage('error', error && error.message ? error.message : String(error));
  }
});
if (els.cancelAccountLoginBtn) {
  els.cancelAccountLoginBtn.addEventListener('click', () => withAction(els.cancelAccountLoginBtn, async () => {
    const flowId = activeLoginFlowId;
    if (!flowId) {
      setAccountLoginPendingState(false);
      setMessage('info', '当前没有进行中的登录流程。');
      return;
    }

    clearMessage();
    cancelledLoginFlows.add(flowId);
    activeLoginFlowId = null;
    await api('/admin/api/accounts/login/cancel', { method: 'POST', body: { flowId } });
    setAccountLoginPendingState(false);
    setMessage('warn', '已放弃本次登录，你现在可以重新发起登录。');
  }).catch((error) => {
    setMessage('error', error && error.message ? error.message : String(error));
  }));
}
document.addEventListener('click', async (event) => {
  const activate = event.target.closest('[data-activate-snapshot]');
  if (activate) {
    const alias = activate.getAttribute('data-activate-snapshot');
    await withAction(activate, async () => {
      clearMessage();
      const payload = await api('/admin/api/snapshots/activate', { method: 'POST', body: { alias } });
      await refreshState();

      if (payload && payload.manualRelaunchRequired && payload.expectedUserId && isElectronShell) {
        await sendDesktopCommand('launch-accio');
        setMessage('warn', '快照已恢复，正在通过桌面壳拉起 Accio，并等待目标账号上线...');
        const state = await waitForGatewayUser(payload.expectedUserId, 30000);
        const currentUserId = state && state.gateway && state.gateway.user && state.gateway.user.id
          ? String(state.gateway.user.id)
          : '';

        if (currentUserId && currentUserId === String(payload.expectedUserId)) {
          setMessage('ok', 'Accio 已重新打开，当前账号已切换到 ' + currentUserId + '。');
        } else {
          setMessage('warn', payload.note || '快照已恢复，但仍未确认目标账号。请手动打开 Accio 后再刷新状态。');
        }
        return;
      }

      setMessage(payload && payload.switched ? 'ok' : 'warn', payload.note || ('已切换到账号 ' + alias + '。'));
    });
    return;
  }

  const remove = event.target.closest('[data-delete-snapshot]');
  if (!remove) {
    return;
  }

  const aliasToDelete = remove.getAttribute('data-delete-snapshot');
  if (remove.dataset.confirmDelete) {
    delete remove.dataset.confirmDelete;
    await withAction(remove, async () => {
      clearMessage();
      const payload = await api('/admin/api/snapshots/delete', {
        method: 'POST',
        body: { alias: aliasToDelete, deleteCredential: true }
      });
      await refreshState();
      setMessage(
        'ok',
        payload && payload.deletedCredential
          ? ('已删除账号快照和号池凭证：' + aliasToDelete)
          : ('已删除账号快照：' + aliasToDelete)
      );
    });
    return;
  }

  remove.dataset.confirmDelete = '1';
  const prevText = remove.textContent;
  remove.textContent = '删快照+凭证？';
  remove.classList.add('danger-confirm');
  setTimeout(() => {
    if (remove.dataset.confirmDelete) {
      delete remove.dataset.confirmDelete;
      remove.textContent = prevText;
      remove.classList.remove('danger-confirm');
    }
  }, 3000);
});
if (els.addFallbackTargetBtn) {
  els.addFallbackTargetBtn.addEventListener('click', () => {
    fallbackDraft = collectFallbackDraft();
    fallbackDraft.push(createFallbackDraftTarget(fallbackDraft.length));
    renderFallbackTargets();
  });
}

if (els.saveFallbackConfigBtn) {
  els.saveFallbackConfigBtn.addEventListener('click', () => withAction(els.saveFallbackConfigBtn, async () => {
    clearConfigMessage();
    fallbackDraft = collectFallbackDraft();
    const payload = await api('/admin/api/config', {
      method: 'POST',
      body: {
        fallbacks: {
          targets: fallbackDraft
        }
      }
    });
    renderSettings({ settings: payload.settings, bridge: payload.bridge });
    setConfigMessage('ok', '多渠道上游配置已保存并立即生效。');
  }));
}

if (els.reloadFallbackConfigBtn) {
  els.reloadFallbackConfigBtn.addEventListener('click', () => withAction(els.reloadFallbackConfigBtn, async () => {
    clearConfigMessage();
    const payload = await api('/admin/api/config');
    renderSettings({ settings: payload.settings, bridge: payload.bridge });
    setConfigMessage('info', '已重新载入当前多渠道配置。');
  }));
}

if (els.fallbackTargets) {
  els.fallbackTargets.addEventListener('click', async (event) => {
    // 折叠/展开（按钮或整个 header 点击）
    const collapseBtn = event.target.closest('[data-collapse-fallback]');
    const collapseHeader = !collapseBtn && event.target.closest('[data-toggle-collapse]');
    if (collapseBtn || collapseHeader) {
      // 如果是 header 点击但点到了 action 按钮区域，不触发折叠
      if (collapseHeader && event.target.closest('.fallbackCardActions')) {
        // fall through
      } else {
        const card = (collapseBtn || collapseHeader).closest('[data-fallback-item]');
        if (card) {
          const isCollapsed = card.getAttribute('data-collapsed') === 'true';
          card.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
        }
        if (collapseBtn) return;
      }
    }

    const toggle = event.target.closest('[data-toggle-secret]');
    if (toggle) {
      const input = toggle.closest('.inputWrap') ? toggle.closest('.inputWrap').querySelector('input[data-field="apiKey"]') : null;
      if (input) {
        const nextVisible = input.type === 'password';
        input.type = nextVisible ? 'text' : 'password';
        toggle.textContent = nextVisible ? '🙈' : '👁';
        toggle.setAttribute('aria-label', nextVisible ? '隐藏 API Key' : '显示 API Key');
        toggle.setAttribute('title', nextVisible ? '隐藏 API Key' : '显示或隐藏 API Key');
      }
      return;
    }

    const remove = event.target.closest('[data-delete-fallback]');
    if (remove) {
      const targetId = remove.getAttribute('data-delete-fallback');
      if (remove.dataset.confirmDeleteFallback) {
        delete remove.dataset.confirmDeleteFallback;
        fallbackDraft = collectFallbackDraft().filter((target) => target.id !== targetId);
        renderFallbackTargets();
        setConfigMessage('ok', '已删除上游渠道。记得保存配置以生效。');
        return;
      }

      remove.dataset.confirmDeleteFallback = '1';
      const prevText = remove.textContent;
      remove.textContent = '确认删除？';
      remove.classList.add('danger-confirm');
      setTimeout(() => {
        if (remove.dataset.confirmDeleteFallback) {
          delete remove.dataset.confirmDeleteFallback;
          remove.textContent = prevText;
          remove.classList.remove('danger-confirm');
        }
      }, 3000);
      return;
    }

    const moveUp = event.target.closest('[data-move-up-fallback]');
    if (moveUp) {
      const id = moveUp.getAttribute('data-move-up-fallback');
      fallbackDraft = collectFallbackDraft();
      const index = fallbackDraft.findIndex((target) => target.id === id);
      if (index > 0) {
        const temp = fallbackDraft[index - 1];
        fallbackDraft[index - 1] = fallbackDraft[index];
        fallbackDraft[index] = temp;
        renderFallbackTargets();
      }
      return;
    }

    const moveDown = event.target.closest('[data-move-down-fallback]');
    if (moveDown) {
      const id = moveDown.getAttribute('data-move-down-fallback');
      fallbackDraft = collectFallbackDraft();
      const index = fallbackDraft.findIndex((target) => target.id === id);
      if (index >= 0 && index < fallbackDraft.length - 1) {
        const temp = fallbackDraft[index + 1];
        fallbackDraft[index + 1] = fallbackDraft[index];
        fallbackDraft[index] = temp;
        renderFallbackTargets();
      }
      return;
    }

    const testBtn = event.target.closest('[data-test-fallback]');
    if (testBtn) {
      const id = testBtn.getAttribute('data-test-fallback');
      fallbackDraft = collectFallbackDraft();
      const target = fallbackDraft.find((item) => item.id === id);
    if (!target) {
      return;
    }
      await withAction(testBtn, async () => {
        clearConfigMessage();
        const payload = await api('/admin/api/config/test', {
          method: 'POST',
          body: { target }
        });
        const result = payload && payload.result ? payload.result : {};
        const apiStyle = result.openaiApiStyle ? (' · ' + result.openaiApiStyle) : '';
        const preview = result.preview ? ('，返回预览：' + String(result.preview).slice(0, 80)) : '';
        setConfigMessage('ok', '连接成功：' + (target.name || '渠道') + ' · ' + (result.protocol || 'unknown') + apiStyle + ' · ' + (result.model || 'unknown') + preview);
      }).catch((error) => {
        setConfigMessage('error', error && error.message ? error.message : String(error));
      });
    }
  });

  els.fallbackTargets.addEventListener('change', (event) => {
    const enabledCheckbox = event.target.closest('[data-field="enabled"]');
    if (enabledCheckbox) {
      const card = enabledCheckbox.closest('[data-fallback-item]');
      if (card) {
        const checked = enabledCheckbox.checked;
        card.setAttribute('data-enabled', checked ? 'true' : 'false');
        // 更新 header pill
        const pill = card.querySelector('.fallbackCardTitle .pill');
        if (pill) {
          pill.textContent = checked ? '启用' : '停用';
          pill.className = 'pill ' + (checked ? 'current' : 'warn');
        }
        // 更新 toggleRow 文字
        const toggleSpan = enabledCheckbox.closest('.toggleRow') && enabledCheckbox.closest('.toggleRow').querySelector('span');
        if (toggleSpan) {
          toggleSpan.textContent = checked ? '启用' : '停用';
        }
      }
    }
  });
}

try {
  switchTab(localStorage.getItem('accio-admin-tab') || 'accounts');
} catch (_) {
  switchTab('accounts');
}

connectStateStream();
refreshState().catch((error) => setMessage('error', error.message || String(error)));
</script>
</body>
</html>`;
}


async function handleAdminPage(req, res, config) {
  writeHtml(res, 200, renderAdminPage(config));
}

async function handleAdminState(req, res, config, authProvider, directClient, recentActivityStore) {
  const url = req && req.url ? new URL(req.url, "http://127.0.0.1") : null;
  const fresh = url && url.searchParams.get("fresh") === "1";
  writeJson(res, 200, await getSharedAdminState(config, authProvider, directClient, recentActivityStore, { fresh }));
}

async function handleAdminLogs(req, res) {
  const url = req && req.url ? new URL(req.url, "http://127.0.0.1") : null;
  const limit = url ? Number(url.searchParams.get("limit") || 200) : 200;
  writeJson(res, 200, {
    ok: true,
    entries: typeof log.getEntries === "function" ? log.getEntries(limit) : []
  });
}

let _sharedStateCache = { promise: null, ts: 0 };
const SHARED_STATE_TTL_MS = 8000;

function invalidateSharedAdminState() {
  _sharedStateCache = { promise: null, ts: 0 };
}

async function getSharedAdminState(config, authProvider, directClient, recentActivityStore, options = {}) {
  if (options && options.fresh) {
    invalidateSharedAdminState();
  }

  const now = Date.now();
  if (_sharedStateCache.promise && now - _sharedStateCache.ts < SHARED_STATE_TTL_MS) {
    return _sharedStateCache.promise;
  }
  const promise = buildAdminState(config, authProvider, directClient, recentActivityStore);
  _sharedStateCache = { promise, ts: now };
  return promise;
}

async function handleAdminEvents(req, res, config, authProvider, directClient, recentActivityStore) {
  res.writeHead(200, {
    ...ADMIN_CORS_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  let closed = false;
  let sending = false;

  const sendState = async () => {
    if (closed || sending || res.writableEnded || res.destroyed) {
      return;
    }

    sending = true;
    try {
      const payload = await buildAdminState(config, authProvider, directClient, recentActivityStore);
      if (!closed && !res.writableEnded && !res.destroyed) {
        writeSse(res, "state", payload);
      }
    } catch (error) {
      if (!closed && !res.writableEnded && !res.destroyed) {
        writeSse(res, "state_error", {
          message: error && error.message ? error.message : String(error)
        });
      }
    } finally {
      sending = false;
    }
  };

  const unsubscribeRecentActivity = recentActivityStore && typeof recentActivityStore.subscribe === "function"
    ? recentActivityStore.subscribe(() => {
        sendState().catch(() => {});
      })
    : () => {};
  const unsubscribeStandby = directClient && typeof directClient.subscribeStandby === "function"
    ? directClient.subscribeStandby(() => {
        sendState().catch(() => {});
      })
    : () => {};
  const unsubscribeLogs = typeof log.subscribe === "function"
    ? log.subscribe((entry) => {
        if (!closed && !res.writableEnded && !res.destroyed) {
          writeSse(res, "log", entry);
        }
      })
    : () => {};

  const stateTimer = setInterval(() => {
    sendState().catch(() => {});
  }, QUOTA_CACHE_TTL_MS);
  const pingTimer = setInterval(() => {
    if (!closed && !res.writableEnded && !res.destroyed) {
      writeSse(res, "ping", { ts: new Date().toISOString() });
    }
  }, 10000);

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(stateTimer);
    clearInterval(pingTimer);
    unsubscribeRecentActivity();
    unsubscribeStandby();
    unsubscribeLogs();
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  await sendState();
}

async function handleAdminConfigGet(req, res, config) {
  const settings = getFallbackSettings(config);
  writeJson(res, 200, {
    ok: true,
    settings: {
      fallbacks: {
        targets: settings.targets.map((t) => ({ ...t, apiKey: maskToken(t.apiKey) }))
      }
    },
    bridge: {
      envPath: config.envPath || path.join(process.cwd(), ".env")
    }
  });
}

async function handleAdminConfigSave(req, res, config, fallbackPool) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const fallbacks = body && body.fallbacks && typeof body.fallbacks === "object"
    ? body.fallbacks
    : {};

  const nextSettings = applyFallbackSettings(config, fallbackPool, {
    targets: Array.isArray(fallbacks.targets) ? fallbacks.targets : []
  });
  const primary = nextSettings.normalizedTargets[0] || null;

  const envPath = config.envPath || path.join(process.cwd(), ".env");
  upsertEnvValues(envPath, {
    ACCIO_FALLBACKS_JSON: JSON.stringify(nextSettings.targets),
    ACCIO_FALLBACK_OPENAI_BASE_URL: primary ? primary.baseUrl : "",
    ACCIO_FALLBACK_OPENAI_API_KEY: primary ? primary.apiKey : "",
    ACCIO_FALLBACK_OPENAI_MODEL: primary ? primary.model : "",
    ACCIO_FALLBACK_PROTOCOL: primary ? primary.protocol : "openai",
    ACCIO_FALLBACK_ANTHROPIC_VERSION: primary ? primary.anthropicVersion : "2023-06-01",
    ACCIO_FALLBACK_OPENAI_TIMEOUT_MS: String(primary ? primary.timeoutMs : 60000)
  });

  log.info("admin fallback settings updated", {
    envPath,
    fallbackCount: nextSettings.targets.length,
    fallbackProtocol: primary ? primary.protocol : null,
    fallbackModel: primary ? (primary.model || null) : null
  });

  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    saved: true,
    settings: {
      fallbacks: nextSettings
    },
    bridge: {
      envPath
    }
  });
}

async function handleAdminConfigTest(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const target = body && body.target && typeof body.target === "object"
    ? normalizeFallbackTarget(body.target, 0)
    : normalizeFallbackTarget({}, 0);

  const probeClient = new ExternalFallbackClient({
    ...target,
    fetchImpl: fetch
  });

  if (!probeClient.isConfigured()) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "请先填写完整的协议、Base URL、API Key 和 Model。"
      }
    });
    return;
  }

  try {
    const result = await probeClient.probe();
    log.info("admin fallback settings tested", {
      fallbackName: target.name,
      fallbackProtocol: result.protocol,
      fallbackTransport: result.transport,
      fallbackModel: result.model || null
    });

    writeJson(res, 200, {
      ok: true,
      tested: true,
      result
    });
  } catch (error) {
    const status = Number(error && error.status ? error.status : 502) || 502;
    writeJson(res, status, {
      ok: false,
      error: {
        type: error && error.type ? error.type : "api_error",
        message: error && error.message ? error.message : String(error)
      },
      details: error && error.details ? error.details : null
    });
  }
}

async function handleAdminSnapshotCreate(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const gateway = await readGatewayState(config.baseUrl);
  const alias = body && body.alias ? String(body.alias).trim() : deriveSnapshotAliasFromGatewayUser(gateway.user || null);
  const result = snapshotActiveCredentials(alias, { gatewayUser: gateway.user || null });
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    dir: result.dir,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt
  });
}

async function handleAdminSnapshotActivate(req, res, config, gatewayManager) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }

  const gatewayBefore = await readGatewayState(config.baseUrl);
  const snapshotEntry = getSnapshotEntry(alias);
  if (!snapshotEntry) {
    writeJson(res, 404, { error: { type: "not_found_error", message: `snapshot not found for alias: ${alias}` } });
    return;
  }
  const preferArtifactRestore = hasSnapshotArtifactState(snapshotEntry);
  const resolvedAuth = resolveSnapshotAuthPayload(alias, config.accountsPath);
  const authPayload = resolvedAuth.payload;
  const authPayloadSource = resolvedAuth.source;
  log.info("snapshot switch requested", {
    alias,
    gatewayBefore: summarizeGatewayState(gatewayBefore),
    preferArtifactRestore,
    hasAuthCallback: Boolean(authPayload),
    authPayloadSource: authPayloadSource || null
  });

  const canReplayAuthCallback = hasReplayableAuthPayload(authPayload);
  const expectedUserId = authPayload && authPayload.user && authPayload.user.id
    ? String(authPayload.user.id)
    : (snapshotEntry.metadata && snapshotEntry.metadata.gatewayUser && snapshotEntry.metadata.gatewayUser.id
      ? String(snapshotEntry.metadata.gatewayUser.id)
      : "");

  if (!canReplayAuthCallback) {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "该账号缺少可刷新的完整凭证，无法切换为 bridge 默认账号。请重新登录该账号后重新保存。"
      }
    });
    return;
  }

  let primedAuthPayload;
  try {
    primedAuthPayload = await refreshAuthPayloadViaUpstream(config, authPayload, {
      alias,
      previousUserId: extractGatewayUserId(gatewayBefore) || null
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log.warn("snapshot switch upstream refresh failed", {
      alias,
      error: message,
      expectedUserId: expectedUserId || null
    });
    writeJson(res, 502, {
      ok: false,
      alias,
      error: {
        type: "upstream_refresh_failed",
        message: `未能刷新目标账号凭证：${message}`
      }
    });
    return;
  }

  const boundUserId = primedAuthPayload && primedAuthPayload.refreshBoundUserId
    ? String(primedAuthPayload.refreshBoundUserId)
    : "";
  if (expectedUserId && boundUserId && boundUserId !== expectedUserId) {
    log.info("snapshot switch upstream refresh returned alternate user namespace", {
      alias,
      expectedUserId,
      boundUserId
    });
  }

  const refreshedAuth = {
    ...primedAuthPayload,
    user: primedAuthPayload.user || (authPayload && authPayload.user) || (snapshotEntry.metadata && snapshotEntry.metadata.gatewayUser) || null,
    source: "bridge-direct-login"
  };

  writeSnapshotAuthPayload(alias, refreshedAuth);
  writeAccountToFile(config.accountsPath, alias, refreshedAuth.accessToken, {
    user: refreshedAuth.user,
    expiresAtMs: refreshedAuth.expiresAtMs,
    expiresAtRaw: refreshedAuth.expiresAtRaw,
    refreshToken: refreshedAuth.refreshToken,
    cookie: refreshedAuth.cookie,
    source: "bridge-direct-login",
    authPayload: refreshedAuth
  });
  setActiveAccountInFile(config.accountsPath, alias);

  log.info("snapshot switch completed without gateway sync", {
    alias,
    expectedUserId: expectedUserId || null,
    authPayloadSource: authPayloadSource || null
  });
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    alias,
    switched: true,
    currentUserId: null,
    expectedUserId: expectedUserId || null,
    appRestarted: false,
    manualRelaunchRequired: false,
    usedAuthCallback: true,
    authPayloadSource: authPayloadSource || null,
    activeAccount: alias,
    switchStrategy: "bridge-only",
    note: "已切换 bridge 默认账号，未唤起 Accio。后续 direct-llm 请求会优先使用该账号。"
  });
}


async function handleAdminSnapshotDelete(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  const deleteCredential = !(body && body.deleteCredential === false);
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }
  const result = deleteSnapshot(alias);
  const accountRemoval = deleteCredential
    ? removeAccountFromFile(config.accountsPath, { alias })
    : { removed: false, path: config.accountsPath, removedAccounts: [] };
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    deletedCredential: Boolean(accountRemoval && accountRemoval.removed),
    accountsPath: accountRemoval && accountRemoval.path ? accountRemoval.path : config.accountsPath,
    removedAccounts: accountRemoval && Array.isArray(accountRemoval.removedAccounts) ? accountRemoval.removedAccounts : []
  });
}

async function handleAdminGatewayLogin(req, res, gatewayManager) {
  const payload = await requestGatewayJsonWithAutostart(gatewayManager, "/auth/login", { method: "POST", body: {} });
  writeJson(res, 200, { ok: true, loginUrl: payload && payload.loginUrl ? String(payload.loginUrl) : null });
}

async function handleAdminGatewayLogout(req, res, gatewayManager) {
  await requestGatewayJson(gatewayManager, "/auth/logout", { method: "POST", body: {} });
  invalidateSharedAdminState();
  writeJson(res, 200, { ok: true });
}

async function handleAdminCaptureAccount(req, res, config, gatewayManager) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = body && body.accountId ? String(body.accountId).trim() : "";
  if (!accountId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "accountId is required" } });
    return;
  }
  const result = await gatewayManager.waitForGatewayToken();
  const accountsPath = writeAccountToFile(config.accountsPath, accountId, result.token);
  invalidateSharedAdminState();
  writeJson(res, 200, { ok: true, accountId, accountsPath, tokenPreview: maskToken(result.token) });
}

async function handleAdminAccountLogin(req, res, config, gatewayManager) {
  await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});

  const flow = createPendingAccountLogin("", {});
  const callbackUrl = buildAccountLoginCallbackUrl(req, config, flow.id);
  const { loginUrl, state } = buildDirectLoginUrl(callbackUrl);
  let loginOpened = false;

  flow.loginUrl = loginUrl;
  flow.callbackUrl = callbackUrl;
  flow.loginState = state;

  if (loginUrl) {
    loginOpened = await openExternalUrl(loginUrl).catch(() => false);
  }

  log.info("direct login flow started", { flowId: flow.id, loginOpened });

  writeJson(res, 200, {
    ok: true,
    flowId: flow.id,
    previousUserId: null,
    preservedAlias: null,
    loginUrl,
    loginOpened
  });
}

async function handleAdminAccountCallback(req, res, config, url, gatewayManager) {
  const flowId = url.searchParams.get("flowId") ? String(url.searchParams.get("flowId")).trim() : "";
  if (!flowId) {
    writeHtml(res, 400, renderAccountCallbackPage("登录回调缺少 flowId", "请返回管理台重新发起“添加账号登录”。", "error"));
    return;
  }

  const flow = getPendingAccountLogin(flowId);
  if (!flow) {
    writeHtml(res, 404, renderAccountCallbackPage("登录流程已失效", "这个登录流程已经过期或不存在，请回到管理台重新发起。", "error"));
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    logPendingAccountLoginState(flow, "expired");
    deletePendingAccountLogin(flowId);
    writeHtml(res, 410, renderAccountCallbackPage("登录流程已过期", "请返回管理台重新发起“添加账号登录”。", "error"));
    return;
  }

  let authPayload;
  try {
    authPayload = extractAuthCallbackPayloadFromSearchParams(url.searchParams);
  } catch (error) {
    writeHtml(res, 400, renderAccountCallbackPage("登录参数不完整", error && error.message ? error.message : String(error), "error"));
    return;
  }

  flow.callbackReceivedAtMs = Date.now();
  flow.capturedAuth = authPayload;
  logPendingAccountLoginState(flow, "callback_received", {
    previousUserId: flow.previousUserId || null
  });

  try {
    const primedAuthPayload = await refreshAuthPayloadViaUpstream(config, authPayload, {
      flowId,
      previousUserId: flow.previousUserId || null
    });
    flow.capturedAuth = primedAuthPayload;

    const userId = primedAuthPayload.refreshBoundUserId || "";
    const user = userId ? { id: userId, name: userId } : null;
    const alias = deriveSnapshotAliasFromGatewayUser(user);
    const persistedAuth = {
      ...primedAuthPayload,
      user,
      source: "bridge-direct-login"
    };

    writeSnapshotAuthPayload(alias, persistedAuth);
    writeAccountToFile(config.accountsPath, alias, persistedAuth.accessToken, {
      user,
      expiresAtMs: persistedAuth.expiresAtMs,
      expiresAtRaw: persistedAuth.expiresAtRaw,
      source: "bridge-direct-login",
      authPayload: persistedAuth
    });

    let primedQuota = null;
    try {
      const snapshotEntry = getSnapshotEntry(alias);
      primedQuota = await primeSnapshotQuotaState(config, {
        alias,
        dir: snapshotEntry && snapshotEntry.dir ? snapshotEntry.dir : null,
        gatewayUser: user
      }, persistedAuth);
      log.info("direct login quota primed", {
        flowId,
        alias,
        userId: userId || null,
        available: primedQuota ? primedQuota.available === true : null,
        usagePercent: primedQuota && typeof primedQuota.usagePercent === "number"
          ? primedQuota.usagePercent
          : null
      });
    } catch (quotaError) {
      log.warn("direct login quota prime failed", {
        flowId,
        alias,
        userId: userId || null,
        error: quotaError && quotaError.message ? quotaError.message : String(quotaError)
      });
    }

    invalidateSharedAdminState();
    const finalResult = {
      ok: true,
      completed: true,
      state: "completed",
      alias,
      capturedAt: new Date().toISOString(),
      user,
      currentUserId: userId,
      hasAuthCallback: true,
      quota: primedQuota,
      note: `新账号登录成功，已记录为 ${alias}。`
    };

    flow.finalResult = finalResult;
    logPendingAccountLoginState(flow, "completed", { currentUserId: userId, alias });
    writeHtml(res, 200, renderAccountCallbackPage("登录已完成", finalResult.note, "ok"));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    flow.finalResult = {
      ok: false,
      completed: true,
      state: "login_failed",
      note: `登录回调已收到，但未能完成账号接管：${message}`
    };
    logPendingAccountLoginState(flow, "login_failed", { error: message });
    writeHtml(res, 500, renderAccountCallbackPage("登录接管失败", message, "error"));
  }
}

async function handleAdminAccountLoginStatus(req, res, config, url) {
  const flowId = url.searchParams.get("flowId") ? String(url.searchParams.get("flowId")).trim() : "";
  if (!flowId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "flowId is required" } });
    return;
  }

  const flow = getPendingAccountLogin(flowId);
  if (!flow) {
    log.warn("account login flow missing", { flowId: flowId || null });
    writeJson(res, 404, { error: { type: "not_found_error", message: "login flow not found or expired" } });
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    logPendingAccountLoginState(flow, "expired");
    deletePendingAccountLogin(flowId);
    writeJson(res, 410, { error: { type: "expired_error", message: "login flow expired" } });
    return;
  }

  if (flow.finalResult) {
    const payload = flow.finalResult;
    deletePendingAccountLogin(flowId);
    writeJson(res, 200, payload);
    return;
  }

  if (flow.callbackReceivedAtMs) {
    writeJson(res, 200, {
      ok: true,
      completed: false,
      state: "finalizing_login",
      message: "登录回调已收到，正在处理中。"
    });
    return;
  }

  logPendingAccountLoginState(flow, "waiting_login");
  writeJson(res, 200, {
    ok: true,
    completed: false,
    state: "waiting_login",
    message: "登录页已打开，等待你完成账号登录。"
  });
}

async function handleAdminAccountLoginCancel(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const flowId = body && body.flowId ? String(body.flowId).trim() : "";
  if (!flowId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "flowId is required" } });
    return;
  }

  const flow = getPendingAccountLogin(flowId);
  if (!flow) {
    writeJson(res, 200, {
      ok: true,
      cancelled: false,
      flowId,
      note: "该登录流程已结束。"
    });
    return;
  }

  logPendingAccountLoginState(flow, "cancelled");
  deletePendingAccountLogin(flowId);
  writeJson(res, 200, {
    ok: true,
    cancelled: true,
    flowId,
    note: "已取消当前登录流程。"
  });
}

module.exports = {
  handleAdminPage,
  handleAdminState,
  handleAdminLogs,
  handleAdminEvents,
  handleAdminConfigGet,
  handleAdminConfigTest,
  handleAdminConfigSave,
  handleAdminSnapshotCreate,
  handleAdminSnapshotActivate,
  handleAdminSnapshotDelete,
  handleAdminGatewayLogin,
  handleAdminGatewayLogout,
  handleAdminCaptureAccount,
  handleAdminAccountLogin,
  handleAdminAccountCallback,
  handleAdminAccountLoginStatus,
  handleAdminAccountLoginCancel,
  __private__: {
    hasSnapshotArtifactState,
    isQuotaPendingFailure,
    readSnapshotQuotaState,
    requestQuotaViaUpstream,
    resolveSnapshotQuotaForAdmin,
    writeSnapshotQuotaState,
    syncSnapshotAccountState
  }
};
