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
  detectActiveStorageAsync,
  readGatewayState,
  listSnapshots,
  listSnapshotsAsync,
  snapshotActiveCredentials,
  activateSnapshot,
  deleteSnapshot,
  readSnapshotAuthPayload,
  writeSnapshotAuthPayload
} = require("../auth-state");
const {
  loadAccountsFile,
  writeAccountToFile,
  upsertOpaqueAccountToFile,
  findStoredAccountAuthPayload,
  setActiveAccountInFile,
  removeAccountFromFile,
  atomicWriteFileSync
} = require("../accounts-file");
const { ExternalFallbackClient, normalizeFallbackTarget, normalizeFallbackTargets, serializeFallbackTarget } = require("../external-fallback");
const { maskToken } = require("../redaction");
const log = require("../logger");

const execFileAsync = promisify(execFile);

const QUOTA_CACHE_TTL_MS = 15 * 1000;
const QUOTA_CACHE_MAX = 64;
const quotaCache = new Map();
const SNAPSHOT_QUOTA_FILE = "quota-state.json";
const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_OAUTH_SCOPE = "openid profile email offline_access";
const OPENAI_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_CODEX_MODEL = "gpt-5.4";

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
  atomicWriteFileSync(targetPath, JSON.stringify(quota, null, 2) + "\n", "utf8");
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

  atomicWriteFileSync(filePath, nextLines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
}

function getFallbackSettings(config, theme = "claude") {
  const sourceTargets = theme === "codex"
    ? config.codexFallbackTargets
    : config.fallbackTargets;
  const targets = normalizeFallbackTargets(sourceTargets || []);
  return {
    targets: targets.map((target) => serializeFallbackTarget(target))
  };
}

function restoreMaskedApiKeys(incomingTargets, existingTargets) {
  const existingById = new Map();
  const existingByFingerprint = new Map();

  for (const t of Array.isArray(existingTargets) ? existingTargets : []) {
    if (t && typeof t === "object") {
      if (t.id && t.apiKey && !t.apiKey.includes("***")) {
        existingById.set(String(t.id), t);
      }
      // Fingerprint by baseUrl+model for cases where id changed
      const fp = [String(t.baseUrl || "").toLowerCase(), String(t.model || "").toLowerCase()].join("|");
      if (t.apiKey && !t.apiKey.includes("***")) {
        existingByFingerprint.set(fp, t);
      }
    }
  }

  return (Array.isArray(incomingTargets) ? incomingTargets : []).map((t) => {
    if (!t || typeof t !== "object") {
      return t;
    }

    // Only attempt restore if the incoming apiKey looks masked
    if (typeof t.apiKey !== "string" || !t.apiKey.includes("***")) {
      return t;
    }

    // Try exact id match first
    if (t.id && existingById.has(String(t.id))) {
      return { ...t, apiKey: existingById.get(String(t.id)).apiKey };
    }

    // Fallback: match by baseUrl + model fingerprint
    const fp = [String(t.baseUrl || "").toLowerCase(), String(t.model || "").toLowerCase()].join("|");
    if (existingByFingerprint.has(fp)) {
      return { ...t, apiKey: existingByFingerprint.get(fp).apiKey };
    }

    log.warn("restoreMaskedApiKeys: could not restore apiKey for target", {
      id: t.id || null,
      name: t.name || null,
      hint: "apiKey remains masked — user may need to re-enter it"
    });

    return t;
  });
}

function applyThemeFallbackSettings(config, fallbackPool, theme, settings) {
  const existingTargets = theme === "codex" ? config.codexFallbackTargets : config.fallbackTargets;
  const restoredInputTargets = restoreMaskedApiKeys(settings.targets, existingTargets);
  const targets = normalizeFallbackTargets(Array.isArray(restoredInputTargets) ? restoredInputTargets : []);
  const primary = targets[0] || normalizeFallbackTarget({}, 0);

  if (theme === "codex") {
    config.codexFallbackTargets = targets;
    config.codexFallbackBaseUrl = primary.baseUrl;
    config.codexFallbackApiKey = primary.apiKey;
    config.codexFallbackModel = primary.model;
    config.codexFallbackProtocol = primary.protocol;
    config.codexFallbackTimeoutMs = primary.timeoutMs;

    process.env.ACCIO_CODEX_FALLBACKS_JSON = JSON.stringify(targets);
    process.env.ACCIO_CODEX_FALLBACK_BASE_URL = primary.baseUrl;
    process.env.ACCIO_CODEX_FALLBACK_API_KEY = primary.apiKey;
    process.env.ACCIO_CODEX_FALLBACK_MODEL = primary.model;
    process.env.ACCIO_CODEX_FALLBACK_PROTOCOL = primary.protocol;
    process.env.ACCIO_CODEX_FALLBACK_ANTHROPIC_VERSION = primary.anthropicVersion;
    process.env.ACCIO_CODEX_FALLBACK_TIMEOUT_MS = String(primary.timeoutMs || 60000);
  } else {
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
  }

  if (fallbackPool && typeof fallbackPool.updateConfig === "function") {
    fallbackPool.updateConfig({ targets });
  }

  return { targets: targets.map((target) => serializeFallbackTarget(target)), normalizedTargets: targets };
}

function applyFallbackSettings(config, claudeFallbackPool, codexFallbackPool, settings) {
  const claudeSettings = settings && settings.claude && typeof settings.claude === "object"
    ? settings.claude
    : {};
  const codexSettings = settings && settings.codex && typeof settings.codex === "object"
    ? settings.codex
    : {};
  const legacyFallbacks = settings && settings.fallbacks && typeof settings.fallbacks === "object"
    ? settings.fallbacks
    : null;
  const claudeInput = legacyFallbacks ||
    (claudeSettings.fallbacks && typeof claudeSettings.fallbacks === "object"
      ? claudeSettings.fallbacks
      : { targets: getFallbackSettings(config, "claude").targets });
  const codexInput = codexSettings.fallbacks && typeof codexSettings.fallbacks === "object"
    ? codexSettings.fallbacks
    : { targets: getFallbackSettings(config, "codex").targets };

  const claude = applyThemeFallbackSettings(
    config,
    claudeFallbackPool,
    "claude",
    claudeInput
  );
  const codex = applyThemeFallbackSettings(
    config,
    codexFallbackPool,
    "codex",
    codexInput
  );

  return {
    fallbacks: claude,
    claude: { fallbacks: claude },
    codex: { fallbacks: codex }
  };
}

function cloneFallbackTargets(targets) {
  return Array.isArray(targets) ? targets.map((target) => ({ ...target })) : [];
}

