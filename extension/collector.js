// Collector, injected by the popup into the current tab. Where the photos come from:
//   - a Tumblr tag page (www.tumblr.com/tagged/<tag>): pages through the tag's Latest timeline
//     with the logged-in session (the website's own internal API, so mature posts are included
//     and results go back years), keeps photos only and merges reblogs by media key.
//   - a YouPic profile (youpic.com/<name>): scrolls through the portfolio and takes each photo at
//     the largest size YouPic serves (1440 px on the long side; the grid shows 768).
//   - any other page: scrolls to the end (for pages that load more as you scroll) and takes every
//     photo at least MIN_SIDE px, or the full-size image a thumbnail links to.
// The list goes to the image-downloader server through the background worker; the server marks
// what was downloaded before and what is a re-upload, and this panel shows that preview. On
// Download, the server saves the new images one at a time; that runs on the server, so the
// panel (or the tab) can be closed meanwhile. Images the server can't fetch (sites that only
// serve browsers) can then be sent from this tab. Afterwards the server adds the run's photos to
// the Immich album named in the panel, if Immich already has an album by that name.
(() => {
  if (window.__inspoCollector) {
    window.__inspoCollector.show();
    return;
  }

  const PAGE_PAUSE_MS = 300;
  const MAX_PAGES = 2000;
  const POLL_MS = 2000;
  const SCROLL_PAUSE_MS = 700;
  const MAX_SCROLLS = 1500;
  const MIN_SIDE = 500;

  // ---- Panel (shadow DOM, so the site's styles don't leak in) ----
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .panel { width: 300px; background: #fff; color: #222; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
               font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 14px 16px; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .head b { font-size: 14px; }
      .tag { flex: 1; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .x { border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #888; padding: 0 2px; }
      .status { min-height: 20px; }
      .error { color: #c62828; }
      table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; }
      td { padding: 3px 0; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
      tr.new td { color: #1a73e8; font-size: 15px; }
      .note { color: #888; font-size: 12px; margin-top: 6px; }
      .album { display: block; margin-top: 10px; font-size: 12px; color: #555; }
      .album input { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; padding: 5px 7px; font: inherit; font-size: 13px;
                     color: #222; border: 1px solid #ccc; border-radius: 6px; }
      .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      .actions button { flex: 1; padding: 8px 10px; border: 0; border-radius: 6px; font-size: 13px; cursor: pointer; }
      .primary { background: #1a73e8; color: #fff; }
      .primary:disabled { background: #a8c4ee; cursor: default; }
      .secondary { background: #eee; color: #333; }
    </style>
    <div class="panel">
      <div class="head"><b>Inspo</b><span class="tag"></span><button class="x" title="Close">×</button></div>
      <div class="status"></div>
      <div class="result"></div>
      <div class="actions"></div>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (sel) => root.querySelector(sel);

  let stopped = false;     // the panel was closed
  let enough = false;      // "Use what's found": stop scrolling, keep what was collected
  let batchId = null;
  let album = "";          // the Immich album for this run (chosen in the preview)

  function setStatus(text, isError) {
    $(".status").textContent = text;
    $(".status").className = "status" + (isError ? " error" : "");
  }

  function setActions(buttons) {
    const box = $(".actions");
    box.replaceChildren(...buttons.map(({ label, kind = "secondary", onClick, disabled, title }) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = kind;
      b.disabled = !!disabled;
      if (title) b.title = title;
      if (onClick) b.addEventListener("click", onClick);
      return b;
    }));
  }

  let downloadStarted = false;

  // Closing before the download drops the run on the server; once downloading, the server
  // carries on without the panel.
  function close() {
    stopped = true;
    if (batchId && !downloadStarted) server({ type: "inspo-batch-cancel", id: batchId }).catch(() => {});
    host.remove();
    delete window.__inspoCollector;
  }
  $(".x").addEventListener("click", close);

  window.__inspoCollector = { show: () => host.isConnected || document.documentElement.appendChild(host) };

  // Server calls go through the background worker, which holds the URL and API key
  function server(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        reply?.ok ? resolve(reply.data) : reject(new Error(reply?.error || "No reply from the extension"));
      });
    });
  }

  // Chrome throttles timers in hidden tabs (to about once a minute after 5 minutes hidden),
  // so a pause ends early as soon as the tab is visible again.
  function pause(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      };
      const onVisible = () => !document.hidden && done();
      const timer = setTimeout(done, ms);
      document.addEventListener("visibilitychange", onVisible);
    });
  }

  // One retry, and a time limit so a stalled request can't freeze the collector
  async function fetchPage(url, headers) {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { credentials: "include", headers, signal: AbortSignal.timeout(30000) });
        if (response.ok || attempt === 2) return response;
      } catch (err) {
        if (attempt === 2) throw new Error(`Tumblr didn't answer: ${err.message}`);
      }
      await pause(2000);
    }
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const mediaKey = (url) => (String(url).match(/media\.tumblr\.com\/([0-9a-f]{32})\//i) || [])[1]?.toLowerCase() || null;

  // ---- Scrolling through a page (YouPic, any page) ----
  // What scrolls: the document, or the biggest scrollable box (some sites scroll an inner panel)
  function scroller() {
    let best = document.scrollingElement || document.documentElement;
    let room = best.scrollHeight - best.clientHeight;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.scrollHeight - el.clientHeight;
      if (r <= room + 200) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        best = el;
        room = r;
      }
    }
    return best;
  }

  // A screen at a time, taking what's on the page after each step, until the end of the page
  // stays put (nothing more loads). Small steps so lazy-loaded and recycled tiles are all seen.
  async function scrollThrough(grab, count, report) {
    let box = scroller();
    let idle = 0;
    grab();
    for (let steps = 1; !stopped && !enough && steps <= MAX_SCROLLS && idle < 6; steps++) {
      const height = box.scrollHeight;
      const before = count();
      const top = box.scrollTop;
      box.scrollBy(0, Math.max(300, box.clientHeight * 0.85));
      await pause(SCROLL_PAUSE_MS);
      grab();
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      idle = atEnd && box.scrollHeight === height && count() === before ? idle + 1 : 0;
      if (box.scrollTop === top && !atEnd) box = scroller();   // it didn't move: another box scrolls
      report();
    }
  }

  // ---- Sources ----
  function tumblrSource() {
    const tag = decodeURIComponent((location.pathname.match(/^\/tagged\/([^/]+)/) || [])[1] || "");
    return {
      kind: "tumblr",
      label: `#${tag}`,
      title: tag,
      album: tag,
      canStopEarly: false,
      collectingNote: "Keep this tab in front until collecting finishes (about a minute for 1,000 posts). The server's check after that runs on its own.",
      async collect() {
        const state = JSON.parse(document.getElementById("___INITIAL_STATE___")?.textContent || "null");
        const token = state?.apiFetchStore?.API_TOKEN;
        if (!tag || !token) throw new Error("This doesn't look like a Tumblr tag page. Reload the page and try again.");
        const headers = { Authorization: `Bearer ${token}`, ...(state.apiFetchStore.extraHeaders || {}) };

        const stats = { pages: 0, posts: 0, ads: 0, gifs: 0, textOnly: 0, sameUpload: 0, mature: 0 };
        const byKey = new Map();
        const seenPosts = new Set();

        const take = (e) => {
          if (e.object_type !== "post") {
            if (/ad/i.test(e.object_type || "")) stats.ads++;
            return;
          }
          if (seenPosts.has(e.id_string)) return;
          seenPosts.add(e.id_string);
          stats.posts++;

          const mature = !!e.community_labels?.has_community_label;
          const blocks = [...(e.trail || []).flatMap((t) => t.content || []), ...(e.content || [])]
            .filter((b) => b.type === "image" && Array.isArray(b.media) && b.media.some((m) => m.url));
          if (!blocks.length) {
            stats.textOnly++;
            return;
          }
          for (const block of blocks) {
            const media = block.media.filter((m) => m.url);
            const big = media.reduce((a, c) => ((c.width || 0) * (c.height || 0) > (a.width || 0) * (a.height || 0) ? c : a));
            if (/\.gifv?$/i.test(new URL(big.url).pathname)) {
              stats.gifs++;
              continue;
            }
            const key = mediaKey(big.url) || big.url;
            if (byKey.has(key)) {
              stats.sameUpload++;
              continue;
            }
            // Thumbnail for the server's re-upload check: the largest uncropped size up to 540 px
            // wide (what the check was calibrated on)
            const thumb = media
              .filter((m) => !m.cropped && !/_c\d+\//.test(m.url) && (m.width || 0) <= 540)
              .sort((a, c) => (c.width || 0) - (a.width || 0))[0] || big;
            if (mature) stats.mature++;
            byKey.set(key, { key, url: big.url, w: big.width || 0, h: big.height || 0, thumb: thumb.url, post: e.id_string, blog: e.blog_name, mature });
          }
        };

        let next = `/v2/hubs/${encodeURIComponent(tag)}/timeline?sort=recent&limit=14`;
        while (next && !stopped && stats.pages < MAX_PAGES) {
          const response = await fetchPage(`https://www.tumblr.com/api${next}`, headers);
          if (!response.ok) throw new Error(`Tumblr answered HTTP ${response.status} on page ${stats.pages + 1}.`);
          const body = await response.json();
          stats.pages++;
          const timeline = body.response?.timeline || {};
          (timeline.elements || []).forEach(take);
          next = (timeline._links || timeline.links)?.next?.href || null;
          setStatus(`Collecting from Latest… page ${fmt(stats.pages)} · ${fmt(stats.posts)} posts · ${fmt(byKey.size)} photos`);
          // Requests are already one at a time; the extra courtesy pause is skipped while the
          // tab is hidden, where Chrome would stretch it to a minute
          if (!document.hidden) await pause(PAGE_PAUSE_MS);
        }
        return {
          items: [...byKey.values()],
          none: `No photos found under #${tag} (${fmt(stats.posts)} posts).`,
          note: `From ${fmt(stats.posts)} posts (${fmt(stats.mature)} photos from mature posts). Left out: ${fmt(stats.ads)} ads, ${fmt(stats.gifs)} GIFs, ${fmt(stats.textOnly)} text posts, ${fmt(stats.sameUpload)} reblogs of the same upload.`
        };
      }
    };
  }

  function youpicSource() {
    const profile = location.pathname.split("/")[1] || "";
    const name = document.title.split(" — ")[0].trim() || profile;
    return {
      kind: "youpic",
      label: `${name} · portfolio`,
      title: `${name} (YouPic)`,
      album: name,
      canStopEarly: true,
      collectingNote: "Keep this tab in front: the collector scrolls through the whole portfolio to see every photo.",
      async collect() {
        const byKey = new Map();
        // Portfolio tiles link to the photographer's own photos; their image address is
        // youpic.com/i/<40-hex photo ID><…><8-hex size>, the size being the long side / 4.
        // 0x258 asks for 2400 px (YouPic serves up to 1440), 0x87 for 540 (the re-upload check).
        const grab = () => {
          for (const a of document.querySelectorAll(`a.media-image[href^="/${profile}/"]`)) {
            const img = a.querySelector("img");
            const m = (img?.currentSrc || img?.src || "").match(/^(https:\/\/(?:www\.)?youpic\.com\/i\/([0-9a-f]{40})[0-9a-f]*)[0-9a-f]{8}$/i);
            if (!m || byKey.has(m[2])) continue;
            byKey.set(m[2], { url: `${m[1]}00000258`, thumb: `${m[1]}00000087`, w: img.naturalWidth || 0, h: img.naturalHeight || 0, page: a.href });
          }
        };
        await scrollThrough(grab, () => byKey.size, () => setStatus(`Scrolling through the portfolio… ${fmt(byKey.size)} photos`));
        return {
          items: [...byKey.values()],
          none: `No portfolio photos found. Open the profile's Portfolio and try again.`,
          note: `${fmt(byKey.size)} photos from ${escapeHtml(name)}'s portfolio, each at the largest size YouPic serves.`
        };
      }
    };
  }

  function pageSource() {
    const title = document.title.trim() || location.hostname;
    return {
      kind: "page",
      label: title,
      title,
      album: "",
      canStopEarly: true,
      collectingNote: "Keep this tab in front: the collector scrolls to the end of the page to see every photo. “Use what's found” stops it early.",
      async collect() {
        const byUrl = new Map();
        const small = new Set();
        const isImageFile = (u) => {
          try {
            const x = new URL(u);
            return /^https?:$/.test(x.protocol) && /\.(jpe?g|png|webp|avif|heic|tiff?)$/i.test(x.pathname);
          } catch {
            return false;
          }
        };
        // The biggest version an <img> offers (srcset), else what it shows
        const largest = (img) => {
          let best = img.currentSrc || img.src;
          let bestW = img.naturalWidth || 0;
          for (const part of (img.getAttribute("srcset") || "").split(",")) {
            const [u, d] = part.trim().split(/\s+/);
            const w = /^\d+w$/.test(d || "") ? parseInt(d, 10) : 0;
            if (u && w > bestW) {
              best = new URL(u, location.href).href;
              bestW = w;
            }
          }
          return best;
        };
        const grab = () => {
          for (const img of document.images) {
            const shown = img.currentSrc || img.src;
            if (!/^https?:/.test(shown)) continue;
            const link = img.closest("a[href]");
            const full = link && isImageFile(link.href) ? link.href : null;   // a thumbnail of a full-size image
            if (!full && Math.max(img.naturalWidth || 0, img.naturalHeight || 0) < MIN_SIDE) {
              if (img.complete && img.naturalWidth) small.add(shown);   // loaded, and too small: icons, avatars
              continue;
            }
            const url = full || largest(img);
            if (!/^https?:/.test(url) || byUrl.has(url)) continue;
            small.delete(shown);
            byUrl.set(url, { url, thumb: shown, w: full ? 0 : img.naturalWidth, h: full ? 0 : img.naturalHeight, page: location.href });
          }
          for (const a of document.querySelectorAll("a[href]")) {   // links straight to an image, no thumbnail
            if (!a.querySelector("img") && isImageFile(a.href) && !byUrl.has(a.href)) {
              byUrl.set(a.href, { url: a.href, thumb: a.href, w: 0, h: 0, page: location.href });
            }
          }
        };
        await scrollThrough(grab, () => byUrl.size, () => setStatus(`Scrolling through the page… ${fmt(byUrl.size)} photos`));
        return {
          items: [...byUrl.values()],
          none: `No photos of at least ${MIN_SIDE} px on this page.`,
          note: `Photos at least ${MIN_SIDE} px, or the full-size image a thumbnail links to. Left out: ${fmt(small.size)} smaller images (icons, avatars, thumbnails).`
        };
      }
    };
  }

  const SOURCE = location.hostname === "www.tumblr.com" && location.pathname.startsWith("/tagged/") ? tumblrSource()
    : /(^|\.)youpic\.com$/.test(location.hostname) ? youpicSource()
    : pageSource();
  $(".tag").textContent = SOURCE.label;

  // ---- 1. Collect, 2. Server check, 3. Preview ----
  async function run() {
    setActions([
      ...(SOURCE.canStopEarly ? [{ label: "Use what's found", onClick: () => { enough = true; } }] : []),
      { label: "Cancel", onClick: close }
    ]);
    setStatus("Collecting…");
    // Chrome pauses tabs that stay in the background, which would pause collecting
    $(".result").innerHTML = `<div class="note">${SOURCE.collectingNote}</div>`;
    const { items, none, note } = await SOURCE.collect();
    $(".result").replaceChildren();
    if (stopped) return;
    if (!items.length) {
      setStatus(none);
      setActions([{ label: "Close", onClick: close }]);
      return;
    }

    setStatus(`Sending ${fmt(items.length)} photos to the server…`);
    const created = await server({ type: "inspo-batch-create", tag: SOURCE.title, source: SOURCE.kind, album: SOURCE.album, items });
    batchId = created.id;

    let batch = created;
    while (!stopped && ["queued", "checking"].includes(batch.phase)) {
      const { done, total } = batch.progress || {};
      setStatus(batch.phase === "queued"
        ? "Waiting for the server (another run is being checked)…"
        : `Checking for duplicates… ${fmt(done)} / ${fmt(total)}`);
      await pause(POLL_MS);
      batch = await server({ type: "inspo-batch-status", id: batchId });
    }
    if (stopped) return;
    if (batch.phase !== "ready") throw new Error(`The server's check ended as "${batch.phase}". ${(batch.warnings || []).join(" ")}`);

    const c = batch.counts;
    setStatus(`Ready. Nothing has been downloaded yet.`);
    $(".result").innerHTML = `
      <table>
        <tr><td>Photos found</td><td class="n">${fmt(c.total)}</td></tr>
        <tr><td>Downloaded before</td><td class="n">${fmt(c.downloadedBefore)}</td></tr>
        <tr><td>Re-uploads (same photo)</td><td class="n">${fmt(c.repeat)}</td></tr>
        ${c.invalid ? `<tr><td>Not usable</td><td class="n">${fmt(c.invalid)}</td></tr>` : ""}
        <tr class="new"><td>New to download</td><td class="n">${fmt(c.new)}</td></tr>
      </table>
      <div class="note">${note}${(batch.warnings || []).length ? " Server: " + escapeHtml(batch.warnings.join(" ")) : ""}</div>
      <label class="album">Add to Immich album
        <input type="text" placeholder="none" spellcheck="false" value="${escapeHtml(SOURCE.album)}">
      </label>
      <div class="note">Only if Immich already has an album with this name; the photos go in once Immich has scanned them. Leave empty for none.</div>`;
    setActions([
      { label: `Download ${fmt(c.new)}`, kind: "primary", disabled: !c.new, onClick: () => {
        album = $(".album input")?.value.trim() || "";
        download().catch(showError);
      } },
      { label: "Close", onClick: close }
    ]);
  }

  // ---- 4. Download (runs on the server; the panel only follows it) ----
  async function download() {
    downloadStarted = true;
    setActions([]);
    setStatus("Starting the download…");
    let batch = await server({ type: "inspo-batch-download", id: batchId, album });

    while (!stopped && ["download-queued", "downloading"].includes(batch.phase)) {
      const d = batch.download;
      setStatus(batch.phase === "download-queued"
        ? "Waiting for the server (another run is in progress)…"
        : `Downloading… ${fmt(d.done)} / ${fmt(d.total)}${d.failed ? ` · ${fmt(d.failed)} failed` : ""}`);
      setActions([
        { label: "Stop", onClick: () => server({ type: "inspo-batch-cancel", id: batchId }).catch(showError) },
        { label: "Hide", title: "The download continues on the server", onClick: close }
      ]);
      await pause(POLL_MS);
      batch = await server({ type: "inspo-batch-status", id: batchId });
    }
    if (stopped) return;
    if (batch.phase === "failed") throw new Error(`The server's download failed. ${(batch.warnings || []).join(" ")}`);
    showResult(batch);
  }

  function albumLine(batch) {
    const job = batch.albumJob;
    if (!job) return "";
    const text = job.status === "waiting" ? `Album “${job.name}”: the photos go in after Immich's scan.`
      : job.status === "done" ? `Album “${job.name}”: ${fmt(job.added)} added.`
      : job.message || "";
    return text ? `<div class="note">${escapeHtml(text)}</div>` : "";
  }

  function showResult(batch) {
    const d = batch.download;
    const left = d.total - d.done;
    setStatus(batch.phase === "done"
      ? `Done. Press the Immich scan button to pick up the new photos.`
      : `Stopped with ${fmt(left)} still to download.`);
    $(".result").innerHTML = `
      <table>
        <tr class="new"><td>Saved</td><td class="n">${fmt(d.saved)}</td></tr>
        ${d.alreadySaved ? `<tr><td>Already saved meanwhile</td><td class="n">${fmt(d.alreadySaved)}</td></tr>` : ""}
        ${d.skipped ? `<tr><td>Skipped (GIFs)</td><td class="n">${fmt(d.skipped)}</td></tr>` : ""}
        ${d.failed ? `<tr><td>Failed</td><td class="n">${fmt(d.failed)}</td></tr>` : ""}
        ${left ? `<tr><td>Not downloaded yet</td><td class="n">${fmt(left)}</td></tr>` : ""}
      </table>
      ${d.failed && !left ? `<div class="note">Some sites only send their images to a browser; “From this tab” sends them from here instead (keep the tab open).</div>` : ""}
      ${albumLine(batch)}`;
    const again = d.failed + left;
    setActions([
      ...(again ? [{ label: left ? `Continue (${fmt(again)})` : `Retry ${fmt(again)} failed`, kind: "primary", onClick: () => download().catch(showError) }] : []),
      ...(d.failed && !left ? [{ label: "From this tab", title: "Download the failed ones in this tab and send them to the server", onClick: () => downloadHere().catch(showError) }] : []),
      { label: "Close", onClick: close }
    ]);
  }

  // ---- 5. Images the server couldn't fetch, sent from this tab ----
  // The page's own address and cookies get them (a site behind a bot check serves browsers).
  // Read here first; the background worker tries itself when the page may not (another site).
  async function readHere(url) {
    try {
      const response = await fetch(url, { credentials: "include" });
      const blob = response.ok ? await response.blob() : null;
      if (!blob || !blob.size || blob.size > 50e6) return null;
      if (!/^(image\/|application\/octet-stream|binary\/octet-stream|$)/.test(blob.type)) return null;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  async function downloadHere() {
    let halt = false;
    const full = await server({ type: "inspo-batch-status", id: batchId, items: true });
    const todo = full.items.map((item, index) => ({ item, index })).filter(({ item }) => item.status === "new" && item.result === "failed");
    let saved = 0;
    for (const [n, { item, index }] of todo.entries()) {
      if (stopped || halt) break;
      setStatus(`Sending from this tab… ${fmt(n + 1)} / ${fmt(todo.length)}${saved < n ? ` · ${fmt(n - saved)} failed` : ""}`);
      setActions([{ label: "Stop", onClick: () => { halt = true; } }]);
      try {
        const dataUrl = await readHere(item.url);
        const r = await server({ type: "inspo-batch-item-bytes", id: batchId, index, url: item.url, dataUrl });
        if (r.result === "saved") saved++;
      } catch (err) {
        console.warn("Inspo: couldn't send", item.url, err.message);
      }
    }
    if (stopped) return;
    showResult(await server({ type: "inspo-batch-status", id: batchId }));
  }

  function showError(err) {
    if (stopped) return;
    setStatus(err.message, true);
    setActions([{ label: "Close", onClick: close }]);
  }

  run().catch(showError);
})();
