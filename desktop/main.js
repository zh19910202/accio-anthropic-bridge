"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain, safeStorage, nativeImage } = require("electron");

const execFileAsync = promisify(execFile);
const IS_PACKAGED = app.isPackaged;
const CODE_ROOT = IS_PACKAGED ? __dirname : path.resolve(__dirname, "..");
const APP_ROOT = CODE_ROOT;
const BRIDGE_ENTRY_PATH = path.join(CODE_ROOT, "src", "start.js");
const BRIDGE_WORKDIR = IS_PACKAGED ? app.getPath("userData") : APP_ROOT;
const RUNTIME_ROOT = IS_PACKAGED ? app.getPath("userData") : APP_ROOT;
const ENV_PATH = path.join(RUNTIME_ROOT, ".env");
const CONFIG_DIR = path.join(RUNTIME_ROOT, "config");
const DATA_DIR = path.join(RUNTIME_ROOT, ".data");
const ACCOUNTS_PATH = path.join(CONFIG_DIR, "accounts.json");
const SESSION_STORE_PATH = path.join(DATA_DIR, "sessions.json");
const AUTH_STATE_PATH = path.join(DATA_DIR, "auth-provider-state.json");
const AUTH_SNAPSHOT_DIR = path.join(DATA_DIR, "auth-snapshots");
const TRACE_DIR = path.join(DATA_DIR, "traces");
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const DESKTOP_ICON_PATH = path.join(__dirname, "assets", "icon-512.png");
const { loadEnvFile } = require(path.join(CODE_ROOT, "src", "env-file"));
const { createConfig } = require(path.join(CODE_ROOT, "src", "runtime-config"));

if (IS_PACKAGED) {
  process.env.ACCIO_ENV_PATH = process.env.ACCIO_ENV_PATH || ENV_PATH;
  process.env.ACCIO_ACCOUNTS_CONFIG_PATH = process.env.ACCIO_ACCOUNTS_CONFIG_PATH || ACCOUNTS_PATH;
  process.env.ACCIO_DATA_DIR = process.env.ACCIO_DATA_DIR || DATA_DIR;
  process.env.ACCIO_SESSION_STORE_PATH = process.env.ACCIO_SESSION_STORE_PATH || SESSION_STORE_PATH;
  process.env.ACCIO_AUTH_STATE_PATH = process.env.ACCIO_AUTH_STATE_PATH || AUTH_STATE_PATH;
  process.env.ACCIO_AUTH_SNAPSHOT_DIR = process.env.ACCIO_AUTH_SNAPSHOT_DIR || AUTH_SNAPSHOT_DIR;
  process.env.ACCIO_TRACE_DIR = process.env.ACCIO_TRACE_DIR || TRACE_DIR;
}

loadEnvFile(ENV_PATH);

const bridgeConfig = createConfig();
const BRIDGE_PORT = Number(bridgeConfig.port || process.env.PORT || 8082);
const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const ADMIN_URL = `${BRIDGE_BASE_URL}/admin`;
const STATE_URL = `${BRIDGE_BASE_URL}/admin/api/state`;
const HEALTH_URL = `${BRIDGE_BASE_URL}/healthz`;
const START_TIMEOUT_MS = 30000;
const BRIDGE_NODE_PATH = IS_PACKAGED
  ? process.execPath
  : (process.env.ACCIO_DESKTOP_NODE_PATH || process.env.NODE || "node");
const START_POLL_MS = 500;
const DESKTOP_HELPER_PORT = Number(process.env.ACCIO_DESKTOP_HELPER_PORT || bridgeConfig.desktopHelperUrl?.match(/:(\d+)(?:\/|$)/)?.[1] || 8090);

let desktopCommandServer = null;

function loadDesktopIcon() {
  try {
    const icon = nativeImage.createFromPath(DESKTOP_ICON_PATH);
    if (!icon.isEmpty()) {
      return icon;
    }
  } catch (_) {
    // Ignore icon load failures; the desktop shell can still boot without a custom icon.
  }

  return null;
}

function ensureRuntimeLayout() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUTH_SNAPSHOT_DIR, { recursive: true });
  fs.mkdirSync(TRACE_DIR, { recursive: true });
}

let mainWindow = null;
let bridgeProcess = null;
let bridgeOwned = false;
let quitting = false;

