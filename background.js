// Cognitive Shield - service worker
// Centralise les appels au modèle de décision — Cloudflare Workers AI (cloud) ou
// Ollama (local) — pour éviter les restrictions CSP de la page YouTube, et met en
// cache miniatures + décisions.

const DEFAULT_SETTINGS = {
  enabled: true,
  provider: "cloudflare", // cloudflare | ollama | fastflowlm
  // Cloudflare Workers AI
  cloudflareAccountId: "",
  cloudflareApiToken: "",
  cloudflareModel: "@cf/cloudflare/clef-flash",
  // Ollama (local)
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "clef-flash",
  // FastFlowLM (local, modèle de décision d3 — non génératif)
  fastflowlmEndpoint: "http://localhost:52625",
  fastflowlmModel: "d3:lite",
  // Filtrage
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

// API REST Cloudflare Workers AI : POST /accounts/{account_id}/ai/run/{model}
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

const thumbCache = new Map();
const recent = [];
const MAX_RECENT = 50;

function activeProvider(settings) {
  if (settings.provider === "fastflowlm") return "fastflowlm";
  return settings.provider === "ollama" ? "ollama" : "cloudflare";
}

// Endpoint de base d'un serveur System One local (Ollama ou FastFlowLM).
function localEndpoint(settings) {
  return activeProvider(settings) === "fastflowlm"
    ? (settings.fastflowlmEndpoint || DEFAULT_SETTINGS.fastflowlmEndpoint)
    : (settings.ollamaEndpoint || DEFAULT_SETTINGS.ollamaEndpoint);
}

// Un modèle Workers AI s'identifie par "@cf/<auteur>/<modele>". On tolère la forme
// courte ("clef-flash", héritée d'Ollama) en préfixant la namespace Cloudflare.
function normalizeModel(model) {
  const m = (model || "").trim();
  if (!m) return DEFAULT_SETTINGS.cloudflareModel;
  if (m.includes("/")) return m;
  return "@cf/cloudflare/" + m;
}

// Le corps de requête Clef attend le sélecteur court ("clef-flash"),
// pas l'identifiant complet ("@cf/cloudflare/clef-flash").
function modelSelector(model) {
  return normalizeModel(model).split("/").filter(Boolean).pop();
}

function buildCloudflareEndpoint(accountId, model) {
  const account = (accountId || "").trim();
  if (!account) throw new Error("Account ID Cloudflare manquant (réglages).");
  return CLOUDFLARE_API_BASE + "/" + encodeURIComponent(account) + "/ai/run/" + normalizeModel(model);
}

// L'utilisateur peut saisir la base d'un serveur local (http://localhost:11434 ou
// http://localhost:52625) ou l'endpoint complet (…/v1/systemone) : on ajoute
// /v1/systemone si le chemin est vide.
function resolveSystemOneEndpoint(raw) {
  const value = (raw || "").trim() || DEFAULT_SETTINGS.ollamaEndpoint;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path === "" ? "/v1/systemone" : path;
    return url.toString();
  } catch (_) {
    return value;
  }
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // Migration depuis les anciens schémas à plat (Ollama seul, puis Cloudflare seul).
  if (!stored.cloudflareAccountId && stored.accountId) s.cloudflareAccountId = stored.accountId;
  if (!stored.cloudflareApiToken && stored.apiToken) s.cloudflareApiToken = stored.apiToken;
  if (!stored.cloudflareModel && stored.model) s.cloudflareModel = stored.model;
  if (!stored.ollamaModel && stored.model && !String(stored.model).includes("/")) {
    s.ollamaModel = stored.model;
  }
  s.provider = activeProvider(s);
  s.cloudflareModel = normalizeModel(s.cloudflareModel);
  s.ollamaModel = (s.ollamaModel || "").trim() || DEFAULT_SETTINGS.ollamaModel;
  s.ollamaEndpoint = (s.ollamaEndpoint || "").trim() || DEFAULT_SETTINGS.ollamaEndpoint;
  s.fastflowlmModel = (s.fastflowlmModel || "").trim() || DEFAULT_SETTINGS.fastflowlmModel;
  s.fastflowlmEndpoint = (s.fastflowlmEndpoint || "").trim() || DEFAULT_SETTINGS.fastflowlmEndpoint;
  return s;
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
    // On n'accepte que JPEG/PNG/WebP : Clef rejette tout le reste
    // ("invalid image") — data:, SVG, placeholders, etc.
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

// Un serveur System One local (Ollama, FastFlowLM) refuse (403) toute requête
// portant un Origin non autorisé. Les requêtes émises par une extension ont un
// Origin chrome-extension://..., donc on remplace Origin/Referer vers le backend
// local via une règle declarativeNetRequest.
async function syncOriginRule(provider, localEndpointRaw) {
  try {
    if (provider === "cloudflare") {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] });
      return;
    }
    const url = new URL(resolveSystemOneEndpoint(localEndpointRaw));
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
    await syncOriginRule(activeProvider(s), localEndpoint(s));
  } catch (_) {}
}

