const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const sharp = require("sharp");

const app = express();
const port = process.env.PORT || 3000;

// Configuration - adjust these for your setup
const API_KEY = process.env.API_KEY;
const NETWORK_DRIVE_PATH = process.env.NETWORK_DRIVE_PATH || "/mnt/network-drive/images";
const TUMBLR_COOKIE = process.env.TUMBLR_COOKIE || "";
const FETCH_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

// Create directory if it doesn't exist
if (!fs.existsSync(NETWORK_DRIVE_PATH)) {
  fs.mkdirSync(NETWORK_DRIVE_PATH, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());

// Middleware to check API key
function checkApiKey(req, res, next) {
  const apiKey = req.body.apiKey || req.headers["x-api-key"];

  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  next();
}

// Error carrying the HTTP status to send back to the client
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isTumblrHost(hostname) {
  return hostname === "tumblr.com" || hostname.endsWith(".tumblr.com");
}

// A Tumblr page, as opposed to a direct link to Tumblr's image CDN
function isTumblrPostUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const isMediaHost = hostname === "media.tumblr.com" ||
    hostname.endsWith(".media.tumblr.com") ||
    hostname === "images.tumblr.com";
  return isTumblrHost(hostname) && !isMediaHost;
}

// Follow redirects by hand: fetch drops the Cookie header on cross-origin
// redirects (e.g. blog.tumblr.com -> www.tumblr.com), and this way the
// cookie is only ever sent to Tumblr hosts
async function fetchTumblrPage(url) {
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const sendCookie = TUMBLR_COOKIE && isTumblrHost(new URL(currentUrl).hostname);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(sendCookie ? { "Cookie": TUMBLR_COOKIE } : {})
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, finalUrl: currentUrl };
    }

    await response.body?.cancel();
    currentUrl = new URL(location, currentUrl).href;
    console.log(`[EXTRACT] Redirected to: ${currentUrl}`);
  }

  throw new Error("Too many redirects fetching Tumblr post");
}

