const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = __dirname;
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "state.json");
const pipewireConfigDir = path.join(process.env.HOME || root, ".config/pipewire/pipewire.conf.d");
const pipewirePulseConfigDir = path.join(process.env.HOME || root, ".config/pipewire/pipewire-pulse.conf.d");
const pipewireConfigFile = path.join(pipewireConfigDir, "99-mvp-lunar-mic.conf");
const streamOutputConfigFile = path.join(pipewirePulseConfigDir, "95-mvp-stream-output.conf");
const micSinkConfigFile = path.join(pipewirePulseConfigDir, "90-mvp-lunar-mic.conf");
const micSourceConfigFile = path.join(pipewirePulseConfigDir, "89-mvp-lunar-mic-source.conf");
const sourceCacheFile = path.join(dataDir, "default-source.txt");
const loopbackConfigFile = path.join(pipewirePulseConfigDir, "91-mvp-lunar-loopbacks.conf");
const loopbackStateFile = path.join(dataDir, "loopbacks.json");
const micLoopbackFile = path.join(dataDir, "mic-loopback.txt");
const micSinkFile = path.join(dataDir, "mic-sink.txt");
const streamLinksFile = path.join(dataDir, "stream-links.json");
const soundboardMicFile = path.join(dataDir, "soundboard-mic.txt");
const chatMicFile = path.join(dataDir, "chat-mic.txt");
const micFxSourceFile = path.join(dataDir, "mic-fx-source.txt");
const streamOutputStateFile = path.join(dataDir, "stream-output.txt");
const pinFile = path.join(dataDir, "pin.txt");
const serverConfigFile = path.join(dataDir, "server-config.json");
const chatFxFeedFile = path.join(dataDir, "chat-fx-feed.txt");
const soundboardQueue = [];
const maxSoundboardQueue = 100;
const port = process.env.PORT ? Number(process.env.PORT) : 1130;
const serverConfig = readServerConfig();
// Always rotate PIN on server start (app restart/reboot).
refreshPin();

const PACTL_COOLDOWN_MS = 5000;
const PIPEWIRE_RESTART_COOLDOWN_MS = 15000;
const pactlState = { disabledUntil: 0, lastError: "", lastErrorAt: 0 };
let lastPipewireRestartAt = 0;

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(pipewireConfigDir)) {
  fs.mkdirSync(pipewireConfigDir, { recursive: true });
}
if (!fs.existsSync(pipewirePulseConfigDir)) {
  fs.mkdirSync(pipewirePulseConfigDir, { recursive: true });
}

function enqueueSoundboardEvent(type, slotIndex, categoryIndex) {
  const event = {
    type,
    slotIndex: Number.isFinite(slotIndex) ? slotIndex : null,
    categoryIndex: Number.isFinite(categoryIndex) ? categoryIndex : null,
    ts: Date.now(),
  };
  soundboardQueue.push(event);
  if (soundboardQueue.length > maxSoundboardQueue) {
    soundboardQueue.splice(0, soundboardQueue.length - maxSoundboardQueue);
  }
}

function mapGateThreshold(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const value = Math.pow(10, -3 + (clamped / 100) * 3);
  return Number(value.toFixed(6));
}

function writePipewireConfig({ rnnEnabled, gateEnabled, gateThreshold, micFxEnabled, noiseSuppressor }) {
  const fxEnabled = micFxEnabled !== false;
  const useRnnoise = noiseSuppressor !== "off";
  if (!fxEnabled || (!rnnEnabled && !gateEnabled)) {
    if (fs.existsSync(pipewireConfigFile)) {
      fs.rmSync(pipewireConfigFile, { force: true });
    }
    return;
  }
  const rnnoiseEnabled = rnnEnabled && useRnnoise ? 1 : 0;
  const gateEnabledVal = gateEnabled ? 1 : 0;
  const threshold = mapGateThreshold(gateThreshold);
  const config = [
    "# MVP Lunar Mic FX source (filtered input)",
    "context.modules = [",
    "  { name = libpipewire-module-filter-chain",
    "    flags = [ nofail ]",
    "    args = {",
    "      node.description = \"MVP Lunar Mic FX\"",
    "      media.name       = \"MVP Lunar Mic FX\"",
    "      audio.channels   = 1",
    "      audio.rate       = 48000",
    "      audio.position   = [ MONO ]",
    "      filter.graph = {",
    "        nodes = [",
    "          {",
    "            type   = lv2",
    "            name   = rnnoise",
    "            plugin = \"https://github.com/werman/noise-suppression-for-voice#mono\"",
    "            control = {",
    "              enabled = " + rnnoiseEnabled,
    "            }",
    "          }",
    "          {",
    "            type   = lv2",
    "            name   = gate",
    "            plugin = \"http://lsp-plug.in/plugins/lv2/gate_mono\"",
    "            control = {",
    "              enabled = " + gateEnabledVal,
    "              gt = " + threshold,
    "            }",
    "          }",
    "        ]",
    "        links = [",
    "          { output = \"rnnoise:audio_out_1\" input = \"gate:in\" }",
    "        ]",
    "        inputs  = [ \"rnnoise:audio_in_1\" ]",
    "        outputs = [ \"gate:out\" ]",
    "      }",
    "      capture.props = {",
    "        node.name    = \"mvp_lunar_input\"",
    "        node.passive = true",
    "        target.object = \"@DEFAULT_SOURCE@\"",
    "      }",
    "      playback.props = {",
    "        node.name   = \"mvp_lunar_micfx\"",
    "        node.description = \"MVP Lunar Mic FX\"",
    "        media.class = Audio/Source",
    "      }",
    "    }",
    "  }",
    "]",
    "",
  ].join("\n");
  fs.writeFileSync(pipewireConfigFile, config);
}

