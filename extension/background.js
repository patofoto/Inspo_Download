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

// force: save even if the server says it's already saved (the note's "Save again")
async function downloadImage(imageUrl, pageUrl, serverUrl, apiKey, tabId, force = false) {
  showBadge("...", "#1a73e8");

  try {
    const response = await fetch(`${serverUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, sourceUrl: pageUrl, apiKey, ...(force ? { force: true } : {}) })
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
      const filename = data.alreadySavedFiles?.[0];
      showPageNote(tabId, filename
        ? {
            text: "Already in the Inspiration Board",
            detail: filename,
            copyText: searchName(filename),
            again: { imageUrl, pageUrl }
          }
        : {
            text: "Downloaded before, but no longer in the Inspiration Board",
            again: { imageUrl, pageUrl }
          });
    } else {
      showBadge("✓", "#4caf50");
      if (force) showPageNote(tabId, { text: "Saved again", detail: data.filename });
    }
    setTimeout(() => showBadge("", "#4caf50"), 3000);

  } catch (error) {
    console.error("Error downloading image:", error);
    // Show red X for 3 seconds
    showBadge("✗", "#f44336");
    setTimeout(() => showBadge("", "#f44336"), 3000);
  }
}

// The part of a saved file's name that all its copies share (the server adds
// _<date>T<time> and an extension), so an Immich file-name search finds every copy.
function searchName(filename) {
  return filename.replace(/\.[^.]+$/, "").replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(_\d{2})?$/, "");
}

// A note in the top-right corner of the page, near where the pointer usually is after the
// right-click menu. Pages the extension can't script (chrome://, the Web Store) just keep
// the badge.
function showPageNote(tabId, options) {
  if (tabId == null || tabId < 0) return;
  chrome.scripting.executeScript({ target: { tabId }, func: pageNote, args: [options] }).catch(() => {});
}

// Runs inside the page (shadow DOM, so the page's styles don't apply). With buttons it
// stays longer and doesn't fade while the pointer is on it. Esc closes it.
function pageNote({ text, detail, copyText, again }) {
  // Replace a note still showing, including its Esc listener (injected scripts share one
  // isolated world per page, so the previous note's close function is still reachable)
  window.__inspoCloseNote?.(true);
  document.getElementById("inspo-note")?.remove();
  const host = document.createElement("div");
  host.id = "inspo-note";
  host.style.cssText = "position:fixed;right:24px;top:24px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .note { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; background: #424242;
            padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.35); max-width: 340px;
            transition: opacity .25s; animation: fade-in .25s ease-out; }
    @keyframes fade-in { from { opacity: 0; } }
    .head { display: flex; gap: 10px; align-items: flex-start; }
    .text { flex: 1; }
    .x { border: 0; background: none; color: #bbb; font-size: 16px; line-height: 1; cursor: pointer; padding: 0; }
    .detail { color: #ccc; font-size: 12px; margin-top: 2px; word-break: break-all; }
    .buttons { display: flex; gap: 8px; margin-top: 8px; }
    .buttons button { border: 0; border-radius: 5px; padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer;
                      background: #616161; color: #fff; }
    .buttons button:hover { background: #757575; }
  </style>
  <div class="note"><div class="head"><div class="text"></div><button class="x" title="Close">×</button></div></div>`;
  const note = root.querySelector(".note");
  root.querySelector(".text").textContent = text;
  if (detail) {
    const d = document.createElement("div");
    d.className = "detail";
    d.textContent = detail;
    note.appendChild(d);
  }

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  if (copyText) {
    const copy = document.createElement("button");
    copy.textContent = "Copy name for Immich search";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(copyText);
      } catch {
        const area = document.createElement("textarea");
        area.value = copyText;
        root.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      copy.textContent = "Copied";
    });
    buttons.appendChild(copy);
  }
  if (again) {
    const save = document.createElement("button");
    save.textContent = "Save again";
    save.title = "Save a second copy anyway";
    save.addEventListener("click", () => {
      save.textContent = "Saving…";
      save.disabled = true;
      chrome.runtime.sendMessage({ type: "inspo-save-again", ...again });
    });
    buttons.appendChild(save);
  }
  if (buttons.children.length) note.appendChild(buttons);
  document.documentElement.appendChild(host);

  // While the note is up, Esc closes it and nothing else (the page doesn't also get it)
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    remove();
  };
  const remove = (immediately) => {
    window.removeEventListener("keydown", onKey, true);
    if (window.__inspoCloseNote === remove) delete window.__inspoCloseNote;
    if (immediately === true) return host.remove();
    note.style.opacity = "0";
    setTimeout(() => host.remove(), 300);
  };
  window.__inspoCloseNote = remove;
  window.addEventListener("keydown", onKey, true);
  root.querySelector(".x").addEventListener("click", remove);
  let timer = setTimeout(remove, buttons.children.length ? 12000 : 4000);
  note.addEventListener("mouseenter", () => clearTimeout(timer));
  note.addEventListener("mouseleave", () => (timer = setTimeout(remove, 4000)));
}

// Tag runs: the collector (collector.js, running in a Tumblr tab) hands its list to the
// server through here, so the server URL and API key stay in the extension's storage.
const BATCH_ROUTES = {
  "inspo-batch-create": (msg) => ["POST", "/batch", { tag: msg.tag, items: msg.items }],
  "inspo-batch-status": (msg) => ["GET", `/batch/${encodeURIComponent(msg.id)}`],
  "inspo-batch-download": (msg) => ["POST", `/batch/${encodeURIComponent(msg.id)}/download`],
  "inspo-batch-cancel": (msg) => ["POST", `/batch/${encodeURIComponent(msg.id)}/cancel`]
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // "Save again" on the already-saved note
  if (msg?.type === "inspo-save-again") {
    chrome.storage.local.get(["serverUrl", "apiKey"], (config) => {
      if (config.serverUrl && config.apiKey) {
        downloadImage(msg.imageUrl, msg.pageUrl, config.serverUrl, config.apiKey, sender.tab?.id, true);
      }
    });
    return false;
  }

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
