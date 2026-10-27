const CLOUDFLARE_FIELDS = [
  "cloudflareAccountId",
  "cloudflareApiToken",
  "cloudflareModel"
];
const OLLAMA_FIELDS = ["ollamaEndpoint", "ollamaModel"];
const FASTFLOWLM_FIELDS = ["fastflowlmEndpoint", "fastflowlmModel"];
const SHARED_FIELDS = ["prompt", "criteriaTrue", "criteriaFalse", "action"];
const LOCAL_PROVIDERS = ["ollama", "fastflowlm"];

let defaults = null;

function $(id) {
  return document.getElementById(id);
}

async function loadDefaults() {
  defaults = await chrome.runtime.sendMessage({ type: "getSettings" });
}

function provider() {
  const v = $("provider").value;
  return LOCAL_PROVIDERS.includes(v) ? v : "cloudflare";
}

// Chaque provider dispose d'une section id="<provider>Section" à afficher/masquer.
const PROVIDER_SECTIONS = ["cloudflareSection", "ollamaSection", "fastflowlmSection"];

function syncProviderUI() {
  const p = provider();
  for (const id of PROVIDER_SECTIONS) $(id).classList.toggle("hidden", id !== p + "Section");
}

function fillForm(s) {
  $("enabled").checked = !!s.enabled;
  $("provider").value = s.provider === "ollama" ? "ollama" : "cloudflare";
  for (const f of CLOUDFLARE_FIELDS) $(f).value = s[f] != null ? s[f] : "";
  for (const f of OLLAMA_FIELDS) $(f).value = s[f] != null ? s[f] : "";
  for (const f of FASTFLOWLM_FIELDS) $(f).value = s[f] != null ? s[f] : "";
  for (const f of SHARED_FIELDS) $(f).value = s[f] != null ? s[f] : "";
  $("threshold").value = s.threshold;
  $("thresholdOut").textContent = Number(s.threshold).toFixed(2);
  $("useThumbnails").checked = !!s.useThumbnails;
  $("includeMeta").checked = !!s.includeMeta;
  $("includeBadges").checked = !!s.includeBadges;
  $("includeDescription").checked = !!s.includeDescription;
  $("concurrency").value = s.concurrency;
  $("timeoutMs").value = s.timeoutMs;
  syncProviderUI();
}

function readForm() {
  const s = { enabled: $("enabled").checked, provider: provider() };
  for (const f of CLOUDFLARE_FIELDS) s[f] = $(f).value.trim();
  for (const f of OLLAMA_FIELDS) s[f] = $(f).value.trim();
  for (const f of FASTFLOWLM_FIELDS) s[f] = $(f).value.trim();
  for (const f of SHARED_FIELDS) s[f] = $(f).value.trim();
  s.threshold = parseFloat($("threshold").value);
  s.useThumbnails = $("useThumbnails").checked;
  s.includeMeta = $("includeMeta").checked;
  s.includeBadges = $("includeBadges").checked;
  s.includeDescription = $("includeDescription").checked;
  s.concurrency = Math.max(1, Math.min(10, parseInt($("concurrency").value, 10) || 3));
  s.timeoutMs = Math.max(1000, parseInt($("timeoutMs").value, 10) || 30000);
  return s;
}