function buildAdminFallbackSettings(config) {
  const claudeSettings = getFallbackSettings(config, "claude");
  const codexSettings = getFallbackSettings(config, "codex");

  return {
    fallbacks: {
      targets: cloneFallbackTargets(claudeSettings.targets)
    },
    claude: {
      fallbacks: {
        targets: cloneFallbackTargets(claudeSettings.targets)
      }
    },
    codex: {
      fallbacks: {
        targets: cloneFallbackTargets(codexSettings.targets)
      }
    }
  };
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

function createPkceVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function createPkceChallenge(verifier) {
  return crypto.createHash("sha256").update(String(verifier || "")).digest("base64url");
}

function buildCodexAuthorizeUrl(state, codeChallenge) {
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OPENAI_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OPENAI_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", String(codeChallenge || ""));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", String(state || ""));
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

function parseCodexAuthorizationInput(input) {
  const text = String(input || "").trim();
  if (!text) {
    throw new Error("empty input");
  }

  if (text.includes("code=")) {
    try {
      const url = new URL(text);
      return {
        code: String(url.searchParams.get("code") || "").trim(),
        state: String(url.searchParams.get("state") || "").trim()
      };
    } catch {
      try {
        const params = new URLSearchParams(text);
        return {
          code: String(params.get("code") || "").trim(),
          state: String(params.get("state") || "").trim()
        };
      } catch {
        // Fall through to raw parsing below.
      }
    }
  }

  if (text.includes("#")) {
    const [code, state] = text.split("#", 2);
    return {
      code: String(code || "").trim(),
      state: String(state || "").trim()
    };
  }

  return {
    code: text,
    state: ""
  };
}

function decodeJwtClaims(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) {
      return null;
    }

    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractOpenAiAccountIdFromJwt(token) {
  const claims = decodeJwtClaims(token);
  const auth = claims && claims[OPENAI_AUTH_CLAIM_PATH] && typeof claims[OPENAI_AUTH_CLAIM_PATH] === "object"
    ? claims[OPENAI_AUTH_CLAIM_PATH]
    : null;
  const accountId = auth && auth.chatgpt_account_id ? String(auth.chatgpt_account_id).trim() : "";
  return accountId || null;
}

function extractEmailFromJwt(token) {
  const claims = decodeJwtClaims(token);
  const email = claims && claims.email ? String(claims.email).trim() : "";
  return email || null;
}

async function exchangeCodexAuthorizationCode(code, verifier) {
  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code: String(code || "").trim(),
      code_verifier: String(verifier || "").trim(),
      redirect_uri: OPENAI_OAUTH_REDIRECT_URI
    }),
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text().catch(() => "");
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? String(payload.error.message)
      : (text || `HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.type = "authentication_error";
    error.details = payload || text || null;
    throw error;
  }

  return payload && typeof payload === "object" ? payload : {};
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
  const appVersion = config && config.appVersion ? String(config.appVersion).trim() || "0.0.0" : "0.0.0";
  const url = new URL("/api/entitlement/quota", upstreamBaseUrl);
  url.searchParams.set("accessToken", String(authPayload.accessToken));
  url.searchParams.set("utdid", utdid);
  url.searchParams.set("version", appVersion);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-language": config && config.language ? String(config.language) : "zh",
      "x-utdid": utdid,
      "x-app-version": appVersion,
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

  // Always refresh via refreshToken before querying quota so each account
  // gets its own accessToken.  Previously only expired tokens were refreshed,
  // but all snapshots may share the same initial accessToken (from the Accio
  // gateway session), which caused every card to show identical quota.
  if (resolvedAuthPayload.refreshToken) {
    try {
      resolvedAuthPayload = await refreshAuthPayloadViaUpstream(config, resolvedAuthPayload, { alias, reason: "quota_ensure_own_token" });
      persistResolvedAuthPayload(config, alias, resolvedAuthPayload);
    } catch (refreshError) {
      log.warn("pre-quota token refresh failed, proceeding with existing token", {
        alias,
        error: refreshError && refreshError.message ? refreshError.message : String(refreshError)
      });
    }
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
  const canQueryLive = authPayload && authPayload.refreshToken;

  if (!canQueryLive) {
    // No refreshToken — cannot query upstream; fall back to disk cache.
    const persistedQuota = readSnapshotQuotaState(snapshot && snapshot.dir ? snapshot.dir : null);
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

  if (!isCurrentGatewayAccount) {
    // Inactive account: quota only changes when the account is actively used,
    // so once we have a successful result we can keep returning it without
    // re-querying the upstream on every SSE tick.  Only fetch once (when the
    // in-memory cache has no entry yet), then reuse indefinitely until the
    // cache is explicitly cleared (e.g. by the "实时刷新" button or a server
    // restart).
    const gatewayUser = snapshot && snapshot.gatewayUser ? snapshot.gatewayUser : null;
    const userId = gatewayUser && gatewayUser.id ? String(gatewayUser.id) : "";
    const alias = snapshot && snapshot.alias ? String(snapshot.alias) : userId;
    const cacheKey = buildQuotaCacheKey(alias, userId);
    const cached = quotaCache.get(cacheKey);

    if (cached && cached.value && cached.value.available) {
      // Already queried successfully before — reuse without hitting upstream.
      return {
        ...cached.value,
        stale: false
      };
    }

    // First time (or previous attempt failed) — query once and cache.
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

  // Current active account — always query (with 15s in-memory TTL inside
  // resolveSnapshotQuota to avoid flooding).
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

async function refreshAllSnapshotQuotas(config, authProvider) {
  const configuredAccounts = authProvider.getConfiguredAccounts();
  const entries = listSnapshots();

  if (entries.length === 0) {
    return;
  }

  const CONCURRENCY = 3;
  const now = Date.now();
  let refreshed = 0;
  let failed = 0;

  const tasks = entries.map((entry) => {
    const alias = entry.alias;
    const resolvedAuth = resolveSnapshotAuthPayload(alias, config.accountsPath);
    const storedAuthPayload = resolvedAuth.payload;

    if (!storedAuthPayload || !storedAuthPayload.accessToken) {
      return null;
    }

    const snapshotBase = {
      alias,
      dir: entry.dir,
      gatewayUser: entry.metadata && entry.metadata.gatewayUser ? entry.metadata.gatewayUser : null,
      authPayloadUser: storedAuthPayload && storedAuthPayload.user ? storedAuthPayload.user : null
    };
    const matchedAccount = findMatchingConfiguredAccount(configuredAccounts, snapshotBase);

    if (matchedAccount) {
      const invalidUntil = authProvider.getInvalidUntil(matchedAccount.id);
      if (invalidUntil && Number(invalidUntil) > now) {
        return null;
      }
    }

    return { entry, snapshotBase, storedAuthPayload, matchedAccount };
  }).filter(Boolean);

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (task) => {
      const { entry, snapshotBase, storedAuthPayload, matchedAccount } = task;
      const snapshot = {
        ...snapshotBase,
        accountState: matchedAccount
          ? {
              id: matchedAccount.id,
              enabled: matchedAccount.enabled !== false,
              hasToken: Boolean(matchedAccount.accessToken),
              expiresAt: matchedAccount.expiresAt || null,
              source: matchedAccount.source || null,
              invalidUntil: authProvider.getInvalidUntil(matchedAccount.id),
              lastFailure: authProvider.getLastFailure(matchedAccount.id) || null
            }
          : null
      };

      const liveQuota = await resolveSnapshotQuota(config, snapshot, storedAuthPayload);
      writeSnapshotQuotaState(entry.dir, { ...liveQuota, stale: false });

      snapshot.quota = liveQuota;
      syncSnapshotAccountState(authProvider, snapshot);

      return true;
    }));

    for (const result of results) {
      if (result.status === "fulfilled") {
        refreshed++;
      } else {
        failed++;
      }
    }
  }

  log.info("startup quota refresh completed", {
    total: entries.length,
    refreshed,
    skipped: entries.length - tasks.length,
    failed
  });
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
  const accent = tone === "error" ? "#dc2626" : "#16a34a";
  const accentSoft = tone === "error" ? "rgba(220,38,38,0.1)" : "rgba(22,163,74,0.1)";
  const iconSvg = tone === "error"
    ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><circle cx="10" cy="10" r="7.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/></svg>'
    : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="36" height="36"><circle cx="10" cy="10" r="7.5"/><path d="M6.5 10l2.5 2.5 4.5-5"/></svg>';
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
body { margin: 0; background: linear-gradient(175deg, #f8f9fc, #e8ecf4); color: #111827; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Noto Sans SC",sans-serif; display: grid; place-items: center; min-height: 100vh; -webkit-font-smoothing: antialiased; }
main { width: min(520px, calc(100vw - 32px)); background: rgba(255,255,255,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(17,24,39,0.08); border-radius: 22px; padding: 28px; box-shadow: 0 16px 48px rgba(17,24,39,0.1); animation: fadeSlideUp 0.5s ease-out; }
.icon { display: flex; justify-content: center; margin-bottom: 12px; color: ${accent}; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: ${accentSoft}; color: ${accent}; letter-spacing: 0.1em; text-transform: uppercase; font-size: 11px; font-weight: 600; margin-bottom: 12px; }
h1 { margin: 0 0 10px; font-size: 26px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; }
p { margin: 0; color: #6b7280; font-size: 14px; line-height: 1.7; }
.countdown { margin-top: 16px; color: #6b7280; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="icon">${iconSvg}</div>
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
const PENDING_CODEX_OAUTH_MAX = 32;
const pendingCodexOAuthFlows = new Map();

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

function prunePendingCodexOAuthFlows(now = Date.now()) {
  for (const [flowId, flow] of pendingCodexOAuthFlows.entries()) {
    if (now - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
      pendingCodexOAuthFlows.delete(flowId);
    }
  }
  while (pendingCodexOAuthFlows.size > PENDING_CODEX_OAUTH_MAX) {
    pendingCodexOAuthFlows.delete(pendingCodexOAuthFlows.keys().next().value);
  }
}

function createPendingCodexOAuthFlow(extras = {}) {
  prunePendingCodexOAuthFlows();
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const flow = {
    id: crypto.randomUUID(),
    state,
    verifier,
    challenge,
    authorizeUrl: buildCodexAuthorizeUrl(state, challenge),
    createdAtMs: Date.now(),
    account: extras && extras.account && typeof extras.account === "object"
      ? { ...extras.account }
      : {}
  };
  pendingCodexOAuthFlows.set(flow.id, flow);
  return flow;
}

function getPendingCodexOAuthFlow(flowId) {
  prunePendingCodexOAuthFlows();
  return flowId ? (pendingCodexOAuthFlows.get(String(flowId)) || null) : null;
}

function findPendingCodexOAuthFlowByState(state) {
  prunePendingCodexOAuthFlows();
  const normalizedState = String(state || "").trim();
  if (!normalizedState) {
    return null;
  }

  for (const flow of pendingCodexOAuthFlows.values()) {
    if (String(flow && flow.state ? flow.state : "") === normalizedState) {
      return flow;
    }
  }

  return null;
}

function deletePendingCodexOAuthFlow(flowId) {
  if (!flowId) {
    return;
  }
  pendingCodexOAuthFlows.delete(String(flowId));
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


async function buildAdminState(config, authProvider, codexAuthProvider, directClient, recentActivityStore) {
  const [gateway, storage, rawSnapshotEntries] = await Promise.all([
    readGatewayState(config.baseUrl),
    detectActiveStorageAsync(),
    listSnapshotsAsync()
  ]);
  const configuredAccounts = authProvider.getConfiguredAccounts();
  const authSummary = authProvider.getSummary();
  const activeAccountId = authSummary && authSummary.activeAccount ? String(authSummary.activeAccount) : "";
  const currentGatewayUserId = gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";
  const snapshotEntries = rawSnapshotEntries.map((entry) => {
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
              enabled: matchedAccount.enabled !== false,
              hasToken: Boolean(matchedAccount.accessToken),
              expiresAt: matchedAccount.expiresAt || null,
              source: matchedAccount.source || null,
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
  const codexAccounts = codexAuthProvider && typeof codexAuthProvider.getConfiguredAccounts === "function"
    ? codexAuthProvider.getConfiguredAccounts().map((account) => ({
        id: account.id,
        name: account.name,
        source: account.source,
        authMode: account.authMode || null,
        enabled: account.enabled,
        hasCredentialBundle: Boolean(account.credentialBundle),
        model: account.model || account.probeModel || null,
        baseUrl: account.baseUrl || null,
        invalidUntil: codexAuthProvider.getInvalidUntil(account.id),
        lastFailure: codexAuthProvider.getLastFailure(account.id) || null
      }))
    : [];
  const codexSummary = codexAuthProvider && typeof codexAuthProvider.getSummary === "function"
    ? codexAuthProvider.getSummary()
    : null;
  const codexUsableAccounts = codexAccounts.filter((account) => {
    if (!account.enabled || !account.hasCredentialBundle) {
      return false;
    }

    return !(account.invalidUntil && Number(account.invalidUntil) > Date.now());
  });

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
      ...buildAdminFallbackSettings(config)
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
    codexAuth: codexSummary,
    codexAuthRuntime: {
      accountsPath: config.codexAccountsPath,
      totalAccounts: codexAccounts.length,
      usableAccounts: codexUsableAccounts.length,
      activeAccount: codexSummary && codexSummary.activeAccount ? codexSummary.activeAccount : null
    },
    accountStandby: directClient && typeof directClient.getStandbyState === "function"
      ? directClient.getStandbyState()
      : null,
    accounts,
    codexAccounts,
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
  --bg: #f5f7fa;
  --panel: rgba(255,255,255,0.97);
  --panel-hover: rgba(255,255,255,1);
  --ink: #111827;
  --ink-secondary: #374151;
  --muted: #6b7280;
  --line: rgba(17,24,39,0.06);
  --line-strong: rgba(17,24,39,0.12);
  --accent: #4f6ef7;
  --accent-soft: rgba(79,110,247,0.08);
  --accent-deep: #3b5bdb;
  --good: #16a34a;
  --good-soft: rgba(22,163,74,0.08);
  --warn: #d97706;
  --warn-soft: rgba(217,119,6,0.08);
  --bad: #dc2626;
  --bad-soft: rgba(220,38,38,0.08);
  --shadow-sm: 0 1px 3px rgba(17,24,39,0.04), 0 1px 2px rgba(17,24,39,0.02);
  --shadow-md: 0 4px 12px rgba(17,24,39,0.06);
  --shadow-lg: 0 8px 24px rgba(17,24,39,0.08);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;
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
  background: linear-gradient(175deg, #f8f9fc 0%, #f0f2f7 50%, #e8ecf4 100%);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; cursor: pointer; }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex-shrink: 0; }
.icon svg { width: 100%; height: 100%; }
.icon.icon-lg { width: 24px; height: 24px; }
.icon.icon-xl { width: 32px; height: 32px; }

/* ── Animations ── */
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(22,163,74,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(22,163,74,0); }
}
@keyframes pulseWarn {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217,119,6,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(217,119,6,0); }
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Shell ── */
.shell {
  width: min(1080px, calc(100vw - 40px));
  margin: 0 auto;
  padding: 8px 0 24px;
  display: grid;
  gap: 20px;
  animation: fadeSlideUp 0.4s ease-out;
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
.titleBlock,
.statusCard,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.titleBlock {
  min-height: 0;
  padding: 16px 20px;
  animation: fadeSlideUp 0.35s ease-out;
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
  padding: 16px 20px;
  animation: fadeSlideUp 0.35s ease-out 0.05s both;
}
.statusCard.statusCard-wide {
  width: 100%;
}
.statusMessage {
  margin-top: 12px;
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
  background: linear-gradient(90deg, rgba(22,163,74,0.18) 0%, rgba(22,163,74,0.08) 100%);
  transition: width 0.8s cubic-bezier(0.4,0,0.2,1), background 0.4s ease;
  pointer-events: none;
}
.statusBadge .badgeFill[data-level="mid"] {
  background: linear-gradient(90deg, rgba(217,119,6,0.18) 0%, rgba(217,119,6,0.08) 100%);
}
.statusBadge .badgeFill[data-level="low"] {
  background: linear-gradient(90deg, rgba(220,38,38,0.22) 0%, rgba(220,38,38,0.10) 100%);
}
.statusBadge .badgeFill[data-level="empty"] {
  background: linear-gradient(90deg, rgba(220,38,38,0.22) 0%, rgba(220,38,38,0.10) 100%);
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
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 6px;
  margin-top: 12px;
}
.kvItem {
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: rgba(243,244,248,0.7);
}
.kvItem.full {
  grid-column: 1 / -1;
}
.kvKey {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.kvValue {
  margin-top: 3px;
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

/* ── Action Panel ── */
.actionPanel {
  padding: 20px;
  animation: fadeSlideUp 0.35s ease-out 0.08s both;
}

/* ── Snapshot Panel (full-width) ── */
.snapshotPanel {
  padding: 20px;
  animation: fadeSlideUp 0.35s ease-out 0.08s both;
}
.panel {
  padding: 20px;
  animation: fadeSlideUp 0.35s ease-out 0.05s both;
}
.panel h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.panelSub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.claudeWorkspace {
  display: grid;
  gap: 16px;
}
.claudeRail {
  display: none;
}
.claudeRailHeader {
  display: none;
}
.claudeRailEyebrow {
  display: none;
}
.claudeRailTitle {
  display: none;
}
.claudeRailSub {
  display: none;
}
/* ── Inline Sub-Tabs (replaces Rail on all sizes) ── */
.claudeSubTabs {
  display: flex;
  gap: 6px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: rgba(243,244,248,0.8);
  border: 1px solid var(--line);
}
.claudeSubTabBtn {
  flex: 1;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}
.claudeSubTabBtn:hover {
  color: var(--ink);
  background: rgba(255,255,255,0.6);
}
.claudeSubTabBtn.active {
  background: #fff;
  color: var(--ink);
  box-shadow: var(--shadow-sm);
}
.claudeNav {
  display: none;
}
.claudeNavBtn {
  display: none;
}
.claudeNavLabel {
  display: none;
}
.claudeNavMeta {
  display: none;
}
.claudeStage {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.claudeSection {
  min-width: 0;
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
  background: #fff;
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.btn:hover {
  background: #f5f7fa;
  border-color: var(--line-strong);
}
.btn:active {
  background: #eff1f5;
}
.btn.primary {
  background: var(--accent);
  color: #fff;
  border: none;
  font-weight: 600;
}
.btn.primary:hover {
  background: var(--accent-deep);
}
.btn.warn {
  background: var(--warn-soft);
  color: #92400e;
  border-color: rgba(217,119,6,0.15);
}
.btn.warn:hover {
  background: rgba(217,119,6,0.15);
}
.btn.danger-confirm {
  background: var(--bad-soft);
  color: var(--bad);
  border-color: rgba(220,38,38,0.2);
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
.message .msg-icon { flex-shrink: 0; width: 16px; height: 16px; display: inline-flex; align-items: center; }
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
.message.info { background: rgba(17,24,39,0.05); color: var(--ink-secondary); }
.message.ok { background: var(--good-soft); color: #15633a; }
.message.warn { background: var(--warn-soft); color: #92400e; }
.message.error { background: var(--bad-soft); color: #991b1b; }

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

/* ── Snapshot Filter ── */
.snapshotFilter {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.filterBtn {
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--muted);
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
}
.filterBtn:hover {
  color: var(--ink);
  background: rgba(243,244,248,0.8);
}
.filterBtn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
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
  background: #fff;
  border: 1px solid var(--line);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  position: relative;
  overflow: hidden;
}
.item::before {
  content: '';
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 3px;
  background: transparent;
  transition: background var(--transition-fast);
}
.item:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-sm);
}
.item.current-item {
  border-color: rgba(22,163,74,0.25);
  background: rgba(22,163,74,0.03);
}
.item.current-item::before { background: var(--good); }
.itemAvatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-soft), rgba(79,110,247,0.2));
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
  background: linear-gradient(135deg, var(--good-soft), rgba(22,163,74,0.2));
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
  background: rgba(17,24,39,0.06);
  color: var(--muted);
}
.pill.current {
  background: var(--good-soft);
  color: #15633a;
}
.pill.warn {
  background: var(--warn-soft);
  color: #92400e;
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
  padding: 24px 16px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--line-strong);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  background: rgba(243,244,248,0.5);
  text-align: center;
}
.empty-icon {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
  color: var(--muted);
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
  background: rgba(243,244,248,0.6);
  color: var(--ink-secondary);
  font-size: 11.5px;
  line-height: 1.55;
  border-left: 3px solid var(--line-strong);
}
.note code {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10.5px;
  background: rgba(17,24,39,0.08);
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
  padding: 8px 0 10px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.tabbar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: rgba(255,255,255,0.88);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-md);
  width: fit-content;
  margin: 0 auto;
  justify-self: center;
}
.tabBtn {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease;
}
.tabBtn:hover {
  color: var(--ink);
}
.tabBtn.active {
  background: var(--accent);
  color: #fff;
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
  border-radius: var(--radius-md);
  border: 1px solid rgba(17,24,39,0.1);
  background: #111827;
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
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: #fff;
  overflow: hidden;
  transition: border-color 160ms ease;
}
.fallbackCard:hover {
  border-color: var(--line-strong);
}
.fallbackCardHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  background: rgba(243,244,248,0.5);
  border-bottom: 1px solid var(--line);
}
.fallbackCard[data-enabled="false"] .fallbackCardHeader {
  background: rgba(243,244,248,0.3);
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
  background: rgba(17,24,39,0.18);
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
  align-content: start;
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
.field select,
.field textarea {
  width: 100%;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  border-radius: var(--radius-sm);
  min-height: 42px;
  padding: 10px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.field .btn {
  min-height: 42px;
  border-radius: var(--radius-sm);
  justify-content: center;
  text-align: center;
  font-weight: 600;
}
.field textarea {
  resize: vertical;
  min-height: 140px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.inputWrap input {
  padding-right: 52px;
}
.field select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 44px;
  background-image:
    linear-gradient(45deg, transparent 50%, rgba(17,24,39,0.72) 50%),
    linear-gradient(135deg, rgba(17,24,39,0.72) 50%, transparent 50%);
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
  background: rgba(17,24,39,0.05);
  color: var(--muted);
  font-size: 15px;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease;
}
.inputToggle:hover {
  background: rgba(17,24,39,0.08);
  color: var(--ink);
}
.inputToggle:focus {
  outline: none;
  box-shadow: 0 0 0 4px rgba(79,110,247,0.12);
  color: var(--ink);
}
.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: rgba(79,110,247,0.45);
  box-shadow: 0 0 0 4px rgba(79,110,247,0.12);
  background: #fff;
}
.fieldHint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.fieldHint.tight {
  min-height: 18px;
}
.settingsTips {
  display: grid;
  gap: 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  overflow: hidden;
  background: rgba(243,244,248,0.6);
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
  background: rgba(17,24,39,0.07);
  padding: 0 4px;
  border-radius: 4px;
}
.settingsTipIcon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
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
.settingsActions.codexImportActions {
  justify-content: flex-start;
  min-height: 24px;
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
  border-radius: var(--radius-sm);
  background: rgba(243,244,248,0.7);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
}
.miniStatIcon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
::-webkit-scrollbar-thumb { background: rgba(17,24,39,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(17,24,39,0.25); }

/* ── Section visibility ── */
.claudeSection,
.codexSection {
  display: none;
}
.claudeSection.active,
.codexSection.active {
  display: block;
}
@media (max-width: 980px) {
  .topbar,
  .statusActionsRow {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .shell {
    width: calc(100vw - 20px);
    padding-top: 8px;
    padding-bottom: 18px;
  }
  .kv {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .kvItem.full {
    grid-column: auto;
  }
  .list {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
  .claudeSubTabs {
    overflow-x: auto;
  }
}
</style>
</head>
<body>
<div class="pageHeadWrap">
  <nav class="tabbar" aria-label="\u63A7\u5236\u53F0\u5206\u533A">
    <button class="tabBtn active" type="button" data-tab="claude">Claude Code</button>
    <button class="tabBtn" type="button" data-tab="codex">Codex</button>
    <button class="tabBtn" type="button" data-tab="logs">\u65E5\u5FD7</button>
  </nav>
</div>
<div class="shell">
  <section class="tabPanel active" data-tab-panel="claude">
    <section class="claudeWorkspace">
      <div class="claudeStage">
        <section class="topbar topbar-head topbar-compact" id="primary-topbar">
          <aside class="statusCard statusCard-wide">
            <div class="statusHeader">
              <div class="statusBadge" id="status-badge"><span class="badgeFill" id="badge-fill"></span><span class="dot" id="gateway-dot"></span><span id="gateway-summary">\u6B63\u5728\u68C0\u67E5 Bridge \u72B6\u6001</span><span class="badgeQuota" id="badge-quota"></span></div>
              <button class="btn-icon" id="refresh-btn" title="\u5237\u65B0\u72B6\u6001"><span class="icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5v4.5h4.5"/><path d="M16.5 16.5v-4.5h-4.5"/><path d="M14.74 7a6 6 0 0 0-10.19.95"/><path d="M5.26 13a6 6 0 0 0 10.19-.95"/></svg></span></button>
            </div>
            <div class="kv" id="overview-kv"></div>
            <div id="action-message" class="message info statusMessage"></div>
          </aside>
        </section>

        <nav class="claudeSubTabs" id="claude-sub-tabs">
          <button class="claudeSubTabBtn" type="button" data-claude-section-btn="actions">\u8D26\u53F7\u64CD\u4F5C</button>
          <button class="claudeSubTabBtn active" type="button" data-claude-section-btn="accounts">\u5DF2\u8BB0\u5F55\u8D26\u53F7</button>
          <button class="claudeSubTabBtn" type="button" data-claude-section-btn="fallbacks">\u5916\u90E8\u6E20\u9053</button>
        </nav>

        <section class="panel actionPanel claudeSection" data-claude-section="actions">
          <div class="sectionHeader">
            <div>
              <h2>\u8D26\u53F7\u64CD\u4F5C</h2>
              <div class="panelSub">\u901A\u8FC7 bridge \u76F4\u63A5\u65B0\u589E\u8D26\u53F7\u3002\u767B\u5F55\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u8BB0\u5F55\u5230\u5217\u8868\u3002</div>
            </div>
          </div>
          <div class="actionList">
            <button class="btn primary" id="account-login-btn">\uFF0B \u6DFB\u52A0\u8D26\u53F7\u767B\u5F55</button>
            <button class="btn" id="cancel-account-login-btn" style="display:none">\u653E\u5F03\u672C\u6B21\u767B\u5F55</button>
          </div>
        </section>

        <section class="panel snapshotPanel claudeSection" data-claude-section="accounts">
          <div class="sectionHeader">
            <div>
              <h2>\u5DF2\u8BB0\u5F55\u8D26\u53F7</h2>
              <div class="panelSub">\u672C\u5730\u5DF2\u4FDD\u5B58\u7684 Accio \u767B\u5F55\u8EAB\u4EFD\u3002\u201C\u5207\u6362\u201D\u4F1A\u5C1D\u8BD5\u5C06\u5B83\u8BBE\u4E3A\u5F53\u524D\u6FC0\u6D3B\u8D26\u53F7\u3002</div>
            </div>
          </div>
      <div class="snapshotFilter" id="snapshot-filter">
        <button class="filterBtn active" data-snapshot-filter="all">\u5168\u90E8</button>
            <button class="filterBtn" data-snapshot-filter="usable">\u53EF\u7528</button>
            <button class="filterBtn" data-snapshot-filter="unusable">\u4E0D\u53EF\u7528</button>
          </div>
          <div class="list" id="snapshot-list"></div>
        </section>

        <section class="panel settingsPanel claudeSection" data-claude-section="fallbacks">
          <div class="sectionHeader">
            <div>
              <h2>\u5916\u90E8\u4E0A\u6E38\u6E20\u9053</h2>
              <div class="panelSub">\u53F7\u6C60\u548C\u672C\u5730\u94FE\u8DEF\u5747\u4E0D\u53EF\u7528\u65F6\uFF0Cbridge \u4F1A\u6309\u4F18\u5148\u7EA7\u4F9D\u6B21\u5C1D\u8BD5\u4EE5\u4E0B\u5916\u90E8\u6E20\u9053\u3002\u652F\u6301 OpenAI compatible \u548C Anthropic Messages \u6DF7\u7528\u3002</div>
            </div>
            <button class="btn" id="add-fallback-target-btn">+ \u65B0\u589E\u6E20\u9053</button>
          </div>

          <div class="settingsMeta">
            <div class="miniStat">
              <span class="miniStatIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 4.95 0l2.12-2.12a3.5 3.5 0 0 0-4.95-4.95L9.5 5.5"/><path d="M11.5 8.5a3.5 3.5 0 0 0-4.95 0L4.43 10.62a3.5 3.5 0 0 0 4.95 4.95l1.12-1.07"/></svg></span>
              <div class="miniStatBody">
                <div class="miniStatLabel">\u6E20\u9053\u6982\u89C8</div>
                <div class="miniStatValue" id="fallback-status">\u672A\u914D\u7F6E</div>
              </div>
            </div>
            <div class="miniStat">
              <span class="miniStatIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V6.5L12 2.5z"/><path d="M12 2.5v4h4"/><path d="M7 10.5h6M7 13.5h4"/></svg></span>
              <div class="miniStatBody">
                <div class="miniStatLabel">\u5199\u5165\u6587\u4EF6</div>
                <div class="miniStatValue" id="fallback-env-path">.env</div>
              </div>
            </div>
          </div>

          <div class="fallbackTargets" id="fallback-targets"></div>
          <div class="empty" id="fallback-empty" style="display:none"><span class="empty-icon icon icon-xl"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12.5v5"/><circle cx="10" cy="10" r="1"/><path d="M6.46 6.46a5 5 0 0 1 7.08 0"/><path d="M4.34 4.34a8 8 0 0 1 11.32 0"/><path d="M7.5 17.5h5"/></svg></span>\u6682\u65E0\u5916\u90E8\u4E0A\u6E38\u6E20\u9053\u3002\u70B9\u51FB\u300C\u65B0\u589E\u6E20\u9053\u300D\u5F00\u59CB\u914D\u7F6E\u3002</div>

          <div class="settingsFooter">
            <div class="settingsActions">
              <button class="btn primary" id="save-fallback-config-btn">\u4FDD\u5B58\u6E20\u9053\u914D\u7F6E</button>
              <button class="btn" id="reload-fallback-config-btn">\u91CD\u65B0\u8F7D\u5165</button>
              <div id="config-message" class="message info"></div>
            </div>
            <div class="settingsTips">
              <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 17.5H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2h8.59a1 1 0 0 1 .7.29l3.92 3.92a1 1 0 0 1 .29.7V15.5a2 2 0 0 1-2 2z"/><path d="M13.5 17.5v-5h-7v5"/><path d="M6.5 2.5v3h5"/></svg></span>\u4FDD\u5B58\u540E\u5199\u5165 bridge \u6839\u76EE\u5F55 .env\uFF0C\u5E76\u7ACB\u5373\u5E94\u7528\u5230\u5F53\u524D\u8FDB\u7A0B\u3002API Key \u9ED8\u8BA4\u9690\u85CF\uFF0C\u53EF\u7528\u53F3\u4FA7\u300C\u773C\u775B\u300D\u6309\u94AE\u5207\u6362\u663E\u793A\u6216\u9690\u85CF\u3002</div>
              <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 4.95 0l2.12-2.12a3.5 3.5 0 0 0-4.95-4.95L9.5 5.5"/><path d="M11.5 8.5a3.5 3.5 0 0 0-4.95 0L4.43 10.62a3.5 3.5 0 0 0 4.95 4.95l1.12-1.07"/></svg></span>OpenAI \u534F\u8BAE\u586B\u5230 <code>/v1</code>\uFF1BAnthropic \u534F\u8BAE\u586B\u5230\u63D0\u4F9B <code>/messages</code> \u7684\u6839\u524D\u7F00\u3002</div>
              <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4"/><path d="M5 9l5-5 5 5"/></svg></span>\u5217\u8868\u987A\u5E8F\u5C31\u662F\u5140\u5E95\u5C1D\u8BD5\u987A\u5E8F\uFF0C\u53EF\u7528\u300C\u4E0A\u79FB / \u4E0B\u79FB\u300D\u8C03\u6574\u3002</div>
              <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8L10 2z"/></svg></span>Anthropic \u6E20\u9053\u9002\u5408 Claude Code \u7B49\u539F\u751F\u5BA2\u6237\u7AEF\u900F\u4F20\uFF0C\u8BED\u4E49\u4FDD\u7559\u66F4\u5B8C\u6574\u3002</div>
            </div>
            <div class="sideNotes">
              <div class="note"><span class="icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.57 3.81L1.92 15.09a1.64 1.64 0 0 0 1.43 2.41h13.3a1.64 1.64 0 0 0 1.43-2.41L11.43 3.81a1.64 1.64 0 0 0-2.86 0z"/><path d="M10 7.5v3.5"/><circle cx="10" cy="14" r=".5" fill="currentColor" stroke="none"/></svg></span>\u4EC5\u5F53 direct-llm \u56E0 quota / auth / timeout / 5xx \u5931\u8D25\u65F6\uFF0Cbridge \u624D\u4F1A\u542F\u7528\u8FD9\u4E2A\u5140\u5E95\u4E0A\u6E38\u3002</div>
              <div class="note"><span class="icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5v1a2 2 0 0 0 4 0v-1"/><path d="M8 14.5a5 5 0 1 1 4 0"/><path d="M8.5 17h3"/></svg></span>Anthropic \u6E20\u9053\u4F1A\u5C06 <code>/v1/messages</code> \u76F4\u63A5\u900F\u4F20\u5230\u5916\u90E8 Anthropic \u4E0A\u6E38\uFF0C\u5C3D\u91CF\u4FDD\u7559 Claude Code \u539F\u59CB\u8BF7\u6C42\u8BED\u4E49\u3002</div>
            </div>
          </div>
        </section>
      </div>
    </section>
  </section>

  <section class="tabPanel" data-tab-panel="codex">
    <nav class="claudeSubTabs" id="codex-sub-tabs">
      <button class="claudeSubTabBtn active" type="button" data-codex-section-btn="accounts">\u8D26\u53F7\u6C60</button>
      <button class="claudeSubTabBtn" type="button" data-codex-section-btn="fallbacks">\u6258\u5E95\u6E20\u9053</button>
    </nav>

    <section class="panel codexSection active" data-codex-section="accounts">
      <div class="sectionHeader">
        <div>
          <h2>\u8D26\u53F7\u6C60</h2>
          <div class="panelSub">\u624B\u52A8\u5BFC\u5165 Codex \u767B\u5F55\u51ED\u8BC1\u5305\uFF0CResponses \u8BF7\u6C42\u5C06\u4F18\u5148\u4ECE\u8FD9\u7EC4\u8D26\u53F7\u4E2D\u9009\u62E9\uFF0C\u4E0D\u4F1A\u8DE8\u5230 Claude \u8D26\u53F7\u6C60\u3002</div>
        </div>
      </div>
      <div class="kv" id="codex-overview-kv"></div>
      <div class="settingsGrid">
        <div class="field">
          <label>\u5BFC\u5165\u65B9\u5F0F</label>
          <select id="codex-import-mode">
            <option value="openai-oauth">OpenAI OAuth</option>
            <option value="json-bundle">JSON \u51ED\u8BC1</option>
          </select>
        </div>
        <div class="field" id="codex-account-id-field">
          <label>\u8D26\u53F7 ID</label>
          <input id="codex-account-id" type="text" placeholder="codex_primary" autocomplete="off" />
        </div>
        <div class="field" id="codex-account-name-field">
          <label>\u4F7F\u7528\u5907\u6CE8</label>
          <input id="codex-account-name" type="text" placeholder="\u4F8B\u5982\uFF1A\u4E3B\u529B\u53F7 / \u5907\u7528\u53F7 / \u56E2\u961F\u53F7" autocomplete="off" />
        </div>
        <div class="field" id="codex-account-model-field">
          <label>\u6A21\u578B</label>
          <select id="codex-account-model">
            <option value="gpt-5.4">gpt-5.4</option>
          </select>
          <div class="fieldHint tight">\u5B98\u65B9 OpenAI OAuth \u8D26\u53F7\u5F53\u524D\u4F7F\u7528 <code>gpt-5.4</code>\u3002</div>
        </div>
        <div class="field" id="codex-oauth-action-field">
          <label>\u6388\u6743</label>
          <button class="btn primary" id="start-codex-oauth-btn">Codex \u6388\u6743</button>
          <div class="fieldHint tight">\u767B\u5F55\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u56DE\u5199\u5E76\u5BFC\u5165\u53F7\u6C60\u3002</div>
        </div>
        <div class="field wide" id="codex-account-base-url-field">
          <label>Base URL</label>
          <input id="codex-account-base-url" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
        </div>
        <div class="field wide" id="codex-credential-field">
          <label id="codex-credential-label">OpenAI OAuth \u56DE\u8C03 URL</label>
          <textarea id="codex-credential-bundle" rows="8" placeholder="\u7C98\u8D34 http://localhost:1455/auth/callback?code=...&state=..."></textarea>
          <div class="fieldHint" id="codex-credential-hint">\u5148\u70B9\u51FB\u4E0B\u65B9 <code>Codex \u6388\u6743</code> \u6253\u5F00 OpenAI \u767B\u5F55\u9875\u3002\u5B8C\u6210\u767B\u5F55\u540E\uFF0C\u628A\u6D4F\u89C8\u5668\u5730\u5740\u680F\u91CC\u7684\u5B8C\u6574 callback URL \u7C98\u8D34\u5230\u8FD9\u91CC\uFF0C\u518D\u70B9\u51FB\u201C\u5B8C\u6210\u6388\u6743\u5E76\u5BFC\u5165\u201D\u3002</div>
        </div>
      </div>
      <div class="settingsActions codexImportActions">
        <button class="btn primary" id="import-codex-account-btn">\u5B8C\u6210\u6388\u6743\u5E76\u5BFC\u5165</button>
        <div id="codex-message" class="message info"></div>
      </div>
      <div class="list" id="codex-account-list"></div>
    </section>

    <section class="panel settingsPanel codexSection" data-codex-section="fallbacks">
      <div class="sectionHeader">
        <div>
          <h2>\u6258\u5E95\u6E20\u9053</h2>
          <div class="panelSub">\u4EC5\u7528\u4E8E Codex \u4E3B\u9898\uFF1B\u4E0D\u4F1A\u5F71\u54CD Claude Code \u7684 fallback \u987A\u5E8F\u3002\u652F\u6301 OpenAI compatible \u548C Anthropic Messages \u6DF7\u7528\u3002</div>
        </div>
        <button class="btn" id="add-codex-fallback-target-btn">+ \u65B0\u589E\u6E20\u9053</button>
      </div>

      <div class="settingsMeta">
        <div class="miniStat">
          <span class="miniStatIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 4.95 0l2.12-2.12a3.5 3.5 0 0 0-4.95-4.95L9.5 5.5"/><path d="M11.5 8.5a3.5 3.5 0 0 0-4.95 0L4.43 10.62a3.5 3.5 0 0 0 4.95 4.95l1.12-1.07"/></svg></span>
          <div class="miniStatBody">
            <div class="miniStatLabel">\u6E20\u9053\u6982\u89C8</div>
            <div class="miniStatValue" id="codex-fallback-status">\u672A\u914D\u7F6E</div>
          </div>
        </div>
      </div>

      <div class="fallbackTargets" id="codex-fallback-targets"></div>
      <div class="empty" id="codex-fallback-empty" style="display:none"><span class="empty-icon icon icon-xl"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12.5v5"/><circle cx="10" cy="10" r="1"/><path d="M6.46 6.46a5 5 0 0 1 7.08 0"/><path d="M4.34 4.34a8 8 0 0 1 11.32 0"/><path d="M7.5 17.5h5"/></svg></span>\u6682\u65E0 Codex \u6258\u5E95\u6E20\u9053\u3002\u70B9\u51FB\u300C\u65B0\u589E\u6E20\u9053\u300D\u5F00\u59CB\u914D\u7F6E\u3002</div>

      <div class="settingsFooter">
        <div class="settingsActions">
          <button class="btn primary" id="save-codex-fallback-config-btn">\u4FDD\u5B58\u6E20\u9053\u914D\u7F6E</button>
          <button class="btn" id="reload-codex-fallback-config-btn">\u91CD\u65B0\u8F7D\u5165</button>
          <div id="codex-config-message" class="message info"></div>
        </div>
        <div class="settingsTips">
          <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 17.5H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2h8.59a1 1 0 0 1 .7.29l3.92 3.92a1 1 0 0 1 .29.7V15.5a2 2 0 0 1-2 2z"/><path d="M13.5 17.5v-5h-7v5"/><path d="M6.5 2.5v3h5"/></svg></span>\u4FDD\u5B58\u540E\u5199\u5165 bridge \u6839\u76EE\u5F55 .env\uFF0C\u5E76\u7ACB\u5373\u5E94\u7528\u5230\u5F53\u524D\u8FDB\u7A0B\u3002API Key \u9ED8\u8BA4\u9690\u85CF\uFF0C\u53EF\u7528\u53F3\u4FA7\u300C\u773C\u775B\u300D\u6309\u94AE\u5207\u6362\u663E\u793A\u6216\u9690\u85CF\u3002</div>
          <div class="settingsTip"><span class="settingsTipIcon icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4"/><path d="M5 9l5-5 5 5"/></svg></span>\u5217\u8868\u987A\u5E8F\u5C31\u662F\u5140\u5E95\u5C1D\u8BD5\u987A\u5E8F\uFF0C\u53EF\u7528\u300C\u4E0A\u79FB / \u4E0B\u79FB\u300D\u8C03\u6574\u3002</div>
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
const ICONS = {
  'chain-link': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 4.95 0l2.12-2.12a3.5 3.5 0 0 0-4.95-4.95L9.5 5.5"/><path d="M11.5 8.5a3.5 3.5 0 0 0-4.95 0L4.43 10.62a3.5 3.5 0 0 0 4.95 4.95l1.12-1.07"/></svg>',
  'document': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V6.5L12 2.5z"/><path d="M12 2.5v4h4"/><path d="M7 10.5h6M7 13.5h4"/></svg>',
  'antenna': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12.5v5"/><circle cx="10" cy="10" r="1"/><path d="M6.46 6.46a5 5 0 0 1 7.08 0"/><path d="M4.34 4.34a8 8 0 0 1 11.32 0"/><path d="M7.5 17.5h5"/></svg>',
  'save': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 17.5H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2h8.59a1 1 0 0 1 .7.29l3.92 3.92a1 1 0 0 1 .29.7V15.5a2 2 0 0 1-2 2z"/><path d="M13.5 17.5v-5h-7v5"/><path d="M6.5 2.5v3h5"/></svg>',
  'arrow-up': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4"/><path d="M5 9l5-5 5 5"/></svg>',
  'sparkle': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8L10 2z"/></svg>',
  'alert': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.57 3.81L1.92 15.09a1.64 1.64 0 0 0 1.43 2.41h13.3a1.64 1.64 0 0 0 1.43-2.41L11.43 3.81a1.64 1.64 0 0 0-2.86 0z"/><path d="M10 7.5v3.5"/><circle cx="10" cy="14" r=".5" fill="currentColor" stroke="none"/></svg>',
  'lightbulb': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5v1a2 2 0 0 0 4 0v-1"/><path d="M8 14.5a5 5 0 1 1 4 0"/><path d="M8.5 17h3"/></svg>',
  'refresh': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5v4.5h4.5"/><path d="M16.5 16.5v-4.5h-4.5"/><path d="M14.74 7a6 6 0 0 0-10.19.95"/><path d="M5.26 13a6 6 0 0 0 10.19-.95"/></svg>',
  'info': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.5"/><circle cx="10" cy="6.75" r=".5" fill="currentColor" stroke="none"/></svg>',
  'check-circle': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M6.5 10l2.5 2.5 4.5-5"/></svg>',
  'warning': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.57 3.81L1.92 15.09a1.64 1.64 0 0 0 1.43 2.41h13.3a1.64 1.64 0 0 0 1.43-2.41L11.43 3.81a1.64 1.64 0 0 0-2.86 0z"/><path d="M10 7.5v3.5"/><circle cx="10" cy="14" r=".5" fill="currentColor" stroke="none"/></svg>',
  'x-circle': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/></svg>',
  'chevron-up': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l5-5 5 5"/></svg>',
  'chevron-down': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5l5 5 5-5"/></svg>',
  'zap': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2L4.5 11h5l-1 7L15.5 9h-5L11 2z"/></svg>',
  'x-mark': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  'chevron-sm': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4"/></svg>',
  'eye': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><circle cx="10" cy="10" r="2.5"/></svg>',
  'eye-off': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l14 14"/><path d="M10 5c3.5 0 7 3 7.5 5-.3 1.1-1.4 2.7-3.1 3.9M14 14.5C12.8 15.4 11.4 16 10 16c-5 0-8-6-8-6s1.2-2.4 3.3-4"/><path d="M8.1 8.1a2.5 2.5 0 0 0 3.4 3.4"/></svg>',
  'puzzle': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3.5h5a1 1 0 0 1 1 1v2a2 2 0 1 1 0 4v2a1 1 0 0 1-1 1h-2a2 2 0 1 1-4 0h-2a1 1 0 0 1-1-1v-2a2 2 0 1 1 0-4v-2a1 1 0 0 1 1-1h2a2 2 0 1 1 4 0z"/></svg>',
  'clipboard': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="14" rx="1.5"/><path d="M7.5 2.5h5a1 1 0 0 1 1 1v1h-7v-1a1 1 0 0 1 1-1z"/><path d="M7 9.5h6M7 12.5h4"/></svg>',
};
function icon(name, cls) { return '<span class="icon' + (cls ? ' ' + cls : '') + '">' + (ICONS[name] || '') + '</span>'; }
const els = {
  primaryTopbar: document.getElementById('primary-topbar'),
  gatewayDot: document.getElementById('gateway-dot'),
  gatewaySummary: document.getElementById('gateway-summary'),
  overviewKv: document.getElementById('overview-kv'),
  snapshotList: document.getElementById('snapshot-list'),
  actionMessage: document.getElementById('action-message'),
  configMessage: document.getElementById('config-message'),
  codexOverviewKv: document.getElementById('codex-overview-kv'),
  codexImportMode: document.getElementById('codex-import-mode'),
  codexAccountIdField: document.getElementById('codex-account-id-field'),
  codexAccountId: document.getElementById('codex-account-id'),
  codexAccountNameField: document.getElementById('codex-account-name-field'),
  codexAccountName: document.getElementById('codex-account-name'),
  codexAccountModelField: document.getElementById('codex-account-model-field'),
  codexAccountModel: document.getElementById('codex-account-model'),
  codexOauthActionField: document.getElementById('codex-oauth-action-field'),
  codexAccountBaseUrlField: document.getElementById('codex-account-base-url-field'),
  codexAccountBaseUrl: document.getElementById('codex-account-base-url'),
  codexCredentialField: document.getElementById('codex-credential-field'),
  codexCredentialLabel: document.getElementById('codex-credential-label'),
  codexCredentialBundle: document.getElementById('codex-credential-bundle'),
  codexCredentialHint: document.getElementById('codex-credential-hint'),
  startCodexOauthBtn: document.getElementById('start-codex-oauth-btn'),
  importCodexAccountBtn: document.getElementById('import-codex-account-btn'),
  codexMessage: document.getElementById('codex-message'),
  codexAccountList: document.getElementById('codex-account-list'),
  codexFallbackTargets: document.getElementById('codex-fallback-targets'),
  codexFallbackEmpty: document.getElementById('codex-fallback-empty'),
  codexFallbackStatus: document.getElementById('codex-fallback-status'),
  addCodexFallbackTargetBtn: document.getElementById('add-codex-fallback-target-btn'),
  saveCodexFallbackConfigBtn: document.getElementById('save-codex-fallback-config-btn'),
  reloadCodexFallbackConfigBtn: document.getElementById('reload-codex-fallback-config-btn'),
  codexConfigMessage: document.getElementById('codex-config-message'),
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
const claudeSectionButtons = Array.from(document.querySelectorAll('[data-claude-section-btn]'));
const claudeSections = Array.from(document.querySelectorAll('[data-claude-section]'));
const codexSectionButtons = Array.from(document.querySelectorAll('[data-codex-section-btn]'));
const codexSections = Array.from(document.querySelectorAll('[data-codex-section]'));
const desktopBridge = typeof window !== 'undefined' && window.accioBridgeDesktop ? window.accioBridgeDesktop : null;
const isElectronShell = String(navigator.userAgent || '').includes('Electron/') || Boolean(desktopBridge);
let messageTimer = null;
let configMessageTimer = null;
let codexMessageTimer = null;
let codexConfigMessageTimer = null;
let currentTab = 'claude';
let refreshInFlight = null;
let stateStream = null;
let fallbackDraft = [];
let codexFallbackDraft = [];
let logEntries = [];
let logsLoaded = false;
let refreshLogsInFlight = null;
let logFollow = true;
let latestLogSeq = 0;
let activeCodexOauthFlowId = null;
let currentClaudeSection = 'accounts';
const cancelledLoginFlows = new Set();
const MAX_RENDERED_LOGS = 300;
const MSG_ICONS = { info: ICONS['info'], ok: ICONS['check-circle'], warn: ICONS['warning'], error: ICONS['x-circle'] };
const CODEX_OAUTH_FLOW_STORAGE_KEY = 'accio-codex-oauth-flow-id';
const CLAUDE_SECTION_STORAGE_KEY = 'accio-admin-claude-section';

function readStoredCodexOauthFlowId() {
  try {
    return localStorage.getItem(CODEX_OAUTH_FLOW_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function persistCodexOauthFlowId(flowId) {
  activeCodexOauthFlowId = flowId ? String(flowId) : null;
  try {
    if (activeCodexOauthFlowId) {
      localStorage.setItem(CODEX_OAUTH_FLOW_STORAGE_KEY, activeCodexOauthFlowId);
    } else {
      localStorage.removeItem(CODEX_OAUTH_FLOW_STORAGE_KEY);
    }
  } catch (_) {}
}

function readStoredClaudeSection() {
  try {
    return localStorage.getItem(CLAUDE_SECTION_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function switchClaudeSection(section) {
  const active = ['actions', 'accounts', 'fallbacks'].includes(String(section))
    ? String(section)
    : 'accounts';
  currentClaudeSection = active;
  claudeSectionButtons.forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-claude-section-btn') === active);
  });
  claudeSections.forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-claude-section') === active);
  });
  try {
    localStorage.setItem(CLAUDE_SECTION_STORAGE_KEY, active);
  } catch (_) {}
}

const CODEX_SECTION_STORAGE_KEY = 'accio-admin-codex-section';
let currentCodexSection = 'accounts';

function readStoredCodexSection() {
  try {
    return localStorage.getItem(CODEX_SECTION_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function switchCodexSection(section) {
  const active = ['accounts', 'fallbacks'].includes(String(section))
    ? String(section)
    : 'accounts';
  currentCodexSection = active;
  codexSectionButtons.forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-codex-section-btn') === active);
  });
  codexSections.forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-codex-section') === active);
  });
  try {
    localStorage.setItem(CODEX_SECTION_STORAGE_KEY, active);
  } catch (_) {}
}

function currentCodexImportMode() {
  return els.codexImportMode && els.codexImportMode.value === 'json-bundle'
    ? 'json-bundle'
    : 'openai-oauth';
}

function currentCodexAccountModel() {
  return els.codexAccountModel && els.codexAccountModel.value
    ? els.codexAccountModel.value.trim()
    : 'gpt-5.4';
}

function updateCodexImportUi() {
  const mode = currentCodexImportMode();
  const isOauth = mode === 'openai-oauth';
  if (els.codexAccountIdField) {
    els.codexAccountIdField.style.display = isOauth ? 'none' : '';
  }
  if (els.codexAccountNameField) {
    els.codexAccountNameField.style.display = '';
  }
  if (els.codexAccountBaseUrlField) {
    els.codexAccountBaseUrlField.style.display = isOauth ? 'none' : '';
  }
  if (els.codexOauthActionField) {
    els.codexOauthActionField.style.display = isOauth ? '' : 'none';
  }
  if (els.codexCredentialLabel) {
    els.codexCredentialLabel.textContent = mode === 'openai-oauth'
      ? 'OpenAI OAuth 回调 URL'
      : 'OpenAI OAuth 凭证 JSON';
  }
  if (els.codexCredentialBundle) {
    els.codexCredentialBundle.placeholder = mode === 'openai-oauth'
      ? '粘贴 http://localhost:1455/auth/callback?code=...&state=...'
      : '{"auth_mode":"chatgpt","tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}';
  }
  if (els.codexCredentialHint) {
    els.codexCredentialHint.innerHTML = mode === 'openai-oauth'
      ? '点击下方 <code>Codex 授权</code> 后会打开 OpenAI 登录页。完成登录后，bridge 会自动接收回调并写入号池。'
      : '支持直接粘贴 OpenAI OAuth 返回的 auth JSON。若其中包含 <code>tokens.account_id</code>，账号 ID 可以留空自动提取。';
  }
  if (els.importCodexAccountBtn) {
    els.importCodexAccountBtn.textContent = mode === 'openai-oauth'
      ? '完成授权并导入'
      : '添加 Codex 账号';
    els.importCodexAccountBtn.style.display = isOauth ? 'none' : '';
  }
  if (els.startCodexOauthBtn) {
    els.startCodexOauthBtn.style.display = mode === 'openai-oauth' ? '' : 'none';
  }
  if (els.codexCredentialField) {
    els.codexCredentialField.style.display = isOauth ? 'none' : '';
  }
}
function setScopedMessage(target, type, text, scope) {
  if (!target) {
    return;
  }

  if (scope === 'config' || scope === 'codex-config') {
    if (configMessageTimer) { clearTimeout(configMessageTimer); configMessageTimer = null; }
    if (codexConfigMessageTimer) { clearTimeout(codexConfigMessageTimer); codexConfigMessageTimer = null; }
  } else if (scope === 'codex-action') {
    if (codexMessageTimer) { clearTimeout(codexMessageTimer); codexMessageTimer = null; }
  } else if (messageTimer) {
    clearTimeout(messageTimer);
    messageTimer = null;
  }

  target.className = 'message show ' + type;
  target.innerHTML = '<span class="msg-icon">' + (MSG_ICONS[type] || '') + '</span><span class="msg-text">' + escapeInline(text) + '</span><button class="msg-close" onclick="' + (
    scope === 'config'
      ? 'clearConfigMessage()'
      : scope === 'codex-config'
        ? 'clearCodexConfigMessage()'
        : scope === 'codex-action'
          ? 'clearCodexMessage()'
          : 'clearMessage()'
  ) + '">×</button>';
  if (type === 'ok') {
    const timer = setTimeout(function() {
      if (scope === 'config') {
        clearConfigMessage();
      } else if (scope === 'codex-config') {
        clearCodexConfigMessage();
      } else if (scope === 'codex-action') {
        clearCodexMessage();
      } else {
        clearMessage();
      }
    }, 6000);
    if (scope === 'config') {
      configMessageTimer = timer;
    } else if (scope === 'codex-config') {
      codexConfigMessageTimer = timer;
    } else if (scope === 'codex-action') {
      codexMessageTimer = timer;
    } else {
      messageTimer = timer;
    }
  }
}
function setMessage(type, text) {
  setScopedMessage(els.actionMessage, type, text, 'action');
}
function setCodexMessage(type, text) {
  if (codexMessageTimer) { clearTimeout(codexMessageTimer); codexMessageTimer = null; }
  setScopedMessage(els.codexMessage, type, text, 'codex-action');
  if (type === 'ok') {
    codexMessageTimer = setTimeout(() => clearCodexMessage(), 6000);
  }
}
function clearMessage() {
  if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
  els.actionMessage.className = 'message info';
  els.actionMessage.innerHTML = '';
}
function clearCodexMessage() {
  if (codexMessageTimer) { clearTimeout(codexMessageTimer); codexMessageTimer = null; }
  if (!els.codexMessage) {
    return;
  }
  els.codexMessage.className = 'message info';
  els.codexMessage.innerHTML = '';
}
function setConfigMessage(type, text) {
  setScopedMessage(els.configMessage, type, text, 'config');
}
function setCodexConfigMessage(type, text) {
  if (codexConfigMessageTimer) { clearTimeout(codexConfigMessageTimer); codexConfigMessageTimer = null; }
  setScopedMessage(els.codexConfigMessage, type, text, 'codex-config');
  if (type === 'ok') {
    codexConfigMessageTimer = setTimeout(() => clearCodexConfigMessage(), 6000);
  }
}
function clearConfigMessage() {
  if (configMessageTimer) { clearTimeout(configMessageTimer); configMessageTimer = null; }
  if (!els.configMessage) {
    return;
  }
  els.configMessage.className = 'message info';
  els.configMessage.innerHTML = '';
}
function clearCodexConfigMessage() {
  if (codexConfigMessageTimer) { clearTimeout(codexConfigMessageTimer); codexConfigMessageTimer = null; }
  if (!els.codexConfigMessage) {
    return;
  }
  els.codexConfigMessage.className = 'message info';
  els.codexConfigMessage.innerHTML = '';
}
function switchTab(tab) {
  const active = ['claude', 'codex', 'logs'].includes(String(tab)) ? String(tab) : 'claude';
  currentTab = active;
  tabButtons.forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-tab') === active);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === active);
  });
  if (els.primaryTopbar) {
    const hideTopbar = active !== 'claude';
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
function buildSnapshotStandbyMap(data) {
  const standby = data && data.accountStandby ? data.accountStandby : null;
  return new Map(
    [
      ...(Array.isArray(standby && standby.candidates) ? standby.candidates : []),
      ...(Array.isArray(standby && standby.cooldownCandidates) ? standby.cooldownCandidates : [])
    ]
      .filter((item) => item && item.accountId)
      .map((item) => [String(item.accountId), item])
  );
}
function getSnapshotFailureReason(snapshot, standbyByAccountId) {
  const accountState = snapshot && snapshot.accountState ? snapshot.accountState : null;
  const standbyEntry = accountState && accountState.id ? standbyByAccountId.get(String(accountState.id)) : null;
  return standbyEntry && standbyEntry.reason
    ? String(standbyEntry.reason)
    : (accountState && accountState.lastFailure && accountState.lastFailure.reason
      ? String(accountState.lastFailure.reason)
      : '');
}
function getSnapshotUiAvailability(snapshot, standbyByAccountId, nowMs = Date.now()) {
  const accountState = snapshot && snapshot.accountState ? snapshot.accountState : null;
  const quota = snapshot && snapshot.quota ? snapshot.quota : null;
  const quotaIsCached = Boolean(quota && quota.stale);
  const quotaHasValue = quota && quota.available && typeof quota.usagePercent === 'number';
  const cooling = accountState && typeof accountState.invalidUntil === 'number' && accountState.invalidUntil > nowMs;
  const cooldownSeconds = cooling ? Math.max(0, Math.ceil((accountState.invalidUntil - nowMs) / 1000)) : 0;
  const standbyEntry = accountState && accountState.id ? standbyByAccountId.get(String(accountState.id)) : null;
  const rawLastFailure = getSnapshotFailureReason(snapshot, standbyByAccountId);
  const normalizedLastFailure = rawLastFailure.trim().toLowerCase();
  const blockedByBusinessReason = normalizedLastFailure && (
    /blocked by sentinel rate limit/.test(normalizedLastFailure) ||
    /user blocked/.test(normalizedLastFailure) ||
    /user not activated|not activated/.test(normalizedLastFailure) ||
    /auth not pass/.test(normalizedLastFailure)
  );

  if (!accountState) {
    return { usable: false, status: '不可用', reason: '未关联到 bridge 账号池，当前不会参与调度。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (accountState.enabled === false) {
    return { usable: false, status: '不可用', reason: '账号已停用。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (!accountState.hasToken) {
    return { usable: false, status: '不可用', reason: '缺少 access token。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (accountState.expiresAt && Number(accountState.expiresAt) <= nowMs) {
    return { usable: false, status: '不可用', reason: 'access token 已过期。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (cooling) {
    return {
      usable: false,
      status: '不可用',
      reason: standbyEntry && standbyEntry.nextCheckAt
        ? ('账号冷却中，预计 ' + formatTime(standbyEntry.nextCheckAt) + ' 后恢复。')
        : ('账号冷却中，约 ' + formatCountdown(cooldownSeconds) + ' 后恢复。'),
      rawLastFailure,
      cooling,
      cooldownSeconds,
      standbyEntry,
      quotaHasValue,
      quotaIsCached
    };
  }

  if (blockedByBusinessReason) {
    return {
      usable: false,
      status: '不可用',
      reason: '最近请求被业务侧拒绝：' + escapeInline(rawLastFailure),
      rawLastFailure,
      cooling,
      cooldownSeconds,
      standbyEntry,
      quotaHasValue,
      quotaIsCached
    };
  }

  if (!quotaHasValue) {
    if (quota && quota.error === 'missing_auth_payload') {
      return { usable: false, status: '不可用', reason: '缺少完整凭证，无法确认额度。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
    }

    if (quota && quota.error === 'quota_unverified_for_inactive_account') {
      return { usable: false, status: '不可用', reason: '额度尚未验证，未进入可用队列。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
    }

    if (quota && quota.error) {
      return { usable: false, status: '不可用', reason: '额度查询失败：' + escapeInline(String(quota.error)), rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
    }

    return { usable: false, status: '不可用', reason: '额度状态未知。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (quota.usagePercent >= 100) {
    return { usable: false, status: '不可用', reason: '额度已满，等待恢复。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  if (quotaIsCached) {
    return { usable: false, status: '不可用', reason: '只有缓存额度，尚未完成实时确认。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
  }

  return { usable: true, status: '可用', reason: '账号启用、token 有效且实时额度可用。', rawLastFailure, cooling, cooldownSeconds, standbyEntry, quotaHasValue, quotaIsCached };
}
function getSnapshotUiCounts(data) {
  const snapshots = Array.isArray(data && data.snapshots) ? data.snapshots : [];
  const standbyByAccountId = buildSnapshotStandbyMap(data);
  const seen = new Set();
  let usable = 0;
  let total = 0;

  snapshots.forEach((snapshot) => {
    const accountState = snapshot && snapshot.accountState ? snapshot.accountState : null;
    const key = accountState && accountState.id ? String(accountState.id) : String(snapshot && snapshot.alias ? snapshot.alias : '');
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    total++;
    const availability = getSnapshotUiAvailability(snapshot, standbyByAccountId);
    if (availability.usable) {
      usable++;
    }
  });

  return { usable, total };
}
function bridgeBadgeState(data) {
  const runtime = data && data.authRuntime ? data.authRuntime : null;
  if (!runtime) {
    return ['warn', 'Bridge 状态未知'];
  }

  const activeAccountId = runtime.activeAccount ? String(runtime.activeAccount) : '';
  const counts = getSnapshotUiCounts(data);
  const usableAccounts = counts.total > 0 ? counts.usable : Number(runtime.usableAccounts || 0);
  const totalAccounts = counts.total > 0 ? counts.total : Number(runtime.totalAccounts || 0);

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
  const themeLabel = activity.theme === 'codex' ? 'Codex' : 'Claude';

  if (transport === 'external-anthropic') {
    return themeLabel + ' · 外部 Anthropic · ' + model;
  }

  if (transport === 'external-openai') {
    return themeLabel + ' · 外部 OpenAI · ' + model;
  }

  if (transport === 'local-ws') {
    return themeLabel + ' · Accio local-ws · ' + model;
  }

  if (transport === 'codex-responses') {
    if (accountLabel) {
      return 'Codex · 号池直连 · ' + accountLabel + ' · ' + model;
    }

    return 'Codex · Responses 直连 · ' + model;
  }

  if (transport === 'direct-llm') {
    if (accountLabel) {
      return themeLabel + ' · 号池直连 · ' + accountLabel + ' · ' + model;
    }

    return themeLabel + ' · Bridge 直连 · ' + model;
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
    const counts = getSnapshotUiCounts(data);
    const usableAccounts = counts.total > 0 ? counts.usable : Number(runtime.usableAccounts || 0);
    parts.push('可用 ' + String(runtime.usableAccounts || 0) + ' 个');
    parts[parts.length - 1] = '可用 ' + String(usableAccounts) + ' 个';
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
  const standby = data && data.accountStandby ? data.accountStandby : null;
  if (!runtime) {
    return '未知';
  }
  const counts = getSnapshotUiCounts(data);
  const usableAccounts = counts.total > 0 ? counts.usable : Number(runtime.usableAccounts || 0);
  const totalAccounts = counts.total > 0 ? counts.total : Number(runtime.totalAccounts || 0);

  const parts = [
    '已加载 ' + String(totalAccounts) + ' 个',
    '本地可用 ' + String(usableAccounts) + ' 个'
  ];

  if (standby && standby.enabled !== false) {
    parts.push('待机就绪 ' + String(standby.readyCount || 0) + ' 个');
  }

  if ((runtime.fileAccounts || 0) > 0 || (runtime.envAccounts || 0) > 0) {
    parts.push('文件 ' + String(runtime.fileAccounts || 0) + ' / 环境 ' + String(runtime.envAccounts || 0));
  }

  return parts.join(' · ');
}
function describeCodexAuthPoolCompact(data) {
  const runtime = data && data.codexAuthRuntime ? data.codexAuthRuntime : null;
  if (!runtime) {
    return '未知';
  }

  return [
    '已加载 ' + String(runtime.totalAccounts || 0) + ' 个',
    '本地可用 ' + String(runtime.usableAccounts || 0) + ' 个'
  ].join(' · ');
}
function describeCodexActiveAccountCompact(data) {
  const activeAccountId = data && data.codexAuthRuntime && data.codexAuthRuntime.activeAccount
    ? String(data.codexAuthRuntime.activeAccount)
    : '';
  return activeAccountId || '未设置';
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
function collectFallbackDraftFrom(container) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll('[data-fallback-item]')).map((item, index) => normalizeFallbackDraftTarget({
    id: item.getAttribute('data-fallback-id') || ('draft_' + index),
    name: item.querySelector('[data-field=\"name\"]') ? item.querySelector('[data-field=\"name\"]').value.trim() : '',
    enabled: item.querySelector('[data-field=\"enabled\"]') ? item.querySelector('[data-field=\"enabled\"]').checked : true,
    protocol: item.querySelector('[data-field=\"protocol\"]') ? item.querySelector('[data-field=\"protocol\"]').value : 'openai',
    baseUrl: item.querySelector('[data-field=\"baseUrl\"]') ? item.querySelector('[data-field=\"baseUrl\"]').value.trim() : '',
    apiKey: (() => {
      const input = item.querySelector('[data-field=\"apiKey\"]');
      if (!input) {
        return '';
      }
      return input.value.trim();
    })(),
    model: item.querySelector('[data-field=\"model\"]') ? item.querySelector('[data-field=\"model\"]').value.trim() : '',
    supportedModels: item.querySelector('[data-field=\"supportedModels\"]') ? item.querySelector('[data-field=\"supportedModels\"]').value.trim() : '',
    reasoningEffort: item.querySelector('[data-field=\"reasoningEffort\"]') ? item.querySelector('[data-field=\"reasoningEffort\"]').value : '',
    anthropicVersion: item.querySelector('[data-field=\"anthropicVersion\"]') ? item.querySelector('[data-field=\"anthropicVersion\"]').value.trim() : '2023-06-01',
    timeoutMs: item.querySelector('[data-field=\"timeoutMs\"]') ? Number(item.querySelector('[data-field=\"timeoutMs\"]').value || 60000) : 60000
  }, index));
}
function collectFallbackDraft() {
  return collectFallbackDraftFrom(els.fallbackTargets);
}
function collectCodexFallbackDraft() {
  return collectFallbackDraftFrom(els.codexFallbackTargets);
}
function renderFallbackTargetsInto(container, emptyEl, draft) {
  if (!container || !emptyEl) {
    return;
  }

  // 记录当前已展开的卡片，其余默认折叠
  const expandedIds = new Set();
  container.querySelectorAll('[data-fallback-item]:not([data-collapsed="true"])').forEach((el) => {
    const id = el.getAttribute('data-fallback-id');
    if (id) expandedIds.add(id);
  });

  const targets = Array.isArray(draft) ? draft : [];
  emptyEl.style.display = targets.length === 0 ? '' : 'none';
  container.innerHTML = targets.map((target, index) => {
    const protocolLabel = target.protocol === 'anthropic'
      ? 'Anthropic Messages'
      : (target.protocol === 'openai-chat-completions'
        ? 'OpenAI Chat Completions'
        : (target.protocol === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI Auto'));
    const enabledAttr = target.enabled ? 'true' : 'false';
    const apiKeyValue = escapeInline(target.apiKey);
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
      + '<button class="btn" type="button" data-move-up-fallback="' + escapeInline(target.id) + '"' + (index === 0 ? ' disabled' : '') + '>' + icon('chevron-up') + ' 上移</button>'
      + '<button class="btn" type="button" data-move-down-fallback="' + escapeInline(target.id) + '"' + (index === targets.length - 1 ? ' disabled' : '') + '>' + icon('chevron-down') + ' 下移</button>'
      + '<button class="btn" type="button" data-test-fallback="' + escapeInline(target.id) + '">' + icon('zap') + ' 测试</button>'
      + '<button class="btn warn" type="button" data-delete-fallback="' + escapeInline(target.id) + '">' + icon('x-mark') + ' 删除</button>'
      + '<button class="fallbackCollapseBtn" type="button" data-collapse-fallback="' + escapeInline(target.id) + '" title="折叠/展开">' + icon('chevron-sm') + '</button>'
      + '</div>'
      + '</div>'
      + '<div class="fallbackCardBody">'
      + '<div class="settingsGrid">'
      + '<div class="field"><label>名称</label><input data-field="name" type="text" value="' + escapeInline(target.name) + '" placeholder="渠道 1" autocomplete="off" /></div>'
      + '<div class="field"><label>协议</label><select data-field="protocol"><option value="openai"' + (target.protocol === 'openai' ? ' selected' : '') + '>OpenAI Auto</option><option value="openai-chat-completions"' + (target.protocol === 'openai-chat-completions' ? ' selected' : '') + '>OpenAI Chat Completions</option><option value="openai-responses"' + (target.protocol === 'openai-responses' ? ' selected' : '') + '>OpenAI Responses</option><option value="anthropic"' + (target.protocol === 'anthropic' ? ' selected' : '') + '>Anthropic Messages</option></select></div>'
      + '<div class="field wide"><label>Base URL</label><input data-field="baseUrl" type="text" value="' + escapeInline(target.baseUrl) + '" placeholder="https://your-upstream-host/v1" autocomplete="off" /></div>'
      + '<div class="field wide"><label>API Key</label><div class="inputWrap"><input data-field="apiKey" type="password" value="' + apiKeyValue + '" placeholder="sk-..." autocomplete="off" autocapitalize="off" spellcheck="false" /><button class="inputToggle" type="button" data-toggle-secret="' + escapeInline(target.id) + '" aria-label="显示 API Key" title="显示或隐藏 API Key">' + icon('eye') + '</button></div><div class="fieldHint tight"></div></div>'
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
function renderFallbackTargets() {
  renderFallbackTargetsInto(els.fallbackTargets, els.fallbackEmpty, fallbackDraft);
}
function renderCodexFallbackTargets() {
  renderFallbackTargetsInto(els.codexFallbackTargets, els.codexFallbackEmpty, codexFallbackDraft);
}
function updateFallbackStatusLabel(statusEl, draft) {
  if (!statusEl) return;
  const enabledTargets = (Array.isArray(draft) ? draft : []).filter((target) => target.enabled !== false && target.baseUrl && target.apiKey && target.model);
  statusEl.textContent = enabledTargets.length > 0
    ? ('已配置 ' + enabledTargets.length + ' 条 · 首选 ' + (enabledTargets[0].name || enabledTargets[0].model || 'external-upstream'))
    : '未配置';
}
function renderSettings(data) {
  const targets = data && data.settings && data.settings.fallbacks && Array.isArray(data.settings.fallbacks.targets)
    ? data.settings.fallbacks.targets
    : [];
  fallbackDraft = targets.map((target, index) => normalizeFallbackDraftTarget(target, index));
  renderFallbackTargets();
  updateFallbackStatusLabel(els.fallbackStatus, fallbackDraft);
  if (els.fallbackEnvPath) els.fallbackEnvPath.textContent = data && data.bridge && data.bridge.envPath ? data.bridge.envPath : '.env';
}
function renderCodexSettings(data) {
  const targets = data && data.settings && data.settings.codex && data.settings.codex.fallbacks && Array.isArray(data.settings.codex.fallbacks.targets)
    ? data.settings.codex.fallbacks.targets
    : [];
  codexFallbackDraft = targets.map((target, index) => normalizeFallbackDraftTarget(target, index));
  renderCodexFallbackTargets();
  updateFallbackStatusLabel(els.codexFallbackStatus, codexFallbackDraft);
}
async function loadFallbackConfig() {
  const payload = await api('/admin/api/config');
  renderSettings({ settings: payload.settings, bridge: payload.bridge });
  renderCodexSettings({ settings: payload.settings, bridge: payload.bridge });
}

function renderCodexPanel(data) {
  if (els.codexOverviewKv) {
    const activity = data && data.recentActivity && data.recentActivity.theme === 'codex'
      ? data.recentActivity
      : null;
    renderKv(els.codexOverviewKv, [
      ['最近请求', describeRecentActivityCompact(activity)],
      ['Codex 池', describeCodexAuthPoolCompact(data)],
      ['默认账号', describeCodexActiveAccountCompact(data)]
    ]);
  }

  if (els.codexAccountList) {
    const accounts = Array.isArray(data && data.codexAccounts) ? data.codexAccounts : [];
    const activeAccountId = data && data.codexAuthRuntime && data.codexAuthRuntime.activeAccount
      ? String(data.codexAuthRuntime.activeAccount)
      : '';

    if (accounts.length === 0) {
      els.codexAccountList.innerHTML = '<div class="empty">' + icon('puzzle', 'icon-xl') + '还没有 Codex 凭证。把登录凭证包粘贴到上方后点击“导入 Codex 凭证”。</div>';
    } else {
      els.codexAccountList.innerHTML = accounts.map((account) => {
        const current = activeAccountId && String(account.id || '') === activeAccountId;
        const status = account.enabled
          ? (account.invalidUntil ? '冷却中' : '可用')
          : '已停用';
        const canTest = account.hasCredentialBundle;
        const importModeLabel = account.authMode === 'chatgpt' || account.source === 'codex-openai-oauth'
          ? 'OpenAI OAuth'
          : 'JSON 凭证';
        return '<div class="item">'
          + '<div class="itemAvatar">' + escapeInline(String(account.name || account.id || 'C').slice(0, 1).toUpperCase()) + '</div>'
          + '<div class="itemTitleRow">'
          + '<h3 class="itemTitle">' + escapeInline(account.name || account.id || 'Codex') + '</h3>'
          + (current ? '<span class="pill current">默认</span>' : '')
          + '</div>'
          + '<div class="itemMeta">' + escapeInline(account.id || '') + '</div>'
          + '<div class="itemMeta">导入方式：' + escapeInline(importModeLabel) + '</div>'
          + '<div class="itemMeta">状态：' + escapeInline(status) + '</div>'
          + (account.model ? '<div class="itemMeta">模型：' + escapeInline(account.model) + '</div>' : '')
          + ((account.authMode === 'chatgpt' || account.source === 'codex-openai-oauth')
            ? ''
            : '<div class="itemMeta">Base URL：' + escapeInline(account.baseUrl || 'https://api.openai.com/v1') + '</div>')
          + (account.lastFailure && account.lastFailure.reason ? '<div class="itemMeta hint">最近失败：' + escapeInline(account.lastFailure.reason) + '</div>' : '')
          + '<div class="itemSpacer"></div>'
          + '<div class="actionRow">'
          + '<button class="btn" data-codex-account-test="' + escapeInline(account.id) + '"' + (canTest ? '' : ' disabled title="该账号缺少可测试凭证"') + '>测试</button>'
          + '<button class="btn" data-codex-account-default="' + escapeInline(account.id) + '"' + (current ? ' disabled' : '') + '>设为默认</button>'
          + '<button class="btn" data-codex-account-toggle="' + escapeInline(account.id) + '" data-codex-enabled="' + (account.enabled ? 'true' : 'false') + '">' + (account.enabled ? '停用' : '启用') + '</button>'
          + '<button class="btn warn" data-codex-account-delete="' + escapeInline(account.id) + '">删除</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }
  }

}

function renderSnapshots(data) {
  const snapshots = data.snapshots || [];
  const currentUserId = data.gateway && data.gateway.user && data.gateway.user.id ? String(data.gateway.user.id) : '';
  const activeAccountId = data && data.authRuntime && data.authRuntime.activeAccount ? String(data.authRuntime.activeAccount) : '';
  const standbyByAccountId = buildSnapshotStandbyMap(data);
  if (snapshots.length === 0) {
    els.snapshotList.innerHTML = '<div class="empty">' + icon('clipboard', 'icon-xl') + '还没有已记录账号。点击左侧"添加账号登录"完成第一个 Accio 登录吧！</div>';
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
    const quotaIsCached = Boolean(quota && quota.stale);
    const quotaHasValue = quota && quota.available && typeof quota.usagePercent === 'number';
    const quotaStatus = quotaHasValue
      ? (quotaIsCached
        ? ('缓存：已用 ' + Math.round(quota.usagePercent) + '%')
        : ('实时：已用 ' + Math.round(quota.usagePercent) + '%'))
      : (quota && quota.error === 'missing_auth_payload'
        ? '未知（缺少完整凭证）'
        : (quota && quota.error === 'quota_unverified_for_inactive_account'
          ? '待验证'
          : (quota && quotaIsCached
            ? '暂无缓存'
            : '未知')));
    const refreshStatus = quotaHasValue && typeof quota.refreshCountdownSeconds === 'number'
      ? formatCountdown(quota.refreshCountdownSeconds)
      : '未知';
    const quotaMeta = quota && quota.checkedAt
      ? ((quotaIsCached ? '缓存时间：' : '实时更新：') + formatTime(quota.checkedAt))
      : (quotaIsCached ? '未切换到该账号，暂无缓存额度' : '');
    const quotaHint = quotaHasValue
      ? (quotaIsCached
        ? ('这是最近一次记录的缓存额度，点击“实时刷新”可重新查询。预计 ' + refreshStatus + ' 后恢复。')
        : ('预计 ' + refreshStatus + ' 后恢复。'))
      : (quota && quota.error && !quotaIsCached
        ? ('实时查询失败：' + escapeInline(String(quota.error)))
        : '');
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
    const rawLastFailure = getSnapshotFailureReason(item, standbyByAccountId);
    const lastFailure = rawLastFailure ? escapeInline(rawLastFailure) : '';
    const standbyMeta = standbyEntry && standbyEntry.quotaCheckedAt
      ? (
          standbyEntry.nextCheckAt
            ? ('上次检查于 ' + formatTime(standbyEntry.quotaCheckedAt))
            : ('预检于 ' + formatTime(standbyEntry.quotaCheckedAt))
        )
      : '';
    const availability = getSnapshotUiAvailability(item, standbyByAccountId);

    return '<div class="' + itemClass + '" data-usable="' + (availability.usable ? 'yes' : 'no') + '">'
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
      + '<div class="itemMeta">调度状态：' + availability.status + '</div>'
      + (availability.reason ? '<div class="itemMeta hint">' + availability.reason + '</div>' : '')
      + '<div class="itemMeta">额度状态：' + quotaStatus + '</div>'
      + (quotaMeta ? '<div class="itemMeta hint">' + quotaMeta + '</div>' : '')
      + (quotaHint ? '<div class="itemMeta hint">' + quotaHint + '</div>' : '')
      + '<div class="itemMeta">等待区：' + standbyStatus + '</div>'
      + (standbyMeta ? '<div class="itemMeta hint">' + standbyMeta + '</div>' : '')
      + (lastFailure ? '<div class="itemMeta hint">最近失败：' + lastFailure + '</div>' : '')
      + (!item.hasAuthCallback ? '<div class="itemMeta hint">缺少原生回调，建议重新登录</div>' : '')
      + (!canActivate ? '<div class="itemMeta hint">该快照缺少完整登录槽位，不能直接切换。</div>' : '')
      + '<div class="itemSpacer"></div>'
      + '<div class="actionRow"><button class="btn" data-test-snapshot="' + item.alias + '"' + (item.hasAuthCallback ? '' : ' disabled title="该快照缺少可用凭证"') + '>实时刷新</button><button class="btn" data-activate-snapshot="' + item.alias + '"' + (canActivate ? '' : ' disabled title="请重新登录该账号后重新保存"') + '>' + (canActivate ? '切换' : '需补全') + '</button><button class="btn" data-delete-snapshot="' + item.alias + '">删除</button></div>'
      + '</div>';
  }).join('');
  applySnapshotFilter();
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
  renderCodexPanel(data);
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

function setCodexOauthPendingState(pending) {
  if (els.startCodexOauthBtn) {
    els.startCodexOauthBtn.disabled = Boolean(pending);
    els.startCodexOauthBtn.classList.toggle('loading', Boolean(pending));
    els.startCodexOauthBtn.textContent = pending ? '等待授权完成...' : 'Codex 授权';
  }
}

async function pollCodexOauth(flowId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastState = '';
  while (Date.now() < deadline) {
    const payload = await api('/admin/api/codex/oauth/status?flowId=' + encodeURIComponent(flowId));

    if (payload.completed) {
      return payload;
    }

    if (payload.state && payload.state !== lastState) {
      setCodexMessage('info', payload.message || '等待 Codex 授权完成。');
      lastState = payload.state;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error('等待 Codex 授权超时。');
}

async function observeCodexOauth(flowId) {
  setCodexOauthPendingState(true);
  try {
    const result = await pollCodexOauth(flowId);
    persistCodexOauthFlowId(null);
    await refreshState();
    if (result && result.state === 'oauth_failed') {
      setCodexMessage('error', result.note || 'Codex 授权失败。');
    } else {
      setCodexMessage('ok', (result && result.note) || 'Codex OAuth 已完成并写入号池。');
    }
  } catch (error) {
    persistCodexOauthFlowId(null);
    setCodexMessage('error', error && error.message ? error.message : String(error));
  } finally {
    if (activeCodexOauthFlowId === flowId) {
      activeCodexOauthFlowId = null;
    }
    setCodexOauthPendingState(false);
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
    if (currentTab === 'claude' || currentTab === 'codex') {
      refreshState().catch(() => {});
    }
  });
});

claudeSectionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    switchClaudeSection(button.getAttribute('data-claude-section-btn'));
  });
});

codexSectionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    switchCodexSection(button.getAttribute('data-codex-section-btn'));
  });
});

let snapshotFilterMode = 'all';
document.getElementById('snapshot-filter').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-snapshot-filter]');
  if (!btn) return;
  snapshotFilterMode = btn.getAttribute('data-snapshot-filter');
  document.querySelectorAll('#snapshot-filter .filterBtn').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
  applySnapshotFilter();
});
function applySnapshotFilter() {
  const items = els.snapshotList.querySelectorAll('.item');
  items.forEach((item) => {
    const usable = item.getAttribute('data-usable');
    if (snapshotFilterMode === 'all') {
      item.style.display = '';
    } else if (snapshotFilterMode === 'usable') {
      item.style.display = usable === 'yes' ? '' : 'none';
    } else {
      item.style.display = usable === 'no' ? '' : 'none';
    }
  });
}

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
      renderState(payload, { allowSettings: currentTab !== 'logs' });
    } catch (_) {}
  });
  stateStream.addEventListener('state_error', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (currentTab === 'codex') {
        setCodexMessage('error', (payload && payload.message) || '状态流更新失败。');
      } else if (currentTab === 'claude') {
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
  switchClaudeSection('actions');
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
  const testSnapshot = event.target.closest('[data-test-snapshot]');
  if (testSnapshot) {
    const alias = testSnapshot.getAttribute('data-test-snapshot');
    await withAction(testSnapshot, async () => {
      clearMessage();
      const payload = await api('/admin/api/snapshots/test', { method: 'POST', body: { alias } });
      await refreshState();
      const quota = payload && payload.quota ? payload.quota : null;
      const usageText = quota && typeof quota.usagePercent === 'number'
        ? ('实时已用 ' + Math.round(quota.usagePercent) + '%')
        : '实时额度已刷新';
      const refreshText = quota && typeof quota.refreshCountdownSeconds === 'number'
        ? ('，预计 ' + formatCountdown(quota.refreshCountdownSeconds) + ' 后恢复')
        : '';
      setMessage('ok', '实时刷新成功：' + (payload.alias || alias || '账号') + ' · ' + usageText + refreshText);
    }).catch((error) => {
      setMessage('error', error && error.message ? error.message : String(error));
    });
    return;
  }

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
    await api('/admin/api/config', {
      method: 'POST',
      body: {
        fallbacks: {
          targets: fallbackDraft
        }
      }
    });
    updateFallbackStatusLabel(els.fallbackStatus, fallbackDraft);
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

if (els.codexImportMode) {
  els.codexImportMode.addEventListener('change', () => {
    updateCodexImportUi();
  });
}

if (els.startCodexOauthBtn) {
  els.startCodexOauthBtn.addEventListener('click', () => withAction(els.startCodexOauthBtn, async () => {
    clearCodexMessage();
    const payload = await api('/admin/api/codex/oauth/start', {
      method: 'POST',
      body: {
        account: {
          id: els.codexAccountId && els.codexAccountId.value ? els.codexAccountId.value.trim() : null,
          name: els.codexAccountName && els.codexAccountName.value ? els.codexAccountName.value.trim() : null,
          model: currentCodexAccountModel()
        }
      }
    });
    if (!payload || !payload.authorizeUrl) {
      throw new Error('未收到 OpenAI 授权地址。');
    }
    persistCodexOauthFlowId(payload.flowId || null);
    window.open(payload.authorizeUrl, '_blank', 'noopener,noreferrer');
    setCodexMessage('info', '已打开 OpenAI 登录页。完成登录后会自动写入 Codex 账号。');
    if (payload.flowId) {
      observeCodexOauth(String(payload.flowId));
    }
  }).catch((error) => {
    setCodexMessage('error', error && error.message ? error.message : String(error));
  }));
}

if (els.importCodexAccountBtn) {
  els.importCodexAccountBtn.addEventListener('click', () => withAction(els.importCodexAccountBtn, async () => {
    clearCodexMessage();
    const mode = currentCodexImportMode();
    const credentialText = els.codexCredentialBundle && els.codexCredentialBundle.value ? els.codexCredentialBundle.value.trim() : '';
    if (!credentialText) {
      throw new Error(mode === 'openai-oauth' ? '请先粘贴 OpenAI OAuth callback URL。' : '请先粘贴 Codex credential bundle JSON。');
    }

    const accountId = els.codexAccountId && els.codexAccountId.value ? els.codexAccountId.value.trim() : '';
    if (!accountId && mode === 'json-bundle') {
      throw new Error('请填写 Codex 账号 ID。');
    }

    if (mode === 'openai-oauth') {
      const payload = await api('/admin/api/codex/oauth/complete', {
        method: 'POST',
        body: {
          flowId: activeCodexOauthFlowId || readStoredCodexOauthFlowId() || null,
          input: credentialText,
          account: {
            id: accountId || null,
            name: els.codexAccountName && els.codexAccountName.value ? els.codexAccountName.value.trim() : accountId,
            model: currentCodexAccountModel()
          }
        }
      });
      persistCodexOauthFlowId(null);
      if (els.codexCredentialBundle && payload && payload.credentialBundle) {
        els.codexCredentialBundle.value = JSON.stringify(payload.credentialBundle, null, 2);
      }
      await refreshState();
      setCodexMessage('ok', 'Codex OAuth 授权已完成并写入号池。');
      return;
    }

    let credentialBundle = null;
    try {
      credentialBundle = JSON.parse(credentialText);
    } catch {
      throw new Error('Codex credential bundle 不是合法 JSON。');
    }

    await api('/admin/api/codex/accounts/import', {
      method: 'POST',
      body: {
        account: {
          id: accountId,
          name: els.codexAccountName && els.codexAccountName.value ? els.codexAccountName.value.trim() : accountId,
          baseUrl: els.codexAccountBaseUrl && els.codexAccountBaseUrl.value ? els.codexAccountBaseUrl.value.trim() : 'https://api.openai.com/v1',
          model: currentCodexAccountModel(),
          credentialBundle
        }
      }
    });

    await refreshState();
    setCodexMessage('ok', 'Codex 凭证已导入。');
  }).catch((error) => {
    setCodexMessage('error', error && error.message ? error.message : String(error));
  }));
}

if (els.addCodexFallbackTargetBtn) {
  els.addCodexFallbackTargetBtn.addEventListener('click', () => {
    codexFallbackDraft = collectCodexFallbackDraft();
    codexFallbackDraft.push(createFallbackDraftTarget(codexFallbackDraft.length));
    renderCodexFallbackTargets();
  });
}

if (els.saveCodexFallbackConfigBtn) {
  els.saveCodexFallbackConfigBtn.addEventListener('click', () => withAction(els.saveCodexFallbackConfigBtn, async () => {
    clearCodexConfigMessage();
    codexFallbackDraft = collectCodexFallbackDraft();
    await api('/admin/api/config', {
      method: 'POST',
      body: {
        codex: {
          fallbacks: {
            targets: codexFallbackDraft
          }
        }
      }
    });
    updateFallbackStatusLabel(els.codexFallbackStatus, codexFallbackDraft);
    setCodexConfigMessage('ok', 'Codex 渠道配置已保存并立即生效。');
  }).catch((error) => {
    setCodexConfigMessage('error', error && error.message ? error.message : String(error));
  }));
}

if (els.reloadCodexFallbackConfigBtn) {
  els.reloadCodexFallbackConfigBtn.addEventListener('click', () => withAction(els.reloadCodexFallbackConfigBtn, async () => {
    clearCodexConfigMessage();
    const payload = await api('/admin/api/config');
    renderCodexSettings({ settings: payload.settings, bridge: payload.bridge });
    setCodexConfigMessage('info', '已重新载入 Codex 渠道配置。');
  }).catch((error) => {
    setCodexConfigMessage('error', error && error.message ? error.message : String(error));
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
        toggle.innerHTML = nextVisible ? ICONS['eye-off'] : ICONS['eye'];
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

if (els.codexFallbackTargets) {
  els.codexFallbackTargets.addEventListener('click', async (event) => {
    const collapseBtn = event.target.closest('[data-collapse-fallback]');
    const collapseHeader = !collapseBtn && event.target.closest('[data-toggle-collapse]');
    if (collapseBtn || collapseHeader) {
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
        toggle.innerHTML = nextVisible ? ICONS['eye-off'] : ICONS['eye'];
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
        codexFallbackDraft = collectCodexFallbackDraft().filter((target) => target.id !== targetId);
        renderCodexFallbackTargets();
        setCodexConfigMessage('ok', '已删除上游渠道。记得保存配置以生效。');
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
      codexFallbackDraft = collectCodexFallbackDraft();
      const index = codexFallbackDraft.findIndex((target) => target.id === id);
      if (index > 0) {
        const temp = codexFallbackDraft[index - 1];
        codexFallbackDraft[index - 1] = codexFallbackDraft[index];
        codexFallbackDraft[index] = temp;
        renderCodexFallbackTargets();
      }
      return;
    }

    const moveDown = event.target.closest('[data-move-down-fallback]');
    if (moveDown) {
      const id = moveDown.getAttribute('data-move-down-fallback');
      codexFallbackDraft = collectCodexFallbackDraft();
      const index = codexFallbackDraft.findIndex((target) => target.id === id);
      if (index >= 0 && index < codexFallbackDraft.length - 1) {
        const temp = codexFallbackDraft[index + 1];
        codexFallbackDraft[index + 1] = codexFallbackDraft[index];
        codexFallbackDraft[index] = temp;
        renderCodexFallbackTargets();
      }
      return;
    }

    const testBtn = event.target.closest('[data-test-fallback]');
    if (testBtn) {
      const id = testBtn.getAttribute('data-test-fallback');
      codexFallbackDraft = collectCodexFallbackDraft();
      const target = codexFallbackDraft.find((item) => item.id === id);
      if (!target) {
        return;
      }
      await withAction(testBtn, async () => {
        clearCodexConfigMessage();
        const payload = await api('/admin/api/config/test', {
          method: 'POST',
          body: { target }
        });
        const result = payload && payload.result ? payload.result : {};
        const apiStyle = result.openaiApiStyle ? (' · ' + result.openaiApiStyle) : '';
        const preview = result.preview ? ('，返回预览：' + String(result.preview).slice(0, 80)) : '';
        setCodexConfigMessage('ok', '连接成功：' + (target.name || '渠道') + ' · ' + (result.protocol || 'unknown') + apiStyle + ' · ' + (result.model || 'unknown') + preview);
      }).catch((error) => {
        setCodexConfigMessage('error', error && error.message ? error.message : String(error));
      });
    }
  });

  els.codexFallbackTargets.addEventListener('change', (event) => {
    const enabledCheckbox = event.target.closest('[data-field="enabled"]');
    if (enabledCheckbox) {
      const card = enabledCheckbox.closest('[data-fallback-item]');
      if (card) {
        const checked = enabledCheckbox.checked;
        card.setAttribute('data-enabled', checked ? 'true' : 'false');
        const pill = card.querySelector('.fallbackCardTitle .pill');
        if (pill) {
          pill.textContent = checked ? '启用' : '停用';
          pill.className = 'pill ' + (checked ? 'current' : 'warn');
        }
        const toggleSpan = enabledCheckbox.closest('.toggleRow') && enabledCheckbox.closest('.toggleRow').querySelector('span');
        if (toggleSpan) {
          toggleSpan.textContent = checked ? '启用' : '停用';
        }
      }
    }
  });
}

document.addEventListener('click', async (event) => {
  const testCodex = event.target.closest('[data-codex-account-test]');
  if (testCodex) {
    const accountId = testCodex.getAttribute('data-codex-account-test');
    await withAction(testCodex, async () => {
      clearCodexMessage();
      const payload = await api('/admin/api/codex/accounts/test', { method: 'POST', body: { accountId } });
      await refreshState();
      const sampleModels = payload && Array.isArray(payload.sampleModels) && payload.sampleModels.length > 0
        ? (' · ' + payload.sampleModels.slice(0, 3).join(', '))
        : '';
      const transport = payload && payload.probeTransport ? (' · ' + payload.probeTransport) : '';
      const modelCount = payload && typeof payload.modelCount === 'number'
        ? ('模型 ' + payload.modelCount + ' 个')
        : '连接已验证';
      const note = payload && payload.note ? (' · ' + payload.note) : '';
      setCodexMessage('ok', '测试成功：' + (payload.accountName || payload.accountId || accountId || 'Codex 账号') + transport + ' · ' + modelCount + sampleModels + note);
    }).catch((error) => {
      setCodexMessage('error', error && error.message ? error.message : String(error));
    });
    return;
  }

  const setDefault = event.target.closest('[data-codex-account-default]');
  if (setDefault) {
    const accountId = setDefault.getAttribute('data-codex-account-default');
    await withAction(setDefault, async () => {
      await api('/admin/api/codex/accounts/default', { method: 'POST', body: { accountId } });
      await refreshState();
      setCodexMessage('ok', '已切换默认 Codex 账号。');
    });
    return;
  }

  const toggle = event.target.closest('[data-codex-account-toggle]');
  if (toggle) {
    const accountId = toggle.getAttribute('data-codex-account-toggle');
    const enabled = toggle.getAttribute('data-codex-enabled') !== 'true';
    await withAction(toggle, async () => {
      await api('/admin/api/codex/accounts/toggle', { method: 'POST', body: { accountId, enabled } });
      await refreshState();
      setCodexMessage('ok', enabled ? 'Codex 账号已启用。' : 'Codex 账号已停用。');
    });
    return;
  }

  const removeCodex = event.target.closest('[data-codex-account-delete]');
  if (removeCodex) {
    const accountId = removeCodex.getAttribute('data-codex-account-delete');
    if (removeCodex.dataset.confirmDeleteCodex) {
      delete removeCodex.dataset.confirmDeleteCodex;
      await withAction(removeCodex, async () => {
        await api('/admin/api/codex/accounts/delete', { method: 'POST', body: { accountId } });
        await refreshState();
        setCodexMessage('ok', '已删除 Codex 账号。');
      });
      return;
    }

    removeCodex.dataset.confirmDeleteCodex = '1';
    const prevText = removeCodex.textContent;
    removeCodex.textContent = '确认删除？';
    removeCodex.classList.add('danger-confirm');
    setTimeout(() => {
      if (removeCodex.dataset.confirmDeleteCodex) {
        delete removeCodex.dataset.confirmDeleteCodex;
        removeCodex.textContent = prevText;
        removeCodex.classList.remove('danger-confirm');
      }
    }, 3000);
  }
});

try {
  switchTab(localStorage.getItem('accio-admin-tab') || 'claude');
} catch (_) {
  switchTab('claude');
}

switchClaudeSection(readStoredClaudeSection() || 'accounts');
switchCodexSection(readStoredCodexSection() || 'accounts');
persistCodexOauthFlowId(readStoredCodexOauthFlowId() || null);
updateCodexImportUi();
if (activeCodexOauthFlowId && currentCodexImportMode() === 'openai-oauth') {
  observeCodexOauth(activeCodexOauthFlowId);
}

connectStateStream();
refreshState().catch((error) => setMessage('error', error.message || String(error)));
loadFallbackConfig().catch(() => {});
</script>
</body>
</html>`;
}


