"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJsonFile } = require("./jsonc");

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJsonIfExists(filePath, options = {}) {
  try {
    if (!exists(filePath)) {
      return null;
    }

    return readJsonFile(filePath, options);
  } catch {
    return null;
  }
}

function listDirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function sortByMtimeDesc(paths) {
  return [...paths].sort((left, right) => {
    const leftMtime = fs.statSync(left).mtimeMs;
    const rightMtime = fs.statSync(right).mtimeMs;
    return rightMtime - leftMtime;
  });
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value) {
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return null;
  }

  const marker = ":cid:";
  const markerIndex = sessionKey.lastIndexOf(marker);

  if (markerIndex <= 0) {
    return null;
  }

  const prefix = sessionKey.slice(0, markerIndex);
  const conversationId = sessionKey.slice(markerIndex + marker.length) || null;
  const parts = prefix.split(":");

  if (parts.length < 5 || parts[0] !== "agent") {
    return null;
  }

  return {
    agentId: parts[1] || null,
    channelId: parts[2] || null,
    chatType: parts[3] || null,
    chatId: parts.slice(4).join(":") || null,
    conversationId
  };
}

function discoverSessionCandidates(accountDir, preferredAgentId) {
  const agentsRoot = path.join(accountDir, "agents");
  const discoveredAgentIds = listDirectories(agentsRoot).filter((name) =>
    name.startsWith("DID-")
  );
  const ordered = preferredAgentId
    ? [preferredAgentId, ...discoveredAgentIds.filter((id) => id !== preferredAgentId)]
    : discoveredAgentIds;
  const candidates = [];

  for (const agentId of ordered) {
    const sessionsDir = path.join(agentsRoot, agentId, "sessions");
    let files = [];

    try {
      files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".meta.jsonc"));
    } catch {
      continue;
    }

    for (const fileName of files) {
      const filePath = path.join(sessionsDir, fileName);
      const meta = readJsonIfExists(filePath, { jsonc: true });
      const parsed = parseSessionKey(meta && meta.sessionId);

      if (!parsed || !parsed.channelId || !parsed.chatId) {
        continue;
      }

      candidates.push({
        ...parsed,
        agentId: parsed.agentId || agentId,
        updatedAt: Math.max(
          parseTimestamp(meta && meta.updatedAt),
          parseTimestamp(meta && meta.lastUserMessageAt),
          statMtimeMs(filePath)
        )
      });
    }
  }

  return candidates.sort((left, right) => right.updatedAt - left.updatedAt);
}

function discoverSessionSource(accountDir, preferredAgentId) {
  return discoverSessionCandidates(accountDir, preferredAgentId)[0] || null;
}

function discoverConversationActivity(accountDir) {
  const sessionIndex = readJsonIfExists(path.join(accountDir, "conversations", "dm", "session_1.json"));

  if (!Array.isArray(sessionIndex)) {
    return 0;
  }

  let latest = 0;

  for (const item of sessionIndex) {
    latest = Math.max(
      latest,
      parseTimestamp(item && item.updatedAt),
      parseTimestamp(item && item.createdAt),
      parseTimestamp(item && item.ts)
    );
  }

  return latest;
}

function collectAccountSignals(accountDir) {
  const sessionCandidates = discoverSessionCandidates(accountDir, null);
  const latestSessionActivity = sessionCandidates[0] ? sessionCandidates[0].updatedAt : 0;
  const latestConversationActivity = discoverConversationActivity(accountDir);
  const channelsRoot = path.join(accountDir, "channels");
  const channelIds = listDirectories(channelsRoot);
  let latestChannelActivity = 0;
  let hasConversationSource = false;

  for (const channelId of channelIds) {
    const dmPath = path.join(channelsRoot, channelId, "dm.json");
    const dm = readJsonIfExists(dmPath);

    if (dm && Array.isArray(dm.conversations) && dm.conversations.length > 0) {
      hasConversationSource = true;

      for (const conversation of dm.conversations) {
        latestChannelActivity = Math.max(
          latestChannelActivity,
          parseTimestamp(conversation && conversation.updatedAt),
          parseTimestamp(conversation && conversation.createdAt)
        );
      }
    }

    latestChannelActivity = Math.max(latestChannelActivity, statMtimeMs(dmPath));
  }

  return {
    latestActivity: Math.max(
      latestSessionActivity,
      latestConversationActivity,
      latestChannelActivity,
      statMtimeMs(accountDir)
    ),
    hasConversationSource,
    hasSessionSource: sessionCandidates.length > 0
  };
}

