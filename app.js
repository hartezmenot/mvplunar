const stateKey = "mvp-lunar-soundboard";
const syncStatus = document.getElementById("syncStatus");
const inputSelect = document.getElementById("inputDevice");
const outputSelect = document.getElementById("outputDevice");
const monitorBtn = document.getElementById("monitorMic");
const gameSink = document.getElementById("gameSink");
const chatSink = document.getElementById("chatSink");
const browserSink = document.getElementById("browserSink");
const soundboardSink = document.getElementById("soundboardSink");
const micSink = document.getElementById("micSink");
const streamToggle = document.getElementById("streamToggle");
const testLeft = document.getElementById("testLeft");
const testRight = document.getElementById("testRight");
const testBoth = document.getElementById("testBoth");
const rnnToggle = document.getElementById("rnnToggle");
const gateToggle = document.getElementById("gateToggle");
const gateThreshold = document.getElementById("gateThreshold");
const micFxToggle = document.getElementById("micFxToggle");
const chatRnnToggle = document.getElementById("chatRnnToggle");
const chatGateToggle = document.getElementById("chatGateToggle");
const chatGateThreshold = document.getElementById("chatGateThreshold");
const noiseEngine = document.getElementById("noiseEngine");
const chatNoiseEngine = document.getElementById("chatNoiseEngine");
const chatFxGain = document.getElementById("chatFxGain");
const chatFxMix = document.getElementById("chatFxMix");
const chatGateTest = document.getElementById("chatGateTest");
const micFxGain = document.getElementById("micFxGain");
const applyFx = document.getElementById("applyFx");
const routingList = document.getElementById("routingList");
const systemOutput = document.getElementById("systemOutput");
const systemInput = document.getElementById("systemInput");
const streamOutput = document.getElementById("streamOutput");
const pinValue = document.getElementById("pinValue");
const pinRefresh = document.getElementById("pinRefresh");
const pinCopy = document.getElementById("pinCopy");
const lanToggle = document.getElementById("lanToggle");
const lanRestart = document.getElementById("lanRestart");
const lanInfo = document.getElementById("lanInfo");
const pinGate = document.getElementById("pinGate");
const pinGateInput = document.getElementById("pinGateInput");
const pinGateSubmit = document.getElementById("pinGateSubmit");
const pinGateError = document.getElementById("pinGateError");
const remoteBadge = document.getElementById("remoteBadge");
const audioStatus = document.getElementById("audioStatus");
const audioStatusText = audioStatus?.querySelector(".status-banner-text") || null;
const isRemote = (() => {
  const host = window.location.hostname;
  return host && host !== "127.0.0.1" && host !== "localhost";
})();
const isElectron = /Electron/i.test(navigator.userAgent || "");
if (document.body) {
  document.body.classList.toggle("electron-app", isElectron);
  document.body.classList.toggle("web-app", !isElectron);
}

const POLL_STATE_MS = 2500;
const SOUND_QUEUE_MS = 800;
const ROUTING_POLL_MS = 3000;

function shouldPoll() {
  return !document.hidden;
}

let audioAvailable = true;
const routingEnforceAt = new Map();

function setAudioStatus(message) {
  if (!audioStatus) return;
  if (message) {
    if (audioStatusText) {
      audioStatusText.textContent = message;
    } else {
      audioStatus.textContent = message;
    }
    audioStatus.classList.remove("hidden");
  } else {
    audioStatus.classList.add("hidden");
  }
}

function startAudioStatusPoll() {
  if (!audioStatus) return;
  const poll = async () => {
    try {
      const res = await fetch("/api/audio-status", { cache: "no-store" });
      const data = await res.json();
      if (!data?.ok) {
        audioAvailable = false;
        setAudioStatus("Audio status unknown.");
        return;
      }
      if (!data.pactlAvailable) {
        audioAvailable = false;
        const err = data.pactlLastError ? ` (${data.pactlLastError})` : "";
        const wait = Number.isFinite(data.pactlRetryInSec) && data.pactlRetryInSec > 0
          ? ` Retry in ${data.pactlRetryInSec}s.`
          : "";
        setAudioStatus(`Audio service down: pactl unavailable${err}.${wait}`);
        return;
      }
      audioAvailable = true;
      setAudioStatus("");
    } catch {
      audioAvailable = false;
      setAudioStatus("Audio service unreachable.");
    }
  };
  poll();
  setInterval(poll, 3000);
}

function setSinkLabel(key, percent, currentDb, peakDb) {
  const labels = Array.from(document.querySelectorAll(`.sink-percent[data-percent="${key}"]`));
  labels.forEach((label) => {
    let volEl = label.querySelector(".sink-vol");
    let dbEl = label.querySelector(".sink-db");
    if (!volEl || !dbEl) {
      label.innerHTML = "";
      volEl = document.createElement("div");
      volEl.className = "sink-vol";
      dbEl = document.createElement("div");
      dbEl.className = "sink-db";
      label.appendChild(volEl);
      label.appendChild(dbEl);
    }
    volEl.textContent = `Volume ${percent}%`;
    if (Number.isFinite(currentDb)) {
      const cur = Math.round(currentDb);
      const peak = Number.isFinite(peakDb) ? Math.round(peakDb) : null;
      dbEl.textContent = peak === null ? `${cur} dB` : `${cur} dB | ${peak} dB`;
    }
  });
}

if (remoteBadge) {
  if (isRemote) {
    remoteBadge.classList.remove("hidden");
  } else {
    remoteBadge.classList.add("hidden");
  }
}

let pinRevealLocked = false;
function showPinValue() {
  if (!pinValue) return;
  const pin = pinValue.dataset.pin || "";
  pinValue.textContent = pin || "••••";
}

function hidePinValue() {
  if (!pinValue) return;
  if (pinRevealLocked) return;
  pinValue.textContent = "••••";
}

const defaultState = {
  categories: [
    { name: "Memes", slots: Array.from({ length: 9 }, () => emptySlot()) },
    { name: "Alerts", slots: Array.from({ length: 9 }, () => emptySlot()) },
  ],
  activeCategory: 0,
  updatedAt: 0,
  volumeUpdatedAt: 0,
  sinkVolumes: {},
  inputDeviceId: "",
  outputDeviceId: "",
  gameSinkId: "",
  chatSinkId: "",
  browserSinkId: "",
  soundboardSinkId: "",
  micSinkId: "",
  streamMode: false,
  streamLinks: {
    browser: false,
    game: false,
    chat: false,
    mic: false,
    soundboard: false,
  },
  soundboardMicLink: false,
  chatMicLink: false,
  mutedSinks: {
    browser: false,
    game: false,
    chat: false,
    mic: false,
    soundboard: false,
    stream: false,
  },
  routingOverrides: {},
  audioSettings: {
    rnnEnabled: false,
    gateEnabled: false,
    gateThreshold: 45,
    micFxEnabled: true,
    noiseSuppressor: "rnnoise",
    micFxGain: 100,
  },
  chatAudioSettings: {
    rnnEnabled: false,
    gateEnabled: false,
    gateThreshold: 45,
    noiseSuppressor: "rnnoise",
    chatFxGain: 100,
    chatFxMix: 100,
    chatGateTest: false,
  },
  systemOutputSink: "",
  systemInputSource: "",
  streamOutputSink: "",
  lanEnabled: false,
};

function emptySlot() {
  return { name: "", bind: "", audioData: "", volume: 100 };
}

let state = loadState();
let serverAvailable = false;
let micMonitor = null;
let pendingAudioApply = false;
const navButtons = document.querySelectorAll(".nav-item");
const pages = {
  sonar: document.getElementById("page-sonar"),
  settings: document.getElementById("page-settings"),
  soundboard: document.getElementById("page-soundboard"),
  routing: document.getElementById("page-routing"),
};
const pageTitle = document.getElementById("pageTitle");
const sbTabs = document.getElementById("sbTabs");
const grid = document.getElementById("soundboardGrid");
const filePicker = document.getElementById("filePicker");
const slotTemplate = document.getElementById("slotTemplate");
const soundMeta = document.getElementById("soundMeta");
const soundNameInput = document.getElementById("soundNameInput");
const soundBindInput = document.getElementById("soundBindInput");
const soundMetaCancel = document.getElementById("soundMetaCancel");
const soundMetaSave = document.getElementById("soundMetaSave");
const soundMetaDelete = document.getElementById("soundMetaDelete");
const soundMetaTitle = document.getElementById("soundMetaTitle");
const soundCategoryRow = document.getElementById("soundCategoryRow");
const soundCategorySelect = document.getElementById("soundCategorySelect");
const soundboardMaster = document.getElementById("soundboardMaster");
const soundboardMasterValue = document.getElementById("soundboardMasterValue");

const categoryModal = document.getElementById("categoryModal");
const categoryModalTitle = document.getElementById("categoryModalTitle");
const categoryNameInput = document.getElementById("categoryNameInput");
const categoryModalCancel = document.getElementById("categoryModalCancel");
const categoryModalSave = document.getElementById("categoryModalSave");

const addSoundBtn = document.getElementById("addSound");
const addCategoryBtn = document.getElementById("addCategory");
const renameCategoryBtn = document.getElementById("renameCategory");
const deleteCategoryBtn = document.getElementById("deleteCategory");

const activeAudio = new Map();
let sinkNameMap = new Map();
let sourceNameMap = new Map();
let pendingSoundFile = null;
let pendingSoundIndex = null;
let pendingSoundEdit = false;
let pendingCategoryMode = "";
let dragTimer = null;
let dragStart = null;
let draggingSlot = null;
let draggingIndex = null;
let draggingPointerId = null;
let draggingFromCategory = null;
let draggingSlotData = null;
let draggingTargetIndex = null;
let draggingTabHover = null;
let draggingTabLast = null;
let draggingTabTimer = null;
let dragGlobalActive = false;
let dragDirty = false;
let dragHover = null;
let dragGhost = null;
let dragOffset = { x: 0, y: 0 };

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    navButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    Object.values(pages).forEach((p) => p.classList.add("hidden"));
    pages[tab].classList.remove("hidden");
    pageTitle.textContent =
      tab === "sonar"
        ? "Mix"
        : tab === "settings"
          ? "Settings"
          : tab === "soundboard"
            ? "Soundboard"
            : "Routing";
  });
});