async function handleAdminPage(req, res, config) {
  writeHtml(res, 200, renderAdminPage(config));
}

async function handleAdminState(req, res, config, authProvider, codexAuthProvider, directClient, recentActivityStore) {
  const url = req && req.url ? new URL(req.url, "http://127.0.0.1") : null;
  const fresh = url && url.searchParams.get("fresh") === "1";
  writeJson(res, 200, await getSharedAdminState(config, authProvider, codexAuthProvider, directClient, recentActivityStore, { fresh }));
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

async function getSharedAdminState(config, authProvider, codexAuthProvider, directClient, recentActivityStore, options = {}) {
  if (options && options.fresh) {
    invalidateSharedAdminState();
  }

  const now = Date.now();
  if (_sharedStateCache.promise && now - _sharedStateCache.ts < SHARED_STATE_TTL_MS) {
    return _sharedStateCache.promise;
  }
  const promise = buildAdminState(config, authProvider, codexAuthProvider, directClient, recentActivityStore);
  _sharedStateCache = { promise, ts: now };
  return promise;
}

async function handleAdminEvents(req, res, config, authProvider, codexAuthProvider, directClient, recentActivityStore) {
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
      const payload = await buildAdminState(config, authProvider, codexAuthProvider, directClient, recentActivityStore);
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
  writeJson(res, 200, {
    ok: true,
    settings: buildAdminFallbackSettings(config),
    bridge: {
      envPath: config.envPath || path.join(process.cwd(), ".env")
    }
  });
}

async function handleAdminConfigSave(req, res, config, claudeFallbackPool, codexFallbackPool) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const nextSettings = applyFallbackSettings(config, claudeFallbackPool, codexFallbackPool, body && typeof body === "object" ? body : {});
  const primaryClaude = nextSettings && nextSettings.claude && nextSettings.claude.fallbacks && Array.isArray(nextSettings.claude.fallbacks.normalizedTargets)
    ? nextSettings.claude.fallbacks.normalizedTargets[0] || null
    : null;
  const primaryCodex = nextSettings && nextSettings.codex && nextSettings.codex.fallbacks && Array.isArray(nextSettings.codex.fallbacks.normalizedTargets)
    ? nextSettings.codex.fallbacks.normalizedTargets[0] || null
    : null;

  const envPath = config.envPath || path.join(process.cwd(), ".env");
  let targetsToWrite = nextSettings.claude.fallbacks.targets;
  let codexTargetsToWrite = nextSettings.codex.fallbacks.targets;

  // Safety check: ensure no masked apiKeys are persisted to .env
  const hasMaskedClaude = targetsToWrite.some((t) => t.apiKey && t.apiKey.includes("***"));
  const hasMaskedCodex = codexTargetsToWrite.some((t) => t.apiKey && t.apiKey.includes("***"));
  if (hasMaskedClaude || hasMaskedCodex) {
    log.warn("masked apiKey detected in fallback targets during save, attempting restore from .env", {
      envPath,
      hasMaskedClaude,
      hasMaskedCodex
    });
    try {
      const rawEnv = fs.readFileSync(envPath, "utf8");
      const restoreFromEnv = (targets, envKey) => {
        const lineMatch = rawEnv.split(/\r?\n/).find((l) => l.startsWith(envKey + "="));
        if (!lineMatch) return targets;
        const jsonStr = lineMatch.slice(envKey.length + 1);
        try {
          const envTargets = JSON.parse(jsonStr);
          if (!Array.isArray(envTargets)) return targets;
          const envById = new Map(envTargets.filter((e) => e.id && e.apiKey && !e.apiKey.includes("***")).map((e) => [String(e.id), e]));
          return targets.map((t) => {
            if (t.apiKey && t.apiKey.includes("***") && t.id && envById.has(String(t.id))) {
              return { ...t, apiKey: envById.get(String(t.id)).apiKey };
            }
            return t;
          });
        } catch { return targets; }
      };
      if (hasMaskedClaude) targetsToWrite = restoreFromEnv(targetsToWrite, "ACCIO_FALLBACKS_JSON");
      if (hasMaskedCodex) codexTargetsToWrite = restoreFromEnv(codexTargetsToWrite, "ACCIO_CODEX_FALLBACKS_JSON");
    } catch {
      // Ignore .env read errors
    }
  }

  upsertEnvValues(envPath, {
    ACCIO_FALLBACKS_JSON: JSON.stringify(targetsToWrite),
    ACCIO_FALLBACK_OPENAI_BASE_URL: primaryClaude ? primaryClaude.baseUrl : "",
    ACCIO_FALLBACK_OPENAI_API_KEY: primaryClaude ? primaryClaude.apiKey : "",
    ACCIO_FALLBACK_OPENAI_MODEL: primaryClaude ? primaryClaude.model : "",
    ACCIO_FALLBACK_PROTOCOL: primaryClaude ? primaryClaude.protocol : "openai",
    ACCIO_FALLBACK_ANTHROPIC_VERSION: primaryClaude ? primaryClaude.anthropicVersion : "2023-06-01",
    ACCIO_FALLBACK_OPENAI_TIMEOUT_MS: String(primaryClaude ? primaryClaude.timeoutMs : 60000),
    ACCIO_CODEX_FALLBACKS_JSON: JSON.stringify(codexTargetsToWrite),
    ACCIO_CODEX_FALLBACK_BASE_URL: primaryCodex ? primaryCodex.baseUrl : "",
    ACCIO_CODEX_FALLBACK_API_KEY: primaryCodex ? primaryCodex.apiKey : "",
    ACCIO_CODEX_FALLBACK_MODEL: primaryCodex ? primaryCodex.model : "",
    ACCIO_CODEX_FALLBACK_PROTOCOL: primaryCodex ? primaryCodex.protocol : "openai",
    ACCIO_CODEX_FALLBACK_ANTHROPIC_VERSION: primaryCodex ? primaryCodex.anthropicVersion : "2023-06-01",
    ACCIO_CODEX_FALLBACK_TIMEOUT_MS: String(primaryCodex ? primaryCodex.timeoutMs : 60000)
  });

  log.info("admin fallback settings updated", {
    envPath,
    claudeFallbackCount: nextSettings.claude.fallbacks.targets.length,
    codexFallbackCount: nextSettings.codex.fallbacks.targets.length,
    fallbackProtocol: primaryClaude ? primaryClaude.protocol : null,
    fallbackModel: primaryClaude ? (primaryClaude.model || null) : null
  });

  invalidateSharedAdminState();

  writeJson(res, 200, {
    ok: true,
    saved: true,
    settings: buildAdminFallbackSettings(config),
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

async function handleAdminCodexOAuthStart(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const account = body && body.account && typeof body.account === "object" ? body.account : {};
  const flow = createPendingCodexOAuthFlow({
    account: {
      id: account.id ? String(account.id).trim() : null,
      name: account.name ? String(account.name).trim() : null,
      model: account.model ? String(account.model).trim() : DEFAULT_CODEX_MODEL
    }
  });

  writeJson(res, 200, {
    ok: true,
    flowId: flow.id,
    state: flow.state,
    authorizeUrl: flow.authorizeUrl,
    redirectUri: OPENAI_OAUTH_REDIRECT_URI
  });
}

async function finalizeCodexOAuthFlow(flow, input, config, accountOverride = {}) {
  if (!flow) {
    throw new Error("OAuth 授权流程不存在或已过期。");
  }

  const code = String(input && input.code ? input.code : "").trim();
  const state = String(input && input.state ? input.state : "").trim();
  if (!code) {
    const error = new Error("回调信息里缺少 code。");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }
  if (state && String(flow.state || "") !== state) {
    const error = new Error("OAuth state 不匹配，请重新发起授权。");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }

  flow.callbackReceivedAtMs = Date.now();

  const tokenPayload = await exchangeCodexAuthorizationCode(code, flow.verifier);
  const accessToken = tokenPayload && (tokenPayload.access_token || tokenPayload.accessToken)
    ? String(tokenPayload.access_token || tokenPayload.accessToken)
    : "";
  const refreshToken = tokenPayload && (tokenPayload.refresh_token || tokenPayload.refreshToken)
    ? String(tokenPayload.refresh_token || tokenPayload.refreshToken)
    : "";
  const expiresIn = Number(tokenPayload && (tokenPayload.expires_in || tokenPayload.expiresIn || 0)) || 0;
  const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
  const clientId = tokenPayload && tokenPayload.client_id
    ? String(tokenPayload.client_id)
    : OPENAI_OAUTH_CLIENT_ID;
  const storedAccount = flow.account && typeof flow.account === "object" ? flow.account : {};
  const mergedAccount = {
    ...storedAccount,
    ...(accountOverride && typeof accountOverride === "object" ? accountOverride : {})
  };
  const model = String(mergedAccount.model || DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;
  const accountIdFromToken = extractOpenAiAccountIdFromJwt(accessToken);
  const email = extractEmailFromJwt(accessToken);
  // OAuth 导入始终以 OpenAI 官方 account_id 作为稳定主键，避免改备注后生成重复记录。
  const id = String(accountIdFromToken || "").trim();
  const name = String(mergedAccount.name || email || accountIdFromToken || id).trim();

  if (!accessToken || !refreshToken || !accountIdFromToken) {
    const error = new Error("OpenAI OAuth 返回的凭证不完整，未能提取 access_token / refresh_token / account_id。");
    error.status = 502;
    error.type = "api_error";
    throw error;
  }

  if (!id) {
    const error = new Error("无法确定 Codex 账号 ID，OpenAI OAuth 返回里缺少 account_id。");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }

  const credentialBundle = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    defaultModel: model,
    model,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountIdFromToken
    },
    last_refresh: new Date().toISOString()
  };

  if (tokenPayload && tokenPayload.id_token) {
    credentialBundle.tokens.id_token = String(tokenPayload.id_token);
  }

  upsertOpaqueAccountToFile(config.codexAccountsPath, {
    id,
    name,
    enabled: mergedAccount.enabled !== false,
    priority: Number(mergedAccount.priority || 0) || undefined,
    baseUrl: mergedAccount.baseUrl ? String(mergedAccount.baseUrl).trim() : "https://chatgpt.com",
    model,
    probeModel: model,
    accessToken,
    refreshToken,
    expiresAt,
    clientId,
    account_id: accountIdFromToken,
    chatGptAccountId: accountIdFromToken,
    credentialBundle,
    source: "codex-openai-oauth"
  });

  invalidateSharedAdminState();

  const result = {
    ok: true,
    imported: true,
    flowCompleted: true,
    completed: true,
    state: "completed",
    accountId: id,
    email: email || null,
    note: `Codex OAuth 已完成，账号 ${name || id} 已写入号池。`,
    credentialBundle: {
      ...credentialBundle,
      tokens: {
        ...credentialBundle.tokens,
        access_token: maskToken(accessToken),
        refresh_token: maskToken(refreshToken),
        ...(credentialBundle.tokens.id_token ? { id_token: maskToken(credentialBundle.tokens.id_token) } : {})
      }
    }
  };

  flow.finalResult = result;
  return result;
}

async function handleAdminCodexOAuthComplete(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const input = String(body && body.input ? body.input : "").trim();
  const flowId = String(body && body.flowId ? body.flowId : "").trim();
  const account = body && body.account && typeof body.account === "object" ? body.account : {};

  if (!input) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少 OpenAI OAuth 回调信息。"
      }
    });
    return;
  }

  let parsedInput;
  try {
    parsedInput = parseCodexAuthorizationInput(input);
  } catch {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "无法解析回调信息，请粘贴完整 callback URL。"
      }
    });
    return;
  }

  const code = String(parsedInput && parsedInput.code ? parsedInput.code : "").trim();
  const state = String(parsedInput && parsedInput.state ? parsedInput.state : "").trim();
  if (!code) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "回调信息里缺少 code。"
      }
    });
    return;
  }

  let flow = getPendingCodexOAuthFlow(flowId);
  if (!flow && state) {
    flow = findPendingCodexOAuthFlowByState(state);
  }

  if (!flow) {
    writeJson(res, 410, {
      ok: false,
      error: {
        type: "expired_error",
        message: "OAuth 授权流程已过期，请重新点击“Codex 授权”。"
      }
    });
    return;
  }
  try {
    const result = await finalizeCodexOAuthFlow(flow, { code, state }, config, account);
    deletePendingCodexOAuthFlow(flow.id);
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, Number(error && error.status ? error.status : 502) || 502, {
      ok: false,
      error: {
        type: error && error.type ? error.type : "authentication_error",
        message: error && error.message ? error.message : String(error)
      },
      details: error && error.details ? error.details : null
    });
    return;
  }
}

