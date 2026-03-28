"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const { AccioClient, HttpError } = require("./accio-client");
const { AuthProvider } = require("./auth-provider");
const { buildErrorResponse } = require("./anthropic");
const { DirectLlmClient } = require("./direct-llm");
const { classifyErrorType } = require("./errors");
const { GatewayManager } = require("./gateway-manager");
const { CORS_HEADERS, writeJson } = require("./http");
const log = require("./logger");
const { ModelsRegistry } = require("./models");
const { handleAccioAuthProbe, handleHealth } = require("./routes/health");
const { handleCountTokens, handleMessagesRequest } = require("./routes/anthropic");
const { handleChatCompletionsRequest, handleModelsRequest, handleResponsesRequest } = require("./routes/openai");
const { createConfig } = require("./runtime-config");
const { SessionStore } = require("./session-store");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function createServer(client, directClient, sessionStore, modelsRegistry) {
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
      requestId
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
            "GET /healthz",
            "GET /debug/accio-auth",
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

      if (req.method === "GET" && url.pathname === "/healthz") {
        await handleHealth(req, res, client, directClient, sessionStore, modelsRegistry);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/debug/accio-auth") {
        await handleAccioAuthProbe(req, res, client, directClient);
        finishLog("info", "request completed", { status: res.statusCode || 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        await handleModelsRequest(req, res, modelsRegistry);
        finishLog("info", "request completed", {
          status: res.statusCode || 200,
          protocol: "openai",
          modelsSource: client.config.modelsSource
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessagesRequest(req, res, client, directClient, sessionStore);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        await handleCountTokens(req, res);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletionsRequest(req, res, client, directClient, sessionStore);
        finishLog("info", "request completed", { status: res.statusCode || 200, protocol: "openai" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleResponsesRequest(req, res, client, directClient, sessionStore);
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

      log.error("request failed", {
        ...requestMeta,
        status: statusCode,
        error: message,
        type: error && error.type ? error.type : classifyErrorType(statusCode, error),
        ms: Date.now() - startTime
      });

      writeJson(
        res,
        statusCode,
        buildErrorResponse(
          message,
          error && typeof error.type === "string"
            ? error.type
            : classifyErrorType(statusCode, error),
          error && error.details ? { details: error.details } : {}
        )
      );
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
    gatewayManager,
    localGatewayBaseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    upstreamBaseUrl: config.directLlmBaseUrl,
    authCacheTtlMs: config.authCacheTtlMs
  });
  const sessionStore = new SessionStore(config.sessionStorePath);
  const modelsRegistry = new ModelsRegistry(config);
  const server = createServer(client, directClient, sessionStore, modelsRegistry);

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("shutdown requested", { signal });
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