function writeChatFilterConfig({ rnnEnabled, gateEnabled, gateThreshold, noiseSuppressor, chatGateTest }) {
  const useRnnoise = Boolean(rnnEnabled) && noiseSuppressor !== "off";
  const useGate = Boolean(gateEnabled);
  const gateValue = mapGateThreshold(gateThreshold);
  const gateControl = chatGateTest ? 1 : (useGate ? 1 : 0);
  const nodes = [];
  const links = [];
  let inputs = [];
  let outputs = [];

  if (!useRnnoise) {
    nodes.push(
      "        nodes = [",
      "          { type = builtin label = copy name = copyL }",
      "          { type = builtin label = copy name = copyR }"
    );
    if (useGate || chatGateTest) {
      nodes.push(
        "          {",
        "            type   = lv2",
        "            name   = gate",
        "            plugin = \"http://lsp-plug.in/plugins/lv2/gate_lr\"",
        "            control = {",
        "              enabled = " + gateControl + ",",
        "              gt_l = " + gateValue + ",",
        "              gt_r = " + gateValue,
        "            }",
        "          }"
      );
      links.push(
        "        links = [",
        "          { output = \"copyL:Out\" input = \"gate:in_l\" }",
        "          { output = \"copyR:Out\" input = \"gate:in_r\" }",
        "        ]"
      );
      outputs = ["        outputs = [ \"gate:out_l\" \"gate:out_r\" ]"];
    } else {
      links.push("        links = [ ]");
      outputs = ["        outputs = [ \"copyL:Out\" \"copyR:Out\" ]"];
    }
    nodes.push("        ]");
    inputs = ["        inputs  = [ \"copyL:In\" \"copyR:In\" ]"];
  } else {
    nodes.push(
      "        nodes = [",
      "          {",
      "            type   = lv2",
      "            name   = rnnoise",
      "            plugin = \"https://github.com/werman/noise-suppression-for-voice#stereo\"",
      "            control = { enabled = 1 }",
      "          }"
    );
    if (useGate || chatGateTest) {
      nodes.push(
        "          {",
        "            type   = lv2",
        "            name   = gate",
        "            plugin = \"http://lsp-plug.in/plugins/lv2/gate_lr\"",
        "            control = {",
        "              enabled = " + gateControl + ",",
        "              gt_l = " + gateValue + ",",
        "              gt_r = " + gateValue,
        "            }",
        "          }"
      );
      links.push(
        "        links = [",
        "          { output = \"rnnoise:audio_out_1\" input = \"gate:in_l\" }",
        "          { output = \"rnnoise:audio_out_2\" input = \"gate:in_r\" }",
        "        ]"
      );
      outputs = ["        outputs = [ \"gate:out_l\" \"gate:out_r\" ]"];
    } else {
      links.push("        links = [ ]");
      outputs = ["        outputs = [ \"rnnoise:audio_out_1\" \"rnnoise:audio_out_2\" ]"];
    }
    nodes.push("        ]");
    inputs = ["        inputs  = [ \"rnnoise:audio_in_1\" \"rnnoise:audio_in_2\" ]"];
  }

  const base = [
    "# MVP Lunar Chat filter chain",
    "context.modules = [",
    "  { name = libpipewire-module-filter-chain",
    "    flags = [ nofail ]",
    "    args = {",
    "      node.description = \"MVP Lunar Chat Filter\"",
    "      media.name       = \"MVP Lunar Chat Filter\"",
    "      audio.channels   = 2",
    "      audio.rate       = 48000",
    "      audio.position   = [ FL FR ]",
    "      filter.graph = {",
  ];
  const tail = [
    "      }",
    "      capture.props = {",
    "        node.name    = \"chat_fx_input\"",
    "        node.description = \"Chat FX Input\"",
    "        media.class = Audio/Sink",
    "      }",
    "      playback.props = {",
    "        node.name   = \"chat_fx_output\"",
    "        node.description = \"Chat FX Output\"",
    "        media.class = Audio/Source",
    "      }",
    "    }",
    "  }",
    "]",
    "",
  ];
  const config = base.concat(nodes, links, inputs, outputs, tail).join("\n");
  fs.writeFileSync(path.join(pipewireConfigDir, "98-mvp-lunar-chat.conf"), config);
}

function isPactlCmd(cmd) {
  return cmd.endsWith("/pactl") || cmd === "pactl";
}

function canUsePactl() {
  return Date.now() >= pactlState.disabledUntil;
}

function markPactlFailure(err) {
  const msg = String(err || "pactl failed").trim();
  const now = Date.now();
  const logGapMs = 30000;
  if (now - pactlState.lastErrorAt > logGapMs || msg !== pactlState.lastError) {
    console.error(`[pactl] ${msg}`);
    pactlState.lastError = msg;
    pactlState.lastErrorAt = now;
  }
  pactlState.disabledUntil = Math.max(pactlState.disabledUntil, now + PACTL_COOLDOWN_MS);
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    if (isPactlCmd(cmd) && !canUsePactl()) return resolve();
    if (isPactlCmd(cmd)) {
      const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      if (proc.stderr) proc.stderr.on("data", (chunk) => (err += chunk.toString()));
      proc.on("exit", (code) => {
        if (code !== 0) markPactlFailure(err || `exit ${code}`);
        resolve();
      });
      return;
    }
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("exit", () => resolve());
  });
}

function runCmdOutput(cmd, args) {
  return new Promise((resolve) => {
    if (isPactlCmd(cmd) && !canUsePactl()) return resolve("");
    const proc = spawn(cmd, args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    if (proc.stderr) proc.stderr.on("data", (chunk) => (err += chunk.toString()));
    proc.on("exit", (code) => {
      if (isPactlCmd(cmd) && code !== 0) {
        markPactlFailure(err || `exit ${code}`);
        return resolve("");
      }
      resolve(out.trim());
    });
  });
}

async function safeRestartPipewire(units) {
  const now = Date.now();
  if (now - lastPipewireRestartAt < PIPEWIRE_RESTART_COOLDOWN_MS) return;
  lastPipewireRestartAt = now;
  await runCmd("/usr/bin/systemctl", ["--user", "restart", ...units]);
}

function normalizeDeviceLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return label;
  if (/MVP Lunar Mic FX/i.test(raw) || /mvp_lunar_micfx/i.test(raw)) {
    return "MVP Lunar Mic FX";
  }
  if (/behringer_?umc202hd_192k/i.test(raw) || /UMC202HD/i.test(raw)) {
    if (/mic1/i.test(raw)) return "UMC202HD 192k Input 1";
    if (/mic2/i.test(raw)) return "UMC202HD 192k Input 2";
    if (/line/i.test(raw)) return "UMC202HD 192k Line A";
  }
  return raw;
}

async function listModules() {
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  return moduleList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const id = parts[0];
      const name = parts[1] || "";
      const args = parts.slice(2).join("\t");
      return { id, name, args };
    })
    .filter((entry) => entry.id && entry.name);
}

async function unloadModules(match) {
  const modules = await listModules();
  for (const mod of modules) {
    if (!match(mod)) continue;
    await runCmd("/usr/bin/pactl", ["unload-module", String(mod.id)]);
  }
}

async function micFxSourcePresent() {
  const sources = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sources"]);
  return sources.split("\n").some((line) => line.split(/\s+/)[1] === "mvp_lunar_mic");
}

async function micLoopbackPresent() {
  const modules = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  return modules.split("\n").some((line) => line.includes("module-loopback") && line.includes("sink=mic"));
}

let micFxEnsuring = false;

async function ensureMicFxSource(attempt = 0) {
  return;
  if (micFxEnsuring) return;
  micFxEnsuring = true;
  await unloadModules(
    (mod) => mod.name === "module-remap-source" && mod.args.includes("source_name=mvp_lunar_mic")
  );
  if (fs.existsSync(micFxSourceFile)) {
    const id = fs.readFileSync(micFxSourceFile, "utf8").trim();
    if (id) {
      await runCmd("/usr/bin/pactl", ["unload-module", id]);
    }
    fs.rmSync(micFxSourceFile, { force: true });
  }
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-remap-source",
    "master=mic.monitor",
    "source_name=mvp_lunar_mic",
    "source_properties=device.description=MVP Lunar Mic (FX)",
  ]);
  if (moduleId) {
    fs.writeFileSync(micFxSourceFile, moduleId);
    micFxEnsuring = false;
    return;
  }
  micFxEnsuring = false;
  if (attempt < 4) {
    setTimeout(() => ensureMicFxSource(attempt + 1), 700);
  }
}

