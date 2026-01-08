// =====================
// CONFIG
// =====================
const PLACE_ID = 109983668079237;
const LIMIT = 100;
const RATE_LIMIT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min cache

let lastJoinedServer = null;

// =====================
// STORAGE SAFE WRAPPER
// =====================
const storage = {
  async get(key) {
    // extension context
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise(resolve => chrome.storage.local.get(key, d => resolve(d[key] ?? null)));
    }
    // fallback (if you opened popup.html directly)
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  },
  async set(key, value) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
    }
    localStorage.setItem(key, JSON.stringify(value));
  }
};

const settingsStore = {
  async load() {
    return new Promise(resolve => {
      if (chrome?.storage?.local) {
        chrome.storage.local.get("settings", d => resolve(d.settings || {}));
      } else {
        resolve(JSON.parse(localStorage.getItem("settings") || "{}"));
      }
    });
  },
  save(data) {
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ settings: data });
    } else {
      localStorage.setItem("settings", JSON.stringify(data));
    }
  }
};

async function saveLastJoined(server) {
  lastJoinedServer = server;
  await storage.set("lastJoinedServer", server);
}

async function loadLastJoined() {
  lastJoinedServer = await storage.get("lastJoinedServer");
}


// =====================
// SOUNDS (Howler)
// =====================
const clickSound = new Howl({ src: ["sounds/click.mp3"], volume: 0.3 });
const doneSound  = new Howl({ src: ["sounds/done.mp3"],  volume: 0.22 });

function playClick() {
  clickSound.rate(0.95 + Math.random() * 0.1);
  clickSound.play();
}

function playDone() {
  // avoid crash if file missing
  try { doneSound.play(); } catch {}
}

// =====================
// Toastify
// =====================
function notify(text, type = "info") {
  const colors = {
    info: "#1f2430",
    success: "#1e3a2b",
    warn: "#3a2f1e",
    error: "#3a1e1e"
  };

  if (typeof Toastify === "undefined") {
    return; // optional
  }

  Toastify({
    text,
    duration: 2500,
    gravity: "bottom",
    position: "right",
    style: {
      background: colors[type] || colors.info,
      border: "1px solid #2a3244",
      borderRadius: "8px",
      fontSize: "12px",
      color: "#e6e6e6"
    }
  }).showToast();
}

// =====================
// STATE
// =====================
let currentCursor = "";
let nextCursor = null;
let endReached = false;
let loading = false;

// totals
let totalServers = 0;
let serversWithPlayers = 0;
let serversWithPlayersNoOwner = 0;
let maxPages = 1;
let currentPage = 1;

// action-aware resume
let pendingAction = { reset: true, useCurrent: false, next: false };

// totals scan control
let abortTotals = false;

// =====================
// ELEMENTS
// =====================
const serversDiv = document.getElementById("servers");
const statusEl = document.getElementById("status");
const pageInfoEl = document.getElementById("pageInfo");
const totalServersEl = document.getElementById("totalServers");
const serversWithPlayersEl = document.getElementById("serversWithPlayers");
const serversWithPlayersNoOwnerEl = document.getElementById("serversWithPlayersNoOwner"); 
const showOwnerInsideCb = document.getElementById("showOwnerInside");
const onlyOnePlayerCb = document.getElementById("onlyOnePlayer");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const liveCount = document.getElementById("liveCount");

const skipTotalsCb = document.getElementById("skipTotals");
const skipScanBtn = document.getElementById("skipScan");
const scanTotalsAgainBtn = document.getElementById("scanTotalsAgain");
const useDeeplinkCb = document.getElementById("useDeeplink");

// =====================
// UI HELPERS
// =====================

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

useDeeplinkCb.addEventListener("change", () => {
  settingsStore.save({
    skipTotals: skipTotalsCb.checked,
    showOwnerInside: showOwnerInsideCb.checked,
    onlyOnePlayer: onlyOnePlayerCb?.checked,
    useDeeplink: useDeeplinkCb.checked
  });
});


showOwnerInsideCb.addEventListener("change", () => {
  settingsStore.save({
    skipTotals: skipTotalsCb.checked,
    showOwnerInside: showOwnerInsideCb.checked,
    onlyOnePlayer: onlyOnePlayerCb?.checked,
    useDeeplink: useDeeplinkCb.checked
  });

  // re-render current page with the new filter
  loadServers({ useCurrent: true });
});

onlyOnePlayerCb.addEventListener("change", () => {
  settingsStore.save({
    skipTotals: skipTotalsCb.checked,
    showOwnerInside: showOwnerInsideCb.checked,
    onlyOnePlayer: onlyOnePlayerCb?.checked,
    useDeeplink: useDeeplinkCb.checked
  });

  loadServers({ useCurrent: true });
});


