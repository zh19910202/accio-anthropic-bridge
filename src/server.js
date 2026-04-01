"use strict";

const http = require("node:http");

const { AccioClient, HttpError } = require("./accio-client");
const { AuthProvider } = require("./auth-provider");
const { buildErrorResponse } = require("./anthropic");
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
  handleAdminSnapshotActivate,
  handleAdminSnapshotDelete,
  handleAdminGatewayLogin,
  handleAdminGatewayLogout,
  handleAdminCaptureAccount,
  handleAdminAccountLogin,
  handleAdminAccountCallback,
  handleAdminAccountLoginStatus
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

function createServer(config, client, directClient, fallbackPool, authProvider, gatewayManager, sessionStore, modelsRegistry, responseCache, traceStore, recentActivityStore) {
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
          endpoints: [
            "GET /admin",
            "GET /admin/api/state",
            "GET /admin/api/logs",
            "GET /admin/api/config",
            "POST /admin/api/config/test",
            "POST /admin/api/config",
            "POST /admin/api/snapshots",
            "POST /admin/api/snapshots/activate",
            "POST /admin/api/snapshots/delete",
            "POST /admin/api/gateway/login",
            "POST /admin/api/gateway/logout",
            "POST /admin/api/accounts/login",
            "GET /admin/api/accounts/callback",
            "GET /admin/api/accounts/login-status",
            "POST /admin/api/accounts/capture",
            "GET /healthz",
            "GET /debug/accio-auth",
            "GET /debug/traces",
            "GET /debug/traces/:id",
            "GET /debug/traces/:id/replay",
            "GET /v1/models",
            "POST /v1/messages",
            "POST /v1/messages/count_tokens",
            "POST /v1/chat/completions",
            "POST /v1/responses"
          ]
        });
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin") {
        await handleAdminPage(req, res, config);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-ui" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/state") {
        await handleAdminState(req, res, config, authProvider, recentActivityStore);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/logs") {
        await handleAdminLogs(req, res);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/events") {
        await handleAdminEvents(req, res, config, authProvider, recentActivityStore);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-sse" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/config") {
        await handleAdminConfigGet(req, res, config);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/config") {
        await handleAdminConfigSave(req, res, config, fallbackPool);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/config/test") {
        await handleAdminConfigTest(req, res);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/snapshots") {
        await handleAdminSnapshotCreate(req, res, config);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/snapshots/activate") {
        await handleAdminSnapshotActivate(req, res, config, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/snapshots/delete") {
        await handleAdminSnapshotDelete(req, res, config);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/gateway/login") {
        await handleAdminGatewayLogin(req, res, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/gateway/logout") {
        await handleAdminGatewayLogout(req, res, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/accounts/login") {
        await handleAdminAccountLogin(req, res, config, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/accounts/callback") {
        await handleAdminAccountCallback(req, res, config, url, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/accounts/login-status") {
        await handleAdminAccountLoginStatus(req, res, config, url);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/accounts/capture") {
        await handleAdminCaptureAccount(req, res, config, gatewayManager);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "admin-api" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        await handleHealth(req, res, client, directClient, sessionStore, modelsRegistry, responseCache, traceStore);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/debug/accio-auth") {
        await handleAccioAuthProbe(req, res, client, directClient);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/debug/traces") {
        handleTracesList(req, res, traceStore, url);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

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
        await handleMessagesRequest(req, res, client, directClient, fallbackPool, sessionStore, responseCache);
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
        await handleChatCompletionsRequest(req, res, client, directClient, fallbackPool, sessionStore, responseCache);
        captureTrace(traceStore, req, res, requestMeta, startTime);
        recordRecentActivity(recentActivityStore, req, requestMeta, "openai", res.statusCode || 200);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "openai" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleResponsesRequest(req, res, client, directClient, fallbackPool, sessionStore, responseCache);
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
    accioHome: config.accioHome,
    language: config.language
  });
  const fallbackPool = new ExternalFallbackPool({
    targets: config.fallbackTargets || [],
    fetchImpl: fetch
  });
  const sessionStore = new SessionStore(config.sessionStorePath);
  const modelsRegistry = new ModelsRegistry(config);
  const responseCache = new ResponseCache({
    ttlMs: config.responseCacheTtlMs,
    maxEntries: config.responseCacheMaxEntries
  });
  const recentActivityStore = new RecentActivityStore();
  const traceStore = new DebugTraceStore({
    enabled: config.traceEnabled,
    dirPath: config.traceDir,
    maxEntries: config.traceMaxEntries,
    maxStringLength: config.traceMaxBodyChars,
    sampleRate: config.traceSampleRate
  });
  const server = createServer(config, client, directClient, fallbackPool, authProvider, gatewayManager, sessionStore, modelsRegistry, responseCache, traceStore, recentActivityStore);

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("shutdown requested", { signal });
    authProvider.flushSync();
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
  });
}

main().catch((error) => {
  log.error("server bootstrap failed", {
    error: error instanceof Error ? error.stack : String(error)
  });
  process.exitCode = 1;
});
