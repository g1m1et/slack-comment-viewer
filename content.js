const FLOW_LANES = 8;
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

function renderFlowMessage(msg) {
  const item = document.createElement("div");
  item.className = "sco-flow-item";
  item.style.fontSize = (currentSettings.fontSize + 4) + "px";
  item.style.opacity = currentSettings.opacity;
  item.textContent = msg.user + ": " + msg.text;

  // Pick the lane that became available earliest
  const now = Date.now();
  let bestLane = 0;
  for (let i = 1; i < FLOW_LANES; i++) {
    if (laneNextAvailable[i] < laneNextAvailable[bestLane]) {
      bestLane = i;
    }
  }

  const speed = currentSettings.flowSpeed;
  const laneHeight = window.innerHeight / FLOW_LANES;
  item.style.top = (bestLane * laneHeight + 10) + "px";
  item.style.animationDuration = speed + "s";

  document.body.appendChild(item);

  // Mark lane as occupied for a portion of the duration (so next message doesn't overlap)
  laneNextAvailable[bestLane] = now + (speed * 0.3 * 1000);

  // Remove element after animation completes
  item.addEventListener("animationend", () => item.remove());
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
    if (currentSettings.enabled) {
      createOverlay();
    }
  }
);

chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in currentSettings) {
      currentSettings[key] = newValue;
    }
  }
  if (currentSettings.enabled) createOverlay();
  applySettings();
});