function resolveAccioHome(preferredHome) {
  return preferredHome || process.env.ACCIO_HOME || path.join(os.homedir(), ".accio");
}

function discoverAccioAppPath(preferredPath) {
  if (preferredPath && exists(preferredPath)) {
    return preferredPath;
  }

  if (process.platform === "darwin") {
    const candidates = [
      process.env.ACCIO_APP_PATH,
      "/Applications/Accio.app",
      path.join(os.homedir(), "Applications", "Accio.app")
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (exists(candidate)) {
        return candidate;
      }
    }

    return preferredPath || "/Applications/Accio.app";
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const candidates = [
      process.env.ACCIO_APP_PATH,
      path.join(localAppData, "Programs", "Accio", "Accio.exe"),
      path.join(programFiles, "Accio", "Accio.exe")
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (exists(candidate)) {
        return candidate;
      }
    }

    return preferredPath || path.join(programFiles, "Accio", "Accio.exe");
  }

  return preferredPath || process.env.ACCIO_APP_PATH || "Accio";
}

function discoverAccountId(accioHome, preferredAccountId) {
  if (preferredAccountId) {
    return preferredAccountId;
  }

  const accountsRoot = path.join(accioHome, "accounts");
  const accountIds = listDirectories(accountsRoot).filter((name) => name !== "guest");
  const ranked = accountIds
    .map((accountId) => {
      const accountDir = path.join(accountsRoot, accountId);
      const signals = collectAccountSignals(accountDir);

      return {
        accountId,
        hasConversationSource: signals.hasConversationSource,
        hasSessionSource: signals.hasSessionSource,
        latestActivity: signals.latestActivity,
        mtimeMs: statMtimeMs(accountDir)
      };
    })
    .sort((left, right) => {
      if (left.latestActivity !== right.latestActivity) {
        return right.latestActivity - left.latestActivity;
      }

      if (left.hasSessionSource !== right.hasSessionSource) {
        return Number(right.hasSessionSource) - Number(left.hasSessionSource);
      }

      if (left.hasConversationSource !== right.hasConversationSource) {
        return Number(right.hasConversationSource) - Number(left.hasConversationSource);
      }

      return right.mtimeMs - left.mtimeMs;
    });

  return ranked[0] ? ranked[0].accountId : null;
}

function discoverLanguage(accioHome, fallback) {
  const settings = readJsonIfExists(path.join(accioHome, "settings.jsonc"), {
    jsonc: true
  });

  return (
    fallback ||
    (settings &&
      settings.general &&
      typeof settings.general.language === "string" &&
      settings.general.language) ||
    "zh"
  );
}

function discoverChannelInfo(accountDir, preferredChannelId) {
  const channelsRoot = path.join(accountDir, "channels");
  const channelIds = listDirectories(channelsRoot);
  const ordered = preferredChannelId
    ? [preferredChannelId, ...channelIds.filter((id) => id !== preferredChannelId)]
    : channelIds;

  for (const channelId of ordered) {
    const channelDir = path.join(channelsRoot, channelId);
    const dm = readJsonIfExists(path.join(channelDir, "dm.json"));
    const conversation = dm && Array.isArray(dm.conversations) ? dm.conversations[0] : null;

    if (!conversation && preferredChannelId !== channelId) {
      continue;
    }

    const info = (conversation && conversation.info) || {};
    const agents = readJsonIfExists(path.join(channelDir, "agents.json"));
    const primaryAgent =
      agents && Array.isArray(agents.agents)
        ? agents.agents.find((agent) => agent && agent.isPrimary) || agents.agents[0]
        : null;

    return {
      agentId:
        (primaryAgent && primaryAgent.id) || (conversation && conversation.agentId) || null,
      channelId,
      chatId: conversation ? conversation.chatId : null,
      chatType: info.type || "private",
      conversationId: conversation ? conversation.conversationId : null,
      title: info.title || info.displayName || null,
      userId: info.userId || info.username || (conversation && conversation.chatId) || null
    };
  }

  const latestSession = discoverSessionCandidates(accountDir, null)[0] || null;

  if (latestSession) {
    return {
      agentId: latestSession.agentId || null,
      channelId: latestSession.channelId || preferredChannelId || "weixin",
      chatId: latestSession.chatId || null,
      chatType: latestSession.chatType || "private",
      conversationId: latestSession.conversationId || null,
      title: null,
      userId: latestSession.chatId || null
    };
  }

  return {
    agentId: null,
    channelId: preferredChannelId || "weixin",
    chatId: null,
    chatType: "private",
    conversationId: null,
    title: null,
    userId: null
  };
}