async function handleCodexOAuthCallback(req, res, config, url) {
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  const flow = findPendingCodexOAuthFlowByState(state);

  if (!state || !flow) {
    writeHtml(res, 404, renderAccountCallbackPage("Codex 授权流程已失效", "这个授权流程已经过期或不存在，请回到管理台重新发起。", "error"));
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    deletePendingCodexOAuthFlow(flow.id);
    writeHtml(res, 410, renderAccountCallbackPage("Codex 授权流程已过期", "请返回管理台重新点击“Codex 授权”。", "error"));
    return;
  }

  try {
    const result = await finalizeCodexOAuthFlow(flow, { code, state }, config);
    writeHtml(res, 200, renderAccountCallbackPage("Codex 授权已完成", result.note || "Codex 账号已自动写入号池。", "ok"));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    flow.finalResult = {
      ok: false,
      completed: true,
      state: "oauth_failed",
      note: `Codex 授权回调已收到，但导入失败：${message}`
    };
    writeHtml(res, Number(error && error.status ? error.status : 500) || 500, renderAccountCallbackPage("Codex 授权失败", message, "error"));
  }
}

async function handleAdminCodexOAuthStatus(req, res, url) {
  const flowId = url.searchParams.get("flowId") ? String(url.searchParams.get("flowId")).trim() : "";
  if (!flowId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "flowId is required" } });
    return;
  }

  const flow = getPendingCodexOAuthFlow(flowId);
  if (!flow) {
    writeJson(res, 404, { error: { type: "not_found_error", message: "oauth flow not found or expired" } });
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    deletePendingCodexOAuthFlow(flowId);
    writeJson(res, 410, { error: { type: "expired_error", message: "oauth flow expired" } });
    return;
  }

  if (flow.finalResult) {
    const payload = flow.finalResult;
    deletePendingCodexOAuthFlow(flowId);
    writeJson(res, 200, payload);
    return;
  }

  if (flow.callbackReceivedAtMs) {
    writeJson(res, 200, {
      ok: true,
      completed: false,
      state: "finalizing_oauth",
      message: "授权回调已收到，正在写入 Codex 账号。"
    });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    completed: false,
    state: "waiting_oauth",
    message: "OpenAI 登录页已打开，等待你完成授权。"
  });
}