async function launchAccioDesktopApp() {
  process.stdout.write('[desktop] launch Accio requested\n');
  const appPath = String(bridgeConfig.appPath || '/Applications/Accio.app');
  const attempts = [];

  if (process.platform === 'darwin') {
    try {
      await execFileAsync('open', ['-a', appPath]);
      return { ok: true, method: 'open -a', appPath };
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error));
    }

    try {
      await execFileAsync('open', [appPath]);
      return { ok: true, method: 'open path', appPath };
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    const shellResult = await shell.openPath(appPath);
    if (!shellResult) {
      return { ok: true, method: 'shell.openPath', appPath };
    }
    attempts.push(shellResult);
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error));
  }

  throw new Error(`Failed to launch Accio desktop app: ${attempts.filter(Boolean).join(' | ') || 'unknown error'}`);
}

ipcMain.handle('bridge:launch-accio', async (_event, params = {}) => {
  const result = await launchAccioDesktopApp();
  if (params && params.reload && mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reloadIgnoringCache();
      }
    }, 1000);
  }
  process.stdout.write(`[desktop] launch Accio finished via IPC: ${JSON.stringify(result)}\n`);
  return result;
});

ipcMain.handle('bridge:clipboard-read-text', async () => clipboard.readText());

async function handleDesktopBridgeCommand(targetUrl) {
  const parsed = new URL(targetUrl);
  const command = parsed.hostname || parsed.pathname.replace(/^\//, '');

  if (command === 'launch-accio') {
    await launchAccioDesktopApp();

    const shouldReload = parsed.searchParams.get('reload') === '1';
    if (shouldReload && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      }, 1000);
    }

    return true;
  }

  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sanitizeCredentialPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "invalid_payload" };
  }

  return {
    ok: true,
    user: payload.user || null,
    accessTokenPreview: payload.accessToken ? String(payload.accessToken).slice(0, 12) + '***' : null,
    refreshTokenPreview: payload.refreshToken ? String(payload.refreshToken).slice(0, 12) + '***' : null,
    expiresAt: payload.expiresAt || null,
    hasCookie: Boolean(payload.cookie),
    cookiePreview: payload.cookie ? String(payload.cookie).slice(0, 64) + '***' : null,
    keys: Object.keys(payload).sort()
  };
}

function decryptCredentialFile(filePath) {
  const raw = require("node:fs").readFileSync(filePath);
  const decrypted = safeStorage.decryptString(raw);
  return sanitizeCredentialPayload(JSON.parse(decrypted));
}

function startDesktopCommandServer() {
  if (desktopCommandServer) {
    return desktopCommandServer;
  }

  desktopCommandServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        writeJson(res, 200, { ok: true, port: DESKTOP_HELPER_PORT });
        return;
      }

      if (req.method === "POST" && req.url === "/launch-accio") {
        const result = await launchAccioDesktopApp();
        process.stdout.write(`[desktop] launch Accio finished via helper: ${JSON.stringify(result)}
`);
        writeJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && req.url === "/debug/decrypt-credentials") {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const filePath = body && body.path ? String(body.path) : "";
        if (!filePath) {
          writeJson(res, 400, { ok: false, error: "path is required" });
          return;
        }
        writeJson(res, 200, decryptCredentialFile(filePath));
        return;
      }

      writeJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[desktop] helper request failed: ${message}\n`);
      writeJson(res, 500, { ok: false, error: message });
    }
  });

  desktopCommandServer.on("error", (error) => {
    process.stderr.write(`[desktop] helper server error: ${error instanceof Error ? error.stack : String(error)}\n`);
  });

  desktopCommandServer.listen(DESKTOP_HELPER_PORT, "127.0.0.1", () => {
    process.stdout.write(`[desktop] helper listening on http://127.0.0.1:${DESKTOP_HELPER_PORT}\n`);
  });

  return desktopCommandServer;
}

function encodeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildShellHtml(title, body, tone) {
  const isError = tone === "error";
  const accent = isError ? "#c43c3c" : "#c25a32";
  const accentSoft = isError ? "rgba(196,60,60,0.1)" : "rgba(194,90,50,0.1)";
  const icon = isError ? "\u26A0\uFE0F" : "\u2728";
  const loadingHtml = isError ? "" : `<div class="loading-dots"><span></span><span></span><span></span></div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${encodeHtml(title)}</title>
<style>
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}
@keyframes gradientShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
* { box-sizing: border-box; margin: 0; }
html, body {
  margin: 0; min-height: 100%;
  background: linear-gradient(175deg, #faf8f5 0%, #f2ede6 50%, #ede7df 100%);
  background-size: 200% 200%;
  animation: gradientShift 8s ease infinite;
  color: #1a1816;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Noto Sans SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
body { display: grid; place-items: center; padding: 28px; }
main {
  width: min(600px, 100%);
  background: rgba(255,254,252,0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(24,22,20,0.08);
  border-radius: 22px;
  box-shadow: 0 16px 48px rgba(56,40,28,0.1);
  overflow: hidden;
  animation: fadeSlideUp 0.5s ease-out;
}
header { padding: 24px 26px 0; }
.icon { font-size: 32px; margin-bottom: 10px; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: ${accentSoft};
  color: ${accent};
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 600;
}
h1 { margin: 12px 0 0; font-size: clamp(22px, 3vw, 30px); font-weight: 700; line-height: 1.15; letter-spacing: -0.03em; }
section { padding: 16px 26px 26px; }
p { margin: 0; color: #8a8279; font-size: 13px; line-height: 1.7; }
.code {
  margin-top: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(24,22,20,0.04);
  border: 1px solid rgba(24,22,20,0.08);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #4a443e;
}
.loading-dots {
  display: flex;
  gap: 6px;
  margin-top: 18px;
  justify-content: center;
}
.loading-dots span {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: ${accent};
  animation: bounce 1.4s ease-in-out infinite both;
}
.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }
.loading-dots span:nth-child(3) { animation-delay: 0s; }
</style>
</head>
<body>
<main>
  <header>
    <div class="icon">${icon}</div>
    <div class="badge">Accio Bridge Desktop</div>
    <h1>${encodeHtml(title)}</h1>
  </header>
  <section>
    <p>${encodeHtml(body)}</p>
    <div class="code">Bridge: ${encodeHtml(BRIDGE_BASE_URL)}\nAdmin: ${encodeHtml(ADMIN_URL)}</div>
    ${loadingHtml}
  </section>
</main>
</body>
</html>`;
}

function toDataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function requestOk(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json, text/html;q=0.9, */*;q=0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response;
}

async function isBridgeReady() {
  try {
    await requestOk(STATE_URL, 1500);
    return true;
  } catch {
    return false;
  }
}

function pipeBridgeLogs(stream, label) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      process.stdout.write(`[bridge:${label}] ${line}\n`);
    }
  });
}

function startBridgeProcess() {
  if (bridgeProcess && bridgeProcess.exitCode == null) {
    return bridgeProcess;
  }

  ensureRuntimeLayout();

  const bridgeEnv = {
    ...process.env,
    ACCIO_ENV_PATH: ENV_PATH,
    ACCIO_ACCOUNTS_CONFIG_PATH: ACCOUNTS_PATH,
    ACCIO_DATA_DIR: DATA_DIR,
    ACCIO_SESSION_STORE_PATH: SESSION_STORE_PATH,
    ACCIO_AUTH_STATE_PATH: AUTH_STATE_PATH,
    ACCIO_AUTH_SNAPSHOT_DIR: AUTH_SNAPSHOT_DIR,
    ACCIO_TRACE_DIR: TRACE_DIR,
    ACCIO_DESKTOP_NODE_PATH: BRIDGE_NODE_PATH
  };

  if (IS_PACKAGED) {
    bridgeEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  bridgeProcess = spawn(BRIDGE_NODE_PATH, [BRIDGE_ENTRY_PATH], {
    cwd: BRIDGE_WORKDIR,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridgeOwned = true;

  pipeBridgeLogs(bridgeProcess.stdout, "stdout");
  pipeBridgeLogs(bridgeProcess.stderr, "stderr");

  bridgeProcess.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stdout.write(`[bridge] child exited with ${reason}\n`);

    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      const html = buildShellHtml(
        "Bridge 已退出",
        "桌面壳检测到 bridge 提前退出。通常是端口占用或本地配置异常，先确认 8082 没被旧进程占用，再重新打开管理台。",
        "error"
      );
      mainWindow.loadURL(toDataUrl(html)).catch(() => {});
    }
  });

  bridgeProcess.on("error", (error) => {
    process.stderr.write(`[bridge] spawn failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  });

  return bridgeProcess;
}

async function ensureBridgeReady() {
  if (await isBridgeReady()) {
    return { startedByDesktop: false };
  }

  startBridgeProcess();
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    try {
      if (await isBridgeReady()) {
        return { startedByDesktop: true };
      }

      await requestOk(HEALTH_URL, 1500);
    } catch (error) {
      lastError = error;
    }

    await delay(START_POLL_MS);
  }

  throw new Error(
    `Bridge did not become ready within ${START_TIMEOUT_MS}ms${lastError ? `: ${lastError.message}` : ""}`
  );
}

function createMainWindow() {
  const desktopIcon = loadDesktopIcon();

  mainWindow = new BrowserWindow({
    width: 960,
    height: 560,
    minWidth: 800,
    minHeight: 540,
    show: false,
    backgroundColor: "#f4efe8",
    title: "Accio Bridge Desktop",
    autoHideMenuBar: false,
    ...(desktopIcon ? { icon: desktopIcon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (String(url).startsWith('accio-bridge://')) {
      handleDesktopBridgeCommand(url).catch((error) => {
        dialog.showErrorBox('Accio 操作失败', error instanceof Error ? error.message : String(error));
      });
      return { action: "deny" };
    }

    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (String(url).startsWith('accio-bridge://')) {
      event.preventDefault();
      handleDesktopBridgeCommand(url).catch((error) => {
        dialog.showErrorBox('Accio 操作失败', error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (!url.startsWith(BRIDGE_BASE_URL)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  return mainWindow;
}

async function loadInitialShell() {
  if (!mainWindow) {
    return;
  }

  const html = buildShellHtml(
    "正在准备管理台",
    "桌面壳会先检查本地 bridge 是否已经在线；如果没有，就自动从当前仓库目录拉起 bridge，然后把内置管理台加载进来。"
  );

  await mainWindow.loadURL(toDataUrl(html));
}

async function loadAdminConsole() {
  if (!mainWindow) {
    return;
  }

  await mainWindow.loadURL(ADMIN_URL);
}

async function showStartupError(error) {
  if (!mainWindow) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const html = buildShellHtml("管理台启动失败", message, "error");
  await mainWindow.loadURL(toDataUrl(html));
}

async function stopBridgeProcess() {
  if (!bridgeOwned || !bridgeProcess || bridgeProcess.exitCode != null) {
    return;
  }

  const child = bridgeProcess;
  bridgeProcess = null;

  await new Promise((resolve) => {
    let finished = false;

    function done() {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    }

    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill("SIGKILL");
      }
      done();
    }, 3000);

    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });

    if (process.platform === "win32") {
      execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(() => {}).finally(done);
      return;
    }

    child.kill("SIGTERM");
  });
}

function buildMenuTemplate() {
  const template = [
    {
      label: "Bridge",
      submenu: [
        {
          label: "重新加载管理台",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.reload();
            }
          }
        },
        {
          label: "在浏览器中打开管理台",
          click: () => {
            shell.openExternal(ADMIN_URL).catch(() => {});
          }
        },
        {
          label: "复制管理台地址",
          click: () => {
            clipboard.writeText(ADMIN_URL);
          }
        },
        {
          label: "复制健康检查地址",
          click: () => {
            clipboard.writeText(HEALTH_URL);
          }
        },
        { type: "separator" },
        {
          label: "退出",
          role: "quit"
        }
      ]
    },
    {
      label: "Window",
      role: "windowMenu"
    }
  ];

  template.splice(1, 0, process.platform === "darwin"
    ? {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" }
        ]
      }
    : {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "delete" },
          { role: "selectAll" }
        ]
      });

  return template;
}

async function boot() {
  startDesktopCommandServer();
  const desktopIcon = loadDesktopIcon();
  if (desktopIcon && process.platform === "darwin" && app.dock && typeof app.dock.setIcon === "function") {
    app.dock.setIcon(desktopIcon);
  }
  createMainWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  await loadInitialShell();

  try {
    const result = await ensureBridgeReady();
    process.stdout.write(`[desktop] bridge ready at ${BRIDGE_BASE_URL} (startedByDesktop=${result.startedByDesktop})\n`);
    await loadAdminConsole();
  } catch (error) {
    await showStartupError(error);
    dialog.showErrorBox(
      "Accio Bridge Desktop",
      error instanceof Error ? error.message : String(error)
    );
  }
}

app.setName("Accio Bridge Desktop");
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await boot();
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (desktopCommandServer) {
    desktopCommandServer.close();
    desktopCommandServer = null;
  }
});

app.whenReady()
  .then(boot)
  .catch(async (error) => {
    dialog.showErrorBox("Accio Bridge Desktop", error instanceof Error ? error.message : String(error));
    await stopBridgeProcess();
    app.exit(1);
  });

app.on("will-quit", (event) => {
  if (!bridgeOwned || !bridgeProcess || bridgeProcess.exitCode != null) {
    return;
  }

  event.preventDefault();
  stopBridgeProcess()
    .catch(() => {})
    .finally(() => {
      app.exit(0);
    });
});
