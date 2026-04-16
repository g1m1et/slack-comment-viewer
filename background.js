let pollingTimer = null;
let lastTs = null;
let userCache = {};
let polling = false;

async function loadLastTs() {
  const data = await chrome.storage.local.get({ _lastTs: null });
  lastTs = data._lastTs;
}

async function saveLastTs() {
  await chrome.storage.local.set({ _lastTs: lastTs });
}

async function fetchSlackMessages(token, channel) {
  const params = new URLSearchParams({
    channel,
    limit: "20",
  });

  if (lastTs) {
    params.set("oldest", (Number(lastTs) + 0.000001).toString());
  } else {
    // Initial fetch: only get messages from the last 30 seconds
    const now = (Date.now() / 1000).toString();
    params.set("oldest", (Number(now) - 30).toString());
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

  // messages are returned newest-first; update lastTs to the newest
  const newestTs = filtered[0].ts;
  if (!lastTs || Number(newestTs) > Number(lastTs)) {
    lastTs = newestTs;
    await saveLastTs();
  }

  // Resolve user names and send to content script (oldest first for display order)
  const enriched = [];
  for (const msg of filtered.reverse()) {
    const userName = await resolveUserName(settings.token, msg.user);
    enriched.push({ user: userName, text: msg.text, ts: msg.ts });
  }

  // Send to all tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "NEW_MESSAGES", messages: enriched }).catch(() => {
      // content script not loaded on this tab — ignore
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
  lastTs = null;
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