function loadState() {
  const raw = localStorage.getItem(stateKey);
  if (!raw) return structuredClone(defaultState);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.categories?.length) return structuredClone(defaultState);
    if (typeof parsed.updatedAt !== "number") parsed.updatedAt = 0;
    if (typeof parsed.volumeUpdatedAt !== "number") parsed.volumeUpdatedAt = 0;
    if (!parsed.sinkVolumes || typeof parsed.sinkVolumes !== "object") parsed.sinkVolumes = {};
    if (parsed.streamLinks?.chat_fx && !parsed.streamLinks?.chat) {
      parsed.streamLinks.chat = parsed.streamLinks.chat_fx;
      delete parsed.streamLinks.chat_fx;
    }
    if (parsed.mutedSinks?.chat_fx && !parsed.mutedSinks?.chat) {
      parsed.mutedSinks.chat = parsed.mutedSinks.chat_fx;
      delete parsed.mutedSinks.chat_fx;
    }
    const normalized = {
      ...structuredClone(defaultState),
      ...parsed,
      audioSettings: {
        ...structuredClone(defaultState.audioSettings),
        ...parsed.audioSettings,
      },
      chatAudioSettings: {
        ...structuredClone(defaultState.chatAudioSettings),
        ...parsed.chatAudioSettings,
      },
      streamLinks: {
        ...structuredClone(defaultState.streamLinks),
        ...parsed.streamLinks,
      },
      mutedSinks: {
        ...structuredClone(defaultState.mutedSinks),
        ...parsed.mutedSinks,
      },
      sinkVolumes: {
        ...structuredClone(defaultState.sinkVolumes),
        ...parsed.sinkVolumes,
      },
    };
    normalized.categories = (normalized.categories || []).map((cat) => ({
      ...cat,
      slots: (cat.slots || []).map((slot) => ({
        volume: 100,
        ...slot,
      })),
    }));
    return normalized;
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState(options = {}) {
  const touchUpdatedAt = options.touchUpdatedAt !== false;
  const touchVolume = options.touchVolume === true;
  if (touchUpdatedAt) state.updatedAt = Date.now();
  if (touchVolume) state.volumeUpdatedAt = Date.now();
  localStorage.setItem(stateKey, JSON.stringify(state));
  if (serverAvailable) pushStateToServer();
}

function renderTabs() {
  sbTabs.innerHTML = "";
  state.categories.forEach((cat, idx) => {
    const btn = document.createElement("button");
    let cls = "sb-tab";
    if (idx === state.activeCategory) cls += " active";
    if (draggingSlot && draggingTabLast === idx) cls += " drop-target";
    btn.className = cls;
    btn.textContent = cat.name;
    btn.dataset.index = String(idx);
    btn.addEventListener("click", () => {
      state.activeCategory = idx;
      saveState();
      render();
    });
    btn.addEventListener("pointerenter", () => {
      if (!draggingSlot) return;
      draggingTabLast = idx;
      if (draggingTabTimer) clearTimeout(draggingTabTimer);
      draggingTabTimer = setTimeout(() => {
        state.activeCategory = idx;
        saveState();
        renderTabs();
        renderGrid();
      }, 140);
    });
    sbTabs.appendChild(btn);
  });
}

function renderGrid() {
  grid.innerHTML = "";
  const cat = state.categories[state.activeCategory];
  cat.slots.forEach((slot, idx) => {
    const node = slotTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.index = String(idx);
    const nameEl = node.querySelector(".slot-name");
    const bindEl = node.querySelector(".slot-bind");
    const playBtn = node.querySelector(".play");
    const stopBtn = node.querySelector(".stop");
    const plusBtns = node.querySelectorAll(".plus");
    const editBtn = node.querySelector(".edit");
    const deleteBtn = null;
    const volValue = node.querySelector(".slot-vol-value");
    const volMinus = node.querySelector(".slot-vol-minus");
    const volPlus = node.querySelector(".slot-vol-plus");

    const isFilled = Boolean(slot.name && slot.audioData);
    node.classList.add(isFilled ? "filled" : "empty");
    nameEl.textContent = slot.name || "Empty";
    if (bindEl) {
      if (slot.bind) {
        bindEl.textContent = `Bind: ${slot.bind}`;
        bindEl.classList.remove("hidden");
      } else {
        bindEl.textContent = "";
        bindEl.classList.add("hidden");
      }
    }
    if (volValue) volValue.textContent = `${clampPercent(slot.volume)}%`;

    plusBtns.forEach((btn) => {
      btn.addEventListener("click", () => handleAddSound(idx));
    });

    playBtn.addEventListener("click", () => playSound(idx));
    stopBtn.addEventListener("click", () => stopSound(idx));
    if (editBtn) {
      editBtn.addEventListener("click", () => editSlot(idx));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deleteSlot(idx));
    }
    if (volMinus) {
      volMinus.addEventListener("click", () => adjustSlotVolume(idx, -5));
    }
    if (volPlus) {
      volPlus.addEventListener("click", () => adjustSlotVolume(idx, 5));
    }

    node.addEventListener("dragover", (event) => {
      event.preventDefault();
      node.classList.add("dragover");
    });

    node.addEventListener("dragleave", () => {
      node.classList.remove("dragover");
    });

    node.addEventListener("drop", async (event) => {
      event.preventDefault();
      node.classList.remove("dragover");
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        alert("Please drop an audio file.");
        return;
      }
      openSoundMeta(file, idx);
    });

    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button")) return;
      if (event.target.closest("input, textarea, select")) return;
      if (event.target.closest(".slot-bind")) return;
      dragStart = { x: event.clientX, y: event.clientY };
      if (dragTimer) clearTimeout(dragTimer);
      dragTimer = setTimeout(() => {
        startSlotDrag(node, idx, event);
      }, 250);
    });

    node.addEventListener("pointermove", (event) => {
      if (draggingSlot) {
        handleSlotDragMove(event);
        return;
      }
      if (!dragTimer || !dragStart) return;
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      if (Math.hypot(dx, dy) > 8) {
        clearTimeout(dragTimer);
        dragTimer = null;
        dragStart = null;
      }
    });

    node.addEventListener("pointerup", () => {
      clearTimeout(dragTimer);
      dragTimer = null;
      dragStart = null;
      if (draggingSlot) endSlotDrag();
    });

    node.addEventListener("pointercancel", () => {
      clearTimeout(dragTimer);
      dragTimer = null;
      dragStart = null;
      if (draggingSlot) endSlotDrag();
    });

    grid.appendChild(node);
  });
}

function findFirstEmptySlot() {
  const cat = state.categories[state.activeCategory];
  if (!cat) return -1;
  return cat.slots.findIndex((slot) => !slot?.audioData);
}

function compactCategory(categoryIndex) {
  const cat = state.categories[categoryIndex];
  if (!cat) return;
  const filled = cat.slots.filter((slot) => slot?.audioData);
  const emptyCount = Math.max(0, cat.slots.length - filled.length);
  const empties = Array.from({ length: emptyCount }, () => emptySlot());
  cat.slots = [...filled, ...empties];
}

function startSlotDrag(node, idx, event) {
  if (draggingSlot) return;
  const sourceCat = state.categories[state.activeCategory];
  const slotData = sourceCat?.slots?.[idx];
  if (!slotData?.audioData) return;
  draggingSlot = node;
  draggingIndex = idx;
  draggingPointerId = event.pointerId;
  draggingFromCategory = state.activeCategory;
  draggingSlotData = { ...slotData };
  draggingTargetIndex = null;
  dragDirty = false;
  const rect = node.getBoundingClientRect();
  dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  dragGhost = node.cloneNode(true);
  dragGhost.classList.add("slot-ghost");
  dragGhost.style.width = `${rect.width}px`;
  dragGhost.style.height = `${rect.height}px`;
  document.body.appendChild(dragGhost);
  updateDragGhost(event.clientX, event.clientY);
  node.classList.add("drag-source");
  node.classList.add("dragging");
  document.body.classList.add("dragging-active");
  if (typeof node.setPointerCapture === "function") {
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }
  if (!dragGlobalActive) {
    dragGlobalActive = true;
    document.addEventListener("pointermove", handleSlotDragMove);
    document.addEventListener("pointerup", endSlotDrag);
    document.addEventListener("pointercancel", endSlotDrag);
  }
}

function handleSlotDragMove(event) {
  if (!draggingSlot) return;
  updateDragGhost(event.clientX, event.clientY);
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const tab = target ? target.closest(".sb-tab") : null;
  if (tab && tab.dataset.index) {
    const tabIndex = Number(tab.dataset.index);
    if (Number.isFinite(tabIndex) && tabIndex !== state.activeCategory) {
      if (draggingTabHover !== tabIndex) {
        draggingTabHover = tabIndex;
        draggingTabLast = tabIndex;
        if (draggingTabTimer) clearTimeout(draggingTabTimer);
        draggingTabTimer = setTimeout(() => {
          state.activeCategory = tabIndex;
          saveState();
          renderTabs();
          renderGrid();
        }, 180);
      }
    }
    return;
  }
  draggingTabHover = null;
  const slot = target ? target.closest(".slot") : null;
  if (!slot || slot === draggingSlot) return;
  const targetIndex = Number(slot.dataset.index);
  if (!Number.isFinite(targetIndex) || targetIndex === draggingIndex) return;
  if (draggingFromCategory === state.activeCategory) {
    swapSlots(draggingIndex, targetIndex);
    draggingIndex = targetIndex;
    dragDirty = true;
  } else {
    draggingTargetIndex = targetIndex;
  }
  if (dragHover && dragHover !== slot) dragHover.classList.remove("dragover");
  dragHover = slot;
  dragHover.classList.add("dragover");
}

function endSlotDrag() {
  if (!draggingSlot) return;
  const dragEndX = dragGhost ? dragGhost.getBoundingClientRect().left + 4 : draggingSlot.getBoundingClientRect().left + 4;
  const dragEndY = dragGhost ? dragGhost.getBoundingClientRect().top + 4 : draggingSlot.getBoundingClientRect().top + 4;
  draggingSlot.classList.remove("dragging");
  draggingSlot.classList.remove("drag-source");
  document.body.classList.remove("dragging-active");
  if (dragGhost) {
    dragGhost.remove();
    dragGhost = null;
  }
  if (dragHover) dragHover.classList.remove("dragover");
  if (typeof draggingSlot.releasePointerCapture === "function" && draggingPointerId !== null) {
    try {
      draggingSlot.releasePointerCapture(draggingPointerId);
    } catch {
      // ignore
    }
  }
  draggingSlot = null;
  draggingIndex = null;
  draggingPointerId = null;
  draggingTabHover = null;
  draggingTabLast = null;
  if (draggingTabTimer) {
    clearTimeout(draggingTabTimer);
    draggingTabTimer = null;
  }
  if (dragGlobalActive) {
    dragGlobalActive = false;
    document.removeEventListener("pointermove", handleSlotDragMove);
    document.removeEventListener("pointerup", endSlotDrag);
    document.removeEventListener("pointercancel", endSlotDrag);
  }
  dragHover = null;
  let targetCategoryIndex =
    draggingTabLast !== null && Number.isFinite(draggingTabLast)
      ? draggingTabLast
      : state.activeCategory;
  if (draggingFromCategory !== null && draggingFromCategory === targetCategoryIndex && sbTabs) {
    const tabAtRelease = document.elementFromPoint(dragEndX, dragEndY)?.closest(".sb-tab");
    if (tabAtRelease && tabAtRelease.dataset.index) {
      const tabIndex = Number(tabAtRelease.dataset.index);
      if (Number.isFinite(tabIndex)) targetCategoryIndex = tabIndex;
    }
  }
  if (draggingFromCategory !== null) {
    console.log("drag-drop", {
      from: draggingFromCategory,
      to: targetCategoryIndex,
      active: state.activeCategory,
      lastTab: draggingTabLast,
      hasData: Boolean(draggingSlotData?.audioData),
    });
  }
  if (draggingFromCategory !== null && draggingFromCategory !== targetCategoryIndex) {
    const sourceCat = state.categories[draggingFromCategory];
    const targetCat = state.categories[targetCategoryIndex];
    const sourceIndex = Number.isFinite(draggingIndex) ? draggingIndex : -1;
    if (sourceCat && targetCat && sourceIndex >= 0 && draggingSlotData?.audioData) {
      let targetIndex = targetCat.slots.findIndex((slot) => !slot?.audioData);
      if (targetIndex < 0) {
        targetCat.slots.push(emptySlot());
        targetIndex = targetCat.slots.length - 1;
      }
      const displaced = targetCat.slots[targetIndex];
      targetCat.slots[targetIndex] = draggingSlotData;
      if (displaced?.audioData) {
        sourceCat.slots[sourceIndex] = displaced;
      } else {
        sourceCat.slots[sourceIndex] = emptySlot();
        compactCategory(draggingFromCategory);
      }
      saveState();
      state.activeCategory = targetCategoryIndex;
      render();
    } else if (dragDirty) {
      saveState();
      renderGrid();
    }
  } else if (dragDirty) {
    saveState();
    renderGrid();
  }
  dragDirty = false;
  draggingFromCategory = null;
  draggingSlotData = null;
  draggingTargetIndex = null;
}

