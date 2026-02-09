const { app, BrowserWindow, session, globalShortcut, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const serverPath = path.join(__dirname, "server.js");
const port = process.env.PORT ? Number(process.env.PORT) : 1130;
const stateFile = path.join(__dirname, "data", "state.json");

let serverProcess = null;
let mainWindow = null;
let tray = null;
let lastShortcutStamp = 0;
let shortcutTimer = null;
let stateWatcher = null;
let portalSessionHandle = null;
let portalShortcuts = new Map();
let portalBusy = false;
let portalMonitor = null;
const isWayland =
  (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
  Boolean(process.env.WAYLAND_DISPLAY);

function startServer() {
  if (serverProcess) return;
  serverProcess = spawn("/usr/bin/node", [serverPath], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port) },
  });
  serverProcess.on("exit", () => {
    serverProcess = null;
  });
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
}

function waitForServer(timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error("Timeout"));
        setTimeout(tick, 300);
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) return reject(new Error("Timeout"));
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeKeyName(key) {
  if (key === "Space") return "Space";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function toPortalKeyName(key) {
  if (!key) return "";
  if (key === "Space") return "space";
  if (key === "Enter") return "Return";
  if (key === "Escape") return "Escape";
  if (key === "Backspace") return "BackSpace";
  if (key === "Tab") return "Tab";
  if (key === "PageUp") return "Page_Up";
  if (key === "PageDown") return "Page_Down";
  if (key === "ArrowUp" || key === "Up") return "Up";
  if (key === "ArrowDown" || key === "Down") return "Down";
  if (key === "ArrowLeft" || key === "Left") return "Left";
  if (key === "ArrowRight" || key === "Right") return "Right";
  if (key.length === 1) return key.toLowerCase();
  return key;
}

function bindToAccelerator(bind) {
  if (!bind) return "";
  const parts = bind.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const key = parts.pop();
  const mods = parts.map((mod) => {
    if (mod === "Ctrl") return "Ctrl";
    if (mod === "Alt") return "Alt";
    if (mod === "Shift") return "Shift";
    if (mod === "Meta") return "Super";
    return mod;
  });
  const normalizedKey = normalizeKeyName(key);
  return [...mods, normalizedKey].join("+");
}

function bindToPortalTrigger(bind) {
  if (!bind) return "";
  const parts = bind.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const key = parts.pop();
  const mods = parts.map((mod) => {
    if (mod === "Ctrl") return "CTRL";
    if (mod === "Alt") return "ALT";
    if (mod === "Shift") return "SHIFT";
    if (mod === "Meta") return "LOGO";
    if (mod === "Super") return "LOGO";
    return mod.toUpperCase();
  });
  const normalizedKey = toPortalKeyName(key);
  if (!normalizedKey) return "";
  return [...mods, normalizedKey].join("+");
}

function postSoundboard(slotIndex, categoryIndex) {
  const payload = JSON.stringify({ slotIndex, categoryIndex });
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/api/soundboard-play",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.write(payload);
  req.end();
}

function escapeGdbusString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function parseGdbusObjectPath(output) {
  const match = output.match(/objectpath ['"]([^'"]+)['"]/);
  return match ? match[1] : "";
}

function runGdbus(args) {
  return new Promise((resolve) => {
    const proc = spawn("gdbus", args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.stderr.on("data", (chunk) => (err += chunk.toString()));
    proc.on("exit", (code) => resolve({ code, out, err }));
  });
}

function waitForPortalResponse(requestHandle, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let resolved = false;
    const proc = spawn("gdbus", [
      "monitor",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      requestHandle,
    ]);
    let buffer = "";
    let inResponse = false;
    let responseLines = [];
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ response: 2, sessionHandle: "" }), timeoutMs);
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.includes("member=Response")) {
          inResponse = true;
          responseLines = [];
          return;
        }
        if (inResponse && trimmed === "") {
          inResponse = false;
          let code = 2;
          let sessionHandle = "";
          responseLines.forEach((entry) => {
            const codeMatch = entry.match(/uint32\s+(\d+)/);
            if (codeMatch) code = Number(codeMatch[1]);
            const sessionMatch = entry.match(/session_handle.*objectpath ['"]([^'"]+)['"]/);
            if (sessionMatch) sessionHandle = sessionMatch[1];
          });
          clearTimeout(timer);
          finish({ response: code, sessionHandle });
          return;
        }
        if (inResponse) responseLines.push(trimmed);
      });
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      finish({ response: 2, sessionHandle: "" });
    });
  });
}

async function closePortalSession() {
  if (!portalSessionHandle) return;
  await runGdbus([
    "call",
    "--session",
    "--dest",
    "org.freedesktop.portal.Desktop",
    "--object-path",
    portalSessionHandle,
    "--method",
    "org.freedesktop.portal.Session.Close",
  ]);
  portalSessionHandle = null;
  portalShortcuts = new Map();
}

function buildGdbusShortcuts(entries) {
  const parts = entries.map((entry) => {
    const desc = escapeGdbusString(entry.description);
    const trigger = escapeGdbusString(entry.trigger);
    return `('${entry.id}', {'description': <'${desc}'>, 'preferred_trigger': <'${trigger}'>})`;
  });
  return `[${parts.join(", ")}]`;
}