function readLoopbacks() {
  if (!fs.existsSync(loopbackStateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(loopbackStateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeLoopbacks(state) {
  fs.writeFileSync(loopbackStateFile, JSON.stringify(state, null, 2));
}

function writeLoopbackConfig(state) {
  const entries = Object.entries(state).filter(([source]) => source !== "mic.monitor");
  const lines = ["# MVP Lunar loopbacks (virtual sinks to physical output)", "pulse.cmd = ["];
  entries.forEach(([source, sink]) => {
    if (!sink) return;
    lines.push(
      `  { cmd = "load-module" args = "module-loopback source=${source} sink=${sink} latency_msec=20" }`
    );
  });
  lines.push("]");
  lines.push("");
  fs.writeFileSync(loopbackConfigFile, lines.join("\n"));
}

async function applyLoopbacks(state, options = {}) {
  const { restart = true, load = true, writeConfig = true } = options;
  if (state["mic.monitor"]) {
    delete state["mic.monitor"];
    writeLoopbacks(state);
  }
  const sourceList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sources"]);
  const sources = new Set(
    sourceList
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
  );
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  const stateSources = new Set(Object.keys(state || {}));
  const unloadIds = [];
  moduleList
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.includes("module-loopback") && line.includes("source="))
    .forEach((line) => {
      if (line.includes("sink=mic")) return;
      const id = line.split("\t")[0];
      const match = line.match(/source=([^\\s]+)/);
      const source = match ? match[1] : "";
      if (!id) return;
      if (source.endsWith(".monitor") || stateSources.has(source) || source === "chat_fx_output") {
        unloadIds.push(id);
      }
    });
  for (const id of unloadIds) {
    await runCmd("/usr/bin/pactl", ["unload-module", id]);
  }
  const filtered = Object.fromEntries(
    Object.entries(state).filter(([source]) => sources.has(source) || source.endsWith(".monitor") || source === "chat_fx_output")
  );
  writeLoopbacks(filtered);
  if (writeConfig) writeLoopbackConfig(filtered);
  if (restart) {
    await safeRestartPipewire(["pipewire-pulse"]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await reapplySoundboardMicIfNeeded();
    return;
  }
  if (!load) {
    await reapplySoundboardMicIfNeeded();
    return;
  }
  for (const [source, sink] of Object.entries(filtered)) {
    if (!sink) continue;
    await runCmd("/usr/bin/pactl", [
      "load-module",
      "module-loopback",
      `source=${source}`,
      `sink=${sink}`,
      "latency_msec=20",
    ]);
  }
  await reapplySoundboardMicIfNeeded();
}

function readStreamLinks() {
  if (!fs.existsSync(streamLinksFile)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(streamLinksFile, "utf8"));
  } catch {
    return {};
  }
}

function writeStreamLinks(state) {
  fs.writeFileSync(streamLinksFile, JSON.stringify(state, null, 2));
}

async function applyStreamLinks(state) {
  const entries = Object.entries(state || {});
  // Always clear any existing stream loopbacks to avoid stale links
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  moduleList
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.includes("module-loopback") && line.includes("sink=stream"))
    .forEach((line) => {
      const id = line.split("\t")[0];
      if (id) {
        runCmd("/usr/bin/pactl", ["unload-module", id]);
      }
    });

  for (const [, entry] of entries) {
    if (entry?.moduleId) {
      await runCmd("/usr/bin/pactl", ["unload-module", String(entry.moduleId)]);
    }
  }
  const nextState = {};
  for (const [sink, entry] of entries) {
    if (!entry?.enabled) continue;
    const moduleId = await runCmdOutput("/usr/bin/pactl", [
      "load-module",
      "module-loopback",
      `source=${sink}.monitor`,
      "sink=stream",
      "latency_msec=10",
    ]);
    nextState[sink] = { enabled: true, moduleId };
  }
  writeStreamLinks(nextState);
}

async function clearStreamOutput() {
  if (fs.existsSync(streamOutputConfigFile)) {
    fs.rmSync(streamOutputConfigFile, { force: true });
  }
  if (fs.existsSync(streamOutputStateFile)) {
    fs.rmSync(streamOutputStateFile, { force: true });
  }
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  const unloadIds = moduleList
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.includes("module-loopback") && line.includes("source=stream.monitor"))
    .map((line) => line.split("\t")[0])
    .filter(Boolean);
  for (const id of unloadIds) {
    await runCmd("/usr/bin/pactl", ["unload-module", id]);
  }
}

async function setStreamOutput(sink) {
  const lines = ["# MVP Lunar stream monitor output", "pulse.cmd = ["];
  if (sink) {
    lines.push(
      `  { cmd = "load-module" args = "module-loopback source=stream.monitor sink=${sink} latency_msec=20" }`
    );
  }
  lines.push("]");
  lines.push("");
  fs.writeFileSync(streamOutputConfigFile, lines.join("\n"));
  fs.writeFileSync(streamOutputStateFile, sink || "");
  await safeRestartPipewire(["pipewire-pulse"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await ensureMicSink();
  await ensureMicSource();
  await reapplySoundboardMicIfNeeded();
  const links = readStreamLinks();
  await applyStreamLinks(links);
}

async function listSinks() {
  const list = async () =>
    new Promise((resolve) => {
      const proc = spawn("/usr/bin/pactl", ["list", "sinks"]);
      let out = "";
      proc.stdout.on("data", (chunk) => (out += chunk.toString()));
      proc.on("exit", () => {
        const blocks = out.split(/Sink #/).filter(Boolean);
        const sinks = blocks
          .map((block) => {
            const lines = block.split("\n");
            const nameLine = lines.find((l) => l.trim().startsWith("Name:"));
            const descLine = lines.find((l) => l.trim().startsWith("Description:"));
            const name = nameLine ? nameLine.split(":")[1].trim() : "";
        const description = normalizeDeviceLabel(descLine ? descLine.split(":")[1].trim() : name);
            return { name, description };
          })
          .filter((s) => s.name);
        const filtered = sinks.filter(
          (s) =>
            !s.name.endsWith("_meter") &&
            ![
              "browser",
              "game",
              "chat",
              "chat_fx_input",
              "chat_fx_output",
              "soundboard",
              "mic",
              "stream",
              "mvp_lunar_input",
            ].includes(s.name)
        );
        resolve(filtered);
      });
    });
  return list();
}

async function listRouteSinks() {
  const list = async () =>
    new Promise((resolve) => {
      const proc = spawn("/usr/bin/pactl", ["list", "sinks"]);
      let out = "";
      proc.stdout.on("data", (chunk) => (out += chunk.toString()));
      proc.on("exit", () => {
        const allowed = new Set(["browser", "game", "chat", "soundboard", "stream"]);
        const blocks = out.split(/Sink #/).filter(Boolean);
        const sinks = blocks
          .map((block) => {
            const lines = block.split("\n");
            const nameLine = lines.find((l) => l.trim().startsWith("Name:"));
            const descLine = lines.find((l) => l.trim().startsWith("Description:"));
            const name = nameLine ? nameLine.split(":")[1].trim() : "";
        const description = normalizeDeviceLabel(descLine ? descLine.split(":")[1].trim() : name);
            return { name, description };
          })
          .filter((s) => s.name && allowed.has(s.name));
        resolve(sinks);
      });
    });
  return list();
}

async function listSinksIndexMap() {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/pactl", ["list", "sinks"]);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("exit", () => {
      const blocks = out.split(/Sink #/).filter(Boolean);
      const map = new Map();
      blocks.forEach((block) => {
        const lines = block.split("\n");
        const index = Number(lines[0].trim());
        const nameLine = lines.find((l) => l.trim().startsWith("Name:"));
        const name = nameLine ? nameLine.split(":")[1].trim() : "";
        if (Number.isFinite(index) && name) map.set(index, name);
      });
      resolve(map);
    });
  });
}

async function listSources() {
  const list = async () =>
    new Promise((resolve) => {
      const proc = spawn("/usr/bin/pactl", ["list", "sources"]);
      let out = "";
      proc.stdout.on("data", (chunk) => (out += chunk.toString()));
      proc.on("exit", () => {
        const blocks = out.split(/Source #/).filter(Boolean);
        const sources = blocks
          .map((block) => {
            const lines = block.split("\n");
            const nameLine = lines.find((l) => l.trim().startsWith("Name:"));
            const descLine = lines.find((l) => l.trim().startsWith("Description:"));
            const name = nameLine ? nameLine.split(":")[1].trim() : "";
            const description = normalizeDeviceLabel(descLine ? descLine.split(":")[1].trim() : name);
            return { name, description };
          })
          .filter(
            (s) =>
              s.name &&
              !s.name.endsWith(".monitor") &&
              !s.name.endsWith("_meter") &&
              s.name !== "mvp_lunar_output"
          );
        resolve(sources);
      });
    });
  return list();
}

async function listSinkInputs() {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/pactl", ["list", "sink-inputs"]);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("exit", async () => {
      const sinkMap = await listSinksIndexMap();
      const blocks = out.split(/Sink Input #/).filter(Boolean);
      const items = blocks
        .map((block) => {
          const lines = block.split("\n");
          const id = Number(lines[0].trim());
          const ownerLine = lines.find((l) => l.trim().startsWith("Owner Module:"));
          const owner = ownerLine ? Number(ownerLine.split(":")[1].trim()) : NaN;
          const sinkLine = lines.find((l) => l.trim().startsWith("Sink:"));
          const sinkIdRaw = sinkLine ? sinkLine.split(":")[1].trim() : "";
          const sinkId = Number(sinkIdRaw);
          const sink = Number.isFinite(sinkId) ? sinkMap.get(sinkId) || sinkIdRaw : sinkIdRaw;
          const stateLine = lines.find((l) => l.trim().startsWith("State:"));
          const state = stateLine ? stateLine.split(":")[1].trim() : "";
          const appLine =
            lines.find((l) => l.trim().startsWith("application.name =")) ||
            lines.find((l) => l.trim().startsWith("Application.name ="));
          const binLine =
            lines.find((l) => l.trim().startsWith("application.process.binary =")) ||
            lines.find((l) => l.trim().startsWith("application.process.binary="));
          const mediaLine = lines.find((l) => l.trim().startsWith("media.name ="));
          const app = appLine ? appLine.split("=").slice(1).join("=").trim().replace(/^\"|\"$/g, "") : "App";
          const binary = binLine ? binLine.split("=").slice(1).join("=").trim().replace(/^\"|\"$/g, "") : "";
          const media = mediaLine
            ? mediaLine.split("=").slice(1).join("=").trim().replace(/^\"|\"$/g, "")
            : "";
          const mediaLower = media.toLowerCase();
          const appLower = app.toLowerCase();
          const isLoopback =
            mediaLower.startsWith("loopback-") ||
            appLower.includes("pipewire") ||
            appLower.includes("loopback");
          const displayParts = [];
          displayParts.push(app);
          if (binary) displayParts.push(`(${binary})`);
          if (media) displayParts.push(`— ${media}`);
          const display = displayParts.join(" ").replace("  ", " ").trim();
          return { id, sink, app, media, binary, display, state, isLoopback, owner };
        })
        .filter(
          (item) =>
            item.id &&
            item.app &&
            !item.isLoopback &&
            !/MVP LUNAR|Electron/i.test(item.app)
        );

      const grouped = new Map();
      items.forEach((item) => {
        const key = `${item.app}|${item.binary || ""}`;
        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            key,
            app: item.app,
            binary: item.binary,
            display: item.display,
            ids: [item.id],
            sink: item.sink,
            states: new Set([item.state]),
            media: new Set(item.media ? [item.media] : []),
          });
          return;
        }
        existing.ids.push(item.id);
        existing.states.add(item.state);
        if (item.media) existing.media.add(item.media);
      });

      const result = Array.from(grouped.values()).map((item) => {
        const media = Array.from(item.media).slice(0, 2).join(", ");
        const stateLabel = Array.from(item.states).join("/");
        const display = media ? `${item.app} — ${media}` : item.app;
        return {
          key: item.key,
          app: item.app,
          binary: item.binary,
          display,
          ids: item.ids,
          sink: item.sink,
          state: stateLabel,
        };
      });
      resolve(result);
    });
  });
}

