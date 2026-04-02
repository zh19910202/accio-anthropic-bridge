"use strict";

const path = require("node:path");

const { discoverAccioAppPath, discoverAccioConfig } = require("./discovery");
const { normalizeFallbackTarget } = require("./external-fallback");
const { parseFlag } = require("./gateway-manager");

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function parseFallbackTargetsFromEnv() {
  const raw = String(env("ACCIO_FALLBACKS_JSON", "") || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item, index) => normalizeFallbackTarget(item, index));
      }
    } catch {
      // Ignore invalid JSON and fall back to legacy single-target env vars.
    }
  }

  const legacy = normalizeFallbackTarget({
    id: "legacy-primary",
    name: "默认渠道",
    baseUrl: env("ACCIO_FALLBACK_OPENAI_BASE_URL", ""),
    apiKey: env("ACCIO_FALLBACK_OPENAI_API_KEY", ""),
    model: env("ACCIO_FALLBACK_OPENAI_MODEL", ""),
    protocol: env("ACCIO_FALLBACK_PROTOCOL", "openai"),
    anthropicVersion: env("ACCIO_FALLBACK_ANTHROPIC_VERSION", "2023-06-01"),
    timeoutMs: Number(env("ACCIO_FALLBACK_OPENAI_TIMEOUT_MS", "60000")),
    enabled: true
  }, 0);

  if (!legacy.baseUrl && !legacy.apiKey && !legacy.model) {
    return [];
  }

  return [legacy];
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
  const fallbackTargets = parseFallbackTargetsFromEnv();
  const primaryFallback = fallbackTargets[0] || normalizeFallbackTarget({}, 0);

  return {
    envPath: env("ACCIO_ENV_PATH", path.join(process.cwd(), ".env")),
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
    desktopHelperUrl: env("ACCIO_DESKTOP_HELPER_URL", "http://127.0.0.1:8090"),
    desktopHelperTimeoutMs: Number(env("ACCIO_DESKTOP_HELPER_TIMEOUT_MS", "15000")),
    gatewayWaitMs: Number(env("ACCIO_GATEWAY_WAIT_MS", "20000")),
    gatewayPollMs: Number(env("ACCIO_GATEWAY_POLL_MS", "500")),
    directLlmBaseUrl: env(
      "ACCIO_DIRECT_LLM_BASE_URL",
      "https://phoenix-gw.alibaba.com/api/adk/llm"
    ),
    fallbackTargets,
    fallbackOpenAiBaseUrl: primaryFallback.baseUrl,
    fallbackOpenAiApiKey: primaryFallback.apiKey,
    fallbackOpenAiModel: primaryFallback.model,
    fallbackOpenAiProtocol: primaryFallback.protocol,
    fallbackAnthropicVersion: primaryFallback.anthropicVersion,
    fallbackOpenAiTimeoutMs: Number(primaryFallback.timeoutMs || 60000),
    clientIdPrefix: env("ACCIO_CLIENT_ID_PREFIX", "anthropic-bridge"),
    sessionStorePath: env(
      "ACCIO_SESSION_STORE_PATH",
      path.join(process.cwd(), ".data", "sessions.json")
    ),
    authStatePath: env(
      "ACCIO_AUTH_STATE_PATH",
      path.join(process.cwd(), ".data", "auth-provider-state.json")
    ),
    maxRetries: Number(env("ACCIO_MAX_RETRIES", "2")),
    retryBaseMs: Number(env("ACCIO_RETRY_BASE_MS", "250")),
    retryMaxDelayMs: Number(env("ACCIO_RETRY_MAX_DELAY_MS", "2500")),
    modelsSource: env("ACCIO_MODELS_SOURCE", "gateway"),
    modelsCacheTtlMs: Number(env("ACCIO_MODELS_CACHE_TTL_MS", "30000")),
    maxBodyBytes: Number(env("ACCIO_MAX_BODY_BYTES", String(10 * 1024 * 1024))),
    bodyReadTimeoutMs: Number(env("ACCIO_BODY_READ_TIMEOUT_MS", "30000")),
    authCacheTtlMs: Number(env("ACCIO_AUTH_CACHE_TTL_MS", String(2 * 60 * 1000))),
    quotaPreflightEnabled: parseFlag(env("ACCIO_QUOTA_PREFLIGHT_ENABLED", "1"), true),
    quotaCacheTtlMs: Number(env("ACCIO_QUOTA_CACHE_TTL_MS", "30000")),
    accountStandbyEnabled: parseFlag(env("ACCIO_ACCOUNT_STANDBY_ENABLED", "1"), true),
    accountStandbyRefreshMs: Number(env("ACCIO_ACCOUNT_STANDBY_REFRESH_MS", "30000")),
    defaultMaxOutputTokens: Number(env("ACCIO_DEFAULT_MAX_OUTPUT_TOKENS", "4096")),
    responseCacheTtlMs: Number(env("ACCIO_RESPONSE_CACHE_TTL_MS", "10000")),
    responseCacheMaxEntries: Number(env("ACCIO_RESPONSE_CACHE_MAX_ENTRIES", "128")),
    traceEnabled: parseFlag(env("ACCIO_TRACE_ENABLED", "1"), true),
    traceSampleRate: Number(env("ACCIO_TRACE_SAMPLE_RATE", "0")),
    traceMaxEntries: Number(env("ACCIO_TRACE_MAX_ENTRIES", "200")),
    traceMaxBodyChars: Number(env("ACCIO_TRACE_MAX_BODY_CHARS", String(16 * 1024))),
    traceDir: env("ACCIO_TRACE_DIR", path.join(process.cwd(), ".data", "traces"))
  };
}

module.exports = {
  createConfig,
  env
};
