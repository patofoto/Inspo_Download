const webhookUrlInput = document.getElementById("webhookUrl");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

chrome.storage.local.get(["webhookUrl"], ({ webhookUrl }) => {
  if (webhookUrl) webhookUrlInput.value = webhookUrl;
});

saveBtn.addEventListener("click", () => {
  const webhookUrl = webhookUrlInput.value.trim();

  if (!webhookUrl) {
    status.style.color = "red";
    status.textContent = "Webhook URL is required.";
    return;
  }

  chrome.storage.local.set({ webhookUrl }, () => {
    status.style.color = "green";
    status.textContent = "Saved!";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
