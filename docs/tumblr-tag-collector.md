# Tumblr tag collector — plan

Collect every photo posted under a Tumblr tag (a photographer or model), skip what's already in Immich, download the rest into the Inspiration Board, and let culling happen in Immich. One exact tag per run (multi-word names like "marta bevacqua" are a single tag, not case-sensitive); no alternate spellings.

Built on a `feature/tumblr-tag-collector` branch in both repos, merged into `main` on Oct 4, 2026:

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

### Duplicate check against Immich (tested, read-only; not used, see Settled questions)

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
- Writes to the Inspiration Board take a few seconds each (exFAT/USB, ~129k files). The server already writes asynchronously and one file at a time. (Measured on the first real run: about 0.3 s per downloaded image in total, so this no longer holds.)

## Decisions

1. **Source:** the tag page's Latest view, collected by the extension inside the logged-in browser.
2. **Selection:** download everything; culling happens in Immich.
3. **Duplicates:** avoid downloading the same Tumblr image twice, and only one copy of a photo re-uploaded by several blogs, using cheap checks only (below). **No comparison against Immich's database**: it cost 0.35–0.8 s of database CPU per image on an already busy server. Images already in Immich get deleted from Immich's duplicate review instead.
4. **Order:** collect, check, preview, then download only after confirmation. Downloads run one at a time.
5. **No new tools:** Immich's built-in duplicate review handles what's left. immich-deduper was reviewed and set aside.
6. **One exact tag per run**, as typed. No merging of spellings like `martabevacqua`.
7. **No size filter.** Small unique images are kept; smaller copies are left to Immich's duplicate review.
8. **Immich scan is triggered by you** (webhook-trigger button) after a run, not by the server.

## Flow

```text
1. Collect   (browser)   tag page → all posts → drop ads, GIFs, text → merge by media key
2. Check     (server)    per image: downloaded before? (ledger, existing file name) → re-upload of a photo already in this batch? (perceptual hash)
3. Preview   (extension) "1,422 found · 30 downloaded before · 150 re-uploads · download 1,242?"  [Download] [Cancel]
4. Download  (server)    one at a time, existing save pipeline; progress
5. Scan      (you)       press the webhook-trigger button; delete leftovers in Immich's duplicate review
```

## How duplicates are avoided (no AI, no Immich database)

