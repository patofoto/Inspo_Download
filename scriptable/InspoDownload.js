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

let imageUrl = sharedUrl
let sourceUrl = sharedUrl

// If it's a Tumblr post URL, try to extract the first image
if (sharedUrl.includes("tumblr.com/post") || sharedUrl.includes("tumblr.com/image")) {
  try {
    let req = new Request(sharedUrl)
    req.headers = { "User-Agent": "Mozilla/5.0" }
    let html = await req.loadString()
    let match = html.match(/https:\/\/(?:64\.media|media)\.tumblr\.com\/[^"' >]+\.(?:jpg|jpeg|png|gif|webp)/i)
    if (match) imageUrl = match[0]
  } catch(e) {
    // fall through - use original URL
  }
}

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
  if (res.success) {
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
