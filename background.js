// Cognitive Shield - service worker
// Centralise les appels à clef-flash (Ollama System One) pour éviter les
// restrictions CSP de la page YouTube, et met en cache miniatures + décisions.

const DEFAULT_SETTINGS = {
  enabled: true,
  endpoint: "http://localhost:11434/v1/systemone",
  model: "clef-flash",
  prompt:
    "Cette vidéo est-elle une suggestion réellement utile, pertinente et de qualité qui correspond à ce que je veux regarder maintenant ? Réponds vrai uniquement si c'est clairement le cas.",
  criteriaTrue:
    "La vidéo est pertinente, substantielle et mérite mon attention.",
  criteriaFalse:
    "La vidéo est hors-sujet, putaclic, de faible valeur, répétitive ou une distraction.",
  threshold: 0.5,
  action: "hide", // hide | blur | mark
  useThumbnails: true,
  concurrency: 3,
  timeoutMs: 30000,
  includeMeta: true,
  includeBadges: true,
  includeDescription: true
};

const thumbCache = new Map();
const recent = [];
const MAX_RECENT = 50;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function buildState(video, settings) {
  const state = {
    title: video.title || "",
    channel: video.channel || ""
  };
  if (settings.includeMeta) {
    if (video.duration) state.duration = video.duration;
    if (video.views) state.views = video.views;
    if (video.published) state.published = video.published;
  }
  if (settings.includeBadges && video.badges && video.badges.length) {
    state.badges = video.badges;
  }
  if (settings.includeDescription && video.description) {
    state.description = video.description;
  }
  if (video.videoId) {
    state.url = "https://www.youtube.com/watch?v=" + video.videoId;
  }
  return state;
}

function sniffImage(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}

async function fetchThumbBase64(url) {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  if (thumbCache.has(url)) return thumbCache.get(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // On n'accepte que JPEG/PNG/WebP : clef-flash rejette tout le reste
    // ("invalid decision image") — data:, SVG, placeholders, etc.
    if (!sniffImage(bytes)) throw new Error("format d'image non supporté");
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(bin);
    if (thumbCache.size > 500) thumbCache.clear();
    thumbCache.set(url, b64);
    return b64;
  } catch (e) {
    thumbCache.set(url, "");
    return "";
  }
}

function resolveEndpoint(raw) {
  const value = (raw || "").trim();
  if (!value) return DEFAULT_SETTINGS.endpoint;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path === "" ? "/v1/systemone" : path;
    return url.toString();
  } catch (_) {
    return value;
  }
}

// Ollama refuse (403) toute requête portant un Origin non autorisé. Les requêtes
// émises par une extension ont un Origin chrome-extension://..., donc on retire
// Origin/Referer vers le backend via une règle declarativeNetRequest dynamique.
async function syncOriginRule(endpoint) {
  try {
    const url = new URL(resolveEndpoint(endpoint));
    const rule = {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "set", value: url.origin }
        ]
      },
      condition: {
        urlFilter: url.origin + "/*",
        resourceTypes: ["xmlhttprequest", "other"]
      }
    };
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [rule]
    });
  } catch (_) {}
}

async function initOriginRule() {
  try {
    const s = await getSettings();
    await syncOriginRule(s.endpoint);
  } catch (_) {}
}

async function postDecision(endpoint, body, signal) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch (_) {}
    const err = new Error("HTTP " + res.status + (detail ? " - " + detail.slice(0, 200) : ""));
    err.detail = detail;
    throw err;
  }
  return res.json();
}

async function classify(video, settings) {
  const endpoint = resolveEndpoint(settings.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || 30000);
  const started = Date.now();
  try {
    const body = {
      model: settings.model,
      state: buildState(video, settings),
      questions: {
        keep: {
          type: "noul",
          instructions: settings.prompt,
          criteria: {
            true: settings.criteriaTrue,
            false: settings.criteriaFalse
          }
        }
      }
    };

    let images = [];
    if (settings.useThumbnails && video.thumbnailUrl) {
      const b64 = await fetchThumbBase64(video.thumbnailUrl);
      if (b64) images = [b64];
    }

    let data;
    try {
      data = await postDecision(
        endpoint,
        images.length ? { ...body, images } : body,
        controller.signal
      );
    } catch (e) {
      // Repli : le modèle rejette l'image ("invalid decision image") → on réessaie sans.
      const detail = (e && e.detail) || (e && e.message) || "";
      if (images.length && /image|vision|multimodal/i.test(detail)) {
        data = await postDecision(endpoint, body, controller.signal);
      } else {
        throw e;
      }
    }

    const answer = data && data.answers && data.answers.keep;
    const probability = answer && typeof answer.noul === "number" ? answer.noul : null;
    if (probability === null) {
      throw new Error("Réponse inattendue du modèle");
    }

    const keep = probability >= settings.threshold;
    const entry = {
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      probability,
      keep,
      threshold: settings.threshold,
      ms: Date.now() - started,
      ts: Date.now()
    };
    recent.unshift(entry);
    if (recent.length > MAX_RECENT) recent.pop();

    return { ok: true, probability, keep };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Délai dépassé" : String((e && e.message) || e);
    recent.unshift({
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      error: msg,
      ts: Date.now()
    });
    if (recent.length > MAX_RECENT) recent.pop();
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(settings) {
  const sample = {
    videoId: "dQw4w9WgXcQ",
    title: "Sample video used to test the Cognitive Shield connection",
    channel: "Test channel",
    duration: "3:32",
    views: "1.2M views",
    published: "2 years ago",
    badges: ["HD"],
    description: "A short sample used only to verify the local model answers."
  };
  return classify(sample, settings);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "classify": {
          const settings = msg.settings || (await getSettings());
          await syncOriginRule(settings.endpoint);
          const result = await classify(msg.video, settings);
          sendResponse(result);
          break;
        }
        case "getSettings":
          sendResponse(await getSettings());
          break;
        case "getRecent":
          sendResponse({ ok: true, recent });
          break;
        case "clearRecent":
          recent.length = 0;
          sendResponse({ ok: true });
          break;
        case "test": {
          const settings = { ...(await getSettings()), ...(msg.settings || {}) };
          await syncOriginRule(settings.endpoint);
          const result = await testConnection(settings);
          sendResponse(result);
          break;
        }
        default:
          sendResponse({ ok: false, error: "Type de message inconnu" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => {
    chrome.storage.sync.set(s);
    syncOriginRule(s.endpoint);
  });
});

chrome.runtime.onStartup.addListener(initOriginRule);
initOriginRule();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.endpoint) {
    syncOriginRule(changes.endpoint.newValue);
  }
});