function updateDragGhost(clientX, clientY) {
  if (!dragGhost) return;
  const x = clientX - dragOffset.x;
  const y = clientY - dragOffset.y;
  dragGhost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function swapSlots(fromIndex, toIndex) {
  const slots = state.categories[state.activeCategory].slots;
  const temp = slots[fromIndex];
  slots[fromIndex] = slots[toIndex];
  slots[toIndex] = temp;

  const fromEl = grid.querySelector(`.slot[data-index="${fromIndex}"]`);
  const toEl = grid.querySelector(`.slot[data-index="${toIndex}"]`);
  if (!fromEl || !toEl) return;

  fromEl.dataset.index = String(toIndex);
  toEl.dataset.index = String(fromIndex);

  const fromNext = fromEl.nextSibling;
  const toNext = toEl.nextSibling;
  if (fromNext === toEl) {
    grid.insertBefore(toEl, fromEl);
  } else if (toNext === fromEl) {
    grid.insertBefore(fromEl, toEl);
  } else {
    if (toNext) grid.insertBefore(fromEl, toNext);
    else grid.appendChild(fromEl);
    if (fromNext) grid.insertBefore(toEl, fromNext);
    else grid.appendChild(toEl);
  }
}

function render() {
  renderTabs();
  renderGrid();
  renderDeviceSelectors();
  renderStreamModes();
  updateMeterVisibility();
  renderAudioSettings();
  renderSinkControls();
}

function setSyncStatus(text, ok) {
  if (!syncStatus) return;
  syncStatus.textContent = text;
  syncStatus.style.color = ok ? "var(--success)" : "var(--muted)";
}

function renderSinkControls() {
  const muteButtons = Array.from(document.querySelectorAll(".mute-btn"));
  muteButtons.forEach((btn) => {
    const sink = btn.dataset.sink;
    if (!sink) return;
    const muted = Boolean(state.mutedSinks?.[sink]);
    btn.classList.toggle("active", muted);
    btn.textContent = muted ? "Muted" : "Mute";
  });
  const clipButtons = Array.from(document.querySelectorAll(".clip-btn"));
  clipButtons.forEach((btn) => {
    const sink = btn.dataset.sink;
    if (!sink) return;
    const linked = Boolean(state.streamLinks?.[sink]);
    btn.classList.toggle("active", linked);
    btn.textContent = linked ? "Linked" : "Link";
  });
  const micButtons = Array.from(document.querySelectorAll(".miclink-btn"));
  micButtons.forEach((btn) => {
    const linked = Boolean(state.soundboardMicLink);
    btn.classList.toggle("active", linked);
    btn.textContent = linked ? "Mic On" : "Mic";
  });
  const soundboardMuted = Boolean(state.mutedSinks?.soundboard);
  const masterValue = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume());
  setActiveSoundboardVolume(soundboardMuted ? 0 : masterValue);
  // Chat-to-mic removed.
}

async function refreshPin(forceRefresh = false) {
  if (!serverAvailable) return;
  try {
    const res = await fetch(forceRefresh ? "/api/pin-refresh" : "/api/pin", {
      method: forceRefresh ? "POST" : "GET",
      cache: "no-store",
    });
    const data = await res.json();
    const pin = String(data?.pin || "").trim();
    if (!pinValue) return;
    pinValue.dataset.pin = pin;
    pinRevealLocked = false;
    pinValue.textContent = "••••";
  } catch {
    // ignore
  }
}

async function refreshLanInfo() {
  if (!serverAvailable) return;
  try {
    const res = await fetch("/api/server-config", { cache: "no-store" });
    const data = await res.json();
    const enabled = Boolean(data?.lanEnabled);
    state.lanEnabled = enabled;
    if (lanToggle) {
      lanToggle.classList.toggle("active", enabled);
      lanToggle.textContent = enabled ? "Enabled" : "Disabled";
    }
    if (lanInfo) {
      if (!enabled) {
        lanInfo.textContent = "LAN access is disabled.";
      } else {
        const ip = data?.ip || "0.0.0.0";
        const port = data?.port || 1130;
        lanInfo.textContent = `LAN: http://${ip}:${port}`;
      }
    }
  } catch {
    // ignore
  }
}

async function applyStreamLinksForMode(enabled) {
  if (!serverAvailable) return;
  const targets = Object.keys(state.streamLinks || {});
  for (const sink of targets) {
    const shouldEnable = enabled && Boolean(state.streamLinks?.[sink]);
    try {
      await fetch("/api/stream-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink, enabled: shouldEnable }),
      });
    } catch {
      // ignore
    }
  }
}


async function initServerSync() {
  try {
    const ping = await fetch("/api/ping", { cache: "no-store" });
    serverAvailable = ping.ok;
  } catch {
    serverAvailable = false;
  }

  if (!serverAvailable) {
    setSyncStatus("Local", false);
    return;
  }

  try {
    await pullStateFromServer();
    setSyncStatus("Synced", true);
  } catch {
    setSyncStatus("Local", false);
    serverAvailable = false;
  }

  if (serverAvailable) {
    startSoundboardQueue();
  }

  if (serverAvailable && !isRemote) {
    ensureLoopbacksOnce();
  }

  setInterval(() => {
    if (!serverAvailable) return;
    if (!shouldPoll()) return;
    pullStateFromServer();
  }, POLL_STATE_MS);
}

let loopbackBootstrapped = false;
async function ensureLoopbacksOnce() {
  if (loopbackBootstrapped) return;
  loopbackBootstrapped = true;
  try {
    let sink = state.systemOutputSink || "";
    if (!sink) {
      const res = await fetch("/api/default-sink", { cache: "no-store" });
      const data = await res.json();
      sink = data?.sink || "";
    }
    if (!sink) return;
    await fetch("/api/loopback-default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sink }),
    });
  } catch {
    // ignore
  }
}

let soundboardQueueTimer = null;
let soundboardQueueBusy = false;
let soundboardRouteTimer = null;

function scheduleSoundboardRoute() {
  if (isRemote) return;
  if (!serverAvailable) return;
  if (soundboardRouteTimer) return;
  soundboardRouteTimer = setTimeout(async () => {
    soundboardRouteTimer = null;
    try {
      const res = await fetch("/api/mvp-sink-inputs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const ids = Array.isArray(data?.ids) ? data.ids : [];
      if (!ids.length) return;
      await fetch("/api/move-sink-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, sink: "soundboard" }),
      });
    } catch {
      // ignore
    }
  }, 200);
}