async function handleAdminSnapshotTest(req, res, config, authProvider) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = String(body && body.alias ? body.alias : "").trim();

  if (!alias) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少要测试的账号快照 alias。"
      }
    });
    return;
  }

  const snapshotEntry = getSnapshotEntry(alias);
  if (!snapshotEntry) {
    writeJson(res, 404, {
      ok: false,
      error: {
        type: "not_found_error",
        message: `snapshot not found for alias: ${alias}`
      }
    });
    return;
  }

  const resolvedAuth = resolveSnapshotAuthPayload(alias, config.accountsPath);
  const authPayload = resolvedAuth && resolvedAuth.payload ? resolvedAuth.payload : null;
  if (!authPayload || !authPayload.accessToken) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "该账号快照缺少可测试的登录凭证，请重新登录后再试。"
      }
    });
    return;
  }

  const gatewayUser = snapshotEntry.metadata && snapshotEntry.metadata.gatewayUser
    ? snapshotEntry.metadata.gatewayUser
    : null;
  const snapshot = {
    alias,
    dir: snapshotEntry.dir,
    gatewayUser,
    authPayloadUser: authPayload && authPayload.user ? authPayload.user : null,
    accountState: null
  };

  const configuredAccounts = authProvider && typeof authProvider.getConfiguredAccounts === "function"
    ? authProvider.getConfiguredAccounts()
    : [];
  const matchedAccount = findMatchingConfiguredAccount(configuredAccounts, snapshot);
  if (matchedAccount) {
    snapshot.accountState = {
      id: matchedAccount.id,
      invalidUntil: authProvider.getInvalidUntil(matchedAccount.id),
      lastFailure: authProvider.getLastFailure(matchedAccount.id) || null
    };
  }

  const userId = gatewayUser && gatewayUser.id ? String(gatewayUser.id) : "";
  quotaCache.delete(buildQuotaCacheKey(alias, userId));

  const quota = await resolveSnapshotQuota(config, snapshot, authPayload);
  writeSnapshotQuotaState(snapshotEntry.dir, {
    ...quota,
    stale: false
  });

  snapshot.quota = quota;
  syncSnapshotAccountState(authProvider, snapshot);
  invalidateSharedAdminState();

  if (!quota.available) {
    writeJson(res, 502, {
      ok: false,
      alias,
      quota,
      error: {
        type: "api_error",
        message: quota.error || "账号测试失败"
      }
    });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    tested: true,
    alias,
    quota,
    accountState: snapshot.accountState || null
  });
}

