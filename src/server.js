"use strict";

const http = require("node:http");

const { AccioClient, HttpError } = require("./accio-client");
const { setActiveAccountInFile } = require("./accounts-file");
const { AuthProvider } = require("./auth-provider");
const { buildErrorResponse } = require("./anthropic");
const { CodexAuthProvider } = require("./codex-auth-provider");
const { CodexResponsesClient } = require("./codex-responses");
const { DebugTraceStore, setTraceError, updateTrace } = require("./debug-traces");
const { DirectLlmClient } = require("./direct-llm");
const { ExternalFallbackPool } = require("./external-fallback");
const { classifyErrorType } = require("./errors");
const { GatewayManager } = require("./gateway-manager");
const { CORS_HEADERS, writeJson } = require("./http");
const { generateId } = require("./id");
const log = require("./logger");
const { ModelsRegistry } = require("./models");
const { ResponseCache } = require("./response-cache");
const { RecentActivityStore } = require("./recent-activity-store");
const { handleTraceDetail, handleTraceReplay, handleTracesList } = require("./routes/debug");
const {
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
  refreshAllSnapshotQuotas
} = require("./routes/admin");
const { handleAccioAuthProbe, handleHealth } = require("./routes/health");
const { handleCountTokens, handleMessagesRequest } = require("./routes/anthropic");
const { handleChatCompletionsRequest, handleModelsRequest, handleResponsesRequest } = require("./routes/openai");
const { createConfig } = require("./runtime-config");
const { SessionStore } = require("./session-store");

function captureTrace(traceStore, req, res, requestMeta, startedAt) {
  if (!traceStore || !req.bridgeContext || req.bridgeContext.traceCaptured) {
    return;
  }

  const trace = req.bridgeContext.trace;

  if (!trace || !trace.protocol) {
    return;
  }

  req.bridgeContext.traceCaptured = true;
  traceStore.record({
    ...trace,
    id: generateId("trace"),
    requestId: requestMeta.requestId,
    method: requestMeta.method,
    path: requestMeta.path,
    ts: startedAt,
    durationMs: Date.now() - startedAt,
    statusCode: Number((trace.response && trace.response.statusCode) || res.statusCode || 0)
  });
}

function buildRecentActivity(req, requestMeta, protocol) {
  const trace = req && req.bridgeContext && req.bridgeContext.trace ? req.bridgeContext.trace : null;
  const bridge = trace && trace.bridge ? trace.bridge : {};
  const request = trace && trace.request ? trace.request : {};
  const response = trace && trace.response ? trace.response : {};
  const requestBody = request && request.body && typeof request.body === "object" ? request.body : {};
  const transportSelected = bridge.transportSelected || null;

  if (!transportSelected || response.cacheState === "hit") {
    return null;
  }

  return {
    endpoint: requestMeta.path,
    protocol,
    theme: bridge.theme || (protocol === "anthropic" ? "claude" : "codex"),
    transportSelected,
    requestedModel: bridge.requestedModel || requestBody.model || null,
    resolvedProviderModel: bridge.resolvedProviderModel || null,
    accountId: bridge.accountId || null,
    accountName: bridge.accountName || null,
    authSource: bridge.authSource || null,
    fallbackModel: bridge.fallbackModel || null,
    fallbackProtocol: bridge.fallbackProtocol || null,
    cacheState: response.cacheState || null
  };
}

function recordRecentActivity(activityStore, req, requestMeta, protocol, statusCode) {
  if (!activityStore || Number(statusCode) >= 400) {
    return;
  }

  const activity = buildRecentActivity(req, requestMeta, protocol);
  if (activity) {
    activityStore.record(activity);
  }
}

