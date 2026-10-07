# Inspo Download

Browser and phone tools for the **Inspiration Board** folder (an Immich external library): saving images into it through the image-downloader server, and telling Immich to rescan it.

The server is not in this repo. It lives in [`homelab-config/image-downloader-m1`](https://github.com/patofoto/homelab-config/tree/main/image-downloader-m1) and runs on the Mac mini as the Portainer stack `image-downloader-m1`, reachable at `https://inspo-dl.make3.co`.

## What's here

| Folder | What it is |
| --- | --- |
| `extension/` | Chrome extension: right-click an image → **Download to Network Drive**; and from the toolbar button, collect a whole Tumblr tag |
| `scriptable/` | iOS Scriptable script: share a link → send it to the server |
| `webhook-trigger/` | Chrome extension: a toolbar button that calls an n8n webhook, which starts an Immich external library scan so newly saved images show up |

On the iPhone, the **Inspo Board** Shortcut in the share sheet does the same job as the Scriptable script: it POSTs the shared link to `/upload` and shows the server's reply as a notification.

## Setup

### Chrome extension

1. Open `chrome://extensions/`, turn on **Developer mode**, click **Load unpacked**, pick `extension/`.
2. Open the extension's **Options**: Server URL `https://inspo-dl.make3.co`, API key = the server's `API_KEY`.

### Collecting a Tumblr tag

1. Click the extension's toolbar button. On a Tumblr tag page (`tumblr.com/tagged/…`) choose **Collect this tag**; anywhere else, type a name (e.g. *Marta Bevacqua*) and open its tag page first. The tag is used exactly as typed; spaces are part of it.
2. Keep the tab in front while it collects (about a minute per 1,000 posts). It reads the tag's Latest view with your login, so mature posts are included, and leaves out ads, GIFs, text posts and reblogs of the same upload.
3. The server checks the list and the panel shows a preview: photos found, downloaded before, re-uploads (the same photo posted by several blogs; the biggest copy is kept), new to download. Nothing has been downloaded yet.
4. **Download** saves the new ones on the server, one at a time. The panel shows progress; **Stop** pauses (continue later), **Hide** closes the panel while the server carries on.
5. Press the webhook-trigger button so Immich picks up the new photos, then cull in Immich's duplicate review.

Single right-click saves always save, even an image saved before; duplicates are deleted in Immich's duplicate review.

Plan and findings: [`docs/tumblr-tag-collector.md`](docs/tumblr-tag-collector.md).

### Webhook trigger

Load `webhook-trigger/` the same way. In its **Options**, set the Webhook URL to the n8n workflow's webhook. Clicking the toolbar button sends it a GET; the badge shows `✓` or `✗`.

### Scriptable

Paste `scriptable/InspoDownload.js` into Scriptable and set `API_KEY` at the top.

## Server API

`POST /upload` with JSON `{ "imageUrl": "...", "sourceUrl": "...", "apiKey": "..." }` (or the key in an `X-API-Key` header).

- `imageUrl` can be a direct image link or a Tumblr post link. For Tumblr posts the server finds the photos itself, including every photo of a multi-photo post and posts on login-only blogs. GIFs are skipped.
- `200` → `{ "success": true, "count": 1, "filename": "...", "filenames": [...] }`
- `401` → wrong API key
- `422` → `{ "error": "...", "message": "..." }` when nothing could be saved

Tag runs use `POST /batch`, `GET /batch/:id`, `POST /batch/:id/download` and `POST /batch/:id/cancel`; see the server's README.

`GET /health` → `{ "status": "ok" }`
