const DEFAULTS = {
  token: "",
  channel: "",
  enabled: false,
  mode: "ticker",
  position: "right",
  fontSize: 14,
  opacity: 0.8,
  maxItems: 5,
  flowSpeed: 8,
};

const FIELDS = Object.keys(DEFAULTS);

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el.type === "checkbox") {
      el.checked = settings[id];
    } else {
      el.value = settings[id];
    }
  }
  updateStatus(settings.enabled);
}

function updateStatus(enabled) {
  const el = document.getElementById("status");
  el.textContent = enabled ? "ON — ポーリング中" : "OFF";
  el.className = "status " + (enabled ? "on" : "off");
}

function saveSettings() {
  const settings = {};
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el.type === "checkbox") {
      settings[id] = el.checked;
    } else if (el.type === "number") {
      settings[id] = Number(el.value);
    } else {
      settings[id] = el.value.trim();
    }
  }
  chrome.storage.local.set(settings);
  updateStatus(settings.enabled);
}

document.addEventListener("DOMContentLoaded", loadSettings);

for (const id of FIELDS) {
  const el = document.getElementById(id);
  el.addEventListener("change", saveSettings);
  if (el.type === "text") {
    el.addEventListener("input", saveSettings);
  }
}
