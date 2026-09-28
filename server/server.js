const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const sharp = require("sharp");

const app = express();
const port = process.env.PORT || 3000;

// Configuration - adjust these for your setup
const API_KEY = process.env.API_KEY;
const NETWORK_DRIVE_PATH = process.env.NETWORK_DRIVE_PATH || "/mnt/network-drive/images";
// Tumblr API app credentials (https://www.tumblr.com/oauth/apps). The OAuth
// token lets the API see login-only blogs; without it only public posts work
const TUMBLR_CONSUMER_KEY = process.env.TUMBLR_CONSUMER_KEY || "";
const TUMBLR_CONSUMER_SECRET = process.env.TUMBLR_CONSUMER_SECRET || "";
const TUMBLR_OAUTH_TOKEN = process.env.TUMBLR_OAUTH_TOKEN || "";
const TUMBLR_OAUTH_TOKEN_SECRET = process.env.TUMBLR_OAUTH_TOKEN_SECRET || "";
const FETCH_TIMEOUT_MS = 30000;

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

// Blog name and post ID from a Tumblr post link, e.g.
// www.tumblr.com/{blog}/{id}/slug or {blog}.tumblr.com/post/{id}/slug
function parseTumblrPostUrl(url) {
  const { hostname, pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  const isPostId = segment => /^\d+$/.test(segment || "");

  if (hostname === "www.tumblr.com" || hostname === "tumblr.com") {
    return isPostId(segments[1]) ? { blog: segments[0], id: segments[1] } : null;
  }

  const blog = hostname.slice(0, -".tumblr.com".length);
  if (!blog.includes(".") && ["post", "image"].includes(segments[0]) && isPostId(segments[1])) {
    return { blog, id: segments[1] };
  }

  return null;
}

// RFC 3986 percent-encoding, as OAuth 1.0a signatures require
function oauthEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// OAuth 1.0a (HMAC-SHA1) Authorization header for a Tumblr API GET request
function tumblrOAuthHeader(url) {
  const { origin, pathname, searchParams } = new URL(url);
  const oauth = {
    oauth_consumer_key: TUMBLR_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: TUMBLR_OAUTH_TOKEN,
    oauth_version: "1.0"
  };

  const params = [...searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)])
    .sort(([k1, v1], [k2, v2]) => (k1 === k2 ? (v1 < v2 ? -1 : 1) : (k1 < k2 ? -1 : 1)))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseString = ["GET", oauthEncode(origin + pathname), oauthEncode(params)].join("&");
  const signingKey = `${oauthEncode(TUMBLR_CONSUMER_SECRET)}&${oauthEncode(TUMBLR_OAUTH_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  return "OAuth " + Object.entries(oauth).map(([k, v]) => `${oauthEncode(k)}="${oauthEncode(v)}"`).join(", ");
}

// Fetch a post (NPF format) through Tumblr's API. Signed with the OAuth
// token it sees what the authorized account sees, including login-only
// blogs, and the token doesn't expire; with just the consumer key it only
// sees public blogs
async function fetchTumblrApiPost(blog, id) {
  const url = new URL(`https://api.tumblr.com/v2/blog/${blog}.tumblr.com/posts`);
  url.searchParams.set("id", id);
  url.searchParams.set("npf", "true");

  const headers = {};
  if (TUMBLR_OAUTH_TOKEN) {
    headers.Authorization = tumblrOAuthHeader(url.href);
  } else {
    url.searchParams.set("api_key", TUMBLR_CONSUMER_KEY);
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await response.json().catch(() => ({}));
  const apiError = body.errors?.[0];

  // Login-only blog. Tumblr quietly treats a badly signed request as logged
  // out, so with a token set this usually means a wrong TUMBLR_* value
  if (apiError?.code === 4012) {
    throw httpError(422, TUMBLR_OAUTH_TOKEN
      ? "This blog is only visible to logged-in Tumblr accounts and Tumblr didn't accept the login - check the TUMBLR_* variables on the server"
      : "This blog is only visible to logged-in Tumblr accounts - set the TUMBLR_OAUTH_* variables on the server");
  }
  if (response.status === 404) {
    throw httpError(422, "Tumblr post not found");
  }
  if (!response.ok) {
    throw new Error(`Tumblr API error: ${response.status} ${apiError?.detail || response.statusText}`);
  }

  const post = body.response?.posts?.[0];
  if (!post) {
    throw httpError(422, "Tumblr post not found");
  }
  return post;
}

// Largest version of each image in a post (NPF format), in display order:
// reblog trail first, then the reblogger's own content
function postImages(post) {
  const blocks = [
    ...(post.trail || []).flatMap(item => item.content || []),
    ...(post.content || [])
  ];

  return blocks
    .filter(block => block.type === "image" && Array.isArray(block.media) && block.media.length)
    .map(block => block.media.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url)
    .filter(Boolean);
}

function firstPostImage(images) {
  console.log(`[EXTRACT] Post has ${images.length} image(s)`);
  if (images.length === 0) {
    throw httpError(422, "No images found in Tumblr post");
  }
  console.log(`Extracted Tumblr image: ${images[0]}`);
  return images[0];
}

// Tumblr's web app embeds its page data as JSON, including the post's
// content blocks with every image size
function parseTumblrState(html) {
  const match = html.match(/<script[^>]*id="___INITIAL_STATE___"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// The post a Tumblr page is about, from its embedded page data
function findPostInState(state, postUrl) {
  const posts = state?.PeeprRoute?.initialTimeline?.objects || [];
  const postId = new URL(postUrl).pathname.split("/").find(segment => /^\d+$/.test(segment));
  return (postId ? posts.find(p => String(p.id) === postId) : posts[0]) || null;
}

// Extract image URL from a Tumblr post. Non-Tumblr URLs and direct Tumblr
// image links are returned as-is; a Tumblr post we can't get an image from
// throws, so the post page is never saved as an "image"
async function extractTumblrImage(url) {
  if (!isTumblrPostUrl(url)) {
    return url;
  }

  console.log(`[EXTRACT] Starting extraction for: ${url.substring(0, 60)}...`);

  // Prefer Tumblr's API: it separates the post's images from everything
  // else on the page and, with the OAuth token, sees login-only blogs
  const postRef = parseTumblrPostUrl(url);
  if (postRef && TUMBLR_CONSUMER_KEY) {
    console.log(`[EXTRACT] Fetching post ${postRef.id} from ${postRef.blog} via API...`);
    const post = await fetchTumblrApiPost(postRef.blog, postRef.id);
    return firstPostImage(postImages(post));
  }
  if (!postRef) {
    console.log(`[EXTRACT] Unrecognized post link, reading the page instead`);
  }

  // Otherwise read the post page, which only works for public blogs
  console.log(`[EXTRACT] Fetching HTML...`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (response.url.includes("/login_required/")) {
    console.log(`[EXTRACT] Redirected to login wall`);
    throw httpError(422, TUMBLR_OAUTH_TOKEN
      ? "Tumblr requires login for this post"
      : "Tumblr requires login for this post - set the TUMBLR_* API variables on the server");
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch Tumblr post: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  console.log(`[EXTRACT] Got HTML, length: ${html.length}`);

  // Prefer the embedded post data: it separates the post's images from
  // the blog header and avatars
  const state = parseTumblrState(html);
  if (state) {
    const post = findPostInState(state, response.url);
    if (post) {
      return firstPostImage(postImages(post));
    }
    console.log(`[EXTRACT] Post not found in page data, scanning HTML...`);
  }

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
