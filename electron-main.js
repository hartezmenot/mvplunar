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

function postSoundboard(slotIndex) {
  const payload = JSON.stringify({ slotIndex });
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

function refreshGlobalShortcuts() {
  return;
  const state = readState();
  if (!state?.categories?.length) return;
  const stamp = state.updatedAt || 0;
  if (stamp === lastShortcutStamp) return;
  lastShortcutStamp = stamp;

  globalShortcut.unregisterAll();
  const active = state.categories[state.activeCategory || 0];
  if (!active?.slots?.length) return;
  active.slots.forEach((slot, idx) => {
    if (!slot?.bind) return;
    const accelerator = bindToAccelerator(slot.bind);
    if (!accelerator) return;
    const ok = globalShortcut.register(accelerator, () => postSoundboard(idx));
    if (!ok) {
      console.log("Failed to register shortcut:", accelerator);
    }
  });
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
    })
    .catch(() => {
      createWindow();
      createTray();
    });
  // Soundboard binds removed.
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
