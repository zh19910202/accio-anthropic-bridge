"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/test-direct-token.js [--account <id-or-name>] [--model <model>] [--prompt <text>] [--all]",
      "",
      "Examples:",
      "  node scripts/test-direct-token.js",
      "  node scripts/test-direct-token.js --account acct-river-zhou-7083725131",
      "  node scripts/test-direct-token.js --all --prompt \"reply with ok\""
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  const args = {
    account: "",
    model: "claude-sonnet-4-6",
    prompt: "Reply with exactly: ok",
    all: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || "");
    if (value === "--account") {
      args.account = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (value === "--model") {
      args.model = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (value === "--prompt") {
      args.prompt = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (value === "--all") {
      args.all = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    }
  }

  return args;
}

function loadAccounts(accountsPath) {
  const resolved = path.resolve(accountsPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const accounts = Array.isArray(parsed) ? parsed : Array.isArray(parsed.accounts) ? parsed.accounts : [];
  return accounts.map((account) => ({
    id: account && account.id ? String(account.id) : "",
    name: account && account.name ? String(account.name) : "",
    accessToken: account && account.accessToken ? String(account.accessToken) : "",
    expiresAt: account && account.expiresAt ? Number(account.expiresAt) : null
  }));
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
          // Ignore malformed SSE frames for this quick probe.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function collectTextFromFrame(frame) {
  const texts = [];

  const parts = frame && frame.content && Array.isArray(frame.content.parts)
    ? frame.content.parts
    : [];

  for (const part of parts) {
    if (part && typeof part.text === "string" && part.text) {
      texts.push(part.text);
    }
  }

  if (frame && frame.raw_response_json) {
    try {
      const raw = JSON.parse(frame.raw_response_json);
      const deltaText = raw && raw.delta && typeof raw.delta.text === "string" ? raw.delta.text : "";
      if (deltaText) {
        texts.push(deltaText);
      }
    } catch {
      // Ignore parse failure in probe mode.
    }
  }

  return texts;
}

async function requestWithToken({ upstreamBaseUrl, model, prompt, account }) {
  const normalizedBaseUrl = String(upstreamBaseUrl || "").replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/generateContent`;
  const body = {
    model,
    request_id: `probe-${crypto.randomUUID()}`,
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
    max_output_tokens: 64,
    stop_sequences: [],
    token: account.accessToken
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  const result = {
    id: account.id,
    name: account.name,
    httpStatus: response.status,
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

    for (const text of collectTextFromFrame(frame)) {
      result.reply += text;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const accountsPath = path.join(repoRoot, "config", "accounts.json");
  const upstreamBaseUrl = process.env.ACCIO_DIRECT_LLM_BASE_URL || "https://phoenix-gw.alibaba.com/api/adk/llm";
  const accounts = loadAccounts(accountsPath);

  const selected = args.all
    ? accounts.filter((account) => account.accessToken)
    : accounts.filter((account) => {
        if (!account.accessToken) {
          return false;
        }
        if (!args.account) {
          return true;
        }
        return account.id === args.account || account.name === args.account;
      }).slice(0, 1);

  if (selected.length === 0) {
    throw new Error(args.account ? `No account matched ${args.account}` : "No usable accessToken found in accounts.json");
  }

  const results = [];
  for (const account of selected) {
    const result = await requestWithToken({
      upstreamBaseUrl,
      model: args.model,
      prompt: args.prompt,
      account
    });
    results.push(result);
  }

  process.stdout.write(JSON.stringify({
    upstreamBaseUrl,
    model: args.model,
    prompt: args.prompt,
    results
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
