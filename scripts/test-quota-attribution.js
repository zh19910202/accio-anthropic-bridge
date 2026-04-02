"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { createConfig } = require("../src/runtime-config");
const { readAccioUtdid, extractCnaFromCookie, normalizeCookieHeader } = require("../src/discovery");

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/test-quota-attribution.js --account <id-or-name> [--model <model>] [--prompt <text>]",
      "  node scripts/test-quota-attribution.js --account acct-river-zhou-7083725131 --wait-ms 3000",
      "",
      "What it does:",
      "  1. Refresh auth for all enabled accounts in config/accounts.json",
      "  2. Query quota for all enabled accounts",
      "  3. Send one direct /generateContent request using only the selected account accessToken",
      "  4. Query quota for all enabled accounts again",
      "  5. Print before/after changes for attribution analysis"
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  const args = {
    account: "",
    model: "claude-sonnet-4-6",
    prompt: "Reply with exactly: ok",
    waitMs: 2000,
    skipRefresh: false,
    repeat: 1,
    maxOutputTokens: 64
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--account") {
      args.account = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--model") {
      args.model = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--prompt") {
      args.prompt = String(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--wait-ms") {
      args.waitMs = Math.max(0, Number(argv[index + 1] || 0));
      index += 1;
      continue;
    }
    if (value === "--skip-refresh") {
      args.skipRefresh = true;
      continue;
    }
    if (value === "--repeat") {
      args.repeat = Math.max(1, Number(argv[index + 1] || 1));
      index += 1;
      continue;
    }
    if (value === "--max-output-tokens") {
      args.maxOutputTokens = Math.max(1, Number(argv[index + 1] || 64));
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    }
  }

  if (!args.account) {
    usage();
    throw new Error("Missing required --account <id-or-name>");
  }

  return args;
}