skipTotalsCb.addEventListener("change", () => {
  settingsStore.save({
    skipTotals: skipTotalsCb.checked,
    showOwnerInside: showOwnerInsideCb.checked,
    onlyOnePlayer: onlyOnePlayerCb?.checked,
    useDeeplink: useDeeplinkCb.checked
  });
});

function setButtonsDisabled(v) {
  // Don’t disable the Skip button inside the loading overlay
  document.querySelectorAll("button").forEach(b => {
    if (b.id === "skipScan") return;
    b.disabled = v;
  });
}

function showLoading(show) {
  loadingOverlay.classList.toggle("hidden", !show);
}

function setStatus(t) {
  statusEl.textContent = t;
}

function updateTopStats() {
  totalServersEl.textContent = totalServers ? String(totalServers) : "—";
  serversWithPlayersEl.textContent = serversWithPlayers ? String(serversWithPlayers) : "—";
  serversWithPlayersNoOwnerEl.textContent = serversWithPlayersNoOwner ? String(serversWithPlayersNoOwner) : "—";
}

function updatePageInfo() {
  // if maxPages unknown, show —
  const mp = maxPages ? maxPages : "—";
  pageInfoEl.textContent = `Page ${currentPage} / ${mp}`;
}

function showSkeletons() {
  serversDiv.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement("div");
    sk.className = "skeleton";
    serversDiv.appendChild(sk);
  }
}

function clearAllJoinedBadges() {
  document.querySelectorAll(".joined-badge").forEach(badge => {
    badge.remove();
  });
}
// =====================
// ROBLOX TAB
// =====================
async function getRobloxTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url && t.url.includes("roblox.com"));
}

// =====================
// SERVER PLAYER CHECK
// =====================


function serverHasPlayers(s) {
  const ownerId = s.owner?.id;

  // primary: playerTokens
  if (Array.isArray(s.playerTokens) && s.playerTokens.length > 0) return true;

  // fallback: players[] but NOT owner
  if (Array.isArray(s.players) && s.players.some(p => p.id !== ownerId)) return true;

  return false;
}

function ownerIsInside(s) {
  const ownerId = s.owner?.id;
  return Array.isArray(s.players) && ownerId && s.players.some(p => p.id === ownerId);
}

function countPlayersExcludingOwner(s) {
  const ownerId = s.owner?.id;

  // playerTokens is best when present, but it can sometimes be empty even when players[] exists.
  if (Array.isArray(s.playerTokens) && s.playerTokens.length > 0) {
    return s.playerTokens.length; // tokens don’t include owner info
  }

  if (Array.isArray(s.players)) {
    return s.players.filter(p => p.id !== ownerId).length;
  }

  return 0;
}

// =====================
// CACHE (Totals)
// =====================
async function loadTotalsCache() {
  const cached = await storage.get("totalsCache");
  if (!cached) return false;
  if (Date.now() - cached.ts > CACHE_TTL_MS) return false;

  totalServers = cached.totalServers;
  serversWithPlayers = cached.serversWithPlayers;
  serversWithPlayersNoOwner = cached.serversWithPlayersNoOwner || 0;
  maxPages = cached.maxPages;

  updateTopStats();
  updatePageInfo();
  return true;
}

async function saveTotalsCache() {
  await storage.set("totalsCache", {
    ts: Date.now(),
    totalServers,
    serversWithPlayers,
    serversWithPlayersNoOwner,
    maxPages
  });
}