function writeAccountsState(filePath, state) {
  atomicWriteFileSync(
    filePath,
    JSON.stringify({
      strategy: state.strategy || "round_robin",
      activeAccount: state.activeAccount || null,
      accounts: Array.isArray(state.accounts) ? state.accounts : []
    }, null, 2) + "\n",
    "utf8"
  );
}

async function handleAdminCodexAccountImport(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const account = body && body.account && typeof body.account === "object" ? body.account : {};

  // Detect OpenAI token format: { tokens: { access_token, refresh_token, ... } }
  // or flat { accessToken, refreshToken, ... }
  const tokens = account.tokens && typeof account.tokens === "object" ? account.tokens : null;
  const accessToken = tokens
    ? (tokens.access_token || tokens.accessToken || null)
    : (account.accessToken || account.access_token || null);
  const refreshToken = tokens
    ? (tokens.refresh_token || tokens.refreshToken || null)
    : (account.refreshToken || account.refresh_token || null);
  const accountId = tokens
    ? (tokens.account_id || tokens.accountId || null)
    : (account.account_id || account.accountId || null);
  const model = String(account.model || DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;

  if (accessToken) {
    // OpenAI structured token import
    const id = String(account.id || account.name || accountId || "").trim();
    const name = String(account.name || id).trim();

    if (!id) {
      writeJson(res, 400, {
        ok: false,
        error: {
          type: "invalid_request_error",
          message: "Codex 账号需要提供 id（可从 account_id 自动提取）。"
        }
      });
      return;
    }

    // Parse JWT exp for expiresAt
    let expiresAt = null;
    try {
      const parts = String(accessToken).split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (payload && payload.exp) {
          expiresAt = payload.exp * 1000;
        }
      }
    } catch {
      // Ignore JWT parse errors
    }

    // Extract clientId from JWT if present
    let clientId = null;
    try {
      const parts = String(accessToken).split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (payload && payload.client_id) {
          clientId = String(payload.client_id);
        }
      }
    } catch {
      // Ignore JWT parse errors
    }

    upsertOpaqueAccountToFile(config.codexAccountsPath, {
      id,
      name,
      enabled: account.enabled !== false,
      priority: Number(account.priority || 0) || undefined,
      baseUrl: account.baseUrl ? String(account.baseUrl).trim() : null,
      model,
      probeModel: model,
      accessToken: String(accessToken),
      refreshToken: refreshToken ? String(refreshToken) : null,
      expiresAt,
      clientId,
      credentialBundle: {
        accessToken: String(accessToken),
        defaultModel: model,
        model
      },
      source: "codex-openai-token-import"
    });

    invalidateSharedAdminState();
    writeJson(res, 200, {
      ok: true,
      imported: true,
      accountId: id
    });
    return;
  }

  // Legacy credentialBundle import
  const id = String(account.id || account.name || "").trim();
  const name = String(account.name || id).trim();
  const credentialBundle = account.credentialBundle && typeof account.credentialBundle === "object"
    ? account.credentialBundle
    : null;

  if (!id || !credentialBundle) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "Codex 账号需要提供 id 和 credentialBundle，或提供 accessToken/refreshToken。"
      }
    });
    return;
  }

  upsertOpaqueAccountToFile(config.codexAccountsPath, {
    id,
    name,
    enabled: account.enabled !== false,
    priority: Number(account.priority || 0) || undefined,
    baseUrl: account.baseUrl ? String(account.baseUrl).trim() : null,
    model,
    probeModel: model,
    credentialBundle: {
      ...credentialBundle,
      defaultModel: model,
      model
    },
    source: "codex-manual-import"
  });

  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    imported: true,
    accountId: id
  });
}

