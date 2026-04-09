"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteFileSync } = require("./accounts-file");

const AUTH_CALLBACK_FILE = "auth-callback.json";

const AUTH_ARTIFACTS = [
  "credentials.enc",
  "Cookies",
  "Cookies-journal",
  "Network Persistent State",
  "Preferences",
  "Local Storage",
  "Session Storage",
  "SharedStorage",
  "SharedStorage-wal",
  "Trust Tokens",
  "Trust Tokens-journal",
  "DIPS",
  "DIPS-shm",
  "DIPS-wal"
];

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function getRepoRoot() {
  return path.resolve(__dirname, "..");
}

function getDataRoot() {
  const configured = String(env("ACCIO_DATA_DIR", "")).trim();

  if (configured) {
    return path.resolve(configured);
  }

  return path.join(getRepoRoot(), ".data");
}

function getSnapshotRoot() {
  return path.resolve(
    env("ACCIO_AUTH_SNAPSHOT_DIR", path.join(getDataRoot(), "auth-snapshots"))
  );
}

function getUserDataDir() {
  const configured = String(env("ACCIO_USER_DATA_DIR", "")).trim();

  if (configured) {
    return path.resolve(configured);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Accio");
  }

  if (process.platform === "win32") {
    return path.join(env("APPDATA", path.join(os.homedir(), "AppData", "Roaming")), "Accio");
  }

  return path.join(env("XDG_CONFIG_HOME", path.join(os.homedir(), ".config")), "Accio");
}

function getLegacyConfigDir() {
  return path.join(os.homedir(), ".config", "accio");
}

function getEncryptedCredentialsPath() {
  return path.join(getUserDataDir(), "credentials.enc");
}

function getPlaintextCredentialsPath() {
  return path.join(getLegacyConfigDir(), "credentials.json");
}

function sanitizeAlias(alias) {
  const value = String(alias || "").trim();

  if (!value) {
    throw new Error("Snapshot alias is required");
  }

  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!safe) {
    throw new Error(`Invalid snapshot alias: ${alias}`);
  }

  return safe;
}

function detectActiveStorage() {
  const encryptedPath = getEncryptedCredentialsPath();
  const plaintextPath = getPlaintextCredentialsPath();
  const encryptedExists = fs.existsSync(encryptedPath);
  const plaintextExists = fs.existsSync(plaintextPath);
  const kind = encryptedExists ? "encrypted" : plaintextExists ? "plaintext" : null;
  const sourcePath = kind === "encrypted" ? encryptedPath : kind === "plaintext" ? plaintextPath : null;

  return {
    userDataDir: getUserDataDir(),
    legacyConfigDir: getLegacyConfigDir(),
    encryptedPath,
    plaintextPath,
    encryptedExists,
    plaintextExists,
    kind,
    sourcePath
  };
}

function getSnapshotDir(alias) {
  return path.join(getSnapshotRoot(), sanitizeAlias(alias));
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePathSync(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyPathSync(sourcePath, targetPath) {
  const stat = fs.statSync(sourcePath);
  ensureDirSync(path.dirname(targetPath));

  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);

  try {
    fs.chmodSync(targetPath, stat.mode);
  } catch {
    // ignore chmod failures on copied artifacts
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeAuthCallbackPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Auth callback payload is required");
  }

  const accessToken = String(payload.accessToken || "").trim();
  const refreshToken = String(payload.refreshToken || "").trim();
  const expiresAtRaw = String(payload.expiresAtRaw || payload.expiresAt || "").trim();
  const expiresAtMs = Number(payload.expiresAtMs || 0) || (expiresAtRaw ? Number(expiresAtRaw) * 1000 : 0);

  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new Error("Auth callback payload must include accessToken, refreshToken, and expiresAtRaw");
  }

  return {
    accessToken,
    refreshToken,
    expiresAtRaw,
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    cookie: payload.cookie ? String(payload.cookie) : null,
    user: payload.user || null,
    source: payload.source ? String(payload.source) : "gateway-callback",
    capturedAt: payload.capturedAt ? String(payload.capturedAt) : new Date().toISOString()
  };
}

