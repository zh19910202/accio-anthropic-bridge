"use strict";

const { readAccioUtdid, extractCnaFromCookie } = require("./discovery");
const log = require("./logger");
const { maskToken } = require("./redaction");
const { delay } = require("./utils");

function buildGatewayAuthCallbackQuery(payload, options = {}) {
  const query = new URLSearchParams();
  query.set("accessToken", String(payload.accessToken || ""));
  query.set("refreshToken", String(payload.refreshToken || ""));
  query.set("expiresAt", String(payload.expiresAtRaw || payload.expiresAt || ""));

  if (payload.cookie) {
    query.set("cookie", String(payload.cookie));
  }

  if (options.includeState && payload.state) {
    query.set("state", String(payload.state));
  }

  return query.toString();
}

function extractAuthCallbackPayloadFromSearchParams(searchParams) {
  const accessToken = searchParams.get("accessToken") ? String(searchParams.get("accessToken")).trim() : "";
  const refreshToken = searchParams.get("refreshToken") ? String(searchParams.get("refreshToken")).trim() : "";
  const expiresAtRaw = searchParams.get("expiresAt") ? String(searchParams.get("expiresAt")).trim() : "";
  const cookie = searchParams.get("cookie") ? String(searchParams.get("cookie")) : null;
  const state = searchParams.get("state") ? String(searchParams.get("state")).trim() : null;
  const expiresAtMs = expiresAtRaw ? Number(expiresAtRaw) * 1000 : 0;

  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new Error("Missing required auth callback parameters");
  }

  return {
    accessToken,
    refreshToken,
    expiresAtRaw,
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    cookie,
    state,
    capturedAt: new Date().toISOString(),
    source: "gateway-auth-callback"
  };
}

function deriveUpstreamGatewayBaseUrl(config = {}) {
  const candidate = config && (config.upstreamBaseUrl || config.directLlmBaseUrl)
    ? String(config.upstreamBaseUrl || config.directLlmBaseUrl).trim()
    : "";
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Fall through to the default prod gateway.
    }
  }

  return "https://phoenix-gw.alibaba.com";
}

function resolveUpstreamAppVersion(config = {}) {
  const candidate = config && config.appVersion ? String(config.appVersion).trim() : "";
  return candidate || "0.0.0";
}

async function refreshAuthPayloadViaUpstream(config, authPayload, context = {}) {
  if (!authPayload || !authPayload.accessToken || !authPayload.refreshToken) {
    throw new Error("Auth payload is missing accessToken or refreshToken");
  }

  const fetchImpl = context.fetchImpl || fetch;
  const logger = context.log || log;
  const upstreamBaseUrl = deriveUpstreamGatewayBaseUrl(config);
  const utdid = context.utdid != null
    ? String(context.utdid)
    : readAccioUtdid(config && config.accioHome);
  const cna = extractCnaFromCookie(authPayload.cookie);
  const appVersion = resolveUpstreamAppVersion(config);
  const requestBody = {
    utdid,
    version: appVersion,
    accessToken: String(authPayload.accessToken),
    refreshToken: String(authPayload.refreshToken)
  };
  const response = await fetchImpl(`${upstreamBaseUrl}/api/auth/refresh_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-language": config && config.language ? String(config.language) : "zh",
      "x-utdid": utdid,
      "x-app-version": appVersion,
      "x-os": process.platform,
      "x-cna": cna
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(Number(context.timeoutMs || 15000))
  });
  const responseText = await response.text();

  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(`Upstream refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok || !payload || payload.success !== true || !payload.data || !payload.data.accessToken || !payload.data.refreshToken || !payload.data.expiresAt) {
    const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(`Upstream refresh failed: ${message}`);
  }

  const expiresAtMs = Number(payload.data.expiresAt) * 1000;
  const refreshed = {
    ...authPayload,
    accessToken: String(payload.data.accessToken),
    refreshToken: String(payload.data.refreshToken),
    expiresAtRaw: String(payload.data.expiresAt),
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    refreshedAt: new Date().toISOString(),
    refreshBoundUserId: payload.data.userId ? String(payload.data.userId) : null,
    source: "upstream-refresh"
  };

  logger.info("auth payload upstream refresh succeeded", {
    alias: context.alias || null,
    accountId: context.accountId || null,
    flowId: context.flowId || null,
    previousUserId: context.previousUserId || null,
    expectedUserId: authPayload && authPayload.user && authPayload.user.id ? String(authPayload.user.id) : null,
    boundUserId: refreshed.refreshBoundUserId,
    upstreamBaseUrl,
    accessToken: maskToken(refreshed.accessToken),
    refreshToken: maskToken(refreshed.refreshToken)
  });

  return refreshed;
}

async function waitForGatewayAuthenticatedUser(readGatewayState, expectedUserId = "", waitMs = 15000, pollMs = 500) {
  const deadline = Date.now() + waitMs;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState();
    lastGateway = gateway;
    const currentUserId = gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";

    if (gateway && gateway.reachable && gateway.authenticated && (!expectedUserId || currentUserId === String(expectedUserId))) {
      return gateway;
    }

    await delay(pollMs);
  }

  return lastGateway;
}

module.exports = {
  buildGatewayAuthCallbackQuery,
  extractAuthCallbackPayloadFromSearchParams,
  deriveUpstreamGatewayBaseUrl,
  resolveUpstreamAppVersion,
  refreshAuthPayloadViaUpstream,
  waitForGatewayAuthenticatedUser
};