async function handleAdminCodexAccountTest(req, res, codexClient) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = String(body && body.accountId ? body.accountId : "").trim();

  if (!accountId) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少要测试的 Codex 账号 ID。"
      }
    });
    return;
  }

  if (!codexClient || typeof codexClient.probeAccount !== "function") {
    writeJson(res, 503, {
      ok: false,
      error: {
        type: "service_unavailable_error",
        message: "Codex 测试执行器未启用。"
      }
    });
    return;
  }

  try {
    const result = await codexClient.probeAccount(accountId);
    invalidateSharedAdminState();
    writeJson(res, 200, {
      ok: true,
      tested: true,
      ...result
    });
  } catch (error) {
    invalidateSharedAdminState();
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

async function handleAdminCodexAccountDelete(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = String(body && body.accountId ? body.accountId : "").trim();

  if (!accountId) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少要删除的 Codex 账号 ID。"
      }
    });
    return;
  }

  const result = removeAccountFromFile(config.codexAccountsPath, {
    accountId,
    name: accountId,
    alias: accountId
  });
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    removed: result.removed,
    accountId
  });
}

async function handleAdminCodexAccountSetDefault(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = String(body && body.accountId ? body.accountId : "").trim();

  if (!accountId) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少要设为默认的 Codex 账号 ID。"
      }
    });
    return;
  }

  setActiveAccountInFile(config.codexAccountsPath, accountId);
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    activeAccount: accountId
  });
}