async function listMvpSinkInputs() {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/pactl", ["list", "sink-inputs"]);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("exit", async () => {
      const blocks = out.split(/Sink Input #/).filter(Boolean);
      const ids = [];
      blocks.forEach((block) => {
        const lines = block.split("\n");
        const id = Number(lines[0].trim());
        if (!Number.isFinite(id)) return;
        const appLine =
          lines.find((l) => l.trim().startsWith("application.name =")) ||
          lines.find((l) => l.trim().startsWith("Application.name ="));
        const binLine =
          lines.find((l) => l.trim().startsWith("application.process.binary =")) ||
          lines.find((l) => l.trim().startsWith("application.process.binary="));
        const app = appLine ? appLine.split("=").slice(1).join("=").trim().replace(/^\"|\"$/g, "") : "";
        const binary = binLine ? binLine.split("=").slice(1).join("=").trim().replace(/^\"|\"$/g, "") : "";
        if (/MVP LUNAR|Electron/i.test(app) || binary === "electron") {
          ids.push(id);
        }
      });
      resolve(ids);
    });
  });
}

async function applyPipewireSettings(settings, chatSettings) {
  const currentSink = await runCmdOutput("/usr/bin/pactl", ["get-default-sink"]);
  const currentSource = await runCmdOutput("/usr/bin/pactl", ["get-default-source"]);
  writePipewireConfig(settings);
  writeChatFilterConfig(chatSettings || settings);
  await safeRestartPipewire(["pipewire", "pipewire-pulse"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (currentSink) {
    await runCmd("/usr/bin/pactl", ["set-default-sink", currentSink]);
  }
  const fxEnabled = Boolean(settings?.micFxEnabled !== false && (settings?.rnnEnabled || settings?.gateEnabled));
  if (fxEnabled) {
    if (currentSource && currentSource !== "mvp_lunar_micfx") {
      fs.writeFileSync(sourceCacheFile, currentSource);
    }
    await runCmd("/usr/bin/pactl", ["set-default-source", "mvp_lunar_micfx"]);
  } else if (fs.existsSync(sourceCacheFile)) {
    const cached = fs.readFileSync(sourceCacheFile, "utf8").trim();
    if (cached) {
      await runCmd("/usr/bin/pactl", ["set-default-source", cached]);
    }
  }
  await ensureMicSink();
  await ensureMicSource();
  await reapplySoundboardMicIfNeeded();
}

async function ensureDefaultLoopbacks() {
  const state = readState();
  const systemSink =
    state?.systemOutputSink || (await runCmdOutput("/usr/bin/pactl", ["get-default-sink"])) || "";
  if (!systemSink) return;
  const current = readLoopbacks();
  const required = ["browser.monitor", "game.monitor", "soundboard.monitor"];
  let changed = false;
  required.forEach((source) => {
    if (!current[source]) {
      current[source] = systemSink;
      changed = true;
    }
  });
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  const hasLoopbacks = required.some((source) => moduleList.includes(`source=${source}`));
  const missing = required.filter((source) => !moduleList.includes(`source=${source}`));
  if (changed || !hasLoopbacks || missing.length) {
    writeLoopbacks(current);
    await applyLoopbacks(current, {
      restart: !hasLoopbacks || missing.length > 0,
      load: hasLoopbacks && missing.length === 0,
      writeConfig: true,
    });
  }
}

async function updateChatLoopbacks(chatSettings, options = {}) {
  const { restartPulse = false } = options;
  const state = readState();
  const systemSink =
    state?.systemOutputSink || (await runCmdOutput("/usr/bin/pactl", ["get-default-sink"])) || "";
  if (!systemSink) return;
  const current = readLoopbacks();
  const required = ["browser.monitor", "game.monitor", "soundboard.monitor"];
  required.forEach((source) => {
    if (!current[source]) current[source] = systemSink;
  });
  const fxEnabled = Boolean(chatSettings?.rnnEnabled || chatSettings?.gateEnabled);
  current["chat.monitor"] = systemSink;
  if (fxEnabled) {
    current["chat_fx_output"] = systemSink;
  } else {
    delete current["chat_fx_output"];
  }
  writeLoopbacks(current);
  await applyLoopbacks(current, { restart: true, load: false, writeConfig: true });
  if (fxEnabled) {
    await applyChatFxFeed(true);
  } else {
    await applyChatFxFeed(false);
  }
}

async function applyChatFxFeed(enable) {
  if (fs.existsSync(chatFxFeedFile)) {
    const id = fs.readFileSync(chatFxFeedFile, "utf8").trim();
    if (id) await runCmd("/usr/bin/pactl", ["unload-module", id]);
  }
  if (!enable) return;
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-loopback",
    "source=chat.monitor",
    "sink=chat_fx_input",
    "latency_msec=20",
  ]);
  if (moduleId) fs.writeFileSync(chatFxFeedFile, moduleId);
}

