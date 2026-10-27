function $(id) {
  return document.getElementById(id);
}

let tabId = null;
let onYouTube = false;
let poll = null;

function setStats(s) {
  s = s || {};
  $("s-scanned").textContent = s.scanned ?? "–";
  $("s-analyzed").textContent = s.analyzed ?? "–";
  $("s-hidden").textContent = s.hidden ?? "–";
  $("s-kept").textContent = s.kept ?? "–";
  $("s-errors").textContent = s.errors ?? "–";
  $("s-queue").textContent = s.queue ?? "–";
}

function renderRecent(list) {
  const ul = $("recent");
  ul.innerHTML = "";
  if (!list || !list.length) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="m">Aucune décision pour le moment.</span>';
    ul.appendChild(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = r.title || "(sans titre)";
    title.title = r.title || "";

    const meta = document.createElement("div");
    meta.className = "m";
    const left = document.createElement("span");
    left.textContent = r.channel || "";
    const right = document.createElement("span");

    if (r.error) {
      left.textContent = r.error;
      right.innerHTML = '<span class="pill err">erreur</span>';
    } else {
      const pct = Math.round((r.probability || 0) * 100) + "%";
      right.innerHTML =
        (r.keep
          ? '<span class="pill keep">gardée</span> '
          : '<span class="pill drop">filtrée</span> ') + pct;
    }
    meta.appendChild(left);
    meta.appendChild(right);
    li.appendChild(title);
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

async function loadSummary() {
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  $("enabled").checked = !!s.enabled;
  const action =
    s.action === "blur" ? "floutées" : s.action === "mark" ? "marquées" : "masquées";
  const isOllama = s.provider === "ollama";
  const model = isOllama ? s.ollamaModel : s.cloudflareModel;
  const providerLabel = isOllama ? "Ollama" : "Cloudflare";
  $("summary").textContent =
    `${model} · ${providerLabel}\nseuil ${Number(s.threshold).toFixed(2)} · filtrées ${action}`;
  return s;
}

async function refreshStats() {
  if (!onYouTube || tabId == null) {
    setStats({});
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "getStats" });
    if (res && res.ok) {
      setStats(res.stats);
      $("pageNote").textContent = res.running
        ? "Actif sur cet onglet."
        : "Inactif (page d'accueil YouTube requise, ou extension désactivée).";
    }
  } catch (_) {
    setStats({});
    $("pageNote").textContent = "Recharge la page YouTube pour activer le scan.";
  }
}

async function refreshRecent() {
  const res = await chrome.runtime.sendMessage({ type: "getRecent" });
  renderRecent(res && res.recent);
}

async function init() {
  await loadSummary();

  $("enabled").addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ enabled: e.target.checked });
    setTimeout(refreshStats, 300);
  });
  $("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  onYouTube = !!(tab && tab.url && /youtube\.com/.test(tab.url));

  if (!onYouTube) {
    $("pageNote").textContent = "Ouvre youtube.com pour utiliser le filtrage.";
    setStats({});
  }

  $("rescan").addEventListener("click", async () => {
    if (!onYouTube || tabId == null) return;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "rescan" });
      if (res && res.ok) setStats(res.stats);
      $("pageNote").textContent = "Nouveau scan lancé.";
    } catch (_) {
      $("pageNote").textContent = "Recharge la page YouTube pour activer le scan.";
    }
    refreshRecent();
  });

  $("clear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearRecent" });
    renderRecent([]);
  });

  await refreshStats();
  await refreshRecent();

  poll = setInterval(() => {
    refreshStats();
  }, 1000);
  setInterval(refreshRecent, 2500);

  window.addEventListener("unload", () => {
    if (poll) clearInterval(poll);
  });
}

init();