function discoverAgentProfile(accountDir, preferredAgentId, channelInfo) {
  const agentsRoot = path.join(accountDir, "agents");
  const discoveredAgentIds = listDirectories(agentsRoot).filter((name) =>
    name.startsWith("DID-")
  );
  const ordered = [];

  for (const candidate of [
    preferredAgentId,
    channelInfo && channelInfo.agentId,
    ...discoveredAgentIds
  ]) {
    if (candidate && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }

  for (const agentId of ordered) {
    const profile = readJsonIfExists(path.join(agentsRoot, agentId, "profile.jsonc"), {
      jsonc: true
    });

    if (profile || exists(path.join(agentsRoot, agentId))) {
      return {
        agentId,
        profile
      };
    }
  }

  return {
    agentId: preferredAgentId || (channelInfo && channelInfo.agentId) || null,
    profile: null
  };
}

function discoverWorkspacePath(accountDir, agentId, profile, fallbackPath) {
  if (fallbackPath) {
    return fallbackPath;
  }

  const profilePath =
    profile &&
    profile.defaultProject &&
    typeof profile.defaultProject.dir === "string" &&
    profile.defaultProject.dir;

  if (profilePath) {
    return profilePath;
  }

  if (!agentId) {
    return null;
  }

  const inferred = path.join(accountDir, "agents", agentId, "project");
  return exists(inferred) ? inferred : null;
}

function discoverAccioConfig(overrides = {}) {
  const accioHome = resolveAccioHome(overrides.accioHome);
  const accountId = discoverAccountId(accioHome, overrides.accountId);
  const accountDir = accountId ? path.join(accioHome, "accounts", accountId) : null;
  const channelInfo = accountDir
    ? discoverChannelInfo(accountDir, overrides.sourceChannelId)
    : null;
  const agentInfo = accountDir
    ? discoverAgentProfile(accountDir, overrides.agentId, channelInfo)
    : { agentId: overrides.agentId || null, profile: null };

  return {
    accioHome,
    accountId,
    agentId: overrides.agentId || agentInfo.agentId || null,
    language: overrides.language || discoverLanguage(accioHome, null),
    sourceChannelId:
      overrides.sourceChannelId || (channelInfo && channelInfo.channelId) || "weixin",
    sourceChatId: overrides.sourceChatId || (channelInfo && channelInfo.chatId) || null,
    sourceChatType:
      overrides.sourceChatType || (channelInfo && channelInfo.chatType) || "private",
    sourceUserId:
      overrides.sourceUserId ||
      (channelInfo && (channelInfo.userId || channelInfo.chatId)) ||
      null,
    initialConversationId:
      overrides.initialConversationId || (channelInfo && channelInfo.conversationId) || null,
    workspacePath: accountDir
      ? discoverWorkspacePath(
          accountDir,
          overrides.agentId || agentInfo.agentId,
          agentInfo.profile,
          overrides.workspacePath
        )
      : overrides.workspacePath || null
  };
}

function readAccioUtdid(accioHome) {
  const base = String(accioHome || "").trim();
  if (!base) {
    return "";
  }

  try {
    return fs.readFileSync(path.join(base, "utdid"), "utf8").trim();
  } catch {
    return "";
  }
}

function extractCnaFromCookie(rawCookie) {
  if (!rawCookie) {
    return "";
  }

  const text = String(rawCookie);
  const match = text.match(/(?:^|%3B\s*|;\s*)cna(?:=|%3D)([^;%]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

module.exports = {
  discoverAccioConfig,
  discoverAccioAppPath,
  discoverSessionCandidates,
  discoverSessionSource,
  exists,
  extractCnaFromCookie,
  listDirectories,
  parseSessionKey,
  readAccioUtdid,
  readJsonIfExists,
  resolveAccioHome
};