async function refreshPortalShortcuts(state) {
  if (!isWayland) return;
  if (portalBusy) return;
  portalBusy = true;
  try {
    const active = state.categories[state.activeCategory || 0];
    const slots = active?.slots || [];
    const entries = [];
    const nextMap = new Map();
    slots.forEach((slot, idx) => {
      if (!slot?.bind) return;
      const trigger = bindToPortalTrigger(slot.bind);
      if (!trigger) return;
      const id = `slot_${state.activeCategory || 0}_${idx}`;
      entries.push({
        id,
        description: slot.name ? `Soundboard: ${slot.name}` : "Soundboard",
        trigger,
      });
      nextMap.set(id, idx);
    });
    await closePortalSession();
    if (!entries.length) return;
    const requestToken = `mvp_lunar_req_${Date.now()}`;
    const sessionToken = `mvp_lunar_session_${Date.now()}`;
    const createRes = await runGdbus([
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.GlobalShortcuts.CreateSession",
      `{'session_handle_token': <'${sessionToken}'>, 'handle_token': <'${requestToken}'>}`,
    ]);
    const requestHandle = parseGdbusObjectPath(createRes.out || "");
    if (!requestHandle) return;
    const sessionRes = await waitForPortalResponse(requestHandle);
    if (sessionRes.response !== 0 || !sessionRes.sessionHandle) return;
    portalSessionHandle = sessionRes.sessionHandle;
    const shortcutsArg = buildGdbusShortcuts(entries);
    const bindRes = await runGdbus([
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.GlobalShortcuts.BindShortcuts",
      portalSessionHandle,
      shortcutsArg,
      "",
      `{'handle_token': <'mvp_lunar_bind_${Date.now()}'>}`,
    ]);
    const bindReqHandle = parseGdbusObjectPath(bindRes.out || "");
    if (!bindReqHandle) return;
    const bindResp = await waitForPortalResponse(bindReqHandle);
    if (bindResp.response !== 0) return;
    portalShortcuts = nextMap;
  } finally {
    portalBusy = false;
  }
}

function startPortalMonitor() {
  if (!isWayland || portalMonitor) return;
  portalMonitor = spawn("gdbus", [
    "monitor",
    "--session",
    "--dest",
    "org.freedesktop.portal.Desktop",
    "--object-path",
    "/org/freedesktop/portal/desktop",
  ]);
  let buffer = "";
  let inActivated = false;
  let activatedLines = [];
  portalMonitor.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.includes("member=Activated")) {
        inActivated = true;
        activatedLines = [];
        return;
      }
      if (inActivated && trimmed === "") {
        inActivated = false;
        let sessionHandle = "";
        let shortcutId = "";
        activatedLines.forEach((entry) => {
          const sessionMatch = entry.match(/objectpath ['"]([^'"]+)['"]/);
          if (sessionMatch) sessionHandle = sessionMatch[1];
          const shortcutMatch = entry.match(/string ['"]([^'"]+)['"]/);
          if (shortcutMatch) shortcutId = shortcutMatch[1];
        });
        if (portalSessionHandle && sessionHandle === portalSessionHandle) {
          const slotIndex = portalShortcuts.get(shortcutId);
          if (Number.isFinite(slotIndex)) postSoundboard(slotIndex);
        }
        return;
      }
      if (inActivated) activatedLines.push(trimmed);
    });
  });
  portalMonitor.on("exit", () => {
    portalMonitor = null;
  });
}

function refreshGlobalShortcuts() {
  const state = readState();
  if (!state?.categories?.length) return;
  const stamp = state.updatedAt || 0;
  if (stamp === lastShortcutStamp) return;
  lastShortcutStamp = stamp;

  globalShortcut.unregisterAll();
  const activeIndex = state.activeCategory || 0;
  const active = state.categories[activeIndex];
  if (!active?.slots?.length) return;
  active.slots.forEach((slot, idx) => {
    if (!slot?.bind) return;
    const accelerator = bindToAccelerator(slot.bind);
    if (!accelerator) return;
    const ok = globalShortcut.register(accelerator, () => postSoundboard(idx, activeIndex));
    if (!ok) {
      console.log("Failed to register shortcut:", accelerator);
    }
  });
  refreshPortalShortcuts(state);
}

function startShortcutWatcher() {
  if (shortcutTimer) return;
  refreshGlobalShortcuts();
  shortcutTimer = setInterval(refreshGlobalShortcuts, 1500);
}

function watchStateFile() {
  if (stateWatcher) return;
  try {
    stateWatcher = fs.watch(stateFile, { persistent: false }, () => refreshGlobalShortcuts());
  } catch {
    // ignore watcher failures
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0c0f14",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "assets", "icon.png");
  tray = new Tray(iconPath);
  tray.setToolTip("MVP Lunar");
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  const menu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

app.commandLine.appendSwitch("ozone-platform-hint", "auto");
if (isWayland) {
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations,GlobalShortcutsPortal"
  );
} else {
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

app.on("ready", () => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === "media" || permission === "audioCapture") return true;
    return false;
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "audioCapture") return callback(true);
    return callback(false);
  });
  startServer();
  waitForServer()
    .then(() => {
      createWindow();
      createTray();
      startShortcutWatcher();
      watchStateFile();
      startPortalMonitor();
    })
    .catch(() => {
      createWindow();
      createTray();
      startShortcutWatcher();
      watchStateFile();
      startPortalMonitor();
    });
});

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopServer();
});
