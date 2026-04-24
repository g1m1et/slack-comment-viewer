let pollingTimer = null;
// Slack ts は "SEC.USEC"（6桁マイクロ秒）形式。内部は整数マイクロ秒で扱い、
// 境界（Slack API / storage）だけ文字列に変換する。1.8e15 は Number.MAX_SAFE_INTEGER (2^53) の約 1/5。
let lastTsMicro = null;
let userCache = {};
let polling = false;

function tsToMicro(ts) {
  const [sec, usec = ""] = String(ts).split(".");
  return Number(sec) * 1_000_000 + Number((usec + "000000").slice(0, 6));
}

function microToTs(micro) {
  const sec = Math.floor(micro / 1_000_000);
  const usec = micro % 1_000_000;
  return `${sec}.${String(usec).padStart(6, "0")}`;
}

async function loadLastTs() {
  const data = await chrome.storage.local.get({ _lastTs: null });
  lastTsMicro = data._lastTs === null ? null : tsToMicro(data._lastTs);
}

async function saveLastTs() {
  await chrome.storage.local.set({ _lastTs: lastTsMicro === null ? null : microToTs(lastTsMicro) });
}

async function fetchSlackMessages(token, channel) {
  const params = new URLSearchParams({
    channel,
    limit: "20",
  });

  if (lastTsMicro !== null) {
    params.set("oldest", microToTs(lastTsMicro + 1));
  } else {
    // Initial fetch: only get messages from the last 30 seconds
    const nowSec = Math.floor(Date.now() / 1000);
    params.set("oldest", String(nowSec - 30));
  }

  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();

  if (!data.ok) {
    console.error("Slack API error:", data.error);
    return [];
  }

  return data.messages || [];
}

function filterMessages(messages) {
  return messages.filter((msg) => {
    if (msg.subtype) return false;
    if (msg.bot_id) return false;
    if (msg.thread_ts && msg.thread_ts !== msg.ts) return false;
    return true;
  });
}

async function resolveUserName(token, userId) {
  if (userCache[userId]) return userCache[userId];

  const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();

  if (data.ok && data.user) {
    const name =
      data.user.profile.display_name ||
      data.user.profile.real_name ||
      data.user.name;
    userCache[userId] = name;
    return name;
  }
  return userId;
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await pollOnceInner();
  } finally {
    polling = false;
  }
}

async function pollOnceInner() {
  const settings = await chrome.storage.local.get({
    token: "",
    channel: "",
    enabled: false,
  });

  if (!settings.enabled || !settings.token || !settings.channel) return;

  const messages = await fetchSlackMessages(settings.token, settings.channel);
  const filtered = filterMessages(messages);

  if (filtered.length === 0) return;

  // messages are returned newest-first; update lastTsMicro to the newest
  const newestMicro = tsToMicro(filtered[0].ts);
  if (lastTsMicro === null || newestMicro > lastTsMicro) {
    lastTsMicro = newestMicro;
    await saveLastTs();
  }

  // Resolve user names and send to content script (oldest first for display order)
  const enriched = [];
  for (const msg of filtered.reverse()) {
    const userName = await resolveUserName(settings.token, msg.user);
    enriched.push({ user: userName, text: msg.text, ts: msg.ts });
  }

  // Fire-and-forget to all tabs; content.js may or may not be present
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "NEW_MESSAGES", messages: enriched }).catch((e) => {
      // Silence the expected "no receiver" error for tabs without content.js (chrome://, devtools://, etc.)
      if (e.message && e.message.includes("Could not establish connection")) return;
      console.warn("Slack Comment Overlay: sendMessage failed for tab", tab.id, e.message);
    });
  }
}

function startPolling() {
  stopPolling();
  loadLastTs().then(() => {
    pollOnce();
    pollingTimer = setInterval(pollOnce, 3000);
    console.log("Slack Comment Overlay: polling started");
  });
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  lastTsMicro = null;
  userCache = {};
  chrome.storage.local.remove("_lastTs");
  console.log("Slack Comment Overlay: polling stopped");
}

// React to settings changes
chrome.storage.onChanged.addListener((changes) => {
  // Ignore our own _lastTs changes
  if (changes._lastTs && Object.keys(changes).length === 1) return;

  if (changes.enabled) {
    if (changes.enabled.newValue) {
      startPolling();
    } else {
      stopPolling();
    }
  }
  // If token or channel changed while enabled, restart polling
  if (changes.token || changes.channel) {
    chrome.storage.local.get({ enabled: false }, (settings) => {
      if (settings.enabled) {
        startPolling();
      }
    });
  }
});

// On startup, check if already enabled
chrome.storage.local.get({ enabled: false }, (settings) => {
  if (settings.enabled) {
    startPolling();
  }
});
