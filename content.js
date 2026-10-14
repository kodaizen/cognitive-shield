// Cognitive Shield - content script
// Scanne les suggestions de la page d'accueil YouTube, extrait un maximum
// d'informations, les envoie à clef-flash via le service worker, puis filtre.
// Les infos et boutons sont dans la popup de la barre d'outils.

(() => {
  const HOME = () => location.hostname.endsWith("youtube.com") && location.pathname === "/";

  let settings = null;
  let running = false;
  let observer = null;
  let scheduled = null;
  const queue = [];
  let active = 0;

  const results = new Map(); // videoId -> { done, keep, probability, error }
  const inflight = new Map(); // videoId -> Promise
  const elementsByVideo = new Map(); // videoId -> Set<Element>
  let seen = new WeakSet();
  const videoByElement = new WeakMap();

  const stats = { analyzed: 0, hidden: 0, kept: 0, errors: 0, scanned: 0 };

  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-rich-grid-media";

  function parseVideoId(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const shorts = url.pathname.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return shorts[1];
    } catch (_) {}
    const m = href.match(/[?&]v=([\w-]+)/);
    if (m) return m[1];
    const s = href.match(/\/shorts\/([\w-]+)/);
    return s ? s[1] : null;
  }

  function txt(el) {
    return el ? (el.textContent || "").trim().replace(/\s+/g, " ") : "";
  }

  function extractCard(card) {
    if (seen.has(card)) return videoByElement.get(card) || null;

    const link =
      card.querySelector("a#thumbnail") ||
      card.querySelector("a#video-title-link") ||
      card.querySelector("a#video-title") ||
      card.querySelector('a[href*="/watch"]') ||
      card.querySelector('a[href*="/shorts/"]');

    const videoId = parseVideoId(link && link.getAttribute("href"));
    if (!videoId) {
      seen.add(card);
      return null;
    }

    const titleEl =
      card.querySelector("#video-title") ||
      card.querySelector("a#video-title-link") ||
      card.querySelector("h3 a") ||
      card.querySelector("h3");
    const title = txt(titleEl) || (titleEl && titleEl.getAttribute("title")) || "";

    const channel = txt(
      card.querySelector("ytd-channel-name #text a") ||
        card.querySelector("ytd-channel-name a") ||
        card.querySelector("#channel-name a")
    );

    const metaSpans = Array.from(card.querySelectorAll("#metadata-line span"))
      .map((s) => txt(s))
      .filter(Boolean);
    const views = metaSpans.find((t) => /view|vue/i.test(t)) || metaSpans[0] || "";
    const published = metaSpans.find((t) => /ago|il y a|jour|semaine|mois|an/i.test(t)) || "";

    const duration = txt(
      card.querySelector("ytd-thumbnail-overlay-time-status-renderer #text") ||
        card.querySelector(".badge-shape-wiz__text") ||
        card.querySelector("span.ytd-thumbnail-overlay-time-status-renderer")
    );

    const badges = Array.from(card.querySelectorAll("ytd-badge-supported-renderer"))
      .map((b) => txt(b))
      .filter((t) => t && t.length < 40);

    const description = txt(card.querySelector("#description-text"));

    // Miniature toujours construite depuis l'ID : URL JPEG stable sur i.ytimg.com
    // (évite les src data:/blob:/SVG qui font échouer le modèle).
    const thumbnailUrl = "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg";

    const video = {
      videoId,
      title,
      channel,
      duration,
      views,
      published,
      badges,
      description,
      thumbnailUrl
    };

    seen.add(card);
    videoByElement.set(card, video);
    if (!elementsByVideo.has(videoId)) elementsByVideo.set(videoId, new Set());
    elementsByVideo.get(videoId).add(card);
    return video;
  }

  function clearShieldClasses(card) {
    card.classList.remove(
      "cognitive-shield-pending",
      "cognitive-shield-hidden",
      "cognitive-shield-blurred",
      "cognitive-shield-marked"
    );
    const badge = card.querySelector(":scope > .cognitive-shield-badge");
    if (badge) badge.remove();
  }

  function applyResult(card, entry) {
    clearShieldClasses(card);
    if (!entry || !entry.done) return;
    if (entry.error) return; // échec ouvert : on ne masque pas

    if (entry.keep) {
      card.classList.add("cognitive-shield-kept");
      return;
    }

    if (settings.action === "blur") {
      card.classList.add("cognitive-shield-blurred");
    } else if (settings.action === "mark") {
      card.classList.add("cognitive-shield-marked");
      const badge = document.createElement("div");
      badge.className = "cognitive-shield-badge";
      badge.textContent =
        "Filtré · " + Math.round(((entry.probability || 0) * 100)) + "%";
      card.appendChild(badge);
    } else {
      card.classList.add("cognitive-shield-hidden");
    }
  }

  async function classifyVideo(video) {
    const cached = results.get(video.videoId);
    if (cached) return cached;
    if (inflight.has(video.videoId)) return inflight.get(video.videoId);

    const p = chrome.runtime
      .sendMessage({ type: "classify", video, settings })
      .then((res) => {
        const entry = res && res.ok
          ? { done: true, keep: res.keep, probability: res.probability }
          : { done: true, error: (res && res.error) || "Erreur inconnue" };
        results.set(video.videoId, entry);
        return entry;
      })
      .catch((e) => {
        const entry = { done: true, error: String((e && e.message) || e) };
        results.set(video.videoId, entry);
        return entry;
      })
      .finally(() => inflight.delete(video.videoId));

    inflight.set(video.videoId, p);
    return p;
  }

  function applyToAll(videoId, entry) {
    const set = elementsByVideo.get(videoId);
    if (!set) return;
    for (const card of set) {
      if (!card.isConnected) {
        set.delete(card);
        continue;
      }
      applyResult(card, entry);
    }
  }

  function pump() {
    while (active < (settings.concurrency || 3) && queue.length) {
      const job = queue.shift();
      active++;
      runJob(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function runJob({ card, video }) {
    const cached = results.get(video.videoId);
    if (cached && cached.done) {
      applyResult(card, cached);
      if (!cached.error) {
        stats.analyzed++;
        cached.keep ? stats.kept++ : stats.hidden++;
      } else {
        stats.errors++;
      }
      return;
    }

    card.classList.add("cognitive-shield-pending");
    const entry = await classifyVideo(video);
    applyToAll(video.videoId, entry);

    if (entry.error) {
      stats.errors++;
    } else {
      stats.analyzed++;
      entry.keep ? stats.kept++ : stats.hidden++;
    }
  }

  function scan() {
    const cards = document.querySelectorAll(CARD_SELECTOR);
    for (const card of cards) {
      if (card.classList.contains("cognitive-shield-pending")) continue;
      const video = extractCard(card);
      if (!video) continue;

      const cached = results.get(video.videoId);
      if (cached && cached.done) {
        applyResult(card, cached);
        continue;
      }
      // évite les doublons dans la file
      if (card.dataset.csQueued === video.videoId) continue;
      card.dataset.csQueued = video.videoId;
      card.classList.add("cognitive-shield-pending");
      queue.push({ card, video });
    }
    stats.scanned = cards.length;
    pump();
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      scan();
    }, 300);
  }

  function resetStats() {
    stats.analyzed = 0;
    stats.hidden = 0;
    stats.kept = 0;
    stats.errors = 0;
    stats.scanned = 0;
  }

  function clearAll() {
    const touched = document.querySelectorAll(
      ".cognitive-shield-hidden, .cognitive-shield-blurred, .cognitive-shield-marked, .cognitive-shield-pending, .cognitive-shield-kept, [data-cs-queued]"
    );
    for (const card of touched) {
      clearShieldClasses(card);
      delete card.dataset.csQueued;
    }
  }

  function resetDomTracking() {
    seen = new WeakSet();
    elementsByVideo.clear();
  }

  function rescan() {
    results.clear();
    resetStats();
    clearAll();
    resetDomTracking();
    if (running) scan();
  }

  function start() {
    if (running) return;
    running = true;
    queue.length = 0;
    resetStats();
    resetDomTracking();
    scan();

    observer = new MutationObserver((mutations) => {
      let added = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          added = true;
          break;
        }
      }
      if (added) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("yt-navigate-finish", onNavigate);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener("yt-navigate-finish", onNavigate);
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    queue.length = 0;
    clearAll();
  }

  function onNavigate() {
    if (HOME()) {
      if (settings.enabled && !running) start();
      else if (running) scheduleScan();
    } else if (running) {
      stop();
    }
  }

  async function loadSettings() {
    settings = await chrome.runtime.sendMessage({ type: "getSettings" });
    return settings;
  }

  async function init() {
    try {
      await loadSettings();
    } catch (_) {
      return;
    }
    if (settings.enabled && HOME()) start();

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "sync") return;
      await loadSettings();
      if (settings.enabled && HOME()) {
        stop();
        start();
      } else {
        stop();
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "rescan") {
      rescan();
      sendResponse({
        ok: true,
        stats: { ...stats, queue: queue.length + active },
        running: running && HOME()
      });
    } else if (msg && msg.type === "getStats") {
      sendResponse({
        ok: true,
        stats: { ...stats, queue: queue.length + active },
        running: running && HOME()
      });
    }
    return false;
  });

  init();
})();
