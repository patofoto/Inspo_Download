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
  → badge "..." (sending), "✓" (saved), "=" (Tumblr image already saved, not saved again), "✗" (error)
```

When the server reports "already saved", `background.js` injects a note into the page (`pageNote`) with the existing file name, **Copy name for Immich search** and **Save again**; the latter sends `inspo-save-again` back to `background.js`, which re-posts with `force: true`.

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

**Versioning:** bump `version` in `extension/manifest.json` with every change to the extension, so the number shown in `chrome://extensions` tells the user which build is loaded (1.2 = tag collector with download, already-saved note with Copy name / Save again, top-right note closing with Esc).

**Test the server:**

```bash
curl https://inspo-dl.make3.co/health
curl -X POST https://inspo-dl.make3.co/upload \
  -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
  -d '{"imageUrl": "https://www.tumblr.com/<blog>/<post-id>"}'
```

`/upload` returns `200 { success, count, filename, filenames }`, `401` for a bad key, or `422 { error, message }` when nothing could be saved.

Extensions use native Chrome APIs only (no dependencies).