function startSoundboardQueue() {
  if (isRemote) return;
  if (!serverAvailable) return;
  if (soundboardQueueTimer) return;
  soundboardQueueTimer = setInterval(async () => {
    if (soundboardQueueBusy) return;
    soundboardQueueBusy = true;
    try {
      const res = await fetch("/api/soundboard-queue", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const events = Array.isArray(data?.events) ? data.events : [];
      events.forEach((event) => {
        if (event?.type === "play" && Number.isFinite(event.slotIndex)) {
          const catIndex = Number.isFinite(event.categoryIndex) ? event.categoryIndex : state.activeCategory;
          playSoundLocal(event.slotIndex, catIndex);
        } else if (event?.type === "stop") {
          if (Number.isFinite(event.slotIndex)) {
            const catIndex = Number.isFinite(event.categoryIndex) ? event.categoryIndex : state.activeCategory;
            stopSoundLocal(event.slotIndex, catIndex);
          } else {
            stopAllSounds();
          }
        }
      });
    } catch {
      // ignore
    } finally {
      soundboardQueueBusy = false;
    }
  }, SOUND_QUEUE_MS);
}

async function pullStateFromServer() {
  const res = await fetch("/api/state", { cache: "no-store" });
  const data = await res.json();
  if (!data?.state?.categories?.length) return;
  const incomingUpdated = data.state.updatedAt || 0;
  const incomingVolume = data.state.volumeUpdatedAt || 0;
  if (incomingUpdated <= (state.updatedAt || 0) && incomingVolume <= (state.volumeUpdatedAt || 0)) return;
  state = data.state;
  localStorage.setItem(stateKey, JSON.stringify(state));
  render();
  applySinkVolumesFromState();
  setSyncStatus("Synced", true);
}

async function handleAddSound(slotIndex) {
  filePicker.value = "";
  filePicker.onchange = () => {
    const file = filePicker.files?.[0];
    if (!file) return;
    openSoundMeta(file, slotIndex);
  };
  filePicker.click();
}

function editSlot(slotIndex) {
  openSoundEdit(slotIndex);
}

function deleteSlot(slotIndex) {
  const slot = state.categories[state.activeCategory].slots[slotIndex];
  if (!slot?.audioData) return;
  const ok = confirm("Delete this sound?");
  if (!ok) return;
  state.categories[state.activeCategory].slots[slotIndex] = emptySlot();
  compactCategory(state.activeCategory);
  saveState();
  render();
}

function adjustSlotVolume(slotIndex, delta) {
  const slot = state.categories[state.activeCategory].slots[slotIndex];
  if (!slot?.audioData) return;
  const next = clampPercent((slot.volume ?? 100) + delta);
  slot.volume = next;
  setSlotPlaybackVolume(slotIndex, next);
  const node = grid?.querySelector(`.slot[data-index="${slotIndex}"] .slot-vol-value`);
  if (node) node.textContent = `${next}%`;
  saveState();
}

function setSlotFromFile(file, slotIndex, name) {
  const reader = new FileReader();
  reader.onload = () => {
    const cat = state.categories[state.activeCategory];
    const bind = soundBindInput?.value?.trim() || "";
    cat.slots[slotIndex] = {
      name,
      audioData: reader.result,
      volume: 100,
      bind,
    };
    saveState();
    render();
  };
  reader.readAsDataURL(file);
}

function populateCategorySelect(currentIndex) {
  if (!soundCategorySelect || !soundCategoryRow) return;
  soundCategorySelect.innerHTML = "";
  state.categories.forEach((cat, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = cat.name;
    if (idx === currentIndex) opt.selected = true;
    soundCategorySelect.appendChild(opt);
  });
  soundCategoryRow.classList.remove("hidden");
}

function moveSoundToCategory(fromIndex, toCategoryIndex, name, bind) {
  const sourceCat = state.categories[state.activeCategory];
  const targetCat = state.categories[toCategoryIndex];
  if (!sourceCat || !targetCat) return;
  const slot = sourceCat.slots[fromIndex];
  if (!slot?.audioData) return;
  let targetIndex = targetCat.slots.findIndex((s) => !s?.audioData);
  if (targetIndex < 0) {
    targetCat.slots.push(emptySlot());
    targetIndex = targetCat.slots.length - 1;
  }
  targetCat.slots[targetIndex] = { ...slot, name, bind: bind ?? slot.bind };
  sourceCat.slots[fromIndex] = emptySlot();
  compactCategory(state.activeCategory);
  state.activeCategory = toCategoryIndex;
}

function openSoundMeta(file, slotIndex) {
  pendingSoundEdit = false;
  pendingSoundFile = file;
  pendingSoundIndex = slotIndex;
  if (soundMetaDelete) soundMetaDelete.classList.add("hidden");
  if (soundMetaTitle) soundMetaTitle.textContent = "Add Sound";
  if (soundNameInput) {
    soundNameInput.value = file.name.replace(/\.[^/.]+$/, "");
    soundNameInput.focus();
  }
  if (soundBindInput) soundBindInput.value = "";
  if (soundCategoryRow) soundCategoryRow.classList.add("hidden");
  if (soundMeta) soundMeta.classList.remove("hidden");
}

function openSoundEdit(slotIndex) {
  const slot = state.categories[state.activeCategory].slots[slotIndex];
  if (!slot?.audioData) return;
  pendingSoundEdit = true;
  pendingSoundFile = null;
  pendingSoundIndex = slotIndex;
  if (soundMetaDelete) soundMetaDelete.classList.remove("hidden");
  if (soundMetaTitle) soundMetaTitle.textContent = "Edit Sound";
  if (soundNameInput) {
    soundNameInput.value = slot.name || "";
    soundNameInput.focus();
  }
  if (soundBindInput) soundBindInput.value = slot.bind || "";
  populateCategorySelect(state.activeCategory);
  if (soundMeta) soundMeta.classList.remove("hidden");
}

function closeSoundMeta() {
  if (soundMeta) soundMeta.classList.add("hidden");
  pendingSoundFile = null;
  pendingSoundIndex = null;
  pendingSoundEdit = false;
  if (soundMetaDelete) soundMetaDelete.classList.add("hidden");
  if (soundNameInput) soundNameInput.value = "";
  if (soundBindInput) soundBindInput.value = "";
  if (soundCategoryRow) soundCategoryRow.classList.add("hidden");
}

function openCategoryModal(mode, currentName = "") {
  pendingCategoryMode = mode;
  if (categoryModalTitle) {
    categoryModalTitle.textContent = mode === "rename" ? "Rename Tab" : "Add Category";
  }
  if (categoryNameInput) {
    categoryNameInput.value = currentName;
    categoryNameInput.focus();
    categoryNameInput.select();
  }
  if (categoryModal) categoryModal.classList.remove("hidden");
}

function closeCategoryModal() {
  pendingCategoryMode = "";
  if (categoryModal) categoryModal.classList.add("hidden");
  if (categoryNameInput) categoryNameInput.value = "";
}

if (soundMetaCancel) {
  soundMetaCancel.addEventListener("click", () => closeSoundMeta());
}

if (soundMetaSave) {
  soundMetaSave.addEventListener("click", () => {
    if (pendingSoundIndex === null) return;
    const name = soundNameInput?.value?.trim();
    const bind = soundBindInput?.value?.trim() || "";
    if (!name) {
      alert("Please enter a name.");
      return;
    }
    if (pendingSoundEdit) {
      const slot = state.categories[state.activeCategory].slots[pendingSoundIndex];
      if (!slot?.audioData) return;
      const targetCatIndex = soundCategorySelect ? Number(soundCategorySelect.value) : state.activeCategory;
      if (Number.isFinite(targetCatIndex) && targetCatIndex !== state.activeCategory) {
        moveSoundToCategory(pendingSoundIndex, targetCatIndex, name, bind);
      } else {
        slot.name = name;
        slot.bind = bind;
      }
      saveState();
      render();
    } else {
      if (!pendingSoundFile) return;
      setSlotFromFile(pendingSoundFile, pendingSoundIndex, name);
    }
    closeSoundMeta();
  });
}

if (soundMetaDelete) {
  soundMetaDelete.addEventListener("click", () => {
    if (!Number.isFinite(pendingSoundIndex)) return;
    deleteSlot(pendingSoundIndex);
    closeSoundMeta();
  });
}

if (soundBindInput) {
  soundBindInput.addEventListener("keydown", (event) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      soundBindInput.value = "";
      return;
    }
    const bind = formatBindFromEvent(event);
    if (bind) soundBindInput.value = bind;
  });
}

if (categoryModalCancel) {
  categoryModalCancel.addEventListener("click", () => closeCategoryModal());
}

if (categoryModalSave) {
  categoryModalSave.addEventListener("click", () => {
    const name = categoryNameInput?.value?.trim();
    if (!name) {
      alert("Please enter a name.");
      return;
    }
    if (pendingCategoryMode === "rename") {
      const current = state.categories[state.activeCategory];
      if (current) current.name = name;
    } else {
      state.categories.push({ name, slots: Array.from({ length: 9 }, () => emptySlot()) });
      state.activeCategory = state.categories.length - 1;
    }
    saveState();
    render();
    closeCategoryModal();
  });
}

function renderDeviceSelectors() {
  if (inputSelect || outputSelect) {
    if (inputSelect?.dataset.ready !== "1" || outputSelect?.dataset.ready !== "1") {
      refreshDevices();
    }
  }
  if (inputSelect) inputSelect.value = state.inputDeviceId || "";
  if (outputSelect) outputSelect.value = state.outputDeviceId || "";
  if (gameSink) gameSink.value = state.gameSinkId || "";
  if (chatSink) chatSink.value = state.chatSinkId || "";
  if (browserSink) browserSink.value = state.browserSinkId || "";
  if (soundboardSink) soundboardSink.value = state.soundboardSinkId || "";
  if (micSink) micSink.value = state.micSinkId || "";
  if (systemOutput) systemOutput.disabled = isRemote;
  if (streamOutput) streamOutput.disabled = isRemote;
  if (systemInput) systemInput.disabled = isRemote;
}

function ensureSelectedOption(select, value, label) {
  if (!select || !value) return;
  const existing = Array.from(select.options).find((opt) => opt.value === value);
  if (existing) return;
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label || value;
  opt.selected = true;
  select.appendChild(opt);
}

async function refreshSystemOutputs() {
  if (!serverAvailable) return;
  try {
    const res = await fetch("/api/sinks", { cache: "no-store" });
    const data = await res.json();
    const sinks = data?.sinks || [];
    sinkNameMap = new Map(
      sinks.map((s) => {
        const desc = s.description || s.name;
        return [s.name, normalizeDeviceLabel(desc)];
      })
    );
    if (systemOutput) {
      systemOutput.innerHTML = "";
      const optDefault = document.createElement("option");
      optDefault.value = "";
      optDefault.textContent = "System Default";
      systemOutput.appendChild(optDefault);
      sinks.forEach((sink) => {
        const opt = document.createElement("option");
        opt.value = sink.name;
        const label = normalizeDeviceLabel(sink.description || sink.name);
        if (state.streamOutputSink && sink.name === state.streamOutputSink) {
          opt.disabled = true;
        }
        opt.textContent = label;
        systemOutput.appendChild(opt);
      });
      systemOutput.value = state.systemOutputSink || "";
      ensureSelectedOption(systemOutput, state.systemOutputSink, sinkNameMap.get(state.systemOutputSink));
    }
    if (streamOutput) {
      streamOutput.innerHTML = "";
      const optNone = document.createElement("option");
      optNone.value = "";
      optNone.textContent = "Disabled";
      streamOutput.appendChild(optNone);
      sinks.forEach((sink) => {
        const opt = document.createElement("option");
        opt.value = sink.name;
        const label = normalizeDeviceLabel(sink.description || sink.name);
        if (state.systemOutputSink && sink.name === state.systemOutputSink) {
          opt.disabled = true;
        }
        opt.textContent = label;
        streamOutput.appendChild(opt);
      });
      streamOutput.value = state.streamOutputSink || "";
      ensureSelectedOption(streamOutput, state.streamOutputSink, sinkNameMap.get(state.streamOutputSink));
    }
  } catch {
    // ignore
  }
}

async function refreshSystemInputs() {
  if (!systemInput || !serverAvailable) return;
  try {
    const res = await fetch("/api/sources", { cache: "no-store" });
    const data = await res.json();
    const sources = data?.sources || [];
    sourceNameMap = new Map(
      sources.map((s) => {
        const desc = s.description || s.name;
        return [s.name, normalizeDeviceLabel(desc)];
      })
    );
    systemInput.innerHTML = "";
    const optDefault = document.createElement("option");
    optDefault.value = "";
    optDefault.textContent = "System Default";
    systemInput.appendChild(optDefault);
    sources.forEach((source) => {
      const opt = document.createElement("option");
      opt.value = source.name;
      opt.textContent = normalizeDeviceLabel(source.description || source.name);
      systemInput.appendChild(opt);
    });
    systemInput.value = state.systemInputSource || "";
    ensureSelectedOption(systemInput, state.systemInputSource, sourceNameMap.get(state.systemInputSource));
  } catch {
    // ignore
  }
}

