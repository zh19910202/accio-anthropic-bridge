"use strict";

const path = require("node:path");

const { discoverAccioAppPath, discoverAccioAppVersion, discoverAccioConfig } = require("./discovery");
const { normalizeFallbackTarget } = require("./external-fallback");
const { parseFlag } = require("./gateway-manager");

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function parseFallbackTargetsFromEnv(options = {}) {
  const jsonEnv = options.jsonEnv || "ACCIO_FALLBACKS_JSON";
  const baseUrlEnv = options.baseUrlEnv || "ACCIO_FALLBACK_OPENAI_BASE_URL";
  const apiKeyEnv = options.apiKeyEnv || "ACCIO_FALLBACK_OPENAI_API_KEY";
  const modelEnv = options.modelEnv || "ACCIO_FALLBACK_OPENAI_MODEL";
  const protocolEnv = options.protocolEnv || "ACCIO_FALLBACK_PROTOCOL";
  const anthropicVersionEnv = options.anthropicVersionEnv || "ACCIO_FALLBACK_ANTHROPIC_VERSION";
  const timeoutEnv = options.timeoutEnv || "ACCIO_FALLBACK_OPENAI_TIMEOUT_MS";
  const raw = String(env(jsonEnv, "") || "").trim();
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
    baseUrl: env(baseUrlEnv, ""),
    apiKey: env(apiKeyEnv, ""),
    model: env(modelEnv, ""),
    protocol: env(protocolEnv, "openai"),
    anthropicVersion: env(anthropicVersionEnv, "2023-06-01"),
    timeoutMs: Number(env(timeoutEnv, "60000")),
    enabled: true
  }, 0);

  if (!legacy.baseUrl && !legacy.apiKey && !legacy.model) {
    return [];
  }

  return [legacy];
}

function createConfig() {
  const appPath = discoverAccioAppPath(env("ACCIO_APP_PATH", ""));
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
  const codexFallbackTargets = parseFallbackTargetsFromEnv({
    jsonEnv: "ACCIO_CODEX_FALLBACKS_JSON",
    baseUrlEnv: "ACCIO_CODEX_FALLBACK_BASE_URL",
    apiKeyEnv: "ACCIO_CODEX_FALLBACK_API_KEY",
    modelEnv: "ACCIO_CODEX_FALLBACK_MODEL",
    protocolEnv: "ACCIO_CODEX_FALLBACK_PROTOCOL",
    anthropicVersionEnv: "ACCIO_CODEX_FALLBACK_ANTHROPIC_VERSION",
    timeoutEnv: "ACCIO_CODEX_FALLBACK_TIMEOUT_MS"
  });
  const primaryFallback = fallbackTargets[0] || normalizeFallbackTarget({}, 0);
  const primaryCodexFallback = codexFallbackTargets[0] || normalizeFallbackTarget({}, 0);

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
    requestTimeoutMs: Number(env("ACCIO_REQUEST_TIMEOUT_MS", "300000")),
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
    appPath,
    appVersion: env("ACCIO_APP_VERSION", discoverAccioAppVersion(appPath) || "0.0.0"),
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
    codexAccountsPath: env(
      "ACCIO_CODEX_ACCOUNTS_CONFIG_PATH",
      path.join(process.cwd(), "config", "codex-accounts.json")
    ),
    codexAuthStatePath: env(
      "ACCIO_CODEX_AUTH_STATE_PATH",
      path.join(process.cwd(), ".data", "codex-auth-provider-state.json")
    ),
    codexResponsesBaseUrl: env("ACCIO_CODEX_BASE_URL", "https://api.openai.com/v1"),
    codexFallbackTargets,
    codexFallbackBaseUrl: primaryCodexFallback.baseUrl,
    codexFallbackApiKey: primaryCodexFallback.apiKey,
    codexFallbackModel: primaryCodexFallback.model,
    codexFallbackProtocol: primaryCodexFallback.protocol,
    codexFallbackTimeoutMs: Number(primaryCodexFallback.timeoutMs || 60000),
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
    accountStandbyReadyTarget: Number(env("ACCIO_ACCOUNT_STANDBY_READY_TARGET", "1")),
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
