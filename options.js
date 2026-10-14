const FIELDS = [
  "endpoint",
  "model",
  "prompt",
  "criteriaTrue",
  "criteriaFalse",
  "action"
];

let defaults = null;

function $(id) {
  return document.getElementById(id);
}

async function loadDefaults() {
  defaults = await chrome.runtime.sendMessage({ type: "getSettings" });
}

function fillForm(s) {
  $("enabled").checked = !!s.enabled;
  for (const f of FIELDS) $(f).value = s[f] != null ? s[f] : "";
  $("threshold").value = s.threshold;
  $("thresholdOut").textContent = Number(s.threshold).toFixed(2);
  $("useThumbnails").checked = !!s.useThumbnails;
  $("includeMeta").checked = !!s.includeMeta;
  $("includeBadges").checked = !!s.includeBadges;
  $("includeDescription").checked = !!s.includeDescription;
  $("concurrency").value = s.concurrency;
  $("timeoutMs").value = s.timeoutMs;
}

function readForm() {
  const s = { enabled: $("enabled").checked };
  for (const f of FIELDS) s[f] = $(f).value.trim();
  s.threshold = parseFloat($("threshold").value);
  s.useThumbnails = $("useThumbnails").checked;
  s.includeMeta = $("includeMeta").checked;
  s.includeBadges = $("includeBadges").checked;
  s.includeDescription = $("includeDescription").checked;
  s.concurrency = Math.max(1, Math.min(10, parseInt($("concurrency").value, 10) || 3));
  s.timeoutMs = Math.max(1000, parseInt($("timeoutMs").value, 10) || 30000);
  return s;
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function ensureHostPermission(endpoint) {
  try {
    const origin = new URL(endpoint).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

async function save() {
  const s = readForm();
  if (!s.endpoint || !s.model || !s.prompt) {
    setStatus("Endpoint, modèle et prompt sont obligatoires.", "err");
    return;
  }
  const granted = await ensureHostPermission(s.endpoint);
  if (!granted) {
    setStatus("Permission d'accès à l'endpoint refusée : le test peut échouer.", "err");
  }
  await chrome.storage.sync.set(s);
  setStatus("Enregistré.", "ok");
}

async function test() {
  const s = readForm();
  const granted = await ensureHostPermission(s.endpoint);
  if (!granted) {
    setStatus("Permission d'accès refusée pour " + s.endpoint, "err");
    return;
  }
  setStatus("Test en cours…");
  $("testBox").classList.remove("hidden");
  $("testOut").textContent = "Envoi de la requête…";
  const res = await chrome.runtime.sendMessage({ type: "test", settings: s });
  if (res && res.ok) {
    setStatus("Connexion OK.", "ok");
    $("testOut").textContent = JSON.stringify(
      {
        modele: s.model,
        endpoint: s.endpoint,
        probabilite_vrai: res.probability,
        gardee: res.keep,
        seuil: s.threshold
      },
      null,
      2
    );
  } else {
    setStatus("Échec du test.", "err");
    let hint = "";
    if (/403/.test((res && res.error) || "")) {
      hint =
        "\n\n403 = Ollama bloque l'origine de l'extension.\n" +
        "Recharge l'extension (chrome://extensions) : elle retire normalement ce blocage.\n" +
        "Sinon, relance Ollama en autorisant l'origine :\n" +
        "  OLLAMA_ORIGINS='chrome-extension://*' ollama serve";
    }
    $("testOut").textContent =
      "Erreur : " + ((res && res.error) || "inconnue") +
      hint +
      "\n\nVérifie aussi que le modèle est installé :\n" +
      "  ollama pull clef-flash\n" +
      "  curl " + s.endpoint + "/v1/systemone";
  }
}

async function reset() {
  await chrome.storage.sync.set(defaults);
  fillForm(defaults);
  setStatus("Réglages par défaut restaurés.", "ok");
}

async function init() {
  await loadDefaults();
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  fillForm(s);

  $("threshold").addEventListener("input", () => {
    $("thresholdOut").textContent = parseFloat($("threshold").value).toFixed(2);
  });
  $("save").addEventListener("click", save);
  $("test").addEventListener("click", test);
  $("reset").addEventListener("click", reset);
}

init();