function renderAudioSettings() {
  const micEngine = state.audioSettings.noiseSuppressor || "rnnoise";
  const chatEngine = state.chatAudioSettings.noiseSuppressor || "rnnoise";
  if (rnnToggle) {
    const rnnActive = Boolean(state.audioSettings.rnnEnabled) && micEngine === "rnnoise";
    rnnToggle.textContent = rnnActive ? "On" : "Off";
    rnnToggle.classList.toggle("active", rnnActive);
    rnnToggle.disabled = micEngine !== "rnnoise";
  }
  if (gateToggle) {
    gateToggle.textContent = state.audioSettings.gateEnabled ? "On" : "Off";
    gateToggle.classList.toggle("active", state.audioSettings.gateEnabled);
  }
  if (gateThreshold) {
    gateThreshold.value = String(state.audioSettings.gateThreshold ?? 45);
  }
  if (noiseEngine) {
    noiseEngine.value = micEngine;
  }
  if (micFxGain) {
    micFxGain.value = String(state.audioSettings.micFxGain ?? 100);
  }
  if (micFxToggle) {
    micFxToggle.textContent = state.audioSettings.micFxEnabled ? "On" : "Off";
    micFxToggle.classList.toggle("active", state.audioSettings.micFxEnabled);
  }
  if (chatRnnToggle) {
    const chatRnnActive = Boolean(state.chatAudioSettings.rnnEnabled) && chatEngine === "rnnoise";
    chatRnnToggle.textContent = chatRnnActive ? "On" : "Off";
    chatRnnToggle.classList.toggle("active", chatRnnActive);
    chatRnnToggle.disabled = chatEngine !== "rnnoise";
  }
  if (chatGateToggle) {
    chatGateToggle.textContent = state.chatAudioSettings.gateEnabled ? "On" : "Off";
    chatGateToggle.classList.toggle("active", state.chatAudioSettings.gateEnabled);
  }
  if (chatGateThreshold) {
    chatGateThreshold.value = String(state.chatAudioSettings.gateThreshold ?? 45);
  }
  if (chatNoiseEngine) {
    chatNoiseEngine.value = chatEngine;
  }
  if (chatFxGain) {
    chatFxGain.value = String(state.chatAudioSettings.chatFxGain ?? 100);
  }
  if (chatFxMix) {
    chatFxMix.value = String(state.chatAudioSettings.chatFxMix ?? 100);
  }
  if (chatGateTest) {
    chatGateTest.textContent = state.chatAudioSettings.chatGateTest ? "On" : "Off";
    chatGateTest.classList.toggle("active", state.chatAudioSettings.chatGateTest);
  }
}

async function refreshRouting() {
  if (!routingList || !serverAvailable) return;
  if (!shouldPoll()) return;
  if (pages.routing && pages.routing.classList.contains("hidden")) return;
  if (routingList.dataset.busy === "1") return;
  if (routingList.dataset.pauseUntil && Date.now() < Number(routingList.dataset.pauseUntil)) return;
  try {
    const res = await fetch("/api/sink-inputs", { cache: "no-store" });
    const data = await res.json();
    const inputs = data?.inputs || [];
    const sinks = data?.sinks || [];
    routingList.innerHTML = "";
    if (!inputs.length) {
      const empty = document.createElement("div");
      empty.className = "routing-empty";
      empty.textContent = "No active audio apps.";
      routingList.appendChild(empty);
      return;
    }
    inputs.forEach((input) => {
      const row = document.createElement("div");
      row.className = "routing-row";
      const name = document.createElement("div");
      name.className = "routing-name";
      name.textContent = input.display + (input.state ? ` (${input.state})` : "");
      const select = document.createElement("select");
      select.className = "routing-select";
      const autoOpt = document.createElement("option");
      autoOpt.value = "__auto__";
      autoOpt.textContent = "Auto";
      select.appendChild(autoOpt);
      sinks.forEach((sink) => {
        const opt = document.createElement("option");
        opt.value = sink.name;
        opt.textContent = sink.description || sink.name;
        if (sink.name === input.sink) opt.selected = true;
        select.appendChild(opt);
      });
      const override = state.routingOverrides?.[input.key];
      if (override && override !== input.sink) {
        select.value = override;
        if (audioAvailable) {
          const last = routingEnforceAt.get(input.key) || 0;
          const now = Date.now();
          if (now - last > 1500) {
            routingEnforceAt.set(input.key, now);
            routingList.dataset.pauseUntil = String(Date.now() + 1500);
            fetch("/api/move-sink-input", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: input.ids || [input.id], sink: override }),
            }).catch(() => {});
          }
        }
      } else if (override && override === input.sink) {
        select.value = override;
      }
      select.addEventListener("change", async () => {
        if (!state.routingOverrides) state.routingOverrides = {};
        if (select.value === "__auto__") {
          delete state.routingOverrides[input.key];
          saveState();
          return;
        }
        state.routingOverrides[input.key] = select.value;
        saveState();
        routingList.dataset.pauseUntil = String(Date.now() + 1500);
        try {
          await fetch("/api/move-sink-input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: input.ids || [input.id], sink: select.value }),
          });
        } catch {
          // ignore
        }
      });
      select.addEventListener("focus", () => {
        routingList.dataset.busy = "1";
      });
      select.addEventListener("blur", () => {
        routingList.dataset.busy = "0";
      });
      row.appendChild(name);
      row.appendChild(select);
      routingList.appendChild(row);
    });
  } catch {
    // ignore
  }
}

async function moveAllSinkInputsTo(sink) {
  if (!serverAvailable || !sink) return;
  try {
    const res = await fetch("/api/sink-inputs", { cache: "no-store" });
    const data = await res.json();
    const inputs = data?.inputs || [];
    if (!inputs.length) return;
    const ids = inputs.flatMap((input) => input.ids || [input.id]).filter(Boolean);
    if (!ids.length) return;
    await fetch("/api/move-sink-input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, sink }),
    });
  } catch {
    // ignore
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices || devices.length === 0) return;
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  if (inputs.length === 0 && outputs.length === 0) return;
  maybeSelectBehringerOutput(outputs);
  if (!state.soundboardSinkId) {
    const sb = outputs.find((d) => /soundboard/i.test(d.label || ""));
    if (sb) {
      state.soundboardSinkId = sb.deviceId;
      saveState();
    }
  }
  fillSelect(inputSelect, inputs, "Input");
  fillSelect(outputSelect, outputs, "Output");
  fillSelect(gameSink, outputs, "Output");
  fillSelect(chatSink, outputs, "Output");
  fillSelect(browserSink, outputs, "Output");
  fillSelect(soundboardSink, outputs, "Output");
  fillSelect(micSink, outputs, "Output");
}

function maybeSelectBehringerOutput(outputs) {
  if (state.outputDeviceId) return;
  const match = outputs.find((device) => /behringer/i.test(device.label || ""));
  if (!match) return;
  state.outputDeviceId = match.deviceId;
  saveState();
}

function fillSelect(select, list, label) {
  if (!select) return;
  if (!list || list.length === 0) return;
  select.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = `Default ${label}`;
  select.appendChild(defaultOption);
  list.forEach((device, index) => {
    const opt = document.createElement("option");
    opt.value = device.deviceId;
    const name = normalizeDeviceLabel(device.label || `${label} Device ${index + 1}`);
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.dataset.ready = "1";
}

function normalizeDeviceLabel(raw) {
  const label = String(raw || "").trim();
  if (!label) return raw;
  if (/behringer_?umc202hd_192k/i.test(label)) {
    if (/mic1/i.test(label)) return "UMC202HD 192k Input 1";
    if (/mic2/i.test(label)) return "UMC202HD 192k Input 2";
    if (/line/i.test(label)) return "UMC202HD 192k Line A";
  }
  return label;
}

function normalizeBindKey(key) {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function formatBindFromEvent(event) {
  const rawKey = event.key;
  if (!rawKey || rawKey === "Unidentified" || rawKey === "Dead") return "";
  if (["Control", "Shift", "Alt", "Meta"].includes(rawKey)) return "";
  const mods = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Meta");
  const key = normalizeBindKey(rawKey);
  return [...mods, key].join("+");
}

function renderStreamModes() {
  if (!streamToggle) return;
  streamToggle.classList.toggle("active", state.streamMode);
  streamToggle.textContent = state.streamMode ? "Stream Mode On" : "Stream Mode Off";
  document.body.classList.toggle("stream-on", state.streamMode);
  document.body.classList.toggle("stream-off", !state.streamMode);
}

async function ensureMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    alert("Mic access is required to list input devices and monitor audio.");
    return false;
  }
}

async function toggleMicMonitor() {
  if (micMonitor) {
    stopMicMonitor();
    return;
  }
  const ok = await ensureMicPermission();
  if (!ok) return;
  await refreshDevices();
  let monitorId = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const match = inputs.find((d) => /mic/i.test(d.label || "") && /monitor/i.test(d.label || ""));
    if (match) monitorId = match.deviceId;
  } catch {
    // ignore
  }
  const constraints = state.inputDeviceId
    ? { audio: { deviceId: { exact: monitorId || state.inputDeviceId } } }
    : { audio: true };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const audio = new Audio();
  audio.srcObject = stream;
  audio.muted = false;
  audio.autoplay = true;
  micMonitor = { stream, audio };
  if (monitorBtn) monitorBtn.textContent = "Stop Monitor";
}

function stopMicMonitor() {
  if (!micMonitor) return;
  micMonitor.stream.getTracks().forEach((t) => t.stop());
  if (micMonitor.audio) {
    micMonitor.audio.pause();
    micMonitor.audio.srcObject = null;
  }
  micMonitor = null;
  if (monitorBtn) monitorBtn.textContent = "Monitor Mic";
  if (pendingAudioApply) {
    pendingAudioApply = false;
    pushAudioSettingsToServer();
  }
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return target.isContentEditable === true;
}

function playSoundByBind(bind) {
  if (!bind) return false;
  const cat = state.categories[state.activeCategory];
  if (!cat?.slots?.length) return false;
  const idx = cat.slots.findIndex((slot) => slot?.bind === bind);
  if (idx < 0) return false;
  playSound(idx);
  return true;
}

document.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (isTypingTarget(event.target)) return;
  const bind = formatBindFromEvent(event);
  if (!bind) return;
  const handled = playSoundByBind(bind);
  if (handled) event.preventDefault();
});

if (inputSelect) {
  inputSelect.addEventListener("change", async () => {
    state.inputDeviceId = inputSelect.value;
    saveState();
    renderDeviceSelectors();
  });
  inputSelect.addEventListener("click", async () => {
    await ensureMicPermission();
    await refreshDevices();
    renderDeviceSelectors();
  });
}

if (outputSelect) {
  outputSelect.addEventListener("change", () => {
    state.outputDeviceId = outputSelect.value;
    saveState();
    renderDeviceSelectors();
  });
  outputSelect.addEventListener("click", async () => {
    await refreshDevices();
    renderDeviceSelectors();
  });
}

if (systemOutput) {
  systemOutput.addEventListener("change", async () => {
    if (isRemote) return;
    state.systemOutputSink = systemOutput.value;
    saveState();
    if (!serverAvailable || !systemOutput.value) return;
    try {
      await fetch("/api/default-sink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink: systemOutput.value }),
      });
      if (streamOutput && state.streamMode) {
        await refreshSystemOutputs();
      }
      await fetch("/api/loopback-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink: systemOutput.value }),
      });
      await moveAllSinkInputsTo(systemOutput.value);
    } catch {
      // ignore
    }
  });
  systemOutput.addEventListener("click", async () => {
    await refreshSystemOutputs();
  });
}

if (streamOutput) {
  streamOutput.addEventListener("change", async () => {
    if (isRemote) return;
    state.streamOutputSink = streamOutput.value;
    saveState();
    if (!serverAvailable) return;
    try {
      await fetch("/api/stream-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink: streamOutput.value }),
      });
      if (state.streamMode) {
        await applyStreamLinksForMode(true);
      }
      await refreshSystemOutputs();
    } catch {
      // ignore
    }
  });
  streamOutput.addEventListener("click", async () => {
    await refreshSystemOutputs();
  });
}

