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

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