async function setLoopbackMixVolumes({ drySource, wetSource, mix }) {
  const mixValue = Math.max(0, Math.min(100, Number(mix)));
  const dry = Math.max(0, Math.min(150, Math.round(100 - mixValue)));
  const wet = Math.max(0, Math.min(150, Math.round(mixValue)));
  const moduleList = await runCmdOutput("/usr/bin/pactl", ["list", "short", "modules"]);
  const moduleIds = {};
  moduleList
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.includes("module-loopback") && line.includes("source="))
    .forEach((line) => {
      const id = Number(line.split("\t")[0]);
      const match = line.match(/source=([^\s]+)/);
      const source = match ? match[1] : "";
      if (source === drySource) moduleIds.dry = id;
      if (source === wetSource) moduleIds.wet = id;
    });
  if (!moduleIds.dry || !moduleIds.wet) return;
  const sinkInputsRaw = await runCmdOutput("/usr/bin/pactl", ["list", "sink-inputs"]);
  const blocks = sinkInputsRaw.split(/Sink Input #/).filter(Boolean);
  const targets = [];
  blocks.forEach((block) => {
    const lines = block.split("\n");
    const id = Number(lines[0].trim());
    const ownerLine = lines.find((l) => l.trim().startsWith("Owner Module:"));
    const owner = ownerLine ? Number(ownerLine.split(":")[1].trim()) : NaN;
    if (owner === moduleIds.dry) targets.push({ id, volume: dry });
    if (owner === moduleIds.wet) targets.push({ id, volume: wet });
  });
  for (const target of targets) {
    await runCmd("/usr/bin/pactl", ["set-sink-input-volume", String(target.id), `${target.volume}%`]);
  }
}

async function ensureMicSink() {
  if (!fs.existsSync(micSinkConfigFile)) {
    const config = [
      "# MVP Lunar virtual mic sink",
      "pulse.cmd = [",
      "  { cmd = \"load-module\" args = \"module-null-sink sink_name=mic sink_properties=device.description=\\\"MVP Lunar Mic\\\"\" }",
      "]",
      "",
    ].join("\n");
    fs.writeFileSync(micSinkConfigFile, config);
  }
  const sinks = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sinks"]);
  const hasMic = sinks
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .includes("mic");
  if (hasMic) return true;
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-null-sink",
    "sink_name=mic",
    "sink_properties=device.description=MVP\\ Lunar\\ Mic",
  ]);
  if (moduleId) fs.writeFileSync(micSinkFile, moduleId);
  return Boolean(moduleId);
}

async function ensureMicSource() {
  if (!fs.existsSync(micSourceConfigFile)) {
    const config = [
      "# MVP Lunar virtual mic source",
      "pulse.cmd = [",
      "  { cmd = \"load-module\" args = \"module-remap-source master=mic.monitor source_name=mvp_lunar_mic source_properties=device.description=\\\"MVP Lunar Mic Input\\\"\" }",
      "]",
      "",
    ].join("\n");
    fs.writeFileSync(micSourceConfigFile, config);
  }
  const sources = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sources"]);
  const hasSource = sources
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .includes("mvp_lunar_mic");
  if (hasSource) return true;
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-remap-source",
    "master=mic.monitor",
    "source_name=mvp_lunar_mic",
    "source_properties=device.description=MVP\\ Lunar\\ Mic\\ Input",
  ]);
  return Boolean(moduleId);
}

async function setMicSinkDefaults() {
  try {
    await runCmd("/usr/bin/pactl", ["set-sink-mute", "mic", "0"]);
    await runCmd("/usr/bin/pactl", ["set-sink-volume", "mic", "100%"]);
  } catch {
    // ignore
  }
}

async function setLoopbackInputVolumeByModule(moduleId, volume = "100%") {
  if (!moduleId) return;
  try {
    const raw = await runCmdOutput("/usr/bin/pactl", ["list", "sink-inputs"]);
    const blocks = raw.split(/Sink Input #/).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const id = Number(lines[0].trim());
      if (!Number.isFinite(id)) continue;
      const ownerLine = lines.find((l) => l.trim().startsWith("Owner Module:"));
      const owner = ownerLine ? Number(ownerLine.split(":")[1].trim()) : NaN;
      if (owner === Number(moduleId)) {
        await runCmd("/usr/bin/pactl", ["set-sink-input-mute", String(id), "0"]);
        await runCmd("/usr/bin/pactl", ["set-sink-input-volume", String(id), volume]);
      }
    }
  } catch {
    // ignore
  }
}

let micLoopbackEnsuring = false;
const micAuxSources = new Set(["soundboard.monitor", "chat.monitor", "chat_fx_output"]);

async function applyMicLoopback(inputSource, attempt = 0) {
  if (micLoopbackEnsuring) return;
  micLoopbackEnsuring = true;
  const micReady = await ensureMicSink();
  if (!micReady) {
    micLoopbackEnsuring = false;
    return;
  }
  await unloadModules((mod) => {
    if (mod.name !== "module-loopback") return false;
    if (!mod.args.includes("sink=mic")) return false;
    const match = mod.args.match(/source=([^\s]+)/);
    const source = match ? match[1] : "";
    if (!source) return false;
    if (micAuxSources.has(source)) return false;
    return true;
  });
  if (fs.existsSync(micLoopbackFile)) {
    const id = fs.readFileSync(micLoopbackFile, "utf8").trim();
    if (id) await runCmd("/usr/bin/pactl", ["unload-module", id]);
  }
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-loopback",
    `source=${inputSource}`,
    "sink=mic",
    "latency_msec=10",
  ]);
  if (moduleId) {
    fs.writeFileSync(micLoopbackFile, moduleId);
    micLoopbackEnsuring = false;
    return;
  }
  micLoopbackEnsuring = false;
  if (attempt < 4) {
    setTimeout(() => applyMicLoopback(inputSource, attempt + 1), 800);
  }
}

