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
      downloadImage(info.srcUrl, tab.url, config.serverUrl, config.apiKey, tab.id);
    });
  }
});

async function downloadImage(imageUrl, pageUrl, serverUrl, apiKey, tabId) {
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

    const data = await response.json();

    // Green checkmark for 3 seconds; a grey "=" and a note on the page when the image was
    // already saved before
    if (data.count === 0 && data.alreadySaved) {
      showBadge("=", "#757575");
      showPageNote(tabId, "Already in the Inspiration Board, not saved again");
    } else {
      showBadge("✓", "#4caf50");
    }
    setTimeout(() => showBadge("", "#4caf50"), 3000);

  } catch (error) {
    console.error("Error downloading image:", error);
    // Show red X for 3 seconds
    showBadge("✗", "#f44336");
    setTimeout(() => showBadge("", "#f44336"), 3000);
  }
}

// A short note in the bottom-right corner of the page, fading out after a few seconds.
// Pages the extension can't script (chrome://, the Web Store) just keep the badge.
function showPageNote(tabId, text) {
  if (tabId == null || tabId < 0) return;
  chrome.scripting.executeScript({ target: { tabId }, func: pageNote, args: [text] }).catch(() => {});
}

// Runs inside the page (shadow DOM, so the page's styles don't apply)
function pageNote(text) {
  document.getElementById("inspo-note")?.remove();
  const host = document.createElement("div");
  host.id = "inspo-note";
  host.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .note { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; background: #424242;
            padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.35); max-width: 320px;
            transition: opacity .25s; animation: fade-in .25s ease-out; }
    @keyframes fade-in { from { opacity: 0; } }
  </style><div class="note"></div>`;
  const note = root.querySelector(".note");
  note.textContent = text;
  document.documentElement.appendChild(host);
  setTimeout(() => {
    note.style.opacity = "0";
    setTimeout(() => host.remove(), 300);
  }, 4000);
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
