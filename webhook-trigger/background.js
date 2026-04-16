chrome.action.onClicked.addListener(() => {
  chrome.storage.local.get(["webhookUrl"], async ({ webhookUrl }) => {
    if (!webhookUrl) {
      showBadge("!", "#f44336");
      chrome.runtime.openOptionsPage();
      return;
    }

    showBadge("...", "#1a73e8");

    try {
      const response = await fetch(webhookUrl, { method: "GET" });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      showBadge("✓", "#4caf50");
      setTimeout(() => showBadge("", "#4caf50"), 3000);
    } catch (error) {
      console.error("Webhook error:", error);
      showBadge("✗", "#f44336");
      setTimeout(() => showBadge("", "#f44336"), 3000);
    }
  });
});

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