async function resolveMicLoopbackSource() {
  const state = readState();
  const fxEnabled = Boolean(state?.audioSettings?.micFxEnabled !== false && (state?.audioSettings?.rnnEnabled || state?.audioSettings?.gateEnabled));
  if (fxEnabled) {
    const sources = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sources"]);
    const hasFx = sources
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
      .includes("mvp_lunar_micfx");
    if (hasFx) return "mvp_lunar_micfx";
  }
  const source = state?.systemInputSource || (await runCmdOutput("/usr/bin/pactl", ["get-default-source"])) || "";
  if (source && !source.endsWith(".monitor")) return source;
  return "";
}

async function clearMicLoopback() {
  if (!fs.existsSync(micLoopbackFile)) return;
  const id = fs.readFileSync(micLoopbackFile, "utf8").trim();
  if (id) {
    await runCmd("/usr/bin/pactl", ["unload-module", id]);
  }
  fs.rmSync(micLoopbackFile, { force: true });
}

async function applySoundboardMic(enabled) {
  await unloadModules((mod) => {
    if (mod.name !== "module-loopback") return false;
    if (!mod.args.includes("sink=mic")) return false;
    return mod.args.includes("source=soundboard.monitor");
  });
  if (fs.existsSync(soundboardMicFile)) {
    const id = fs.readFileSync(soundboardMicFile, "utf8").trim();
    if (id) {
      await runCmd("/usr/bin/pactl", ["unload-module", id]);
    }
    fs.rmSync(soundboardMicFile, { force: true });
  }
  if (!enabled) return;
  const micReady = await ensureMicSink();
  if (!micReady) return;
  await ensureMicSource();
  // Ensure the user's mic is routed into the MVP Lunar Mic sink as well.
  const micSource = await resolveMicLoopbackSource();
  if (micSource) {
    await applyMicLoopback(micSource);
  }
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-loopback",
    "source=soundboard.monitor",
    "sink=mic",
    "latency_msec=10",
  ]);
  if (moduleId) {
    fs.writeFileSync(soundboardMicFile, moduleId);
    await setMicSinkDefaults();
    await setLoopbackInputVolumeByModule(moduleId, "100%");
  }
}

async function reapplySoundboardMicIfNeeded() {
  const state = readState();
  if (state?.soundboardMicLink) {
    await ensureMicSink();
    await ensureMicSource();
    await applySoundboardMic(true);
  }
}

async function applyChatMic(enabled) {
  await unloadModules((mod) => {
    if (mod.name !== "module-loopback") return false;
    if (!mod.args.includes("sink=mic")) return false;
    return mod.args.includes("source=chat.monitor") || mod.args.includes("source=chat_fx_output");
  });
  if (fs.existsSync(chatMicFile)) {
    const id = fs.readFileSync(chatMicFile, "utf8").trim();
    if (id) {
      await runCmd("/usr/bin/pactl", ["unload-module", id]);
    }
    fs.rmSync(chatMicFile, { force: true });
  }
  if (!enabled) return;
  const state = readState();
  const fxEnabled = Boolean(state?.chatAudioSettings?.rnnEnabled || state?.chatAudioSettings?.gateEnabled);
  const source = fxEnabled ? "chat_fx_output" : "chat.monitor";
  const moduleId = await runCmdOutput("/usr/bin/pactl", [
    "load-module",
    "module-loopback",
    `source=${source}`,
    "sink=mic",
    "latency_msec=10",
  ]);
  if (moduleId) fs.writeFileSync(chatMicFile, moduleId);
}

function getPin() {
  if (fs.existsSync(pinFile)) {
    const pin = fs.readFileSync(pinFile, "utf8").trim();
    if (pin) return pin;
  }
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  fs.writeFileSync(pinFile, pin);
  return pin;
}

function refreshPin() {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  fs.writeFileSync(pinFile, pin);
  return pin;
}

function readServerConfig() {
  if (!fs.existsSync(serverConfigFile)) {
    return { lanEnabled: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(serverConfigFile, "utf8"));
    return { lanEnabled: Boolean(data?.lanEnabled) };
  } catch {
    return { lanEnabled: false };
  }
}

function writeServerConfig(config) {
  fs.writeFileSync(serverConfigFile, JSON.stringify(config, null, 2));
}

const meterSinks = ["browser", "game", "chat", "soundboard", "mic", "stream"];
let monitorTargets = meterSinks.map((name) => ({ key: name, target: `${name}.monitor` }));

const liveLevels = new Map();
const monitorProcesses = new Map();
const monitorMeta = new Map();
const monitorErrors = new Map();
const sseClients = new Set();
const defaultLevel = { level: 0, db: -60 };

function startMonitor({ key, target }) {
  try {
    if (!liveLevels.has(key)) {
      liveLevels.set(key, { ...defaultLevel });
    }
    if (!target) {
      console.error(`[pw-cat ${key}] missing target ${target || "unknown"}`);
      liveLevels.set(key, { ...defaultLevel });
      monitorMeta.delete(key);
      monitorErrors.set(key, `missing target ${target || "unknown"}`);
      return;
    }
    monitorErrors.delete(key);
    const runtimeDir =
      process.env.XDG_RUNTIME_DIR ||
      (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
    const env = { ...process.env };
    if (runtimeDir) {
      env.XDG_RUNTIME_DIR = runtimeDir;
      env.PIPEWIRE_RUNTIME_DIR = env.PIPEWIRE_RUNTIME_DIR || runtimeDir;
      env.PULSE_RUNTIME_PATH = env.PULSE_RUNTIME_PATH || `${runtimeDir}/pulse`;
    }
    const proc = spawn(
      "/usr/bin/pw-cat",
      [
        "--record",
        "--format",
        "f32",
        "--rate",
        "48000",
        "--channels",
        "2",
        "--target",
        target,
        "-",
      ],
      { env }
    );
    monitorProcesses.set(key, proc);
    monitorMeta.set(key, { target });
    let remainder = Buffer.alloc(0);

    proc.stdout.on("data", (chunk) => {
      const buffer = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const usable = buffer.length - (buffer.length % 4);
      remainder = buffer.slice(usable);
      let sumSquares = 0;
      let count = 0;
      for (let i = 0; i < usable; i += 4) {
        const sample = buffer.readFloatLE(i);
        sumSquares += sample * sample;
        count += 1;
      }
      if (!count) {
        liveLevels.set(key, { ...defaultLevel });
        return;
      }
      const rms = Math.sqrt(sumSquares / count);
      const db = rms <= 0 ? -60 : 20 * Math.log10(rms);
      const clampedDb = Math.max(-60, Math.min(0, db));
      const level = Math.pow(10, clampedDb / 20);
      liveLevels.set(key, {
        level,
        db: Number.isFinite(clampedDb) ? Math.round(clampedDb) : -60,
      });
    });

    proc.on("exit", () => {
      monitorProcesses.delete(key);
      monitorMeta.delete(key);
      monitorErrors.set(key, "capture exited");
      liveLevels.set(key, { ...defaultLevel });
      setTimeout(() => startMonitor({ key, target }), 1500);
    });

    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) {
        monitorErrors.set(key, msg);
        console.error(`[pw-cat ${key}] ${msg}`);
      }
    });
  } catch {
    // Ignore monitor failures
  }
}

function startAllMonitors() {
  monitorTargets.forEach((target) => startMonitor(target));
}

async function listSinksIndexMap() {
  try {
    const raw = await runCmdOutput("/usr/bin/pactl", ["list", "short", "sinks"]);
    const map = new Map();
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const parts = line.split(/\s+/);
        const id = parts[0];
        const name = parts[1];
        if (id && name) map.set(id, name);
      });
    return map;
  } catch {
    return new Map();
  }
}

