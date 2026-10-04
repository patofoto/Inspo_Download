// Toolbar popup. On a Tumblr tag page it starts the collector (collector.js, injected into
// the tab, where it keeps running after this popup closes); anywhere else it opens the tag
// page for a typed name.
const TAG_PAGE = /^https:\/\/www\.tumblr\.com\/tagged\/([^/?#]+)/;

const $ = (id) => document.getElementById(id);

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  const { serverUrl, apiKey } = await chrome.storage.local.get(["serverUrl", "apiKey"]);
  if (!serverUrl || !apiKey) showError("Set the server URL and API key in Settings first.");

  const match = tab?.url?.match(TAG_PAGE);
  if (match) {
    $("tagName").textContent = decodeURIComponent(match[1]);
    $("onTag").hidden = false;
    $("collect").addEventListener("click", async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collector.js"] });
        window.close();
      } catch (err) {
        showError(`Couldn't start the collector: ${err.message}`);
      }
    });
    return;
  }

  $("offTag").hidden = false;
  $("name").focus();
  const open = () => {
    const name = $("name").value.trim();
    if (!name) return;
    // The exact tag as typed; Tumblr tags aren't case-sensitive, and spaces are part of them
    chrome.tabs.update(tab.id, { url: `https://www.tumblr.com/tagged/${encodeURIComponent(name)}?sort=recent` });
    window.close();
  };
  $("open").addEventListener("click", open);
  $("name").addEventListener("keydown", (e) => e.key === "Enter" && open());
});