// Extract image URL from Tumblr post HTML. Non-Tumblr URLs and direct
// Tumblr image links are returned as-is; a Tumblr post we can't get an
// image from throws, so the post page is never saved as an "image"
async function extractTumblrImage(url) {
  if (!isTumblrPostUrl(url)) {
    return url;
  }

  console.log(`[EXTRACT] Starting extraction for: ${url.substring(0, 60)}...`);

  // Fetch the Tumblr post HTML
  console.log(`[EXTRACT] Fetching HTML...`);
  const { response, finalUrl } = await fetchTumblrPage(url);

  if (finalUrl.includes("/login_required/")) {
    console.log(`[EXTRACT] Redirected to login wall`);
    throw httpError(422, TUMBLR_COOKIE
      ? "Tumblr requires login for this post - TUMBLR_COOKIE may have expired"
      : "Tumblr requires login for this post - set TUMBLR_COOKIE on the server");
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch Tumblr post: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  console.log(`[EXTRACT] Got HTML, length: ${html.length}`);

  // Find the post content area (article tag or post content div)
  let postContent = "";

  // Try to find article with post content
  const articleMatch = html.match(/<article[^>]*>[\s\S]*?<\/article>/i);
  console.log(`[EXTRACT] Article match: ${articleMatch ? 'found' : 'not found'}`);

  if (articleMatch) {
    postContent = articleMatch[0];
    console.log(`[EXTRACT] Article length before cleanup: ${postContent.length}`);
    // Remove header (profile/avatar) and footer (interactions) sections
    postContent = postContent.replace(/<header[^>]*>[\s\S]*?<\/header>/i, "");
    postContent = postContent.replace(/<footer[^>]*>[\s\S]*?<\/footer>/i, "");
    console.log(`[EXTRACT] Article length after cleanup: ${postContent.length}`);
  }

  // If no article found, try to find specific post content divs
  if (!postContent) {
    console.log(`[EXTRACT] No article, trying content divs...`);
    const contentMatch = html.match(/<div[^>]*class="[^"]*(?:VDRZ4|post-content|content)[^"]*"[^>]*>[\s\S]*?<\/div>/i);
    if (contentMatch) {
      postContent = contentMatch[0];
      console.log(`[EXTRACT] Content div found, length: ${postContent.length}`);
    }
  }

  // Fallback to entire HTML if specific area not found
  if (!postContent) {
    console.log(`[EXTRACT] Using entire HTML as fallback`);
    postContent = html;
  }

  // Extract image URLs only from post content
  const imageRegex = /https:\/\/(?:64\.media|media|images)\.tumblr\.com\/[^"'<>\s]+\.(?:jpg|jpeg|png|gif|webp|jpe|pnj)/gi;
  const matches = [...postContent.matchAll(imageRegex)].map(m => m[0]);
  console.log(`[EXTRACT] Found ${matches.length} image matches`);

  // Remove duplicates
  const uniqueImages = [...new Set(matches)];
  console.log(`[EXTRACT] Unique images: ${uniqueImages.length}`);

  if (uniqueImages.length === 0) {
    console.log(`[EXTRACT] No images found!`);
    throw httpError(422, "No images found in Tumblr post");
  }

  // Find the largest image by resolution
  let largestImage = uniqueImages[0];
  let largestSize = 0;

  for (const imgUrl of uniqueImages) {
    const sizeMatch = imgUrl.match(/\/s(\d+)x(\d+)/);
    if (sizeMatch) {
      const width = parseInt(sizeMatch[1]);
      const height = parseInt(sizeMatch[2]);
      const size = width * height;
      if (size > largestSize) {
        largestSize = size;
        largestImage = imgUrl;
      }
    }
  }

  console.log(`Extracted Tumblr image: ${largestImage}`);
  return largestImage;
}

// Upload endpoint — server fetches the image by URL to avoid browser CORS issues
app.post("/upload", express.json(), checkApiKey, async (req, res) => {
  try {
    let { imageUrl, sourceUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: "No image URL provided" });
    }

    // Extract image URL from Tumblr posts if needed
    imageUrl = await extractTumblrImage(imageUrl);

    // Fetch the image from the server side
    console.log(`Fetching image URL: ${imageUrl}`);
    const response = await fetch(imageUrl, {
      headers: {
        "Referer": sourceUrl || imageUrl,
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    console.log(`Response Content-Type: ${contentType}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`Fetched buffer size: ${buffer.length} bytes`);

    // Extract filename from URL (without extension, as we'll use .jpg)
    const urlObj = new URL(imageUrl);
    const rawName = urlObj.pathname.split("/").pop() || "image";
    const nameParts = rawName.split(".");
    const name = nameParts[0] || "image";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filename = `${name}_${timestamp}.jpg`;

    // Convert image to JPEG
    console.log(`Converting to JPEG with filename: ${filename}`);
    let jpegBuffer;
    try {
      jpegBuffer = await sharp(buffer)
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();
      console.log(`Converted buffer size: ${jpegBuffer.length} bytes`);
    } catch (sharpError) {
      console.error(`Sharp conversion failed: ${sharpError.message}`);
      // Don't save web pages or other non-image responses as .jpg files
      if (!contentType.startsWith("image/")) {
        throw httpError(422, `URL did not return an image (content-type: ${contentType || "unknown"})`);
      }
      // If conversion fails, fall back to saving original
      jpegBuffer = buffer;
      console.log(`Falling back to original buffer (${jpegBuffer.length} bytes)`);
    }

    const filepath = path.join(NETWORK_DRIVE_PATH, filename);
    fs.writeFileSync(filepath, jpegBuffer);

    console.log(`Image saved: ${filepath}`);

    res.json({ success: true, filename, path: filepath, sourceUrl });

  } catch (error) {
    if (error.status) {
      console.log(`Upload rejected: ${error.message}`);
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to save image", message: error.message });
  }
});

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", path: NETWORK_DRIVE_PATH });
});

app.listen(port, () => {
  console.log(`Image download server listening on port ${port}`);
  console.log(`Saving images to: ${NETWORK_DRIVE_PATH}`);
});