async function listSinkInputNodes() {
  try {
    const raw = await runCmdOutput("/usr/bin/pactl", ["list", "sink-inputs"]);
    const sinkMap = await listSinksIndexMap();
    const blocks = raw.split(/Sink Input #/).filter(Boolean);
    return blocks
      .map((block) => {
        const lines = block.split("\n");
        const sinkLine = lines.find((l) => l.trim().startsWith("Sink:"));
        const sinkId = sinkLine ? sinkLine.split(":")[1].trim() : "";
        const sink = sinkMap.get(sinkId) || sinkId;
        const getProp = (key) => {
          const regex = new RegExp(`\\b${key}\\s*=`);
          const prop = lines.find((l) => regex.test(l));
          if (!prop) return "";
          const idx = prop.indexOf("=");
          return idx === -1 ? "" : prop.slice(idx + 1).trim().replace(/^\"|\"$/g, "");
        };
        const app = getProp("application.name").toLowerCase();
        const media = getProp("media.name").toLowerCase();
        const node = getProp("node.name");
        const objectId = Number(getProp("object.id"));
        return { sink, app, media, node, nodeId: Number.isFinite(objectId) ? objectId : null };
      })
      .filter((entry) => entry.sink);
  } catch {
    return [];
  }
}

async function updateMonitorTargets() {
  const sinkInputs = await listSinkInputNodes();
  const pickNodeForSink = (sinkName) => {
    const candidate = sinkInputs.find((entry) => {
      if (entry.sink !== sinkName) return false;
      const app = entry.app || "";
      const media = entry.media || "";
      return !app.includes("pipewire") && !media.includes("loopback");
    });
    return candidate || null;
  };
  monitorTargets = meterSinks.map((name) => {
    if (name === "mic") {
      return { key: name, target: "mic.monitor" };
    }
    if (name === "stream") {
      return { key: name, target: "stream.monitor" };
    }
    const node = pickNodeForSink(name);
    if (node) {
      const target = node.node || (Number.isFinite(node.nodeId) ? String(node.nodeId) : "");
      return { key: name, target: target || null };
    }
    return { key: name, target: null };
  });
}

function broadcastLevels() {
  if (!sseClients.size) return;
  const payload = {};
  meterSinks.forEach((key) => {
    payload[key] = liveLevels.get(key) || { ...defaultLevel };
  });
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => res.write(data));
}

function readState() {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
  };
  const contentType = typeMap[ext] || "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/ping") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && req.url === "/api/audio-status") {
    const now = Date.now();
    const retryInMs = Math.max(0, pactlState.disabledUntil - now);
    return sendJson(res, 200, {
      ok: true,
      pactlAvailable: canUsePactl(),
      pactlLastError: pactlState.lastError || "",
      pactlRetryInSec: retryInMs ? Math.ceil(retryInMs / 1000) : 0,
      pipewireRestartCooldownSec: Math.ceil(PIPEWIRE_RESTART_COOLDOWN_MS / 1000),
    });
  }

  if (req.method === "POST" && req.url === "/api/restart-audio") {
    const now = Date.now();
    const elapsed = now - lastPipewireRestartAt;
    const retryInMs = Math.max(0, PIPEWIRE_RESTART_COOLDOWN_MS - elapsed);
    if (retryInMs > 0) {
      return sendJson(res, 200, {
        ok: true,
        restarted: false,
        retryInSec: Math.ceil(retryInMs / 1000),
      });
    }
    await safeRestartPipewire(["pipewire-pulse"]);
    return sendJson(res, 200, { ok: true, restarted: true });
  }

  if (req.method === "GET" && req.url === "/api/state") {
    const state = readState();
    if (!state) return sendJson(res, 200, { ok: true, state: null });
    return sendJson(res, 200, { ok: true, state });
  }

  if (req.method === "GET" && req.url === "/api/sinks") {
    const sinks = await listSinks();
    return sendJson(res, 200, { ok: true, sinks });
  }

  if (req.method === "GET" && req.url === "/api/sources") {
    const sources = await listSources();
    return sendJson(res, 200, { ok: true, sources });
  }

  if (req.method === "GET" && req.url === "/api/sink-inputs") {
    const sinks = await listRouteSinks();
    const inputs = await listSinkInputs();
    return sendJson(res, 200, { ok: true, sinks, inputs });
  }

  if (req.method === "GET" && req.url === "/api/default-sink") {
    const sink = (await runCmdOutput("/usr/bin/pactl", ["get-default-sink"])) || "";
    return sendJson(res, 200, { ok: true, sink: sink.trim() });
  }

  if (req.method === "GET" && req.url === "/api/mvp-sink-inputs") {
    const ids = await listMvpSinkInputs();
    return sendJson(res, 200, { ok: true, ids });
  }

  if (req.method === "POST" && req.url === "/api/audio-settings") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const settings = payload?.settings;
        const chatSettings = payload?.chatSettings;
        const defer = Boolean(payload?.defer);
        if (!settings) return sendJson(res, 400, { ok: false, error: "Missing settings" });
        if (defer) {
          writePipewireConfig(settings);
          writeChatFilterConfig(chatSettings || settings);
        } else {
          await applyPipewireSettings(settings, chatSettings);
          await updateChatLoopbacks(chatSettings || settings, { restartPulse: true });
        }
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/move-sink-input") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const id = payload?.id;
        const ids = payload?.ids;
        const sink = payload?.sink;
        if ((!id && !Array.isArray(ids)) || !sink) {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        const list = Array.isArray(ids) ? ids : [id];
        for (const entry of list) {
          await runCmd("/usr/bin/pactl", ["move-sink-input", String(entry), sink]);
        }
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/sink-volume") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink;
        const volume = Number(payload?.volume);
        if (!sink || Number.isNaN(volume)) {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        const vol = Math.max(0, Math.min(150, volume));
        await runCmd("/usr/bin/pactl", ["set-sink-volume", sink, `${vol}%`]);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/source-volume") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const source = payload?.source || "";
        const volume = Number(payload?.volume);
        if (!source || !Number.isFinite(volume)) {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        const vol = Math.max(0, Math.min(150, Math.round(volume)));
        await runCmd("/usr/bin/pactl", ["set-source-volume", source, `${vol}%`]);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/sink-mute") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink;
        const muted = payload?.muted;
        if (!sink || typeof muted !== "boolean") {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        await runCmd("/usr/bin/pactl", ["set-sink-mute", sink, muted ? "1" : "0"]);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat-mix") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const mix = payload?.mix;
        if (mix === undefined) return sendJson(res, 400, { ok: false, error: "Missing mix" });
        await setLoopbackMixVolumes({
          drySource: "chat.monitor",
          wetSource: "chat_fx_output",
          mix,
        });
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/stream-link") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink;
        const enabled = payload?.enabled;
        if (!sink || typeof enabled !== "boolean") {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        const current = readStreamLinks();
        current[sink] = { enabled };
        await applyStreamLinks(current);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/stream-output") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink || "";
        await setStreamOutput(sink);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/soundboard-play") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const slotIndex = Number(payload?.slotIndex);
        const categoryIndex = Number(payload?.categoryIndex);
        if (!Number.isFinite(slotIndex)) {
          return sendJson(res, 400, { ok: false, error: "Missing slotIndex" });
        }
        enqueueSoundboardEvent("play", slotIndex, categoryIndex);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/soundboard-stop") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const slotIndex = payload?.slotIndex;
        if (slotIndex !== undefined && !Number.isFinite(Number(slotIndex))) {
          return sendJson(res, 400, { ok: false, error: "Bad slotIndex" });
        }
        enqueueSoundboardEvent("stop", slotIndex === undefined ? null : Number(slotIndex), null);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/soundboard-queue") {
    const events = soundboardQueue.splice(0, soundboardQueue.length);
    return sendJson(res, 200, { ok: true, events });
  }

  if (req.method === "POST" && req.url === "/api/soundboard-mic") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const enabled = payload?.enabled;
        if (typeof enabled !== "boolean") {
          return sendJson(res, 400, { ok: false, error: "Missing data" });
        }
        await applySoundboardMic(enabled);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat-mic") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const enabled = Boolean(payload?.enabled);
        await applyChatMic(enabled);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/pin") {
    return sendJson(res, 200, { pin: getPin() });
  }

  if (req.method === "POST" && req.url === "/api/pin-refresh") {
    return sendJson(res, 200, { pin: refreshPin() });
  }

  if (req.method === "POST" && req.url === "/api/pin-verify") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pin = String(payload?.pin || "").trim();
        const ok = pin && pin === getPin();
        return sendJson(res, 200, { ok: Boolean(ok) });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/server-config") {
    const config = readServerConfig();
    const ip = Object.values(require("os").networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;
    return sendJson(res, 200, { lanEnabled: config.lanEnabled, ip: ip || "0.0.0.0", port });
  }

  if (req.method === "POST" && req.url === "/api/server-config") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const enabled = Boolean(payload?.lanEnabled);
        writeServerConfig({ lanEnabled: enabled });
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 300);
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/loopback") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const source = payload?.source;
        const sink = payload?.sink || "";
        if (!source) return sendJson(res, 400, { ok: false, error: "Missing source" });
        const current = readLoopbacks();
        current[source] = sink;
        writeLoopbacks(current);
        await applyLoopbacks(current);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/default-sink") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink || "";
        if (!sink) return sendJson(res, 400, { ok: false, error: "Missing sink" });
        if (sink === "mic") {
          return sendJson(res, 400, { ok: false, error: "Mic sink is not a system output" });
        }
        await runCmd("/usr/bin/pactl", ["set-default-sink", sink]);
        await ensureDefaultLoopbacks();
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/default-source") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const source = payload?.source || "";
        if (!source) return sendJson(res, 400, { ok: false, error: "Missing source" });
        await runCmd("/usr/bin/pactl", ["set-default-source", source]);
        await clearMicLoopback();
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/loopback-default") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.socket.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const sink = payload?.sink || "";
        if (!sink) return sendJson(res, 400, { ok: false, error: "Missing sink" });
        const current = readLoopbacks();
        const targets = ["browser.monitor", "game.monitor", "soundboard.monitor"];
        targets.forEach((source) => {
          current[source] = sink;
        });
        writeLoopbacks(current);
        await applyLoopbacks(current, { restart: false, load: true, writeConfig: true });
        const state = readState();
        if (state?.chatAudioSettings || state?.audioSettings) {
          const chatSettings = state?.chatAudioSettings || state.audioSettings;
          await updateChatLoopbacks(chatSettings);
        }
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/levels") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && req.url === "/api/levels-snapshot") {
    const payload = {};
    meterSinks.forEach((key) => {
      payload[key] = liveLevels.get(key) || { ...defaultLevel };
    });
    return sendJson(res, 200, { ok: true, levels: payload });
  }

  if (req.method === "GET" && req.url === "/api/levels-debug") {
    const payload = {};
    meterSinks.forEach((key) => {
      payload[key] = {
        ...(liveLevels.get(key) || { ...defaultLevel }),
        target: monitorMeta.get(key)?.target || "",
        error: monitorErrors.get(key) || "",
      };
    });
    return sendJson(res, 200, { ok: true, debug: payload });
  }

  if (req.method === "GET" && req.url === "/api/sink-inputs-debug") {
    const entries = await listSinkInputNodes();
    return sendJson(res, 200, { ok: true, entries });
  }

  if (req.method === "POST" && req.url === "/api/state") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000_000) {
        req.socket.destroy();
      }
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload || !payload.state) {
          return sendJson(res, 400, { ok: false, error: "Missing state" });
        }
        writeState(payload.state);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: "Bad JSON" });
      }
    });
    return;
  }

  // Static files
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = decodeURIComponent(filePath.split("?")[0]);
  const fullPath = path.join(root, filePath);
  if (!fullPath.startsWith(root)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  return serveFile(res, fullPath);
});

