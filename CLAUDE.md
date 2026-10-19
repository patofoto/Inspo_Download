# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser and phone tools for the Inspiration Board folder on the Mac mini (an Immich external library):

1. **Chrome extension** (`extension/`) - right-click an image → POST its URL to the image-downloader server; toolbar popup → collect a whole Tumblr tag (`popup.js`, `collector.js`) and download it through the server's `/batch` endpoints
2. **Scriptable** (`scriptable/InspoDownload.js`) - iOS share-sheet script that POSTs a shared link to the server
3. **Webhook trigger** (`webhook-trigger/`) - toolbar button that GETs a configured webhook URL; the user points it at an n8n workflow that starts an Immich external library scan, so newly saved images show up. The URL lives only in the extension's options (chrome.storage), not in code

The user's iPhone mainly uses an iOS Shortcut ("Inspo Board", not in this repo) that does the same as the Scriptable script.

## The server lives elsewhere

The server is **not** in this repo. It is `image-downloader-m1/` in the `patofoto/homelab-config` repo (local clone: `~/Documents/GitHub/homelab-config`). Make server changes there.

- Runs on the Mac mini (`server_m1@10.0.1.26`) as the Portainer stack `image-downloader-m1`; public URL `https://inspo-dl.make3.co`.
- The container bind-mounts `server.js` from the Mac mini's checkout at `/Users/server_m1/homelab-config/image-downloader-m1/server`, not from Portainer's Git copy. To deploy a server change: push to homelab-config, `git pull` in `~/homelab-config` on the Mac mini, then **Pull and redeploy** the stack in Portainer.
- Env vars are set in the Portainer stack UI, and the stack's `docker-compose.yml` must list each one or it never reaches the container: `API_KEY`, `TUMBLR_CONSUMER_KEY`, `TUMBLR_CONSUMER_SECRET`, `TUMBLR_OAUTH_TOKEN`, `TUMBLR_OAUTH_TOKEN_SECRET`.
- Tumblr post links are resolved through Tumblr's API v2 with OAuth 1.0a (sees login-only blogs; the token doesn't expire), falling back to scraping the post page. Browser session cookies were abandoned because Tumblr invalidates copied cookies within minutes.

## Flow (Chrome extension)

```text
Right-click image → extension/background.js
  → reads serverUrl + apiKey from chrome.storage.local (set on the options page)
  → POST {serverUrl}/upload { imageUrl, sourceUrl, apiKey }
  → badge "..." (sending), "✓" (saved), "✗" (error)
```

**On Tumblr pages the same menu item saves the whole post** (there is only one item since 1.5): `tumblr-context.js` (content script) records the right-clicked element; `findPostLinks` collects the post links in its `<article>` (or the nearest element with post links), plus the page itself if it's a permalink, and sends them as `postUrls` with the image. The server saves the photos of the first candidate post that really contains the image, else just the image; the reply's `post` is the matched link or `null`. Badge: `✓` for one image, else the count saved; orange if `post` is `null`. Right-clicking Tumblr's enlarged preview finds no post, so only that image is saved: the user relies on this to pick one image, keep it.

**Other sites (since 1.6):** the extension reads the image bytes itself (`readImage` runs `fetch` in the page with its cookies; else the service worker fetches it) and POSTs them to `/upload-bytes` (headers `X-API-Key`, `X-Image-Url`, `X-Source-Url`, URI-encoded). Sites behind Cloudflare's bot check (e.g. Bellazon) answer the server with a challenge page, never the image. If Chrome can't read the image, or the server answers 404 (older server), it falls back to `/upload` with the address.

Single saves always save, even an image saved before (the user deletes duplicates in Immich); the server still records each saved image's media key, so tag runs skip it.

The server fetches the image itself, which avoids CORS issues in the browser.

## Flow (Tumblr tag collector)

```text
Toolbar popup on tumblr.com/tagged/<tag> → injects extension/collector.js into the tab
  → pages through /api/v2/hubs/<tag>/timeline?sort=recent (Tumblr's internal API, logged-in
    session; next page in response.timeline._links.next) → photos only, merged by media key
  → background.js relays to the server: POST /batch → poll GET /batch/:id → preview
  → POST /batch/:id/download → poll until done (runs on the server; the panel can close)
```

- Plan, findings and calibration: `docs/tumblr-tag-collector.md`
- Chrome pauses background tabs, so collecting needs the tab in front; pauses use `pause()`, which ends early when the tab becomes visible.
- The server skips images downloaded before (ledger of media keys, existing file names) and re-uploads of the same photo (256-bit difference hash of the ~540 px thumbnail, ≤ 20 bits apart). It never talks to Immich.

## Development

**Load an extension:** `chrome://extensions/` → Developer mode → Load unpacked → `extension/` or `webhook-trigger/`. After editing `background.js` or `options.js`, click the reload icon there.

**Versioning:** bump `version` in `extension/manifest.json` with every change to the extension, so the number shown in `chrome://extensions` tells the user which build is loaded (1.2 = tag collector with download and an already-saved note; 1.3 = single saves always save again, the already-saved check and note removed; 1.4 = Download whole post; 1.5 = one right-click item, which saves the whole post on Tumblr; 1.6 = other sites send the image bytes from the browser).

**Test the server:**

```bash
curl https://inspo-dl.make3.co/health
curl -X POST https://inspo-dl.make3.co/upload \
  -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
  -d '{"imageUrl": "https://www.tumblr.com/<blog>/<post-id>"}'
```

`/upload` returns `200 { success, count, filename, filenames }`, `401` for a bad key, or `422 { error, message }` when nothing could be saved.

Extensions use native Chrome APIs only (no dependencies).
