"use strict";

const path = require("node:path");

const { discoverAccioAppPath, discoverAccioConfig } = require("./discovery");
const { parseFlag } = require("./gateway-manager");

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function createConfig() {
  const discovered = discoverAccioConfig({
    accountId: env("ACCIO_ACCOUNT_ID", ""),
    accioHome: env("ACCIO_HOME", ""),
    agentId: env("ACCIO_AGENT_ID", ""),
    language: env("ACCIO_LANGUAGE", ""),
    sourceChannelId: env("ACCIO_SOURCE_CHANNEL_ID", ""),
    sourceChatId: env("ACCIO_SOURCE_CHAT_ID", ""),
    sourceChatType: env("ACCIO_SOURCE_CHAT_TYPE", ""),
    sourceUserId: env("ACCIO_SOURCE_USER_ID", ""),
    workspacePath: env("ACCIO_WORKSPACE_PATH", "")
  });

  return {
    port: Number(env("PORT", "8082")),
    baseUrl: env("ACCIO_BASE_URL", "http://127.0.0.1:4097"),
    accioHome: discovered.accioHome,
    accountId: discovered.accountId,
    agentId: discovered.agentId,
    workspacePath: discovered.workspacePath,
    language: discovered.language,
    sourceChannelId: discovered.sourceChannelId,
    sourceChatId: discovered.sourceChatId,
    sourceUserId: discovered.sourceUserId,
    sourceChatType: discovered.sourceChatType,
    sourcePlatform: env("ACCIO_SOURCE_PLATFORM", "pcApp"),
    sourceType: env("ACCIO_SOURCE_TYPE", "im"),
    requestTimeoutMs: Number(env("ACCIO_REQUEST_TIMEOUT_MS", "120000")),
    transportMode: env("ACCIO_TRANSPORT", "auto"),
    authMode: env("ACCIO_AUTH_MODE", "auto"),
    authStrategy: env("ACCIO_AUTH_STRATEGY", "round_robin"),
    accountsPath: env(
      "ACCIO_ACCOUNTS_CONFIG_PATH",
      env("ACCIO_ACCOUNTS_PATH", path.join(process.cwd(), "config", "accounts.json"))
    ),
    accessToken: env("ACCIO_ACCESS_TOKEN", ""),
    envAccountId: env("ACCIO_AUTH_ACCOUNT_ID", "env-default"),
    accessTokenExpiresAt: env("ACCIO_ACCESS_TOKEN_EXPIRES_AT", ""),
    gatewayAutostart: parseFlag(env("ACCIO_GATEWAY_AUTOSTART", "1"), true),
    appPath: discoverAccioAppPath(env("ACCIO_APP_PATH", "")),
    gatewayWaitMs: Number(env("ACCIO_GATEWAY_WAIT_MS", "20000")),
    gatewayPollMs: Number(env("ACCIO_GATEWAY_POLL_MS", "500")),
    directLlmBaseUrl: env(
      "ACCIO_DIRECT_LLM_BASE_URL",
      "https://phoenix-gw.alibaba.com/api/adk/llm"
    ),
    clientIdPrefix: env("ACCIO_CLIENT_ID_PREFIX", "anthropic-bridge"),
    sessionStorePath: env(
      "ACCIO_SESSION_STORE_PATH",
      path.join(process.cwd(), ".data", "sessions.json")
    ),
    maxRetries: Number(env("ACCIO_MAX_RETRIES", "2")),
    retryBaseMs: Number(env("ACCIO_RETRY_BASE_MS", "250")),
    retryMaxDelayMs: Number(env("ACCIO_RETRY_MAX_DELAY_MS", "2500")),
    modelsSource: env("ACCIO_MODELS_SOURCE", "static"),
    modelsCacheTtlMs: Number(env("ACCIO_MODELS_CACHE_TTL_MS", "30000")),
    maxBodyBytes: Number(env("ACCIO_MAX_BODY_BYTES", String(10 * 1024 * 1024))),
    bodyReadTimeoutMs: Number(env("ACCIO_BODY_READ_TIMEOUT_MS", "30000")),
    authCacheTtlMs: Number(env("ACCIO_AUTH_CACHE_TTL_MS", String(2 * 60 * 1000)))
  };
}

module.exports = {
  createConfig,
  env
};
