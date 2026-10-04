// --- CONFIG ---
const API_KEY = "YOUR_API_KEY_HERE"
const SERVER_URL = "https://inspo-dl.make3.co/upload"

// Get shared URL
let sharedUrl = null
if (args.urls && args.urls.length > 0) {
  sharedUrl = args.urls[0].absoluteString
} else if (args.plainTexts && args.plainTexts.length > 0) {
  sharedUrl = args.plainTexts[0]
}

if (!sharedUrl) {
  let alert = new Alert()
  alert.title = "No URL Found"
  alert.message = "Share a URL or image from your browser to use this script."
  alert.addCancelAction("OK")
  await alert.presentAlert()
  Script.complete()
  return
}

// Send Tumblr post URLs as-is - the server extracts the image
// (with the logged-in cookie, skipping avatars)
let imageUrl = sharedUrl
let sourceUrl = sharedUrl

// Confirm before sending
let confirm = new Alert()
confirm.title = "Send to Inspo?"
confirm.message = imageUrl.length > 80 ? imageUrl.slice(0, 80) + "..." : imageUrl
confirm.addAction("Send")
confirm.addCancelAction("Cancel")
let idx = await confirm.presentAlert()
if (idx === -1) { Script.complete(); return }

// POST to server
let request = new Request(SERVER_URL)
request.method = "POST"
request.headers = {
  "Content-Type": "application/json",
  "X-API-Key": API_KEY
}
request.body = JSON.stringify({ imageUrl, sourceUrl })

let resultAlert = new Alert()
try {
  let res = await request.loadJSON()
  if (res.success && res.count === 0 && res.alreadySaved) {
    resultAlert.title = "Already saved"
    resultAlert.message = res.message || "This image is already in the Inspiration Board."
  } else if (res.success) {
    resultAlert.title = "Saved!"
    resultAlert.message = res.filename || "Image downloaded."
  } else {
    resultAlert.title = "Server Error"
    resultAlert.message = res.error || "Unknown error"
  }
} catch(e) {
  resultAlert.title = "Request Failed"
  resultAlert.message = String(e)
}
resultAlert.addCancelAction("OK")
await resultAlert.presentAlert()
Script.complete()
