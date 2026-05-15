// レーン高さ = (flow item の実フォント px) * この係数。
// 1.0 で文字密着、1.4 前後が AA を密に並べつつ可読性を保つ実用解。
const FLOW_LANE_HEIGHT_RATIO = 1.4;
let FLOW_LANES = 8; // 設定読込前の暫定値。computeFlowLaneCount() で上書き
let laneNextAvailable = new Array(FLOW_LANES).fill(0);
const seenTs = new Set();
let overlayEl = null;
let tickerListEl = null;
let currentSettings = {
  enabled: false,
  mode: "ticker",
  position: "right",
  fontSize: 14,
  opacity: 0.8,
  maxItems: 5,
  flowSpeed: 8,
};

function createOverlay() {
  if (overlayEl) return;

  overlayEl = document.createElement("div");
  overlayEl.id = "sco-overlay";

  tickerListEl = document.createElement("div");
  tickerListEl.id = "sco-ticker-list";
  overlayEl.appendChild(tickerListEl);

  document.body.appendChild(overlayEl);
  applySettings();
}

function applySettings() {
  if (!overlayEl) return;

  overlayEl.style.fontSize = currentSettings.fontSize + "px";
  overlayEl.style.opacity = currentSettings.opacity;

  overlayEl.classList.toggle("sco-visible", currentSettings.enabled);
  overlayEl.classList.toggle("sco-ticker", currentSettings.mode === "ticker");

  // Position
  if (currentSettings.position === "left") {
    overlayEl.style.right = "auto";
    overlayEl.style.left = "20px";
  } else {
    overlayEl.style.left = "auto";
    overlayEl.style.right = "20px";
  }
}

function renderTickerMessage(msg) {
  if (!tickerListEl) return;

  const item = document.createElement("div");
  item.className = "sco-ticker-item";

  const userSpan = document.createElement("span");
  userSpan.className = "sco-ticker-user";
  userSpan.textContent = msg.user + ":";

  const textNode = document.createTextNode(" " + msg.text);

  item.appendChild(userSpan);
  item.appendChild(textNode);
  tickerListEl.appendChild(item);

  // Remove oldest items if exceeding max
  const max = Math.max(1, currentSettings.maxItems || 5);
  while (tickerListEl.children.length > max) {
    tickerListEl.firstElementChild.remove();
  }
}

function getFlowLaneHeightPx() {
  const fontPx = (currentSettings.fontSize ?? 14) + 4;
  return Math.max(20, Math.round(fontPx * FLOW_LANE_HEIGHT_RATIO));
}

function computeFlowLaneCount() {
  return Math.max(4, Math.floor(window.innerHeight / getFlowLaneHeightPx()));
}

function recomputeFlowLanes() {
  const next = computeFlowLaneCount();
  if (next === FLOW_LANES) return;
  FLOW_LANES = next;
  laneNextAvailable = new Array(FLOW_LANES).fill(0);
}

function colorFromUser(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 80%, 85%)`;
}

function renderFlowMessage(msg) {
  const lines = (msg.text ?? "").split("\n");
  if (lines.length <= 1) {
    renderFlowLine(msg.user, msg.user + ": " + (lines[0] ?? ""));
    return;
  }
  // Multiline: 投稿者名行を見出しとして先頭に置き、本文は AA を崩さないよう
  // 純粋な各行のみで流す（1行目にプレフィックスを乗せると行頭がずれるため）
  renderFlowLine(msg.user, msg.user + ":");
  for (const line of lines) {
    renderFlowLine(msg.user, line);
  }
}

function renderFlowLine(user, text) {
  const item = document.createElement("div");
  item.className = "sco-flow-item";
  item.style.fontSize = (currentSettings.fontSize + 4) + "px";
  item.style.opacity = currentSettings.opacity;
  item.style.color = colorFromUser(user);
  item.textContent = text;

  // Pick the lane that became available earliest
  const now = Date.now();
  let bestLane = 0;
  for (let i = 1; i < FLOW_LANES; i++) {
    if (laneNextAvailable[i] < laneNextAvailable[bestLane]) {
      bestLane = i;
    }
  }

  const speed = currentSettings.flowSpeed;
  const laneHeight = getFlowLaneHeightPx();
  item.style.top = (bestLane * laneHeight + 10) + "px";

  document.body.appendChild(item);

  // keyframes は 100vw → -100% を進むため、移動距離は (画面幅 + 要素幅)。
  // duration 固定だと文字長で速度がブレるので、画面幅を speed 秒で通過する
  // px/s を基準に要素ごとに duration を補正し、AA の同一メッセージ内で
  // 行ごとの進行速度が揃うようにする。
  const distance = window.innerWidth + item.offsetWidth;
  const pxPerSec = window.innerWidth / speed;
  const durationSec = distance / pxPerSec;
  item.style.animationDuration = durationSec + "s";

  // Mark lane as occupied for a portion of the duration (so next message doesn't overlap)
  laneNextAvailable[bestLane] = now + (durationSec * 0.3 * 1000);

  // Remove element after animation completes
  item.addEventListener("animationend", () => item.remove());
}

function clearAllDisplayElements() {
  // Ticker items: #sco-ticker-list の子要素すべて
  if (tickerListEl) {
    tickerListEl.replaceChildren();
  }

  // Flow items: document.body 直下の .sco-flow-item すべて
  for (const el of document.querySelectorAll(".sco-flow-item")) {
    el.remove();
  }

  // Flow レーン占有記録をリセット
  laneNextAvailable.fill(0);
}

function handleNewMessages(messages) {
  if (!currentSettings.enabled) return;
  createOverlay();

  for (const msg of messages) {
    if (seenTs.has(msg.ts)) continue;
    seenTs.add(msg.ts);

    if (currentSettings.mode === "ticker") {
      renderTickerMessage(msg);
    } else {
      renderFlowMessage(msg);
    }
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEW_MESSAGES") {
    handleNewMessages(message.messages);
  }
});

// Load settings and watch for changes
chrome.storage.local.get(
  currentSettings,
  (settings) => {
    currentSettings = { ...currentSettings, ...settings };
    recomputeFlowLanes();
    if (currentSettings.enabled) {
      createOverlay();
    }
  }
);

chrome.storage.onChanged.addListener((changes) => {
  const modeChanged = changes.mode
    && changes.mode.oldValue !== changes.mode.newValue;
  const disabledTransition = changes.enabled
    && changes.enabled.oldValue === true
    && changes.enabled.newValue === false;

  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in currentSettings) {
      currentSettings[key] = newValue;
    }
  }

  if (changes.fontSize) {
    recomputeFlowLanes();
  }

  if (modeChanged || disabledTransition) {
    clearAllDisplayElements();
  }

  if (currentSettings.enabled) createOverlay();
  applySettings();
});

window.addEventListener("resize", recomputeFlowLanes);
