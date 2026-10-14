// Create context menu for images
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // One item: on Tumblr it saves the whole post the image belongs to (like the phone's
    // share), elsewhere just the image
    chrome.contextMenus.create({
      id: "download-image",
      title: "Download to Network Drive",
      contexts: ["image"]
    });
  });
});

const TUMBLR_PAGE = /^https:\/\/(?:[A-Za-z0-9-]+\.)?tumblr\.com\//;

// A Tumblr post link: www.tumblr.com/<blog>/<id>, www.tumblr.com/blog/view/<blog>/<id> or
// <blog>.tumblr.com/post/<id>
const POST_LINK = /^https:\/\/(?:www\.tumblr\.com\/(?:blog\/view\/)?[A-Za-z0-9-]+\/\d{6,}|[A-Za-z0-9-]+\.tumblr\.com\/post\/\d{6,})/;

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "download-image") return;
  chrome.storage.local.get(["serverUrl", "apiKey"], async (config) => {
    if (!config.serverUrl || !config.apiKey) {
      showBadge("!", "#f44336");
      return;
    }
    if (!TUMBLR_PAGE.test(tab.url || "")) {
      downloadImage(info.srcUrl, tab.url, config.serverUrl, config.apiKey);
      return;
    }
    // Tumblr: the post links around the clicked image (plus the page itself on a post's own
    // page). The server saves every photo of the first of them that really contains the image.
    let postUrls = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId] },
        func: findPostLinks,
        args: [info.srcUrl]
      });
      postUrls = result || [];
    } catch (err) {
      console.warn("Couldn't look for the post on the page:", err.message);
    }
    const page = (tab.url || "").split(/[?#]/)[0];
    if (POST_LINK.test(page) && !postUrls.includes(page)) postUrls.push(page);
    downloadImage(info.srcUrl, tab.url, config.serverUrl, config.apiKey, postUrls);
  });
});

// Runs in the Tumblr page: the post links in the post that holds the right-clicked image.
// tumblr-context.js recorded which element was right-clicked; failing that, the image is
// found by its address.
function findPostLinks(srcUrl) {
  const postLink = /^https:\/\/(?:www\.tumblr\.com\/(?:blog\/view\/)?[A-Za-z0-9-]+\/\d{6,}|[A-Za-z0-9-]+\.tumblr\.com\/post\/\d{6,})/;
  const key = (srcUrl.match(/media\.tumblr\.com\/([0-9a-f]{32})\//i) || [])[1];
  let el = window.__inspoContextTarget;
  if (!(el instanceof Element) || !el.isConnected) {
    el = [...document.images].find((img) => img.currentSrc === srcUrl || img.src === srcUrl ||
      (key && (img.currentSrc || img.src || "").includes(key))) || null;
  }
  if (!el) return [];
  const linksIn = (node) => [...node.querySelectorAll("a[href]")].map((a) => a.href.split(/[?#]/)[0]).filter((h) => postLink.test(h));
  // Posts are <article>s; otherwise the nearest enclosing element that has post links
  let links = [];
  const post = el.closest("article");
  if (post) links = linksIn(post);
  for (let node = el.parentElement, depth = 0; !links.length && node && depth < 15; node = node.parentElement, depth++) {
    links = linksIn(node);
  }
  return [...new Set(links)].slice(0, 10);
}

async function downloadImage(imageUrl, pageUrl, serverUrl, apiKey, postUrls) {
  showBadge("...", "#1a73e8");

  try {
    const response = await fetch(`${serverUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, sourceUrl: pageUrl, apiKey, ...(postUrls ? { postUrls } : {}) })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || response.statusText);
    }

    const data = await response.json();

    // For 3 seconds: a green checkmark for one image, the number saved for a post with several,
    // in orange when the Tumblr post couldn't be found and only the clicked image was saved
    if (postUrls && data.post === null) {
      showBadge(String(data.count || 1), "#fb8c00");
    } else if (data.count > 1) {
      showBadge(String(data.count), "#4caf50");
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
