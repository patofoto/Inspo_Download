const serverUrlInput = document.getElementById("serverUrl");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

// Load saved settings
chrome.storage.local.get(["serverUrl", "apiKey"], (data) => {
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;
});

// Save settings
saveBtn.addEventListener("click", () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/$/, ""); // strip trailing slash
  const apiKey = apiKeyInput.value.trim();

  if (!serverUrl || !apiKey) {
    status.style.color = "red";
    status.textContent = "Both fields are required.";
    return;
  }

  chrome.storage.local.set({ serverUrl, apiKey }, () => {
    status.style.color = "green";
    status.textContent = "Settings saved!";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
