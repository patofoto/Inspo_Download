const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

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
    // Check if it's a Tumblr post URL
    if (!url.includes("tumblr.com")) {
      return url;
    }

    // Fetch the Tumblr post HTML
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return url;
    }

    const html = await response.text();

    // Try to find the main post content area (not header/profile)
    // Tumblr post content is typically in article or main content sections
    let postContent = html;

    // Look for main post content patterns
    const postMatch = html.match(/<article[^>]*>[\s\S]*?<\/article>/i);
    if (postMatch) {
      postContent = postMatch[0];
    } else {
      // Fallback: look for divs with post-related classes
      const contentMatch = html.match(/<div[^>]*(?:class|id)="[^"]*(?:post|content|body)[^"]*"[^>]*>[\s\S]*?<\/div>/i);
      if (contentMatch) {
        postContent = contentMatch[0];
      }
    }

    // Extract all image URLs from the post content
    const imageRegex = /https:\/\/(?:64\.media|media)\.tumblr\.com\/[^"' >]+\.(?:jpg|jpeg|png|gif|webp)/gi;
    const matches = [...postContent.matchAll(imageRegex)].map(m => m[0]);

    if (matches.length === 0) {
      return url;
    }

    // Find the largest image (by analyzing size in URL like s1280x1920)
    let largestImage = matches[0];
    let largestSize = 0;

    for (const imageUrl of matches) {
      const sizeMatch = imageUrl.match(/\/s(\d+)x(\d+)\//);
      if (sizeMatch) {
        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);
        const size = width * height;
        if (size > largestSize) {
          largestSize = size;
          largestImage = imageUrl;
        }
      }
    }

    console.log(`Extracted Tumblr image: ${largestImage}`);
    return largestImage;
  } catch (error) {
    console.error("Tumblr extraction error:", error);
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
    const response = await fetch(imageUrl, {
      headers: {
        "Referer": sourceUrl || imageUrl,
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Extract filename from URL
    const urlObj = new URL(imageUrl);
    const rawName = urlObj.pathname.split("/").pop() || "image.jpg";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const nameParts = rawName.split(".");
    const ext = nameParts.length > 1 ? nameParts.pop() : "jpg";
    const name = nameParts.join(".");
    const filename = `${name}_${timestamp}.${ext}`;

    const filepath = path.join(NETWORK_DRIVE_PATH, filename);
    fs.writeFileSync(filepath, buffer);

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
