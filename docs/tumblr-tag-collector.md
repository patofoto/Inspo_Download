# Tumblr tag collector — plan

Collect every photo posted under a Tumblr tag (a photographer or model), skip what's already in Immich, download the rest into the Inspiration Board, and let culling happen in Immich.

Branch `feature/tumblr-tag-collector` in both repos:

- **Inspo_Download** — the Chrome extension side, plus this plan
- **homelab-config** (`image-downloader-m1/`) — the server side

## What we learned (Oct 4, 2026, test tag `marta bevacqua`)

### Where the results come from

| Source | Posts | Images | Mature posts | Back to |
|---|---|---|---|---|
| Tumblr search page (Top + Latest) | ~31 per tab | 52 | yes | 2026 |
| Official API `/v2/tagged` | 731 | 1,116 | **no** (filtered out, even with OAuth) | 2011 |
| **Tag page, Latest, logged in** | **1,071** | **1,527** (1,422 distinct) | **40 posts / 80 images** | **2009** |

The tag page's **Latest** view in the logged-in browser is the only source that is both deep and includes mature posts. Its **Top** view is shallow (16 posts).

How the tag page loads (Tumblr's internal API, as used by the website itself):

- First page: `GET https://www.tumblr.com/api/v2/hubs/{tag}/timeline?sort=recent&limit=14`
- Next pages: follow `response.timeline._links.next.href` (note `_links`, not `links`; the search timeline uses `links`)
- Auth: `Authorization: Bearer <API_TOKEN>` from the page's `___INITIAL_STATE___` (`apiFetchStore.API_TOKEN`, plus `apiFetchStore.extraHeaders`), and the browser's cookies (`credentials: "include"`)
- About 135 pages for this tag, ~2¼ minutes at one request every 300 ms

What a page contains:

- `object_type: "post"` — NPF posts; photos are `type: "image"` blocks in `content` and in `trail[].content` (reblogs), each with a `media` array listing every size
- Ads come as their own items (`client_side_ad_waterfall`), never as posts: 157 for this tag. Also `title` and `tag_ribbon` items
- Mature posts carry `community_labels.has_community_label: true`
- Also seen: 18 GIFs, 33 text-only posts

### Image identity

- The **media key** is the first path segment of `64.media.tumblr.com/<media key>/…`. All sizes and all reblogs of one upload share it. 1,527 images → 1,422 distinct media keys.
- The same photo **re-uploaded** by another blog gets a new media key. Only visual matching catches those.
- File names can't be relied on: in a 52-image test, only 1 matched an existing file in the Inspiration Board by name.

### Duplicate check against Immich (tested, read-only)

- Immich 3.2.4 already has a Smart Search embedding for every Inspiration Board image (123k, model `ViT-B-16-SigLIP2__webli`, 768 dimensions, table `smart_search`).
- Method: send Tumblr's ~540 px thumbnail to Immich's ML service (`POST /predict`, same model), then find the nearest neighbour in `smart_search` (cosine distance, `<=>`).
- Checked by eye on 52 search images:

| Closest distance | Result | Action |
|---|---|---|
| < 0.035 | 10 of 10 were the same photo | **skip** |
| 0.035 – 0.06 | mixed: 2 recoloured copies, 1 different photo | download |
| > 0.06 | all different photos | download |

- The same comparison between candidates finds re-uploads within a batch (5 near-identical pairs among 52).
- Immich's own duplicate detection runs daily on all assets (default max distance 0.01). Anything we let through gets caught by the daily review.

### Server constraints (Mac mini)

- The Docker VM has 5.9 GiB. Snapshot: immich_server 1.0 GB, postgres 577 MB, machine learning 171 MB idle, image-downloader 193 MB.
- The ML service loads the model on demand and unloads it after 5 idle minutes.
- Writes to the Inspiration Board take a few seconds each (exFAT/USB, ~129k files). The server already writes asynchronously and one file at a time.

## Decisions

1. **Source:** the tag page's Latest view, collected by the extension inside the logged-in browser.
2. **Selection:** download everything; culling happens in Immich.
3. **Duplicates:** check before download using Immich's existing embeddings. Skip only below **0.035**; when unsure, download.
4. **Order:** check everything first, show a preview, download only after confirmation. One phase at a time, one item at a time, so the ML model is loaded only during the check (minutes), not during the download (up to an hour).
5. **No new tools:** Immich's built-in duplicate review handles what's left. immich-deduper was reviewed and set aside.

## Flow

```text
1. Collect   (browser)  tag page → all posts → drop ads, GIFs, text → merge by media key
2. Check     (server)   per image: already downloaded? → in Immich (< 0.035)? → repeat within batch?
3. Preview   (extension) "1,422 found · 280 already have · 40 repeats · download 1,102?"  [Download] [Cancel]
4. Download  (server)   one at a time, existing save pipeline; progress
5. Scan      (server)   call the Immich scan webhook (n8n) once at the end
```

## Extension (Inspo_Download/extension)

- **Trigger:** a toolbar popup with a **Collect this tag** button, enabled on `tumblr.com/tagged/*`. Optionally a text box that opens the tag page for a typed name.
- **Collector (content script on `www.tumblr.com`):**
  - Reads `API_TOKEN` and `extraHeaders` from `___INITIAL_STATE___`
  - Pages through `/v2/hubs/{tag}/timeline?sort=recent`, 300 ms between pages, with a progress count and a Cancel button
  - Keeps only posts, drops GIFs and text-only posts, merges by media key
  - Records per image: media key, largest URL with width and height, a ~540 px thumbnail URL, post ID, blog name, mature flag
- **Hand-off:** `POST {serverUrl}/batch` with the list and the API key. Then poll `GET /batch/:id` until the check finishes, show the preview, and on **Download** call `POST /batch/:id/download`, showing progress until done.
- **Manifest:** a content script for `https://www.tumblr.com/*` and a popup. Host permissions already cover it.

## Server (homelab-config/image-downloader-m1)

### Endpoints (all require the API key)

- `POST /batch` → `{ id }`. Stores the candidate list and starts the check.
- `GET /batch/:id` → phase (`checking` / `ready` / `downloading` / `done` / `cancelled`), counts, progress
- `POST /batch/:id/download` → starts downloading the images marked `new`
- `POST /batch/:id/cancel`

### Check phase (sequential)

1. **Ledger:** has this media key been downloaded before? Skip. The ledger is a new file of media keys the server saved.
2. **Immich:** fingerprint the thumbnail through the ML service, take the nearest neighbour from `smart_search`. Below 0.035, skip as "already in Immich".
3. **Within the batch:** compare with candidates already kept in this batch. Below 0.035, keep the higher-resolution one.
4. If the ML service or database is unreachable, mark the image `unchecked` and download it. The preview says the check was unavailable.

### Download phase (sequential)

- Reuse `saveImageFromUrl` (GIF skip, format sniffing, SMB-safe names, async writes)
- Add each saved media key to the ledger
- Keep a short optional pause between downloads
- When finished, call the scan webhook once (env `IMMICH_SCAN_WEBHOOK`)

### Connectivity and config

- Join the external network `immich-m1_default` (no change to the Immich stack) to reach `immich_machine_learning:3003` and `immich_postgres:5432`.
- Database access through a **read-only role** with `SELECT` on `asset` and `smart_search` only. Creating it is a one-time change in Immich's database and needs your OK.
- New dependency: `pg`.
- New env vars: `IMMICH_ML_URL`, `IMMICH_DB_URL`, `DUPLICATE_MAX_DISTANCE` (0.035), `IMMICH_SCAN_WEBHOOK`.
- Batch state and the ledger live in a host data folder, following the repo convention (`~/image-downloader-m1/` on the Mac mini, mounted at `/data`), so they survive restarts and stay out of the Git checkout.

## Milestones

1. **Server check, dry run:** connectivity, read-only role, `POST /batch` that only classifies. Verify against the Marta Bevacqua results.
2. **Extension collector:** tag page → list → server → preview.
3. **Server download queue:** sequential downloads, ledger, progress, scan webhook.
4. **First real run** on `marta bevacqua`, watching memory (`docker stats`) and tuning the threshold if needed.

## Open questions

- What is the n8n webhook URL that starts the Immich scan? It goes into `IMMICH_SCAN_WEBHOOK`.
- OK to create the read-only database role in Immich's Postgres?
- Filter out small images? 8 of 32 sampled were under 1000 px on the long side.
- Merge tag variants (`martabevacqua`: 46 more posts) in one run, or one tag at a time?
- Later: the official tag API as a fallback if Tumblr changes its internal API (public posts only).