// =====================
// TOTAL SCAN (cursor-walk, live updates)
// =====================
async function fetchTotals(options = {}) {
  const force = !!options.force;
  if (!force && skipTotalsCb?.checked) {
    // if skipping totals, try cache; if no cache, leave —
    await loadTotalsCache();
    return;
  }

abortTotals = false;
  showLoading(true);
  setButtonsDisabled(true);

  loadingText.textContent = "Scanning private servers…";
  liveCount.textContent = "0 scanned";

  let cursor = "";
  let scanned = 0;
  let pages = 0;

  totalServers = 0;
  serversWithPlayers = 0;
  serversWithPlayersNoOwner = 0;
  maxPages = 1; // temporary

  while (!abortTotals) {
    const url =
      `https://games.roblox.com/v1/games/${PLACE_ID}/private-servers` +
      `?limit=${LIMIT}&sortOrder=Desc&excludeFullGames=false&cursor=${cursor}`;

    const res = await fetch(url, { credentials: "include" });

    if (res.status === 429) {
      loadingText.textContent = "Rate limited… waiting 5s";
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      continue;
    }

    const json = await res.json();
    const data = json.data || [];

    pages++;
    scanned += data.length;
    totalServers += data.length;

   for (const s of data) {
  if (!serverHasPlayers(s)) continue;

  serversWithPlayers++; // any

  // if owner is inside, it's NOT counted as "no owner inside"
  if (!ownerIsInside(s)) {
    serversWithPlayersNoOwner++;
  }
}



    // live UI
    liveCount.textContent = `${scanned} scanned`;
    totalServersEl.textContent = String(totalServers);
    serversWithPlayersEl.textContent = String(serversWithPlayers);
    serversWithPlayersNoOwnerEl.textContent = String(serversWithPlayersNoOwner);

    if (!json.nextPageCursor) {
      cursor = "";
      break;
    }
    cursor = json.nextPageCursor;
  }

  // finalize totals if not aborted
  if (!abortTotals) {
    maxPages = Math.max(1, pages);
    currentPage = 1;
    await saveTotalsCache();
    playDone();
    notify("Totals scan complete", "success");
  } else {
    // aborted: keep whatever partial totals are showing
    notify("Totals scan skipped", "warn");
  }

  showLoading(false);
  setButtonsDisabled(false);
  updatePageInfo();
  setStatus("Ready");
}

// =====================
// RATE LIMIT RESUME (replay exact action)
// =====================
function retrySameActionAfterRateLimit() {
  setStatus("Rate limited — retrying in 5s…");
  setButtonsDisabled(true);
  setTimeout(() => {
    // replay EXACT action user clicked
    loadServers(pendingAction);
  }, RATE_LIMIT_MS);
}

// =====================
// LOAD SERVERS (action-aware)
// =====================
async function loadServers(action = {}) {
  if (loading) return;
  loading = true;

  // remember intent BEFORE doing anything (so 429 can replay)
  pendingAction = {
    reset: !!action.reset,
    useCurrent: !!action.useCurrent,
    next: !!action.next
  };

  setButtonsDisabled(true);

  if (pendingAction.reset) {
    currentCursor = "";
    nextCursor = null;
    endReached = false;
    currentPage = 1;
  }

  // decide cursor based on action
  const cursorToUse =
    pendingAction.useCurrent ? currentCursor :
    pendingAction.next ? nextCursor :
    currentCursor;

  if (pendingAction.next && !nextCursor) {
    loading = false;
    setButtonsDisabled(false);
    notify("Last page reached", "warn");
    return;
  }

  showSkeletons();
  setStatus("Loading servers…");

  const url =
    `https://games.roblox.com/v1/games/${PLACE_ID}/private-servers` +
    `?limit=${LIMIT}&sortOrder=Desc&excludeFullGames=false&cursor=${cursorToUse || ""}`;

  let res;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    loading = false;
    setButtonsDisabled(false);
    setStatus("Network error.");
    return;
  }

  if (res.status === 429) {
    loading = false;
    retrySameActionAfterRateLimit();
    return;
  }
  
  const json = await res.json();
  currentCursor = cursorToUse || "";
  nextCursor = json.nextPageCursor;
  endReached = !nextCursor;

  // store cursor for THIS page
  // page number handling:
  // - next increments
  // - refresh keeps same
  // - reset sets to 1
  if (pendingAction.next) currentPage++;
  if (endReached && maxPages) currentPage = Math.min(currentPage, maxPages);

  // render
  serversDiv.innerHTML = "";
  let shown = 0;

  for (const s of json.data || []) {
    const ownerId = s.owner?.id;

    // owner must not be inside
    const hasOwnerInside = ownerIsInside(s);
    if (hasOwnerInside && !showOwnerInsideCb.checked) continue;

    // must have players (tokens primary)
    if (!serverHasPlayers(s)) continue;

    const count = countPlayersExcludingOwner(s);

    // optional filter: only servers with exactly 1 player (excluding owner)
    if (onlyOnePlayerCb?.checked && count !== 1) continue;
     
    const card = document.createElement("div");
    card.className = "server animate__animated animate__fadeInUp";
    card.dataset.serverId = s.id;
    card.style.setProperty("--animate-duration", "0.22s");

const warn = hasOwnerInside
  ? `<span class="danger" title="Dangerous! Has Owner Inside">⚠</span>`
  : "";

const joinedBadge =
  lastJoinedServer?.id === s.id
    ? `<span class="joined-badge" data-joined-ts="${lastJoinedServer.ts}">
         Recently joined · ${timeAgo(lastJoinedServer.ts)}
       </span>`
    : "";


card.innerHTML = `
  <div class="server-title">
    <span class="srvname">${s.name || "Unnamed Server"}</span>
    ${joinedBadge}
    ${warn}
  </div>
  <div class="server-meta">
    Owner: ${s.owner?.name || "Unknown"} • Players: ${count}
  </div>
  <button class="join">Join</button>
`;

   const dangerEl = card.querySelector(".danger");
if (dangerEl) {
  dangerEl.addEventListener("click", (e) => {
    e.stopPropagation();
    notify("Dangerous! Has Owner Inside", "warn");
  });
}


    card.querySelector(".join").onclick = async () => {
  playClick();

 await saveLastJoined({
  id: s.id,
  ts: Date.now()
});
clearAllJoinedBadges();
const title = card.querySelector(".server-title");

// create badge ONCE
let badge = title.querySelector(".joined-badge");
if (!badge) {
  badge = document.createElement("span");
  badge.className = "joined-badge";
  badge.dataset.joinedTs = lastJoinedServer.ts;
  title.appendChild(badge);
}

// initial text
badge.textContent = `Recently joined · ${timeAgo(lastJoinedServer.ts)}`;

// pin ONCE
serversDiv.prepend(card);


  const robloxTab = await getRobloxTab();
  if (!robloxTab) {
    notify("Open Roblox tab first", "error");
    return;
  }

  if (useDeeplinkCb.checked) {
  const deeplink = `roblox://placeId=${PLACE_ID}&accessCode=${s.accessCode}`;
  chrome.tabs.update(robloxTab.id, { url: deeplink });
} else {
  chrome.scripting.executeScript({
    target: { tabId: robloxTab.id },
    world: "MAIN",
    func: (placeId, code) => {
      if (window.Roblox?.GameLauncher?.joinPrivateGame) {
        Roblox.GameLauncher.joinPrivateGame(placeId, code, null);
      }
    },
    args: [PLACE_ID, s.accessCode]
  });
}


  notify("Joining…", "success");
};


    serversDiv.appendChild(card);
    shown++;
  }
   
  if (lastJoinedServer) {
  const pinnedCard = document.querySelector(
    `.server[data-server-id="${lastJoinedServer.id}"]`
  );
  if (pinnedCard && pinnedCard.parentElement.firstChild !== pinnedCard) {
    pinnedCard.parentElement.prepend(pinnedCard);
  }
}
  updateTopStats();
  updatePageInfo();

  setStatus(
    shown === 0
      ? "No servers found."
      : endReached
        ? `Loaded ${shown} servers. (Last page)`
        : `Loaded ${shown} servers.`
  );
  navigatingBack = false;
  loading = false;
  setButtonsDisabled(false);
}

