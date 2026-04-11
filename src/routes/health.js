"use strict";

const fsp = require("node:fs/promises");

const { writeJson } = require("../http");
const log = require("../logger");
const { errMsg } = require("../utils");

async function handleHealth(req, res, client, directClient, sessionStore, modelsRegistry, responseCache, traceStore) {
  let auth = null;
  let authDebug = null;
  let directLlm = null;
  let models = [];

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    directLlm = {
      available: await directClient.isAvailable(),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  } catch (error) {
    directLlm = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  }

  try {
    models = await modelsRegistry.listModels();
  } catch (error) {
    models = [];
  }

  const storeExists = await fsp.access(client.config.sessionStorePath).then(() => true, () => false);
  const storeStats = storeExists ? await fsp.stat(client.config.sessionStorePath) : null;

  writeJson(res, 200, {
    ok: true,
    auth,
    authDebug,
    directLlm,
    authProvider: directClient.authProvider ? directClient.authProvider.getSummary() : null,
    gatewayManager: directClient.gatewayManager ? directClient.gatewayManager.getSummary() : null,
    models: {
      source: client.config.modelsSource,
      count: models.length,
      ids: models.slice(0, 20).map((model) => model.id)
    },
    responseCache: responseCache ? responseCache.getSummary() : null,
    traces: traceStore ? traceStore.getSummary() : null,
    config: {
      baseUrl: client.config.baseUrl,
      directLlmBaseUrl: client.config.directLlmBaseUrl,
      agentId: client.config.agentId,
      authMode: client.config.authMode,
      authCacheTtlMs: client.config.authCacheTtlMs,
      defaultMaxOutputTokens: client.config.defaultMaxOutputTokens,
      responseCacheTtlMs: client.config.responseCacheTtlMs,
      traceEnabled: client.config.traceEnabled,
      traceSampleRate: client.config.traceSampleRate,
      traceMaxEntries: client.config.traceMaxEntries,
      gatewayAutostart: client.config.gatewayAutostart,
      transportMode: client.config.transportMode,
      workspacePath: client.config.workspacePath,
      port: client.config.port,
      maxBodyBytes: client.config.maxBodyBytes,
      bodyReadTimeoutMs: client.config.bodyReadTimeoutMs,
      traceDir: client.config.traceDir
    },
    discovery: {
      accioHome: client.config.accioHome,
      accountId: client.config.accountId,
      sourceChannelId: client.config.sourceChannelId,
      sourceChatId: client.config.sourceChatId
    },
    sessions: {
      ...sessionStore.getSummary(),
      exists: storeExists,
      updatedAt: storeStats ? storeStats.mtime.toISOString() : null
    }
  });
}

async function handleAccioAuthProbe(req, res, client, directClient) {
  let auth = null;
  let authDebug = null;
  let directLlmAvailable = false;

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const debugData =
    authDebug &&
    typeof authDebug === "object" &&
    authDebug.success === true &&
    authDebug.data &&
    typeof authDebug.data === "object"
      ? authDebug.data
      : null;
  const fileState = debugData && debugData.file && typeof debugData.file === "object"
    ? debugData.file
    : null;
  const memoryState =
    debugData && debugData.memory && typeof debugData.memory === "object"
      ? debugData.memory
      : null;
  const hasLocalCredentials = Boolean(
    (fileState && fileState.hasCredentials) || (memoryState && memoryState.hasCredentials)
  );
  const hasCookie = Boolean(
    (fileState && fileState.hasCookie) || (memoryState && memoryState.hasCookie)
  );
  const hasTokenPrefix = Boolean(
    (fileState && fileState.accessTokenPrefix) ||
      (memoryState && memoryState.accessTokenPrefix)
  );

  try {
    directLlmAvailable = await directClient.isAvailable();
  } catch (error) {
    log.debug("direct llm availability probe failed", {
      error: errMsg(error)
    });
  }

  writeJson(res, 200, {
    ok: true,
    baseUrl: client.config.baseUrl,
    probe: {
      authStatusEndpoint: "/auth/status",
      authDebugEndpoint: "/debug/auth/status",
      uploadProxyEndpoint: "/upload"
    },
    auth,
    authDebug,
    assessment: {
      localGatewayReachable: true,
      hasLocalCredentials,
      hasCookie,
      hasTokenPrefix,
      rawCredentialsExposedOverHttp: true,
      authMode: client.config.authMode,
      directAuthReuseFeasible: directLlmAvailable,
      note: directLlmAvailable
        ? "Local debug endpoints expose enough auth-bearing data to reuse the desktop login for direct /api/adk/llm calls."
        : "Direct upstream auth reuse is currently unavailable from the local gateway."
    }
  });
}

module.exports = {
  handleAccioAuthProbe,
  handleHealth
};