function loadAccounts(accountsPath) {
  const resolved = path.resolve(accountsPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const accounts = Array.isArray(parsed) ? parsed : Array.isArray(parsed.accounts) ? parsed.accounts : [];
  return accounts
    .filter((account) => account && account.enabled !== false)
    .map((account) => ({
      id: account && account.id ? String(account.id) : "",
      name: account && account.name ? String(account.name) : "",
      accountId: account && account.accountId ? String(account.accountId) : "",
      accessToken: account && account.accessToken ? String(account.accessToken) : "",
      refreshToken: account && account.refreshToken ? String(account.refreshToken) : "",
      cookie: account && account.cookie ? String(account.cookie) : "",
      source: account && account.source ? String(account.source) : "",
      user: account && account.user ? account.user : null
    }))
    .filter((account) => account.id && account.accessToken);
}

function deriveGatewayBaseUrl(directLlmBaseUrl) {
  const candidate = String(directLlmBaseUrl || "").trim();
  if (!candidate) {
    return "https://phoenix-gw.alibaba.com";
  }

  const parsed = new URL(candidate);
  return `${parsed.protocol}//${parsed.host}`;
}

async function delay(ms) {
  if (!(Number.isFinite(ms) && ms > 0)) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshAuth({ gatewayBaseUrl, utdid, language, account }) {
  if (!account.refreshToken) {
    return {
      ...account,
      refreshed: false,
      refreshBoundUserId: null
    };
  }

  const response = await fetch(`${gatewayBaseUrl}/api/auth/refresh_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-language": language,
      "x-utdid": utdid,
      "x-app-version": "0.0.0",
      "x-os": process.platform,
      "x-cna": extractCnaFromCookie(account.cookie)
    },
    body: JSON.stringify({
      utdid,
      version: "0.0.0",
      accessToken: account.accessToken,
      refreshToken: account.refreshToken
    }),
    signal: AbortSignal.timeout(15000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload || payload.success !== true || !payload.data) {
    const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(`Refresh failed for ${account.id}: ${message}`);
  }

  const refreshedAccessToken = payload.data.accessToken ? String(payload.data.accessToken) : account.accessToken;
  const refreshedRefreshToken = payload.data.refreshToken ? String(payload.data.refreshToken) : account.refreshToken;

  return {
    ...account,
    accessToken: refreshedAccessToken,
    refreshToken: refreshedRefreshToken,
    refreshed: true,
    refreshBoundUserId: payload.data.userId ? String(payload.data.userId) : null,
    refreshExpiresAt: payload.data.expiresAt ? String(payload.data.expiresAt) : null
  };
}

async function fetchQuota({ gatewayBaseUrl, utdid, language, account }) {
  const url = new URL("/api/entitlement/quota", gatewayBaseUrl);
  url.searchParams.set("accessToken", account.accessToken);
  url.searchParams.set("utdid", utdid);
  url.searchParams.set("version", "0.0.0");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-language": language,
      "x-utdid": utdid,
      "x-app-version": "0.0.0",
      "x-os": process.platform,
      "x-cna": extractCnaFromCookie(account.cookie),
      cookie: normalizeCookieHeader(account.cookie),
      accept: "application/json, text/plain, */*"
    },
    signal: AbortSignal.timeout(10000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload || payload.success !== true || !payload.data) {
    const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(`Quota failed for ${account.id}: ${message}`);
  }

  const usagePercent = Number(payload.data.usagePercent);
  const refreshCountdownSeconds = Number(payload.data.refreshCountdownSeconds);

  return {
    usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
    refreshCountdownSeconds: Number.isFinite(refreshCountdownSeconds) ? refreshCountdownSeconds : null,
    checkedAt: new Date().toISOString()
  };
}

async function* parseSseEvents(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const dataLines = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());

        if (dataLines.length === 0) {
          continue;
        }

        const data = dataLines.join("\n");
        if (data === "[DONE]") {
          continue;
        }

        try {
          yield JSON.parse(data);
        } catch {
          // Ignore malformed SSE blocks in probe mode.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function collectText(frame) {
  const texts = [];
  const parts = frame && frame.content && Array.isArray(frame.content.parts) ? frame.content.parts : [];
  for (const part of parts) {
    if (part && typeof part.text === "string" && part.text) {
      texts.push(part.text);
    }
  }
  return texts.join("");
}

async function requestGenerate({ directLlmBaseUrl, model, prompt, account, maxOutputTokens }) {
  const url = `${String(directLlmBaseUrl || "").replace(/\/+$/, "")}/generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({
      model,
      request_id: `quota-probe-${crypto.randomUUID()}`,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      system_instruction: "",
      tools: [],
      temperature: 0,
      max_output_tokens: maxOutputTokens,
      stop_sequences: [],
      token: account.accessToken
    }),
    signal: AbortSignal.timeout(30000)
  });

  const result = {
    status: response.status,
    ok: response.ok,
    reply: "",
    errorCode: null,
    errorMessage: null
  };

  if (!response.ok) {
    result.errorMessage = await response.text().catch(() => `HTTP ${response.status}`);
    return result;
  }

  for await (const frame of parseSseEvents(response.body)) {
    if (!frame) {
      continue;
    }
    if (frame.error_code || frame.error_message) {
      result.errorCode = frame.error_code || null;
      result.errorMessage = frame.error_message || null;
      break;
    }
    result.reply += collectText(frame);
  }

  return result;
}

async function captureQuotaMap(context, accounts) {
  const entries = [];
  for (const account of accounts) {
    try {
      const quota = await fetchQuota({
        gatewayBaseUrl: context.gatewayBaseUrl,
        utdid: context.utdid,
        language: context.language,
        account
      });
      entries.push({
        id: account.id,
        name: account.name,
        accountId: account.accountId || null,
        refreshBoundUserId: account.refreshBoundUserId || null,
        usagePercent: quota.usagePercent,
        refreshCountdownSeconds: quota.refreshCountdownSeconds,
        checkedAt: quota.checkedAt,
        error: null
      });
    } catch (error) {
      entries.push({
        id: account.id,
        name: account.name,
        accountId: account.accountId || null,
        refreshBoundUserId: account.refreshBoundUserId || null,
        usagePercent: null,
        refreshCountdownSeconds: null,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return entries;
}

function withDelta(before, after) {
  const beforeMap = new Map(before.map((item) => [item.id, item]));
  return after.map((item) => {
    const previous = beforeMap.get(item.id);
    const beforeUsage = previous && typeof previous.usagePercent === "number" ? previous.usagePercent : null;
    const afterUsage = typeof item.usagePercent === "number" ? item.usagePercent : null;
    return {
      ...item,
      beforeUsagePercent: beforeUsage,
      afterUsagePercent: afterUsage,
      usageDelta:
        beforeUsage !== null && afterUsage !== null
          ? Number((afterUsage - beforeUsage).toFixed(4))
          : null
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = createConfig();
  const accounts = loadAccounts(config.accountsPath);
  const target = accounts.find((account) => account.id === args.account || account.name === args.account);

  if (!target) {
    throw new Error(`No enabled account matched ${args.account}`);
  }

  const context = {
    directLlmBaseUrl: config.directLlmBaseUrl,
    gatewayBaseUrl: deriveGatewayBaseUrl(config.directLlmBaseUrl),
    utdid: readAccioUtdid(config.accioHome),
    language: config.language ? String(config.language) : "zh"
  };

  const resolvedAccounts = [];
  for (const account of accounts) {
    if (args.skipRefresh) {
      resolvedAccounts.push({
        ...account,
        refreshed: false,
        refreshBoundUserId: null
      });
      continue;
    }
    resolvedAccounts.push(await refreshAuth({
      gatewayBaseUrl: context.gatewayBaseUrl,
      utdid: context.utdid,
      language: context.language,
      account
    }));
  }

  const resolvedTarget = resolvedAccounts.find((account) => account.id === target.id);
  const before = await captureQuotaMap(context, resolvedAccounts);
  const requests = [];
  for (let index = 0; index < args.repeat; index += 1) {
    requests.push(await requestGenerate({
      directLlmBaseUrl: context.directLlmBaseUrl,
      model: args.model,
      prompt: args.prompt,
      account: resolvedTarget,
      maxOutputTokens: args.maxOutputTokens
    }));
  }
  await delay(args.waitMs);
  const after = await captureQuotaMap(context, resolvedAccounts);

  process.stdout.write(
    JSON.stringify(
      {
        testedAccount: {
          id: resolvedTarget.id,
          name: resolvedTarget.name,
          accountId: resolvedTarget.accountId || null,
          refreshBoundUserId: resolvedTarget.refreshBoundUserId || null,
          accessTokenPrefix: resolvedTarget.accessToken ? `${resolvedTarget.accessToken.slice(0, 12)}...` : null
        },
        requestCount: args.repeat,
        requests,
        before,
        after,
        delta: withDelta(before, after)
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