async function handleAdminCodexAccountToggle(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = String(body && body.accountId ? body.accountId : "").trim();
  const enabled = body && Object.prototype.hasOwnProperty.call(body, "enabled")
    ? body.enabled !== false
    : true;

  if (!accountId) {
    writeJson(res, 400, {
      ok: false,
      error: {
        type: "invalid_request_error",
        message: "缺少要更新的 Codex 账号 ID。"
      }
    });
    return;
  }

  const state = loadAccountsFile(config.codexAccountsPath);
  const nextAccounts = state.accounts.map((account) => {
    if (String(account && (account.id || account.accountId || account.name || "")) !== accountId) {
      return account;
    }

    return {
      ...account,
      enabled
    };
  });
  writeAccountsState(config.codexAccountsPath, {
    strategy: state.strategy,
    activeAccount: state.activeAccount,
    accounts: nextAccounts
  });
  invalidateSharedAdminState();
  writeJson(res, 200, {
    ok: true,
    accountId,
    enabled
  });
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
  handleAdminSnapshotTest,
  handleAdminSnapshotActivate,
  handleAdminSnapshotDelete,
  handleAdminGatewayLogin,
  handleAdminGatewayLogout,
  handleAdminCaptureAccount,
  handleAdminCodexOAuthStart,
  handleAdminCodexOAuthComplete,
  handleAdminCodexOAuthStatus,
  handleCodexOAuthCallback,
  handleAdminCodexAccountImport,
  handleAdminCodexAccountTest,
  handleAdminCodexAccountDelete,
  handleAdminCodexAccountSetDefault,
  handleAdminCodexAccountToggle,
  handleAdminAccountLogin,
  handleAdminAccountCallback,
  handleAdminAccountLoginStatus,
  handleAdminAccountLoginCancel,
  refreshAllSnapshotQuotas,
  __private__: {
    buildAdminFallbackSettings,
    buildCodexAuthorizeUrl,
    parseCodexAuthorizationInput,
    finalizeCodexOAuthFlow,
    extractOpenAiAccountIdFromJwt,
    hasSnapshotArtifactState,
    isQuotaPendingFailure,
    readSnapshotQuotaState,
    requestQuotaViaUpstream,
    resolveSnapshotQuotaForAdmin,
    writeSnapshotQuotaState,
    syncSnapshotAccountState
  }
};