if (systemInput) {
  systemInput.addEventListener("change", async () => {
    if (isRemote) return;
    state.systemInputSource = systemInput.value;
    saveState();
    if (!serverAvailable || !systemInput.value) return;
    try {
      await fetch("/api/default-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: systemInput.value }),
      });
    } catch {
      // ignore
    }
  });
  systemInput.addEventListener("click", async () => {
    await refreshSystemInputs();
  });
}

if (pinValue) {
  pinValue.addEventListener("click", () => {
    const pin = pinValue.dataset.pin || "";
    const showing = pinValue.textContent === pin;
    pinRevealLocked = !showing;
    pinValue.textContent = pinRevealLocked ? pin || "••••" : "••••";
  });
  pinValue.addEventListener("mouseenter", () => {
    showPinValue();
  });
  pinValue.addEventListener("mouseleave", () => {
    hidePinValue();
  });
}

if (pinRefresh) {
  pinRefresh.addEventListener("click", async () => {
    if (!serverAvailable) return;
    try {
      await fetch("/api/pin-refresh", { method: "POST" });
      await refreshPin();
    } catch {
      // ignore
    }
  });
}

if (pinCopy) {
  pinCopy.addEventListener("click", async () => {
    if (!pinValue) return;
    const pin = pinValue.dataset.pin || "";
    if (!pin) return;
    try {
      await navigator.clipboard.writeText(pin);
      pinCopy.textContent = "Copied";
      setTimeout(() => {
        pinCopy.textContent = "Copy";
      }, 1200);
    } catch {
      // ignore
    }
  });
}

function shouldRequirePin() {
  return isRemote;
}