function getSnapshotAuthPayloadPath(alias) {
  return path.join(getSnapshotDir(alias), AUTH_CALLBACK_FILE);
}

function readSnapshotAuthPayload(alias) {
  return readJsonIfExists(getSnapshotAuthPayloadPath(alias));
}

function writeSnapshotAuthPayload(alias, payload) {
  const safeAlias = sanitizeAlias(alias);
  const normalized = normalizeAuthCallbackPayload(payload);
  const targetPath = getSnapshotAuthPayloadPath(safeAlias);
  atomicWriteFileSync(targetPath, JSON.stringify(normalized, null, 2) + "\n", {
    mode: 0o600
  });
  return normalized;
}

function collectAuthArtifacts(active = detectActiveStorage()) {
  const artifacts = [];

  for (const relativePath of AUTH_ARTIFACTS) {
    const sourcePath = path.join(active.userDataDir, relativePath);

    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const stat = fs.statSync(sourcePath);
    artifacts.push({
      relativePath,
      type: stat.isDirectory() ? "directory" : "file"
    });
  }

  if (active.plaintextExists) {
    artifacts.push({
      relativePath: "credentials.json",
      type: "file",
      legacy: true
    });
  }

  return artifacts;
}

async function readGatewayState(baseUrl = env("ACCIO_BASE_URL", "http://127.0.0.1:4097")) {
  const normalized = String(baseUrl).replace(/\/$/, "");

  try {
    const response = await fetch(`${normalized}/auth/status`, {
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) {
      return {
        reachable: true,
        authenticated: false,
        baseUrl: normalized,
        status: response.status,
        user: null
      };
    }

    const payload = await response.json();
    return {
      reachable: true,
      authenticated: Boolean(payload && payload.authenticated),
      baseUrl: normalized,
      status: response.status,
      user: payload && payload.user ? payload.user : null
    };
  } catch (error) {
    return {
      reachable: false,
      authenticated: false,
      baseUrl: normalized,
      status: null,
      user: null,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function listSnapshots() {
  const root = getSnapshotRoot();

  if (!fs.existsSync(root)) {
    return [];
  }

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const metadata = readJsonIfExists(path.join(dir, "metadata.json"));
      const encryptedPath = path.join(dir, "credentials.enc");
      const plaintextPath = path.join(dir, "credentials.json");
      const authPayload = readJsonIfExists(path.join(dir, AUTH_CALLBACK_FILE));

      return {
        alias: entry.name,
        dir,
        metadata,
        kind: fs.existsSync(encryptedPath) ? "encrypted" : fs.existsSync(plaintextPath) ? "plaintext" : null,
        encryptedPath,
        plaintextPath,
        artifacts: metadata && Array.isArray(metadata.artifacts) ? metadata.artifacts : [],
        hasAuthCallback: Boolean(authPayload && authPayload.accessToken && authPayload.refreshToken && (authPayload.expiresAtRaw || authPayload.expiresAtMs)),
        authPayloadUser: authPayload && authPayload.user ? authPayload.user : null,
        authPayloadCapturedAt: authPayload && authPayload.capturedAt ? authPayload.capturedAt : null
      };
    })
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

function snapshotActiveCredentials(alias, extras = {}) {
  const safeAlias = sanitizeAlias(alias);
  const active = detectActiveStorage();

  if (!active.kind || !active.sourcePath) {
    throw new Error("No active Accio credentials file found to snapshot");
  }

  let preservedAuthPayload = null;

  if (!extras.authPayload) {
    try {
      preservedAuthPayload = readSnapshotAuthPayload(safeAlias);
    } catch {
      preservedAuthPayload = null;
    }
  }

  const targetDir = getSnapshotDir(safeAlias);
  removePathSync(targetDir);
  ensureDirSync(targetDir);

  const artifacts = collectAuthArtifacts(active);

  for (const artifact of artifacts) {
    const sourcePath = artifact.legacy
      ? active.plaintextPath
      : path.join(active.userDataDir, artifact.relativePath);
    const targetPath = path.join(targetDir, artifact.relativePath);
    copyPathSync(sourcePath, targetPath);
  }

  if (!artifacts.some((artifact) => artifact.relativePath === (active.kind === "encrypted" ? "credentials.enc" : "credentials.json"))) {
    const fallbackRelativePath = active.kind === "encrypted" ? "credentials.enc" : "credentials.json";
    copyPathSync(active.sourcePath, path.join(targetDir, fallbackRelativePath));
    artifacts.push({
      relativePath: fallbackRelativePath,
      type: "file",
      legacy: fallbackRelativePath === "credentials.json"
    });
  }

  const metadata = {
    alias: safeAlias,
    capturedAt: new Date().toISOString(),
    kind: active.kind,
    sourcePath: active.sourcePath,
    gatewayUser: extras.gatewayUser || null,
    notes: extras.notes || null,
    artifacts
  };

  atomicWriteFileSync(path.join(targetDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", {
    mode: 0o600
  });

  const authPayloadToPersist = extras.authPayload || preservedAuthPayload;

  if (authPayloadToPersist) {
    writeSnapshotAuthPayload(safeAlias, authPayloadToPersist);
  }

  return {
    alias: safeAlias,
    dir: targetDir,
    metadata,
    targetPath: path.join(targetDir, active.kind === "encrypted" ? "credentials.enc" : "credentials.json")
  };
}

function activateSnapshot(alias) {
  const safeAlias = sanitizeAlias(alias);
  const dir = getSnapshotDir(safeAlias);
  const metadata = readJsonIfExists(path.join(dir, "metadata.json"));
  const encryptedSource = path.join(dir, "credentials.enc");
  const plaintextSource = path.join(dir, "credentials.json");
  const kind = fs.existsSync(encryptedSource) ? "encrypted" : fs.existsSync(plaintextSource) ? "plaintext" : null;

  if (!kind) {
    throw new Error(`Snapshot not found or missing payload for alias: ${safeAlias}`);
  }

  const active = detectActiveStorage();
  const destination = kind === "encrypted" ? active.encryptedPath : active.plaintextPath;
  const source = kind === "encrypted" ? encryptedSource : plaintextSource;
  const artifactEntries = metadata && Array.isArray(metadata.artifacts) && metadata.artifacts.length > 0
    ? metadata.artifacts
    : [{ relativePath: path.basename(source), type: "file", legacy: kind === "plaintext" }];

  for (const relativePath of AUTH_ARTIFACTS) {
    removePathSync(path.join(active.userDataDir, relativePath));
  }

  removePathSync(active.plaintextPath);

  for (const artifact of artifactEntries) {
    const sourcePath = path.join(dir, artifact.relativePath);

    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const targetPath = artifact.legacy
      ? active.plaintextPath
      : path.join(active.userDataDir, artifact.relativePath);
    copyPathSync(sourcePath, targetPath);
  }

  if (!fs.existsSync(destination)) {
    copyPathSync(source, destination);
  }

  const opposite = kind === "encrypted" ? active.plaintextPath : active.encryptedPath;
  if (fs.existsSync(opposite)) {
    fs.rmSync(opposite, { force: true });
  }

  return {
    alias: safeAlias,
    kind,
    metadata,
    source,
    destination,
    restoredArtifacts: artifactEntries.map((artifact) => artifact.relativePath),
    removedOpposite: fs.existsSync(opposite) ? opposite : null,
    active
  };
}

function deleteSnapshot(alias) {
  const safeAlias = sanitizeAlias(alias);
  const dir = getSnapshotDir(safeAlias);

  if (!fs.existsSync(dir)) {
    throw new Error(`Snapshot not found for alias: ${safeAlias}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { alias: safeAlias, dir };
}

module.exports = {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot,
  deleteSnapshot,
  sanitizeAlias,
  getSnapshotRoot,
  getEncryptedCredentialsPath,
  getPlaintextCredentialsPath,
  getUserDataDir,
  getLegacyConfigDir,
  getSnapshotAuthPayloadPath,
  readSnapshotAuthPayload,
  writeSnapshotAuthPayload,
  normalizeAuthCallbackPayload
};