function validate(s) {
  if (!s.prompt) return "Le prompt de filtrage est obligatoire.";
  if (LOCAL_PROVIDERS.includes(s.provider)) {
    const epField = s.provider === "fastflowlm" ? "fastflowlmEndpoint" : "ollamaEndpoint";
    const modelField = s.provider === "fastflowlm" ? "fastflowlmModel" : "ollamaModel";
    if (!s[epField] || !s[modelField]) {
      return "Endpoint et modèle locaux sont obligatoires.";
    }
  } else if (!s.cloudflareAccountId || !s.cloudflareApiToken || !s.cloudflareModel) {
    return "Account ID, jeton API et modèle Cloudflare sont obligatoires.";
  }
  return null;
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
  const problem = validate(s);
  if (problem) {
    setStatus(problem, "err");
    return;
  }
  let warning = "";
  if (LOCAL_PROVIDERS.includes(s.provider)) {
    const endpoint = s.provider === "fastflowlm" ? s.fastflowlmEndpoint : s.ollamaEndpoint;
    const granted = await ensureHostPermission(endpoint);
    if (!granted) warning = "Permission d'accès à l'endpoint local refusée : le test peut échouer.";
  }
  await chrome.storage.sync.set(s);
  setStatus(warning || "Enregistré.", warning ? "err" : "ok");
}

async function test() {
  const s = readForm();
  const problem = validate(s);
  if (problem) {
    setStatus(problem, "err");
    return;
  }
  if (LOCAL_PROVIDERS.includes(s.provider)) {
    const endpoint = s.provider === "fastflowlm" ? s.fastflowlmEndpoint : s.ollamaEndpoint;
    const granted = await ensureHostPermission(endpoint);
    if (!granted) {
      setStatus("Permission d'accès refusée pour " + endpoint, "err");
      return;
    }
  }

  setStatus("Test en cours…");
  $("testBox").classList.remove("hidden");
  $("testOut").textContent = "Envoi de la requête…";
  const res = await chrome.runtime.sendMessage({ type: "test", settings: s });

  if (res && res.ok) {
    setStatus("Connexion OK.", "ok");
    $("testOut").textContent = JSON.stringify(
      {
        fournisseur: s.provider === "ollama" ? "Ollama (local)"
          : s.provider === "fastflowlm" ? "FastFlowLM (local)"
          : "Cloudflare Workers AI",
        modele: s.provider === "ollama" ? s.ollamaModel
          : s.provider === "fastflowlm" ? s.fastflowlmModel
          : s.cloudflareModel,
        probabilite_vrai: res.probability,
        gardee: res.keep,
        seuil: s.threshold
      },
      null,
      2
    );
    return;
  }

  setStatus("Échec du test.", "err");
  const err = (res && res.error) || "";
  let hint = "";
  if (s.provider === "cloudflare") {
    if (/401|403/.test(err)) {
      hint =
        "\n\n401/403 = jeton API invalide ou dépourvu de la permission « Workers AI ».\n" +
        "Vérifie le jeton dans Cloudflare (My Profile → API Tokens) et l'Account ID associé.";
    } else if (/404/.test(err)) {
      hint =
        "\n\n404 = Account ID ou modèle introuvable.\n" +
        "Vérifie l'Account ID et le nom du modèle (ex. @cf/cloudflare/clef-flash).";
    } else if (/Account ID|jeton API/.test(err)) {
      hint = "\n\nRenseigne l'Account ID et le jeton API Cloudflare dans les réglages.";
    }
  } else {
    if (/403/.test(err)) {
      hint =
        "\n\n403 = le serveur local bloque l'origine de l'extension.\n" +
        "Recharge l'extension (chrome://extensions) : elle retire normalement ce blocage.";
    }
    if (s.provider === "fastflowlm") {
      hint +=
        "\n\nVérifie que FastFlowLM est lancé avec le modèle de décision :\n" +
        "  flm serve --decision " + s.fastflowlmModel + "\n" +
        "et que le modèle est téléchargé :\n" +
        "  flm pull " + s.fastflowlmModel;
    } else {
      hint +=
        "\n\nVérifie aussi que le modèle est installé :\n" +
        "  ollama pull " + s.ollamaModel;
    }
  }
  $("testOut").textContent = "Erreur : " + (err || "inconnue") + hint;
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
  $("provider").addEventListener("change", syncProviderUI);
  $("save").addEventListener("click", save);
  $("test").addEventListener("click", test);
  $("reset").addEventListener("click", reset);
}

init();
