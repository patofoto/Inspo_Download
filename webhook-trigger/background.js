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

      showBadge("✓", "#4caf50", 3000);
    } catch (error) {
      console.error("Webhook error:", error);
      showBadge("✗", "#f44336", 3000);
    }
  });
});

let badgeTimer = null;
function showBadge(text, color, ms = 0) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (ms) badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), ms);
}
