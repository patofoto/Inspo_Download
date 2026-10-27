// Toolbar popup. Starts the collector (collector.js, injected into the tab, where it keeps
// running after this popup closes) on a Tumblr tag page, a YouPic profile (its portfolio) or
// any other page (the photos on it). Also opens a Tumblr tag page for a typed name.
const TAG_PAGE = /^https:\/\/www\.tumblr\.com\/tagged\/([^/?#]+)/;
const YOUPIC_PAGE = /^https:\/\/(?:www\.)?youpic\.com\/([A-Za-z0-9_.-]+)\/?(?:[?#]|$)/;
const YOUPIC_NOT_PROFILES = new Set(["discover", "explore", "search", "login", "join", "signup", "settings", "messages",
  "notifications", "feed", "web", "about", "help", "privacy", "terms", "blog", "contests", "pricing"]);

const $ = (id) => document.getElementById(id);

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  const { serverUrl, apiKey } = await chrome.storage.local.get(["serverUrl", "apiKey"]);
  if (!serverUrl || !apiKey) showError("Set the server URL and API key in Settings first.");

  const startCollector = async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collector.js"] });
      window.close();
    } catch (err) {
      showError(`Couldn't start the collector: ${err.message}`);
    }
  };

  const match = tab?.url?.match(TAG_PAGE);
  if (match) {
    $("tagName").textContent = decodeURIComponent(match[1]);
    $("onTag").hidden = false;
    $("collect").addEventListener("click", startCollector);
    return;
  }

  const url = tab?.url || "";
  const youpic = url.match(YOUPIC_PAGE);
  if (youpic && !YOUPIC_NOT_PROFILES.has(youpic[1].toLowerCase())) {
    $("title").textContent = "Collect a YouPic portfolio";
    $("pageName").textContent = (tab.title || youpic[1]).split(" — ")[0];
    $("collectPage").textContent = "Collect this portfolio";
    $("pageHint").textContent = "Scrolls through the whole portfolio and takes every photo at the largest size YouPic serves, then shows what's new before anything is downloaded. Keep the tab in front while it scrolls.";
    $("onPage").hidden = false;
  } else if (/^https?:\/\//.test(url) && !/^https:\/\/([a-z0-9-]+\.)?tumblr\.com\//i.test(url)) {
    $("title").textContent = "Collect photos";
    $("pageName").textContent = tab.title || new URL(url).hostname;
    $("collectPage").textContent = "Collect the photos on this page";
    $("pageHint").textContent = "Scrolls to the end of the page and takes every photo at least 500 px, or the full-size image it links to, then shows what's new before anything is downloaded.";
    $("onPage").hidden = false;
  }
  $("collectPage").addEventListener("click", startCollector);

  $("offTag").hidden = false;
  if ($("onPage").hidden) $("name").focus();
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