async function verifyPin(pin) {
  if (!serverAvailable) return false;
  try {
    const res = await fetch("/api/pin-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

function showPinGate() {
  if (!pinGate) return;
  pinGate.classList.remove("hidden");
  if (pinGateInput) pinGateInput.focus();
}

function hidePinGate() {
  if (!pinGate) return;
  pinGate.classList.add("hidden");
}

if (pinGateSubmit) {
  pinGateSubmit.addEventListener("click", async () => {
    const pin = pinGateInput?.value?.trim() || "";
    if (!pin) return;
    const ok = await verifyPin(pin);
    if (ok) {
      hidePinGate();
    } else if (pinGateError) {
      pinGateError.textContent = "Invalid PIN";
    }
  });
}

if (pinGateInput) {
  pinGateInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const pin = pinGateInput.value.trim();
    if (!pin) return;
    const ok = await verifyPin(pin);
    if (ok) {
      hidePinGate();
    } else if (pinGateError) {
      pinGateError.textContent = "Invalid PIN";
    }
  });
}

if (lanToggle) {
  lanToggle.addEventListener("click", async () => {
    const next = !Boolean(state.lanEnabled);
    state.lanEnabled = next;
    if (lanToggle) {
      lanToggle.classList.toggle("active", next);
      lanToggle.textContent = next ? "Enabled" : "Disabled";
    }
    if (!serverAvailable) return;
    try {
      await fetch("/api/server-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lanEnabled: next }),
      });
      setTimeout(() => {
        refreshLanInfo();
      }, 1200);
      if (window.location.hostname && window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost") {
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch {
      // ignore
    }
  });
}

if (lanRestart) {
  lanRestart.addEventListener("click", async () => {
    if (!serverAvailable) return;
    try {
      await fetch("/api/server-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lanEnabled: state.lanEnabled }),
      });
      setSyncStatus("Restarting", true);
    } catch {
      // ignore
    }
  });
}

function bindOutputSelect(select, key) {
  if (!select) return;
  select.addEventListener("change", () => {
    state[key] = select.value;
    saveState();
  });
  select.addEventListener("click", async () => {
    await refreshDevices();
    renderDeviceSelectors();
  });
}

bindOutputSelect(gameSink, "gameSinkId");
bindOutputSelect(chatSink, "chatSinkId");
bindOutputSelect(browserSink, "browserSinkId");
bindOutputSelect(soundboardSink, "soundboardSinkId");
bindOutputSelect(micSink, "micSinkId");

if (monitorBtn) {
  monitorBtn.addEventListener("click", () => toggleMicMonitor());
}

function ensureTestAudio() {
  if (ensureTestAudio.ctx) return ensureTestAudio;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const audio = new Audio();
  audio.srcObject = dest.stream;
  audio.autoplay = true;
  audio.play().catch(() => {});
  ensureTestAudio.ctx = ctx;
  ensureTestAudio.dest = dest;
  ensureTestAudio.audio = audio;
  return ensureTestAudio;
}

async function playTestTone(panValue) {
  const { ctx, dest, audio } = ensureTestAudio();
  await ctx.resume();
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 440;
  const gain = ctx.createGain();
  gain.gain.value = 0.2;
  const panner = ctx.createStereoPanner();
  panner.pan.value = panValue;
  osc.connect(gain).connect(panner).connect(dest);

  const sinkId = state.outputDeviceId;
  if (sinkId && typeof audio.setSinkId === "function") {
    try {
      await audio.setSinkId(sinkId);
    } catch {
      // ignore sink errors
    }
  }
  audio.play().catch(() => {});

  osc.start();
  osc.stop(ctx.currentTime + 0.4);
}

if (testLeft) testLeft.addEventListener("click", () => playTestTone(-1));
if (testBoth) testBoth.addEventListener("click", () => playTestTone(0));
if (testRight) testRight.addEventListener("click", () => playTestTone(1));

if (rnnToggle) {
  rnnToggle.addEventListener("click", () => {
    state.audioSettings.rnnEnabled = !state.audioSettings.rnnEnabled;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (gateToggle) {
  gateToggle.addEventListener("click", () => {
    state.audioSettings.gateEnabled = !state.audioSettings.gateEnabled;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (gateThreshold) {
  gateThreshold.addEventListener("input", () => {
    state.audioSettings.gateThreshold = Number(gateThreshold.value || 0);
    saveState();
    pushAudioSettingsToServer();
  });
}

if (noiseEngine) {
  noiseEngine.addEventListener("change", () => {
    state.audioSettings.noiseSuppressor = noiseEngine.value || "rnnoise";
    if (state.audioSettings.noiseSuppressor !== "rnnoise") {
      state.audioSettings.rnnEnabled = false;
    }
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (micFxToggle) {
  micFxToggle.addEventListener("click", () => {
    state.audioSettings.micFxEnabled = !state.audioSettings.micFxEnabled;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (chatRnnToggle) {
  chatRnnToggle.addEventListener("click", () => {
    state.chatAudioSettings.rnnEnabled = !state.chatAudioSettings.rnnEnabled;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (chatGateToggle) {
  chatGateToggle.addEventListener("click", () => {
    state.chatAudioSettings.gateEnabled = !state.chatAudioSettings.gateEnabled;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (chatGateThreshold) {
  chatGateThreshold.addEventListener("input", () => {
    state.chatAudioSettings.gateThreshold = Number(chatGateThreshold.value || 0);
    saveState();
    pushAudioSettingsToServer();
  });
}

if (chatFxGain) {
  chatFxGain.addEventListener("input", () => {
    state.chatAudioSettings.chatFxGain = Number(chatFxGain.value || 100);
    saveState();
  });
}

if (chatFxMix) {
  chatFxMix.addEventListener("input", async () => {
    state.chatAudioSettings.chatFxMix = Number(chatFxMix.value || 100);
    saveState();
    if (!serverAvailable) return;
    try {
      await fetch("/api/chat-mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mix: state.chatAudioSettings.chatFxMix }),
      });
    } catch {
      // ignore
    }
  });
}

if (chatGateTest) {
  chatGateTest.addEventListener("click", () => {
    state.chatAudioSettings.chatGateTest = !state.chatAudioSettings.chatGateTest;
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (chatNoiseEngine) {
  chatNoiseEngine.addEventListener("change", () => {
    state.chatAudioSettings.noiseSuppressor = chatNoiseEngine.value || "rnnoise";
    if (state.chatAudioSettings.noiseSuppressor !== "rnnoise") {
      state.chatAudioSettings.rnnEnabled = false;
    }
    saveState();
    renderAudioSettings();
    pushAudioSettingsToServer();
  });
}

if (applyFx) {
  applyFx.addEventListener("click", () => {
    applyAudioFxNow();
  });
}

if (micFxGain) {
  micFxGain.addEventListener("input", () => {
    state.audioSettings.micFxGain = Number(micFxGain.value || 100);
    saveState();
  });
}

function toggleStreamMode() {
  state.streamMode = !state.streamMode;
  if (state.streamMode) {
    const links = state.streamLinks || {};
    const hasAny = Object.values(links).some(Boolean);
    if (!hasAny) {
      links.browser = true;
      links.game = true;
      links.chat = true;
      state.streamLinks = links;
    }
  }
  saveState();
  renderStreamModes();
  updateMeterVisibility();
  refreshSystemOutputs();
  applyStreamLinksForMode(state.streamMode);
}

if (streamToggle) streamToggle.addEventListener("click", () => toggleStreamMode());


let pushTimer = null;
let audioSettingsTimer = null;

function pushStateToServer() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (res.ok) setSyncStatus("Synced", true);
    } catch {
      setSyncStatus("Local", false);
      serverAvailable = false;
    }
  }, 250);
}

function pushAudioSettingsToServer() {
  clearTimeout(audioSettingsTimer);
  audioSettingsTimer = setTimeout(async () => {
    if (!serverAvailable) return;
    try {
      pendingAudioApply = true;
      await fetch("/api/audio-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: state.audioSettings, chatSettings: state.chatAudioSettings, defer: true }),
      });
    } catch {
      // ignore audio settings sync errors
    }
  }, 400);
}

async function applyAudioFxNow() {
  if (!serverAvailable) return;
  try {
    await fetch("/api/audio-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: state.audioSettings, chatSettings: state.chatAudioSettings }),
    });
    pendingAudioApply = false;
    if (state.systemOutputSink) {
      await fetch("/api/default-sink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink: state.systemOutputSink }),
      });
      await fetch("/api/loopback-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sink: state.systemOutputSink }),
      });
      await moveAllSinkInputsTo(state.systemOutputSink);
    }
    if (state.chatAudioSettings?.chatFxMix !== undefined) {
      await fetch("/api/chat-mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mix: state.chatAudioSettings.chatFxMix }),
      });
    }
    await refreshAudioDevices();
    await refreshRouting();
  } catch {
    // ignore apply errors
  }
}

function playSoundLocal(slotIndex, categoryIndex = state.activeCategory) {
  const category = state.categories[categoryIndex];
  const slot = category?.slots?.[slotIndex];
  if (!slot?.audioData) return;
  const audio = new Audio(slot.audioData);
  const slotVolume = clampPercent(slot.volume ?? 100) / 100;
  const masterValue = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume()) / 100;
  const masterVolume = state.mutedSinks?.soundboard ? 0 : masterValue;
  audio._slotVolume = slotVolume;
  audio.volume = slotVolume * masterVolume;
  const sinkId = state.soundboardSinkId || "soundboard" || state.outputDeviceId;
  if (sinkId && typeof audio.setSinkId === "function") {
    audio.setSinkId(sinkId).catch(() => {});
  }
  attachSoundboardMeter(audio);
  audio.play();
  scheduleSoundboardRoute();
  const audioKey = `${categoryIndex}:${slotIndex}`;
  const list = activeAudio.get(audioKey) || [];
  list.push(audio);
  activeAudio.set(audioKey, list);
  audio.addEventListener("ended", () => {
    const updated = (activeAudio.get(audioKey) || []).filter((a) => a !== audio);
    activeAudio.set(audioKey, updated);
  });
}

async function playSound(slotIndex) {
  const slot = state.categories[state.activeCategory].slots[slotIndex];
  if (!slot?.audioData) return;
  if (isRemote) {
    try {
      await fetch("/api/soundboard-play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotIndex, categoryIndex: state.activeCategory }),
      });
    } catch {
      // ignore
    }
    return;
  }
  playSoundLocal(slotIndex, state.activeCategory);
}

function stopSoundLocal(slotIndex, categoryIndex = state.activeCategory) {
  const audioKey = `${categoryIndex}:${slotIndex}`;
  const list = activeAudio.get(audioKey) || [];
  list.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  activeAudio.set(audioKey, []);
}

function stopAllSounds() {
  const keys = Array.from(activeAudio.keys());
  keys.forEach((key) => {
    const parts = String(key).split(":");
    if (parts.length === 2) {
      stopSoundLocal(Number(parts[1]), Number(parts[0]));
    } else {
      stopSoundLocal(Number(key), state.activeCategory);
    }
  });
}

function clampPercent(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 100;
  return Math.max(0, Math.min(100, num));
}

function percentToDb(value) {
  const percent = clampPercent(value);
  if (percent <= 0) return -60;
  const db = -60 + (percent / 100) * 60;
  return Math.round(db);
}

function ensureDbMeter(labelEl) {
  if (!labelEl) return null;
  if (isElectron) return labelEl;
  if (labelEl.querySelector(".db-meter")) return labelEl;
  labelEl.innerHTML = "";
  const text = document.createElement("div");
  text.className = "db-text";
  const meter = document.createElement("div");
  meter.className = "db-meter";
  const fill = document.createElement("div");
  fill.className = "db-meter-fill";
  meter.appendChild(fill);
  labelEl.appendChild(text);
  labelEl.appendChild(meter);
  return labelEl;
}

function getSoundboardVolume() {
  const range = document.querySelector('.rocker-range[data-channel="soundboard"]');
  if (!range) return 100;
  return clampPercent(range.value);
}

function setActiveSoundboardVolume(value) {
  const volume = clampPercent(value) / 100;
  const masterVolume = state.mutedSinks?.soundboard ? 0 : volume;
  activeAudio.forEach((list) => {
    list.forEach((audio) => {
      const slotVolume = Number.isFinite(audio._slotVolume) ? audio._slotVolume : 1;
      audio.volume = slotVolume * masterVolume;
    });
  });
  if (soundboardMaster) soundboardMaster.value = String(clampPercent(value));
  if (soundboardMasterValue) {
    const percent = clampPercent(value);
    if (isElectron) {
      soundboardMasterValue.textContent = `${percent}%`;
    } else {
      const db = percentToDb(percent);
      soundboardMasterValue.textContent = `${percent}% (${db} dB)`;
    }
  }
}

function setSlotPlaybackVolume(slotIndex, value, categoryIndex = state.activeCategory) {
  const slotVolume = clampPercent(value) / 100;
  const masterValue = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume()) / 100;
  const masterVolume = state.mutedSinks?.soundboard ? 0 : masterValue;
  const audioKey = `${categoryIndex}:${slotIndex}`;
  const list = activeAudio.get(audioKey) || [];
  list.forEach((audio) => {
    audio._slotVolume = slotVolume;
    audio.volume = slotVolume * masterVolume;
  });
}

async function stopSound(slotIndex) {
  if (isRemote) {
    try {
      await fetch("/api/soundboard-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotIndex }),
      });
    } catch {
      // ignore
    }
    return;
  }
  stopSoundLocal(slotIndex);
}

const liveLevels = new Map();
let soundboardMeterCtx = null;
const soundboardMeterNodes = new Map();

function getSoundboardMeterCtx() {
  if (soundboardMeterCtx) return soundboardMeterCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  soundboardMeterCtx = new Ctx();
  if (soundboardMeterCtx.state === "suspended") {
    soundboardMeterCtx.resume().catch(() => {});
  }
  return soundboardMeterCtx;
}

function attachSoundboardMeter(audio) {
  if (!audio || soundboardMeterNodes.has(audio)) return;
  const ctx = getSoundboardMeterCtx();
  if (!ctx) return;
  try {
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const data = new Float32Array(analyser.fftSize);
    soundboardMeterNodes.set(audio, { source, analyser, data });
    audio.addEventListener(
      "ended",
      () => {
        const nodes = soundboardMeterNodes.get(audio);
        if (nodes) {
          try {
            nodes.source.disconnect();
            nodes.analyser.disconnect();
          } catch {
            // ignore
          }
        }
        soundboardMeterNodes.delete(audio);
      },
      { once: true }
    );
  } catch {
    // ignore
  }
}

function getSoundboardLocalLevel() {
  if (!soundboardMeterNodes.size) return null;
  let peakDb = -80;
  soundboardMeterNodes.forEach((nodes) => {
    const { analyser, data } = nodes;
    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const db = rms <= 0 ? -80 : 20 * Math.log10(rms);
    if (db > peakDb) peakDb = db;
  });
  const clampedDb = Math.max(-80, Math.min(0, peakDb));
  const level = Math.max(0, Math.min(1, (clampedDb + 80) / 80));
  const masterValue = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume()) / 100;
  const masterVolume = state.mutedSinks?.soundboard ? 0 : masterValue;
  return { level: level * masterVolume, db: Math.round(clampedDb) };
}

function updateMeterVisibility() {
  // meters removed
}


function getSinkForSource(source) {
  switch (source) {
    case "mic":
      return state.micSinkId || state.outputDeviceId || "default";
    case "game":
      return state.gameSinkId || state.outputDeviceId || "default";
    case "chat":
      return state.chatSinkId || state.outputDeviceId || "default";
    case "browser":
      return state.browserSinkId || state.outputDeviceId || "default";
    case "soundboard":
      return state.soundboardSinkId || state.outputDeviceId || "default";
    default:
      return state.outputDeviceId || "default";
  }
}

function startMeterLoop() {
  const meters = new Map();
  const meterEls = Array.from(document.querySelectorAll(".peak-meter[data-meter]"));
  meterEls.forEach((meter) => {
    const key = meter.dataset.meter || "";
    const fill = meter.querySelector(".peak-meter-fill");
    if (!key || !fill) return;
    let peak = meter.querySelector(".peak-meter-peak");
    if (!peak) {
      peak = document.createElement("div");
      peak.className = "peak-meter-peak";
      meter.appendChild(peak);
    }
    fill.style.transition = "none";
    const list = meters.get(key) || [];
    list.push({ meter, fill, peak });
    meters.set(key, list);
  });
  if (!meters.size) return;
  const targets = new Map();
  const targetDbByKey = new Map();
  const displays = new Map();
  const peakDbByKey = new Map();
  const peakAtByKey = new Map();
  const lastDbByKey = new Map();
  const volumeScaleByKey = new Map();
  let lastFrame = performance.now();

  const updatePeak = (currentDb, now, peakDb, peakAt) => {
    let db = currentDb;
    if (!Number.isFinite(db)) db = -60;
    if (db > peakDb) {
      peakDb = db;
      peakAt = now;
    }
    return { peakDb, peakAt };
  };

  const clampDb = (db) => {
    if (!Number.isFinite(db)) return -60;
    return Math.max(-60, Math.min(0, db));
  };

  const dbToLevel = (db) => {
    const clamped = clampDb(db);
    return (clamped + 60) / 60;
  };

  const animate = () => {
    const now = performance.now();
    const dt = Math.max(0.001, Math.min(0.05, (now - lastFrame) / 1000));
    lastFrame = now;
    meters.forEach((entries, key) => {
      if (!entries.length) return;
      const target = targets.get(key) ?? 0;
      const current = displays.get(key) ?? 0;
      const volumeScale = volumeScaleByKey.get(key) ?? 1;
      const rise = target > current;
      const jump = target - current;
      const snap = rise && jump > 0.12;
      const attackTime = 0.012;
      const stopSnap = target <= 0.002;
      const releaseTime = 0.08;
      const riseCoef = 1 - Math.exp(-dt / attackTime);
      const fallCoef = 1 - Math.exp(-dt / releaseTime);
      const next = snap
        ? target
        : rise
        ? current + (target - current) * riseCoef
        : stopSnap
        ? target
        : current + (target - current) * fallCoef;
      const display = Math.max(0, Math.min(1, next)) * volumeScale;
      displays.set(key, display);
      entries.forEach((entry) => {
        entry.fill.style.width = `${Math.round(display * 100)}%`;
      });
      const prevPeakDb = peakDbByKey.get(key) ?? -60;
      const prevPeakAt = peakAtByKey.get(key) ?? 0;
      const currentDb = targetDbByKey.get(key) ?? -60;
      const peakRes = updatePeak(currentDb, now, prevPeakDb, prevPeakAt);
      peakDbByKey.set(key, peakRes.peakDb);
      peakAtByKey.set(key, peakRes.peakAt);
      const peakLevel = Math.max(0, Math.min(1, dbToLevel(peakRes.peakDb))) * volumeScale;
      entries.forEach((entry) => {
        if (entry.peak) entry.peak.style.left = `${Math.round(peakLevel * 100)}%`;
      });
    });
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
  const source = new EventSource("/api/levels");
  source.onmessage = (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const updateDbLabel = (key, dbValue, peakValue) => {
      const percent = clampPercent(state.sinkVolumes?.[key] ?? 100);
      setSinkLabel(key, percent, dbValue, peakValue);
      if (key === "soundboard" && soundboardMasterValue) {
        const current = Math.round(dbValue);
        const peak = Math.round(peakValue);
        soundboardMasterValue.textContent = `${percent}% (${current} dB | ${peak} dB)`;
      }
    };
    const localSoundboard = getSoundboardLocalLevel();
    if (localSoundboard) {
      payload = { ...payload, soundboard: { ...localSoundboard } };
    }
    if (state.streamLinks && Object.values(state.streamLinks).some(Boolean)) {
      const linked = Object.entries(state.streamLinks)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([key]) => key)
        .filter((key) => key !== "stream");
      if (linked.length) {
        let maxLevel = 0;
        linked.forEach((key) => {
          const level = Math.max(0, Math.min(1, Number(payload?.[key]?.level || 0)));
          if (level > maxLevel) maxLevel = level;
        });
        const db = maxLevel <= 0 ? -60 : 20 * Math.log10(maxLevel);
        payload = { ...payload, stream: { level: maxLevel, db: Math.round(db) } };
      }
    }
    Object.entries(payload).forEach(([key, value]) => {
      const entries = meters.get(key) || [];
      if (!entries.length) return;
      const rawLevel = Math.max(0, Math.min(1, Number(value?.level || 0)));
      const rawDb =
        Number.isFinite(value?.db) ? Number(value.db) : Math.round(rawLevel * 80 - 80);
      let clampedDb = clampDb(rawDb);
      const prevDb = lastDbByKey.get(key);
      const wasSilent = Number.isFinite(prevDb) ? prevDb <= -59.5 : false;
      const nowActive = clampedDb > -59.5;
      const volumeScale = clampPercent(state.sinkVolumes?.[key] ?? 100) / 100;
      volumeScaleByKey.set(key, volumeScale);
      if (key === "mic") {
        if (Boolean(state.mutedSinks?.mic)) {
          clampedDb = -60;
          targets.set(key, 0);
          targetDbByKey.set(key, clampedDb);
          peakDbByKey.set(key, clampedDb);
          peakAtByKey.set(key, 0);
          updateDbLabel(key, clampedDb, clampedDb);
          lastDbByKey.set(key, clampedDb);
          return;
        }
        if (state.audioSettings?.gateEnabled) {
          const gateDb = -60 + (Number(state.audioSettings.gateThreshold ?? 45) / 100) * 60;
          if (clampedDb < gateDb) {
            clampedDb = -60;
            targets.set(key, 0);
            targetDbByKey.set(key, clampedDb);
            peakDbByKey.set(key, clampedDb);
            peakAtByKey.set(key, 0);
            updateDbLabel(key, clampedDb, clampedDb);
            lastDbByKey.set(key, clampedDb);
            return;
          }
        }
        targets.set(key, dbToLevel(clampedDb));
        targetDbByKey.set(key, clampedDb);
        let peakValue = peakDbByKey.get(key) ?? clampedDb;
        if (wasSilent && nowActive) {
          peakValue = clampedDb;
          peakDbByKey.set(key, clampedDb);
          peakAtByKey.set(key, performance.now());
        }
        updateDbLabel(key, clampedDb, peakValue);
        lastDbByKey.set(key, clampedDb);
        return;
      }
      if (key === "soundboard" && Boolean(state.mutedSinks?.soundboard)) {
        clampedDb = -60;
        targets.set(key, 0);
        targetDbByKey.set(key, clampedDb);
        peakDbByKey.set(key, clampedDb);
        peakAtByKey.set(key, 0);
        updateDbLabel(key, clampedDb, clampedDb);
        lastDbByKey.set(key, clampedDb);
        return;
      }
      targets.set(key, dbToLevel(clampedDb));
      targetDbByKey.set(key, clampedDb);
      let peakValue = peakDbByKey.get(key) ?? clampedDb;
      if (wasSilent && nowActive) {
        peakValue = clampedDb;
        peakDbByKey.set(key, clampedDb);
        peakAtByKey.set(key, performance.now());
      }
      updateDbLabel(key, clampedDb, peakValue);
      lastDbByKey.set(key, clampedDb);
    });
  };
  source.onerror = () => {
    // Let EventSource retry automatically.
  };
}

function applySinkVolumesFromState() {
  const ranges = Array.from(document.querySelectorAll(".rocker-range"));
  ranges.forEach((range) => {
    const channel = range.dataset.channel || "";
    if (!channel) return;
    const value = Number(state.sinkVolumes?.[channel]);
    if (!Number.isFinite(value)) return;
    range.value = String(value);
    setSinkLabel(channel, value);
    if (channel === "soundboard") {
      const muted = Boolean(state.mutedSinks?.soundboard);
      setActiveSoundboardVolume(muted ? 0 : value);
    }
  });
  if (soundboardMasterValue) {
    const percent = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume());
    if (isElectron) {
      soundboardMasterValue.textContent = `${percent}%`;
    } else {
      const db = percentToDb(percent);
      soundboardMasterValue.textContent = `${percent}% (${db} dB)`;
    }
  }
}

function initVolumeRockers() {
  const ranges = Array.from(document.querySelectorAll(".rocker-range"));
  const map = new Map();
  let volumeInitDirty = false;
  ranges.forEach((range) => {
    const channel = range.dataset.channel || "";
    if (!map.has(channel)) map.set(channel, []);
    map.get(channel).push(range);
    const initial = Number(range.value || 0);
    if (!Number.isFinite(state.sinkVolumes?.[channel])) {
      state.sinkVolumes[channel] = initial;
      volumeInitDirty = true;
    }
  });
  const sinkMap = {
    browser: "browser",
    game: "game",
    chat: "chat",
    mic: "mic",
    soundboard: "soundboard",
    stream: "stream",
  };
  const computeVolume = (channel, baseValue) => {
    const value = Number(baseValue);
    if (Number.isNaN(value)) return 0;
    if (channel === "chat") {
      const boost = Number(state.chatAudioSettings.chatFxGain || 100) / 100;
      return Math.min(150, Math.max(0, Math.round(value * boost)));
    }
    if (channel === "mic") {
      const boost = Number(state.audioSettings.micFxGain || 100) / 100;
      return Math.min(150, Math.max(0, Math.round(value * boost)));
    }
    return Math.min(150, Math.max(0, Math.round(value)));
  };
  const volumeFrames = new Map();
  const pushSinkVolume = (sink, value) => {
    if (!serverAvailable) return;
    if (volumeFrames.get(sink)) return;
    volumeFrames.set(
      sink,
      requestAnimationFrame(async () => {
        volumeFrames.delete(sink);
        try {
          await fetch("/api/sink-volume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sink, volume: computeVolume(sink, value) }),
          });
        } catch {
          // ignore
        }
      })
    );
  };

  const setVolume = (channel, value) => {
    const list = map.get(channel) || [];
    list.forEach((range) => {
      range.value = String(value);
    });
  };

  const updatePercent = (baseChannel, value) => {
    setSinkLabel(baseChannel, value);
  };

  const syncPair = (channel, value) => {
    setVolume(channel, value);
    updatePercent(channel, value);
    const sink = sinkMap[channel];
    if (sink) pushSinkVolume(sink, value);
    if (channel === "soundboard") {
      const next = state.mutedSinks?.soundboard ? 0 : value;
      setActiveSoundboardVolume(next);
    }
    const nextValue = Number(value);
    if (Number.isFinite(nextValue) && state.sinkVolumes?.[channel] !== nextValue) {
      state.sinkVolumes[channel] = nextValue;
      saveState({ touchUpdatedAt: false, touchVolume: true });
    }
  };

  ranges.forEach((range) => {
    const channel = range.dataset.channel || "";
    if (!channel) return;
    const initial = Number(state.sinkVolumes?.[channel]);
    if (Number.isFinite(initial)) {
      syncPair(channel, initial);
    } else {
      const fallback = Number(range.value || 0);
      syncPair(channel, fallback);
    }

    range.addEventListener("input", () => {
      syncPair(channel, range.value);
    });

    let lastTap = 0;
    const handleDoubleTap = () => {
      const now = Date.now();
      if (now - lastTap < 320) {
        syncPair(channel, 100);
        lastTap = 0;
        return;
      }
      lastTap = now;
    };

    range.addEventListener("dblclick", (event) => {
      event.preventDefault();
      syncPair(channel, 100);
    });
    range.addEventListener("touchend", () => handleDoubleTap());
    range.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") handleDoubleTap();
    });
  });

  if (soundboardMaster) {
    soundboardMaster.addEventListener("input", () => {
      const value = clampPercent(soundboardMaster.value);
      syncPair("soundboard", value);
    });
  }

  if (volumeInitDirty) {
    saveState({ touchUpdatedAt: false, touchVolume: true });
  }
}

function initSinkControls() {
  const muteButtons = Array.from(document.querySelectorAll(".mute-btn"));
  muteButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sink = btn.dataset.sink;
      if (!sink) return;
      const muted = !Boolean(state.mutedSinks?.[sink]);
      state.mutedSinks[sink] = muted;
      renderSinkControls();
      saveState();
      if (sink === "soundboard") {
        const masterValue = clampPercent(state.sinkVolumes?.soundboard ?? getSoundboardVolume());
        setActiveSoundboardVolume(muted ? 0 : masterValue);
      }
      if (!serverAvailable) return;
      try {
        await fetch("/api/sink-mute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sink, muted }),
        });
      } catch {
        // ignore
      }
    });
  });

  const clipButtons = Array.from(document.querySelectorAll(".clip-btn"));
  clipButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sink = btn.dataset.sink;
      if (!sink) return;
      const enabled = !Boolean(state.streamLinks?.[sink]);
      state.streamLinks[sink] = enabled;
      renderSinkControls();
      saveState();
      if (!serverAvailable) return;
      try {
        await fetch("/api/stream-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sink, enabled }),
        });
      } catch {
        // ignore
      }
    });
  });

  const micButtons = Array.from(document.querySelectorAll(".miclink-btn"));
  micButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const enabled = !Boolean(state.soundboardMicLink);
      state.soundboardMicLink = enabled;
      renderSinkControls();
      saveState();
      if (!serverAvailable) return;
      try {
        await fetch("/api/soundboard-mic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
      } catch {
        // ignore
      }
    });
  });

  // Chat-to-mic removed.
}

