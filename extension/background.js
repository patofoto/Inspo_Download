// Create context menu for images
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "download-image",
    title: "Download to Network Drive",
    contexts: ["image"]
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "download-image") {
    chrome.storage.local.get(["serverUrl", "apiKey"], (config) => {
      if (!config.serverUrl || !config.apiKey) {
        showBadge("!", "#f44336");
        return;
      }
      downloadImage(info.srcUrl, tab.url, config.serverUrl, config.apiKey);
    });
  }
});

async function downloadImage(imageUrl, pageUrl, serverUrl, apiKey) {
  showBadge("...", "#1a73e8");

  try {
    const response = await fetch(`${serverUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, sourceUrl: pageUrl, apiKey })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || response.statusText);
    }

    await response.json();

    // Show green checkmark for 3 seconds
    showBadge("✓", "#4caf50");
    setTimeout(() => showBadge("", "#4caf50"), 3000);

  } catch (error) {
    console.error("Error downloading image:", error);
    // Show red X for 3 seconds
    showBadge("✗", "#f44336");
    setTimeout(() => showBadge("", "#f44336"), 3000);
  }
}

// Tag runs: the collector (collector.js, running in a Tumblr tab) hands its list to the
// server through here, so the server URL and API key stay in the extension's storage.
const BATCH_ROUTES = {
  "inspo-batch-create": (msg) => ["POST", "/batch", { tag: msg.tag, items: msg.items }],
  "inspo-batch-status": (msg) => ["GET", `/batch/${encodeURIComponent(msg.id)}`],
  "inspo-batch-download": (msg) => ["POST", `/batch/${encodeURIComponent(msg.id)}/download`],
  "inspo-batch-cancel": (msg) => ["POST", `/batch/${encodeURIComponent(msg.id)}/cancel`]
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const route = BATCH_ROUTES[msg?.type];
  if (!route) return false;
  batchRequest(...route(msg)).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true; // reply comes asynchronously
});

async function batchRequest(method, path, body) {
  const { serverUrl, apiKey } = await chrome.storage.local.get(["serverUrl", "apiKey"]);
  if (!serverUrl || !apiKey) throw new Error("Set the server URL and API key in the extension's options first.");
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { "X-API-Key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered HTTP ${response.status}.`);
  return data;
}

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
