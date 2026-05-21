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

// Extract image URL from Tumblr post HTML
async function extractTumblrImage(url) {
  try {
    console.log(`[EXTRACT] Starting extraction for: ${url.substring(0, 60)}...`);

    // Check if it's a Tumblr post URL
    if (!url.includes("tumblr.com")) {
      console.log(`[EXTRACT] Not a Tumblr URL, returning as-is`);
      return url;
    }

    // Fetch the Tumblr post HTML
    console.log(`[EXTRACT] Fetching HTML...`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      console.log(`[EXTRACT] Fetch failed: ${response.statusText}`);
      return url;
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
      return url;
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
  } catch (error) {
    console.error("[EXTRACT] Error:", error.message);
    return url;
  }
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
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type");
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
      // If conversion fails, fall back to saving original
      jpegBuffer = buffer;
      console.log(`Falling back to original buffer (${jpegBuffer.length} bytes)`);
    }

    const filepath = path.join(NETWORK_DRIVE_PATH, filename);
    fs.writeFileSync(filepath, jpegBuffer);

    console.log(`Image saved: ${filepath}`);

    res.json({ success: true, filename, path: filepath, sourceUrl });

  } catch (error) {
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
