// Tag collector, injected by the popup into a www.tumblr.com/tagged/<tag> page.
//
// Pages through the tag's Latest timeline with the logged-in session (the website's own
// internal API, so mature posts are included and results go back years), keeps photos only
// and merges reblogs by media key. The list goes to the image-downloader server through the
// background worker; the server marks what was downloaded before and what is a re-upload,
// and this panel shows that preview. On Download, the server saves the new images one at a
// time; that runs on the server, so the panel (or the tab) can be closed meanwhile.
(() => {
  if (window.__inspoCollector) {
    window.__inspoCollector.show();
    return;
  }

  const PAGE_PAUSE_MS = 300;
  const MAX_PAGES = 2000;
  const POLL_MS = 2000;

  const tag = decodeURIComponent((location.pathname.match(/^\/tagged\/([^/]+)/) || [])[1] || "");

  // ---- Panel (shadow DOM, so Tumblr's styles don't leak in) ----
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
      .actions { display: flex; gap: 8px; margin-top: 12px; }
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
  $(".tag").textContent = `#${tag}`;

  let stopped = false;
  let batchId = null;

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

  // ---- 1. Collect ----
  async function collect() {
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
    return { items: [...byKey.values()], stats };
  }

  // ---- 2. Server check, 3. Preview ----
  async function run() {
    setActions([{ label: "Cancel", onClick: close }]);
    setStatus("Collecting from Latest…");
    // Chrome pauses tabs that stay in the background, which would pause collecting
    $(".result").innerHTML = `<div class="note">Keep this tab in front until collecting finishes (about a minute for 1,000 posts). The server's check after that runs on its own.</div>`;
    const { items, stats } = await collect();
    $(".result").replaceChildren();
    if (stopped) return;
    if (!items.length) {
      setStatus(`No photos found under #${tag} (${fmt(stats.posts)} posts).`);
      setActions([{ label: "Close", onClick: close }]);
      return;
    }

    setStatus(`Sending ${fmt(items.length)} photos to the server…`);
    const created = await server({ type: "inspo-batch-create", tag, items });
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
      <div class="note">From ${fmt(stats.posts)} posts (${fmt(stats.mature)} photos from mature posts). Left out: ${fmt(stats.ads)} ads, ${fmt(stats.gifs)} GIFs, ${fmt(stats.textOnly)} text posts, ${fmt(stats.sameUpload)} reblogs of the same upload.${(batch.warnings || []).length ? " Server: " + escapeHtml(batch.warnings.join(" ")) : ""}</div>`;
    setActions([
      { label: `Download ${fmt(c.new)}`, kind: "primary", disabled: !c.new, onClick: () => download().catch(showError) },
      { label: "Close", onClick: close }
    ]);
  }

  // ---- 4. Download (runs on the server; the panel only follows it) ----
  async function download() {
    downloadStarted = true;
    setActions([]);
    setStatus("Starting the download…");
    let batch = await server({ type: "inspo-batch-download", id: batchId });

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
      </table>`;
    const again = d.failed + left;
    setActions([
      ...(again ? [{ label: left ? `Continue (${fmt(again)})` : `Retry ${fmt(again)} failed`, kind: "primary", onClick: () => download().catch(showError) }] : []),
      { label: "Close", onClick: close }
    ]);
  }

  function showError(err) {
    if (stopped) return;
    setStatus(err.message, true);
    setActions([{ label: "Close", onClick: close }]);
  }

  run().catch(showError);
})();