| Duplicate | Caught by | Where |
|---|---|---|
| Reblogs and repeated posts of the same upload | same media key | extension, while collecting |
| Downloaded in an earlier run | ledger of saved media keys | server |
| Saved before the ledger existed (~30k files named after Tumblr's file hash) | largest-size file hash matches an existing file name | server |
| The same photo re-uploaded by another blog (same run) | perceptual hash of the thumbnail; keep the highest resolution | server |
| Already in Immich from other sources | not caught (Immich's duplicate review) | |

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

### Check phase (fast, no AI)

1. **Ledger:** has this media key been downloaded before? Skip. The ledger is a new file of media keys the server saved.
2. **Existing file names:** list the Inspiration Board once per batch; skip an image whose largest-size file hash (the last path segment of its URL, which the server uses as the file name) is already there.
3. **Re-uploads in this batch:** fetch each remaining image's ~540 px thumbnail (one at a time), compute a 256-bit difference hash with `sharp` (greyscale, 17×16, compare neighbours), and compare with the images already kept. At **≤ 20 bits apart** it's the same photo: keep the higher-resolution one, mark the other `repeat`. A thumbnail that fails to load is kept as `new`.

### Download phase (sequential)

- Reuse `saveImageFromUrl` (GIF skip, format sniffing, SMB-safe names, async writes)
- Add each saved media key to the ledger
- Keep a short optional pause between downloads

### Config

- Batch state and the ledger live in a host data folder, following the repo convention (`~/image-downloader-m1/` on the Mac mini, mounted at `/data`), so they survive restarts and stay out of the Git checkout.
- No new dependencies (`sharp` is already used), no access to Immich's network or database.
- New env var: `REPEAT_MAX_BITS` (default 20).

## Milestones

1. **Server batch, dry run:** data folder, ledger, `POST /batch` that only classifies. Verify against the Marta Bevacqua results.
   ✅ Done Oct 4, 2026 (homelab-config `efe5278`, branch only). Test on the 52 Marta Bevacqua images plus seeded ledger and file names: 41 new, 3 downloaded before, 9 repeats, 1 invalid — all as predicted. Listing the real Inspiration Board (129k files) takes under a second.
2. **Extension collector:** tag page → list → server → preview.
   ✅ Code done Oct 4, 2026 (Inspo_Download `bd21093`). Collection tested on `#marta bevacqua` with a stand-in server: 135 pages, 1,071 posts, 1,453 photos. End-to-end with the real server needs the first deploy.
   Note: Chrome pauses tabs left in the background, so collecting needs the tab in front (about a minute per 1,000 posts).
   ✅ First real run Oct 4, 2026 after deploying the server part to `main` (homelab-config `efe5278`): `#Carlos Nunez`, 852 photos → 557 new, 20 downloaded before (by file name; the ledger was still empty), 275 repeats across 136 photos (up to 15 copies each). Server check: 2 min 39 s, 0 thumbnail errors, ~100 MB memory. Every repeat pair 8–16 bits apart (34) and a sample of 0-bit pairs checked by eye: all the same photo, some recolored or black-and-white edits. No false matches.
3. **Server download queue:** sequential downloads, ledger, progress.
   ✅ Done Oct 4, 2026 (homelab-config `a08203e`, deployed to `main`; extension `6e8b9a5`). Resumable downloads (stop / continue / retry failed), one shared job queue. Tested locally: stop at 9 of 44, server killed mid-download, continued to 44 files with no duplicates. Panel flow tested in a Tumblr tab against a simulated server.
4. **First real run**, watching memory (`docker stats`).
   ✅ Done Oct 4, 2026: `#Carlos Nunez`, 852 photos → 557 new downloaded, 0 failed, all files present (66 MB). Download took 3 min 42 s (~0.3 s per image, far faster than the few seconds per write expected). Server memory ~90–100 MB throughout. The run created no duplicate files.

## Settled questions (Oct 4, 2026)

- **Immich scan:** triggered manually with the webhook-trigger button; the server doesn't call it.
- **Small images:** not filtered.
- **Tag variants:** one exact tag per run, as typed.
- **Comparison with Immich's database:** dropped. It worked (10 of 10 duplicates found, no false skips below distance 0.035), but cost 0.35–0.8 s of database CPU per image because Immich's vector index is a single cluster. The read-only role `inspo_reader` created for it was removed again the same day.

## Re-upload check calibration (Oct 4, 2026)

On the 52 Marta Bevacqua images, 256-bit difference hashes of the ~540 px thumbnails:

- The 5 pairs Immich's AI rated near-identical: **0 bits apart** (identical hashes)
- 5 more pairs, checked by eye as the same photo slightly edited or re-compressed: **3–7 bits**
- The closest pair of different photos: **77 bits**, then 90 and up

So ≤ 20 bits leaves a wide margin on both sides. 6 photos were uploaded 2–3 times each: 52 images → 44 downloads. A 64-bit hash was too coarse (different photos at 0–1 bits apart). The cutoff is a setting (`REPEAT_MAX_BITS`) in case larger runs need tuning.

## Also done (Oct 4, 2026)

- Oct 7, 2026: the single-save check below was removed again at the user's request. Single saves always save; duplicates are deleted in Immich. Tag runs keep their downloaded-before check, so reruns don't fetch everything again.

- Single saves (right-click, phone) now skip a Tumblr image that's already saved, using the same ledger and file-name check (homelab-config `338bd69`). That morning, 12 single saves had duplicated files from March.

## Later

- Immich albums per photographer: an "Add to Immich album" box in the preview (pre-filled with the tag), and after the download the server waits for Immich to pick up the files, then creates/finds the album and adds them via Immich's API (API key limited to album permissions; scan started by the server or by the webhook-trigger button). Face names for models are left to Immich's own recognition: name a model once and new photos follow; automating names from a tag is too error-prone. Open questions: pre-fill the album name or not, who starts the scan, albums for model runs too.

- Drawings and animation stills end up in runs alongside photos. For now they're found manually with Immich's Smart Search (`drawing`, `illustration`, `anime`, `cartoon`). Options if this moves into the workflow: skip posts by specific tags (`#anime`, `#animation`, `#illustration`, `#drawing`, `#fanart`, `#cartoon`; not `#art`, which real photos use too), and/or classify each thumbnail with Immich's ML service ("a photograph" vs "a drawing / anime still / cartoon"; same model as Smart Search, no database search, ~0.1–0.3 s per image, model held in memory during the check).


- The official tag API as a fallback if Tumblr changes its internal API (public posts only).