const listenHost = serverConfig.lanEnabled ? "0.0.0.0" : "127.0.0.1";
server.listen(port, listenHost, () => {
  console.log(`MVP LUNAR server running on ${listenHost}:${port}`);
});

async function restartMonitors() {
  await updateMonitorTargets();
  meterSinks.forEach((key) => {
    const target = monitorTargets.find((t) => t.key === key);
    const existing = monitorProcesses.get(key);
    const meta = monitorMeta.get(key);
    if (!target || !target.target) {
      if (existing) {
        try {
          existing.kill();
        } catch {
          // ignore
        }
        monitorProcesses.delete(key);
      }
      monitorMeta.delete(key);
      liveLevels.set(key, { ...defaultLevel });
      return;
    }
    if (!existing || meta?.target !== target.target) {
      if (existing) {
        try {
          existing.kill();
        } catch {
          // ignore
        }
        monitorProcesses.delete(key);
      }
      startMonitor(target);
    }
  });
}

restartMonitors();
setInterval(restartMonitors, 1000);
setInterval(broadcastLevels, 200);

// Apply persisted loopbacks on startup
const savedLoopbacks = readLoopbacks();
if (Object.keys(savedLoopbacks).length) {
  applyLoopbacks(savedLoopbacks);
} else {
  ensureDefaultLoopbacks();
}

// Apply persisted stream links on startup
const savedStreamLinks = readStreamLinks();
if (Object.keys(savedStreamLinks).length) {
  applyStreamLinks(savedStreamLinks);
}
if (fs.existsSync(streamOutputStateFile)) {
  const sink = fs.readFileSync(streamOutputStateFile, "utf8").trim();
  if (sink) {
    setStreamOutput(sink);
  }
}

// Apply soundboard->mic link from saved app state
if (fs.existsSync(stateFile)) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.audioSettings) {
      const chatSettings = state?.chatAudioSettings || state.audioSettings;
      writePipewireConfig(state.audioSettings);
      writeChatFilterConfig(chatSettings);
      safeRestartPipewire(["pipewire", "pipewire-pulse"]);
      updateChatLoopbacks(chatSettings);
      ensureDefaultLoopbacks();
    }
    if (state?.systemInputSource && !state.systemInputSource.endsWith(".monitor")) {
      applyMicLoopback(state.systemInputSource);
    }
    if (state?.soundboardMicLink) {
      applySoundboardMic(true);
    }
    if (state?.chatMicLink) {
      applyChatMic(true);
    }
  } catch {
    // ignore
  }
}

setTimeout(() => {
  (async () => {
    ensureDefaultLoopbacks();
    try {
      await ensureMicSink();
      await ensureMicSource();
      const state = readState();
      if (state?.chatAudioSettings) {
        updateChatLoopbacks(state.chatAudioSettings);
      }
      const source = await resolveMicLoopbackSource();
      if (source && source !== "mvp_lunar_mic" && !source.endsWith(".monitor")) {
        await applyMicLoopback(source);
      }
    } catch {
      // ignore
    }
  })();
}, 1500);

setInterval(() => {
  micLoopbackPresent()
    .then(async (present) => {
      return;
    })
    .catch(() => {});
}, 5000);