// =====================
// EVENTS
// =====================
document.getElementById("firstPage").onclick = () => {
  playClick();
  loadServers({ reset: true });
};

document.getElementById("refreshCurrent").onclick = () => {
  playClick();
  loadServers({ useCurrent: true });
};

document.getElementById("next").onclick = () => {
  playClick();
  loadServers({ next: true });
};

// Rescan totals (shows loading overlay)
if (scanTotalsAgainBtn) scanTotalsAgainBtn.onclick = async () => {
  playClick();
  // Force totals scan even if "Skip totals scan" is checked
  await fetchTotals({ force: true });
};

skipScanBtn.onclick = () => {
  abortTotals = true;
  showLoading(false);
  setButtonsDisabled(false);
  playDone();
};

// =====================
// INIT
// =====================
(async () => {
  await loadLastJoined();
  // show cached totals immediately if available (fast UI), then rescan unless skipped
  // restore saved settings
const savedSettings = await settingsStore.load();

if (savedSettings.skipTotals !== undefined) {
  skipTotalsCb.checked = savedSettings.skipTotals;
}

if (savedSettings.showOwnerInside !== undefined) {
  showOwnerInsideCb.checked = savedSettings.showOwnerInside;
}

if (savedSettings.onlyOnePlayer !== undefined && onlyOnePlayerCb) {
  onlyOnePlayerCb.checked = savedSettings.onlyOnePlayer;
}

if (savedSettings.useDeeplink !== undefined) {
  useDeeplinkCb.checked = savedSettings.useDeeplink;
}


setInterval(() => {
  if (!lastJoinedServer) return;

  const badge = document.querySelector(
    `.server[data-server-id="${lastJoinedServer.id}"] .joined-badge`
  );
  if (!badge) return;

  badge.textContent = `Recently joined · ${timeAgo(lastJoinedServer.ts)}`;
}, 1000);




  await loadTotalsCache();
  updateTopStats();
  updatePageInfo();

  if (!skipTotalsCb.checked) {
  await fetchTotals();
}
  await loadServers({ reset: true });
})();