addCategoryBtn.addEventListener("click", () => {
  openCategoryModal("add", "");
});

renameCategoryBtn.addEventListener("click", () => {
  const current = state.categories[state.activeCategory];
  openCategoryModal("rename", current?.name || "");
});

deleteCategoryBtn.addEventListener("click", () => {
  if (state.categories.length <= 1) return;
  const ok = confirm("Delete this category tab?");
  if (!ok) return;
  state.categories.splice(state.activeCategory, 1);
  state.activeCategory = Math.max(0, state.activeCategory - 1);
  saveState();
  render();
});

if (addSoundBtn) {
  addSoundBtn.addEventListener("click", () => {
    const idx = findFirstEmptySlot();
    if (idx === -1) {
      alert("All slots are full. Delete a sound or add a new category first.");
      return;
    }
    handleAddSound(idx);
  });
}

initServerSync().then(() => {
  if (shouldRequirePin()) showPinGate();
  render();
  initVolumeRockers();
  startMeterLoop();
  startAudioStatusPoll();
  initSinkControls();
  pushAudioSettingsToServer();
  refreshRouting();
  refreshSystemOutputs();
  refreshSystemInputs();
  refreshPin(false);
  refreshLanInfo();
  applyStreamLinksForMode(state.streamMode);
  if (state.streamOutputSink) {
    fetch("/api/stream-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sink: state.streamOutputSink }),
    }).catch(() => {});
  }
  setInterval(refreshRouting, ROUTING_POLL_MS);
});