function extractError(data, status, rawText) {
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const msgs = data.errors
      .map((e) => (typeof e === "string" ? e : (e && (e.message || e.code)) || ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  if (data && Array.isArray(data.messages) && data.messages.length) {
    const msgs = data.messages.filter((m) => typeof m === "string" && m);
    if (msgs.length) return msgs.join("; ");
  }
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (rawText) return String(rawText).slice(0, 200);
  return "HTTP " + status;
}

async function postDecision(endpoint, token, body, signal) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });

  let text = "";
  try {
    text = await res.text();
  } catch (_) {}
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }

  if (!res.ok || (data && data.success === false)) {
    const detail = extractError(data, res.status, text);
    const err = new Error("HTTP " + res.status + (detail ? " - " + detail : ""));
    err.detail = detail;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function classify(video, settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || 30000);
  const started = Date.now();
  try {
    const provider = activeProvider(settings);
    let endpoint;
    let token = "";
    let model;

    if (provider === "ollama" || provider === "fastflowlm") {
      // Les deux serveurs locaux parlent le même protocole System One.
      model = ((provider === "fastflowlm" ? settings.fastflowlmModel : settings.ollamaModel) || "").trim();
      if (!model) throw new Error("Modèle local manquant (réglages).");
      endpoint = resolveSystemOneEndpoint(localEndpoint(settings));
    } else {
      token = (settings.cloudflareApiToken || "").trim();
      if (!token) throw new Error("Jeton API Cloudflare manquant (réglages).");
      model = modelSelector(settings.cloudflareModel);
      endpoint = buildCloudflareEndpoint(settings.cloudflareAccountId, settings.cloudflareModel);
    }

    const body = {
      model,
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
        token,
        images.length ? { ...body, images } : body,
        controller.signal
      );
    } catch (e) {
      // Repli : le modèle rejette l'image ("invalid image") → on réessaie sans.
      const detail = (e && e.detail) || (e && e.message) || "";
      if (images.length && /image|vision|multimodal/i.test(detail)) {
        data = await postDecision(endpoint, token, body, controller.signal);
      } else {
        throw e;
      }
    }

    // Cloudflare encapsule la réponse dans { result, success, errors } ;
    // Ollama renvoie directement { model, answers, usage }.
    const payload =
      data && data.result && typeof data.result === "object" ? data.result : data;
    const answer = payload && payload.answers && payload.answers.keep;
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
    description: "A short sample used only to verify the decision model answers."
  };
  return classify(sample, settings);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "classify": {
          const settings = msg.settings || (await getSettings());
          await syncOriginRule(activeProvider(settings), localEndpoint(settings));
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
          settings.provider = activeProvider(settings);
          await syncOriginRule(settings.provider, localEndpoint(settings));
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
  chrome.storage.sync.get(null).then((stored) => {
    const s = { ...DEFAULT_SETTINGS, ...stored };
    if (!stored.cloudflareModel && stored.model) s.cloudflareModel = stored.model;
    chrome.storage.sync.set(s);
  });
});

chrome.runtime.onStartup.addListener(initOriginRule);
initOriginRule();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.provider || changes.ollamaEndpoint || changes.fastflowlmEndpoint) {
    getSettings().then((s) => syncOriginRule(activeProvider(s), localEndpoint(s)));
  }
});
