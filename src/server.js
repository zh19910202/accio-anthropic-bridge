"use strict";

const http = require("node:http");

const { AccioClient, HttpError } = require("./accio-client");
const { createAccountSyncSubscriber } = require("./account-sync");
const { AuthProvider } = require("./auth-provider");
const { buildErrorResponse } = require("./anthropic");
const { CodexAuthProvider } = require("./codex-auth-provider");
const { CodexResponsesClient } = require("./codex-responses");
const { DebugTraceStore, setTraceError, updateTrace } = require("./debug-traces");
const { DirectLlmClient } = require("./direct-llm");
const { ExternalFallbackPool } = require("./external-fallback");
const { classifyErrorType, normalizeHttpStatusCode } = require("./errors");
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

/**
 * Extract pathname from req.url with minimal overhead (avoids `new URL()` per request).
 * Falls back to the full url if no query string is present.
 */
function extractPathname(rawUrl) {
  const qIndex = rawUrl.indexOf("?");
  return qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
}

function createServer(deps) {
  const {
    config, client, directClient, claudeFallbackPool,
    codexClient, codexFallbackPool, authProvider, codexAuthProvider,
    gatewayManager, sessionStore, modelsRegistry, responseCache,
    traceStore, recentActivityStore
  } = deps;

  /* ── Declarative route table ── */

  /**
   * API routes get trace capture and activity recording automatically.
   * The 5th element is an optional meta object with:
   *   - trace: boolean  — whether to call captureTrace after the handler
   *   - activity: string — protocol name for recordRecentActivity (omit to skip)
   */
  const allRoutes = [
    // Admin UI & API
    ["GET",  "/admin",                               "admin-ui",  (r, s) => handleAdminPage(r, s, config)],
    ["GET",  "/admin/api/state",                     "admin-api", (r, s) => handleAdminState(r, s, config, authProvider, codexAuthProvider, directClient, recentActivityStore)],
    ["GET",  "/admin/api/logs",                      "admin-api", (r, s) => handleAdminLogs(r, s)],
    ["GET",  "/admin/api/events",                    "admin-sse", (r, s) => handleAdminEvents(r, s, config, authProvider, codexAuthProvider, directClient, recentActivityStore)],
    ["GET",  "/admin/api/config",                    "admin-api", (r, s) => handleAdminConfigGet(r, s, config)],
    ["POST", "/admin/api/config",                    "admin-api", (r, s) => handleAdminConfigSave(r, s, config, claudeFallbackPool, codexFallbackPool)],
    ["POST", "/admin/api/config/test",               "admin-api", (r, s) => handleAdminConfigTest(r, s)],
    ["POST", "/admin/api/snapshots",                 "admin-api", (r, s) => handleAdminSnapshotCreate(r, s, config)],
    ["POST", "/admin/api/snapshots/test",            "admin-api", (r, s) => handleAdminSnapshotTest(r, s, config, authProvider)],
    ["POST", "/admin/api/snapshots/activate",        "admin-api", (r, s) => handleAdminSnapshotActivate(r, s, config, gatewayManager)],
    ["POST", "/admin/api/snapshots/delete",          "admin-api", (r, s) => handleAdminSnapshotDelete(r, s, config)],
    ["POST", "/admin/api/gateway/login",             "admin-api", (r, s) => handleAdminGatewayLogin(r, s, gatewayManager)],
    ["POST", "/admin/api/gateway/logout",            "admin-api", (r, s) => handleAdminGatewayLogout(r, s, gatewayManager)],
    ["POST", "/admin/api/accounts/login",            "admin-api", (r, s) => handleAdminAccountLogin(r, s, config, gatewayManager)],
    ["GET",  "/admin/api/accounts/callback",         "admin-api", (r, s, u) => handleAdminAccountCallback(r, s, config, u, gatewayManager)],
    ["GET",  "/admin/api/accounts/login-status",     "admin-api", (r, s, u) => handleAdminAccountLoginStatus(r, s, config, u)],
    ["POST", "/admin/api/accounts/login/cancel",     "admin-api", (r, s) => handleAdminAccountLoginCancel(r, s)],
    ["POST", "/admin/api/accounts/capture",          "admin-api", (r, s) => handleAdminCaptureAccount(r, s, config, gatewayManager)],
    ["POST", "/admin/api/codex/oauth/start",         "admin-api", (r, s) => handleAdminCodexOAuthStart(r, s)],
    ["POST", "/admin/api/codex/oauth/complete",      "admin-api", (r, s) => handleAdminCodexOAuthComplete(r, s, config)],
    ["GET",  "/admin/api/codex/oauth/status",        "admin-api", (r, s, u) => handleAdminCodexOAuthStatus(r, s, u)],
    ["POST", "/admin/api/codex/accounts/import",     "admin-api", (r, s) => handleAdminCodexAccountImport(r, s, config)],
    ["POST", "/admin/api/codex/accounts/test",       "admin-api", (r, s) => handleAdminCodexAccountTest(r, s, codexClient)],
    ["POST", "/admin/api/codex/accounts/delete",     "admin-api", (r, s) => handleAdminCodexAccountDelete(r, s, config)],
    ["POST", "/admin/api/codex/accounts/default",    "admin-api", (r, s) => handleAdminCodexAccountSetDefault(r, s, config)],
    ["POST", "/admin/api/codex/accounts/toggle",     "admin-api", (r, s) => handleAdminCodexAccountToggle(r, s, config)],
    ["GET",  "/auth/callback",                       "admin-api", (r, s, u) => handleCodexOAuthCallback(r, s, config, u)],
    // Health & debug
    ["GET",  "/healthz",                             null,        (r, s) => handleHealth(r, s, client, directClient, sessionStore, modelsRegistry, responseCache, traceStore)],
    ["GET",  "/debug/accio-auth",                    null,        (r, s) => handleAccioAuthProbe(r, s, client, directClient)],
    ["GET",  "/debug/traces",                        null,        (r, s, u) => handleTracesList(r, s, traceStore, u)],
    // API routes (with trace capture & activity recording)
    ["GET",  "/v1/models",                           "openai",    (r, s) => handleModelsRequest(r, s, modelsRegistry),                                                                { trace: true }],
    ["POST", "/v1/messages",                         "anthropic", (r, s) => handleMessagesRequest(r, s, client, directClient, claudeFallbackPool, sessionStore, responseCache),        { trace: true, activity: "anthropic" }],
    ["POST", "/v1/messages/count_tokens",            "anthropic", (r, s) => handleCountTokens(r, s),                                                                                  { trace: true }],
    ["POST", "/v1/chat/completions",                 "openai",    (r, s) => handleChatCompletionsRequest(r, s, client, codexClient, codexFallbackPool, sessionStore, responseCache),    { trace: true, activity: "openai" }],
    ["POST", "/v1/responses",                        "openai-responses", (r, s) => handleResponsesRequest(r, s, client, codexClient, codexFallbackPool, sessionStore, responseCache),  { trace: true, activity: "openai-responses" }]
  ];

  // Build lookup map: "METHOD:/path" -> [protocol, handler, meta]
  const routeMap = new Map();
  for (const [method, routePath, protocol, handler, meta] of allRoutes) {
    routeMap.set(`${method}:${routePath}`, [protocol, handler, meta || null]);
  }

  return http.createServer(async (req, res) => {
    const pathname = extractPathname(req.url);
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
      path: pathname
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

      if (req.method === "GET" && pathname === "/") {
        writeJson(res, 200, {
          name: "accio-anthropic-bridge",
          ok: true,
          endpoints: allRoutes.map(([m, p]) => `${m} ${p}`)
        });
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      /* ── Unified route lookup ── */
      const routeKey = `${req.method}:${pathname}`;
      const matched = routeMap.get(routeKey);
      if (matched) {
        const [protocol, handler, meta] = matched;

        // Only parse full URL when handler actually needs query parameters
        const url = handler.length >= 3
          ? new URL(req.url, `http://${req.headers.host || "localhost"}`)
          : null;

        await handler(req, res, url);

        // Post-handler hooks: trace capture and activity recording
        if (meta && meta.trace) {
          captureTrace(traceStore, req, res, requestMeta, startTime);
        }
        if (meta && meta.activity) {
          recordRecentActivity(recentActivityStore, req, requestMeta, meta.activity, res.statusCode || 200);
        }

        const logMeta = { status: res.statusCode || 200 };
        if (protocol) {
          logMeta.protocol = protocol;
        }
        finishLog("info", "request completed", logMeta);
        return;
      }

      /* ── Dynamic debug trace routes ── */
      if (req.method === "GET" && /^\/debug\/traces\/[^/]+$/.test(pathname)) {
        handleTraceDetail(req, res, traceStore, pathname.split("/").pop());
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && /^\/debug\/traces\/[^/]+\/replay$/.test(pathname)) {
        const segments = pathname.split("/");
        const traceId = segments[segments.length - 2];
        handleTraceReplay(req, res, traceStore, traceId, `http://${req.headers.host || `127.0.0.1:${client.config.port}`}`);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      writeJson(res, 404, buildErrorResponse(`No route for ${pathname}`));
      finishLog("warn", "request completed", { status: 404 });
    } catch (error) {
      const rawStatusCode = error instanceof HttpError ? error.status : Number(error && error.status) || 500;
      const statusCode = normalizeHttpStatusCode(rawStatusCode, 500);
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
    appVersion: config.appVersion,
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
  recentActivityStore.subscribe(
    createAccountSyncSubscriber(config, authProvider, codexAuthProvider)
  );

  const traceStore = new DebugTraceStore({
    enabled: config.traceEnabled,
    dirPath: config.traceDir,
    maxEntries: config.traceMaxEntries,
    maxStringLength: config.traceMaxBodyChars,
    sampleRate: config.traceSampleRate
  });

  const deps = {
    config, client, directClient, claudeFallbackPool,
    codexClient, codexFallbackPool, authProvider, codexAuthProvider,
    gatewayManager, sessionStore, modelsRegistry, responseCache,
    traceStore, recentActivityStore
  };
  const server = createServer(deps);

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