function createServer(config, client, directClient, claudeFallbackPool, codexClient, codexFallbackPool, authProvider, codexAuthProvider, gatewayManager, sessionStore, modelsRegistry, responseCache, traceStore, recentActivityStore) {
  /* ── Declarative route table ── */
  const deps = { config, client, directClient, claudeFallbackPool, codexClient, codexFallbackPool, authProvider, codexAuthProvider, gatewayManager, sessionStore, modelsRegistry, responseCache, traceStore, recentActivityStore };

  const staticRoutes = [
    // Admin UI & API
    ["GET",  "/admin",                               "admin-ui",  (r, s, u) => handleAdminPage(r, s, deps.config)],
    ["GET",  "/admin/api/state",                     "admin-api", (r, s, u) => handleAdminState(r, s, deps.config, deps.authProvider, deps.codexAuthProvider, deps.directClient, deps.recentActivityStore)],
    ["GET",  "/admin/api/logs",                      "admin-api", (r, s) => handleAdminLogs(r, s)],
    ["GET",  "/admin/api/events",                    "admin-sse", (r, s, u) => handleAdminEvents(r, s, deps.config, deps.authProvider, deps.codexAuthProvider, deps.directClient, deps.recentActivityStore)],
    ["GET",  "/admin/api/config",                    "admin-api", (r, s) => handleAdminConfigGet(r, s, deps.config)],
    ["POST", "/admin/api/config",                    "admin-api", (r, s) => handleAdminConfigSave(r, s, deps.config, deps.claudeFallbackPool, deps.codexFallbackPool)],
    ["POST", "/admin/api/config/test",               "admin-api", (r, s) => handleAdminConfigTest(r, s)],
    ["POST", "/admin/api/snapshots",                 "admin-api", (r, s) => handleAdminSnapshotCreate(r, s, deps.config)],
    ["POST", "/admin/api/snapshots/test",            "admin-api", (r, s) => handleAdminSnapshotTest(r, s, deps.config, deps.authProvider)],
    ["POST", "/admin/api/snapshots/activate",        "admin-api", (r, s) => handleAdminSnapshotActivate(r, s, deps.config, deps.gatewayManager)],
    ["POST", "/admin/api/snapshots/delete",          "admin-api", (r, s) => handleAdminSnapshotDelete(r, s, deps.config)],
    ["POST", "/admin/api/gateway/login",             "admin-api", (r, s) => handleAdminGatewayLogin(r, s, deps.gatewayManager)],
    ["POST", "/admin/api/gateway/logout",            "admin-api", (r, s) => handleAdminGatewayLogout(r, s, deps.gatewayManager)],
    ["POST", "/admin/api/accounts/login",            "admin-api", (r, s) => handleAdminAccountLogin(r, s, deps.config, deps.gatewayManager)],
    ["GET",  "/admin/api/accounts/callback",         "admin-api", (r, s, u) => handleAdminAccountCallback(r, s, deps.config, u, deps.gatewayManager)],
    ["GET",  "/admin/api/accounts/login-status",     "admin-api", (r, s, u) => handleAdminAccountLoginStatus(r, s, deps.config, u)],
    ["POST", "/admin/api/accounts/login/cancel",     "admin-api", (r, s) => handleAdminAccountLoginCancel(r, s)],
    ["POST", "/admin/api/accounts/capture",          "admin-api", (r, s) => handleAdminCaptureAccount(r, s, deps.config, deps.gatewayManager)],
    ["POST", "/admin/api/codex/oauth/start",         "admin-api", (r, s) => handleAdminCodexOAuthStart(r, s)],
    ["POST", "/admin/api/codex/oauth/complete",      "admin-api", (r, s) => handleAdminCodexOAuthComplete(r, s, deps.config)],
    ["GET",  "/admin/api/codex/oauth/status",        "admin-api", (r, s, u) => handleAdminCodexOAuthStatus(r, s, u)],
    ["POST", "/admin/api/codex/accounts/import",     "admin-api", (r, s) => handleAdminCodexAccountImport(r, s, deps.config)],
    ["POST", "/admin/api/codex/accounts/test",       "admin-api", (r, s) => handleAdminCodexAccountTest(r, s, deps.codexClient)],
    ["POST", "/admin/api/codex/accounts/delete",     "admin-api", (r, s) => handleAdminCodexAccountDelete(r, s, deps.config)],
    ["POST", "/admin/api/codex/accounts/default",    "admin-api", (r, s) => handleAdminCodexAccountSetDefault(r, s, deps.config)],
    ["POST", "/admin/api/codex/accounts/toggle",     "admin-api", (r, s) => handleAdminCodexAccountToggle(r, s, deps.config)],
    ["GET",  "/auth/callback",                       "admin-api", (r, s, u) => handleCodexOAuthCallback(r, s, deps.config, u)],
    // Health & debug
    ["GET",  "/healthz",                             null,        (r, s) => handleHealth(r, s, deps.client, deps.directClient, deps.sessionStore, deps.modelsRegistry, deps.responseCache, deps.traceStore)],
    ["GET",  "/debug/accio-auth",                    null,        (r, s) => handleAccioAuthProbe(r, s, deps.client, deps.directClient)],
    ["GET",  "/debug/traces",                        null,        (r, s, u) => handleTracesList(r, s, deps.traceStore, u)]
  ];

  // Build lookup map: "METHOD:/path" -> [protocol, handler]
  const routeMap = new Map();
  for (const [method, path, protocol, handler] of staticRoutes) {
    routeMap.set(`${method}:${path}`, [protocol, handler]);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const startTime = Date.now();
    const requestId = String(req.headers["x-request-id"] || generateId("req"));

    res.setHeader("x-request-id", requestId);
    req.bridgeContext = {
      bodyParser: {
        maxBytes: client.config.maxBodyBytes,
        timeoutMs: client.config.bodyReadTimeoutMs
      },
      requestId,
      trace: {
        request: {
          headers: req.headers
        },
        response: {},
        bridge: {}
      }
    };

    const requestMeta = {
      requestId,
      method: req.method,
      path: url.pathname
    };

    const finishLog = (level, message, meta = {}) => {
      log[level](message, {
        ...requestMeta,
        ms: Date.now() - startTime,
        ...meta
      });
    };

    try {
      finishLog("info", "request started");

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        finishLog("info", "request completed", { status: 204 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        writeJson(res, 200, {
          name: "accio-anthropic-bridge",
          ok: true,
          endpoints: staticRoutes.map(([m, p]) => `${m} ${p}`).concat([
            "GET /debug/traces/:id",
            "GET /debug/traces/:id/replay",
            "GET /v1/models",
            "POST /v1/messages",
            "POST /v1/messages/count_tokens",
            "POST /v1/chat/completions",
            "POST /v1/responses"
          ])
        });
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      /* ── Static route lookup (replaces ~20 if-blocks) ── */
      const routeKey = `${req.method}:${url.pathname}`;
      const matched = routeMap.get(routeKey);
      if (matched) {
        const [protocol, handler] = matched;
        await handler(req, res, url);
        const logMeta = { status: res.statusCode || 200 };
        if (protocol) {
          logMeta.protocol = protocol;
        }
        finishLog("info", "request completed", logMeta);
        return;
      }

      /* ── Dynamic debug trace routes ── */
      if (req.method === "GET" && /^\/debug\/traces\/[^/]+$/.test(url.pathname)) {
        handleTraceDetail(req, res, traceStore, url.pathname.split("/").pop());
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && /^\/debug\/traces\/[^/]+\/replay$/.test(url.pathname)) {
        const segments = url.pathname.split("/");
        const traceId = segments[segments.length - 2];
        handleTraceReplay(req, res, traceStore, traceId, `http://${req.headers.host || `127.0.0.1:${client.config.port}`}`);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      /* ── API routes (with trace capture & activity recording) ── */
      if (req.method === "GET" && url.pathname === "/v1/models") {
        await handleModelsRequest(req, res, modelsRegistry);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        finishLog("info", "request completed", {
          status: res.statusCode || 200,
          protocol: "openai",
          modelsSource: client.config.modelsSource
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessagesRequest(req, res, client, directClient, claudeFallbackPool, sessionStore, responseCache);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        recordRecentActivity(recentActivityStore, req, requestMeta, "anthropic", res.statusCode || 200);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        await handleCountTokens(req, res);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletionsRequest(req, res, client, codexClient, codexFallbackPool, sessionStore, responseCache);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        recordRecentActivity(recentActivityStore, req, requestMeta, "openai", res.statusCode || 200);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "openai" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleResponsesRequest(req, res, client, codexClient, codexFallbackPool, sessionStore, responseCache);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        recordRecentActivity(recentActivityStore, req, requestMeta, "openai-responses", res.statusCode || 200);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "openai-responses" });
        return;
      }

      writeJson(res, 404, buildErrorResponse(`No route for ${url.pathname}`));
      finishLog("warn", "request completed", { status: 404 });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : Number(error && error.status) || 500;
      const message =
        error instanceof HttpError
          ? error.body && error.body.error
            ? error.body.error
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);

      const errorType =
        error && typeof error.type === "string"
          ? error.type
          : classifyErrorType(statusCode, error);

      log.error("request failed", {
        ...requestMeta,
        status: statusCode,
        error: message,
        type: errorType,
        ms: Date.now() - startTime
      });

      const errorBody = buildErrorResponse(
        message,
        errorType,
        error && error.details ? { details: error.details } : {}
      );

      setTraceError(req, res, statusCode, error, error && error.details ? error.details : null);
      updateTrace(req, {
        response: {
          statusCode,
          body: errorBody
        }
      });

      if (res.headersSent || res.writableEnded || res.destroyed) {
        log.warn("response already started; skipping JSON error write", {
          ...requestMeta,
          status: statusCode,
          ms: Date.now() - startTime
        });
        captureTrace(traceStore, req, res, requestMeta, startTime);
        return;
      }

      writeJson(res, statusCode, errorBody);
      captureTrace(traceStore, req, res, requestMeta, startTime);
    }
  });
}

async function main() {
  const config = createConfig();
  const client = new AccioClient(config);
  const authProvider = new AuthProvider(config);
  const codexAuthProvider = new CodexAuthProvider(config);
  const gatewayManager = new GatewayManager({
    baseUrl: config.baseUrl,
    appPath: config.appPath,
    autostartEnabled: config.gatewayAutostart,
    waitMs: config.gatewayWaitMs,
    pollMs: config.gatewayPollMs
  });
  const directClient = new DirectLlmClient({
    authMode: config.authMode,
    authProvider,
    accountsPath: config.accountsPath,
    gatewayManager,
    localGatewayBaseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    upstreamBaseUrl: config.directLlmBaseUrl,
    authCacheTtlMs: config.authCacheTtlMs,
    quotaPreflightEnabled: config.quotaPreflightEnabled,
    quotaCacheTtlMs: config.quotaCacheTtlMs,
    accountStandbyEnabled: config.accountStandbyEnabled,
    accountStandbyRefreshMs: config.accountStandbyRefreshMs,
    accioHome: config.accioHome,
    language: config.language
  });
  directClient.startAccountStandbyLoop();
  const claudeFallbackPool = new ExternalFallbackPool({
    targets: config.fallbackTargets || [],
    fetchImpl: fetch
  });
  const codexFallbackPool = new ExternalFallbackPool({
    targets: config.codexFallbackTargets || [],
    fetchImpl: fetch
  });
  const codexClient = new CodexResponsesClient({
    authProvider: codexAuthProvider,
    defaultBaseUrl: config.codexResponsesBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    fetchImpl: fetch
  });
  const sessionStore = new SessionStore(config.sessionStorePath);
  const modelsRegistry = new ModelsRegistry(config);
  const responseCache = new ResponseCache({
    ttlMs: config.responseCacheTtlMs,
    maxEntries: config.responseCacheMaxEntries
  });
  const recentActivityStore = new RecentActivityStore();

  /* ── activeAccount 自动跟随最近成功出口账号 ── */
  const _lastSyncedAccountIdByTheme = new Map();
  const _syncTimerByTheme = new Map();
  const SYNC_DEBOUNCE_MS = 2000;

  recentActivityStore.subscribe((activity) => {
    if (!activity || !activity.accountId || activity.authSource === "gateway") {
      return;
    }

    const nextAccountId = String(activity.accountId);
    const theme = String(activity.theme || "");
    const targetAccountsPath = theme === "codex"
      ? config.codexAccountsPath
      : config.accountsPath;
    const targetProvider = theme === "codex" ? codexAuthProvider : authProvider;

    if (!targetAccountsPath) {
      return;
    }

    if (nextAccountId === _lastSyncedAccountIdByTheme.get(theme || "claude")) {
      return;
    }

    const summary = targetProvider.getSummary();
    const currentActive = summary && summary.activeAccount ? String(summary.activeAccount) : null;

    if (nextAccountId === currentActive) {
      _lastSyncedAccountIdByTheme.set(theme || "claude", nextAccountId);
      const currentTimer = _syncTimerByTheme.get(theme || "claude");
      if (currentTimer) {
        clearTimeout(currentTimer);
        _syncTimerByTheme.delete(theme || "claude");
      }
      return;
    }

    _lastSyncedAccountIdByTheme.set(theme || "claude", nextAccountId);

    const existingTimer = _syncTimerByTheme.get(theme || "claude");
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const nextTimer = setTimeout(() => {
      _syncTimerByTheme.delete(theme || "claude");

      try {
        setActiveAccountInFile(targetAccountsPath, nextAccountId);
        log.info("active account synced to serving account", {
          accountId: nextAccountId,
          theme: theme || "claude",
          previousActive: currentActive || null
        });
      } catch (error) {
        log.warn("failed to sync active account", {
          accountId: nextAccountId,
          error: error && error.message ? error.message : String(error)
        });
      }
    }, SYNC_DEBOUNCE_MS);
    _syncTimerByTheme.set(theme || "claude", nextTimer);
  });

  const traceStore = new DebugTraceStore({
    enabled: config.traceEnabled,
    dirPath: config.traceDir,
    maxEntries: config.traceMaxEntries,
    maxStringLength: config.traceMaxBodyChars,
    sampleRate: config.traceSampleRate
  });
  const server = createServer(config, client, directClient, claudeFallbackPool, codexClient, codexFallbackPool, authProvider, codexAuthProvider, gatewayManager, sessionStore, modelsRegistry, responseCache, traceStore, recentActivityStore);

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("shutdown requested", { signal });
    directClient.stopAccountStandbyLoop();
    authProvider.flushSync();
    codexAuthProvider.flushSync();
    sessionStore.flushSync();

    server.close(() => {
      log.info("server closed", { signal });
      process.exit(0);
    });

    setTimeout(() => {
      log.error("forced shutdown after timeout", { signal, timeoutMs: 5000 });
      process.exit(1);
    }, 5000).unref();
  };

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", {
      error: reason instanceof Error ? reason.stack : String(reason)
    });
  });

  process.on("uncaughtException", (error) => {
    log.error("uncaught exception — initiating shutdown", {
      error: error instanceof Error ? error.stack : String(error)
    });
    shutdown("uncaughtException");
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(config.port, "127.0.0.1", () => {
    log.info("server listening", {
      port: config.port,
      url: `http://127.0.0.1:${config.port}`
    });

    refreshAllSnapshotQuotas(config, authProvider).catch((error) => {
      log.warn("startup quota refresh failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

main().catch((error) => {
  log.error("server bootstrap failed", {
    error: error instanceof Error ? error.stack : String(error)
  });
  process.exitCode = 1;
});
