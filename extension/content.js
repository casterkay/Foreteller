const ROOT_ID = "foreteller-youtube-panel";
const POSITIVE_EDGE_THRESHOLD = 0.1;
const DEFAULT_SETTINGS = Object.freeze({
  serverPort: 4318,
  eventUrl: "",
  customTitle: "Live mention forecast",
  customTerms: "Artificial intelligence\nEconomy\nOne more thing",
  speaker: "primary speaker",
});

let panel;
let pollTimer;
let clockTimer;
let backendPort = DEFAULT_SETTINGS.serverPort;
let mountGeneration = 0;
let mountedVideoUrl;
const pendingMutations = new Set();

document.addEventListener("yt-navigate-finish", mountForCurrentVideo);
mountForCurrentVideo();

async function mountForCurrentVideo() {
  const currentVideoUrl = location.pathname === "/watch" && new URL(location.href).searchParams.has("v")
    ? canonicalVideoUrl()
    : undefined;
  if (currentVideoUrl !== undefined && currentVideoUrl === mountedVideoUrl && panel !== undefined) return;
  const generation = ++mountGeneration;
  mountedVideoUrl = undefined;
  clearTimers();
  document.getElementById(ROOT_ID)?.remove();
  panel = undefined;

  // Navigation only tears down this panel. The one global session outlives the view,
  // so ending it stays an explicit operator action or the event horizon; a navigating
  // tab must never stop monitoring that another tab is displaying. Letting in-flight
  // mutations settle first keeps a late start from landing after the remount.
  await Promise.allSettled([...pendingMutations]);
  if (generation !== mountGeneration) return;

  if (currentVideoUrl === undefined) return;

  const sidebar = await findSidebar();
  if (generation !== mountGeneration || sidebar === null || location.pathname !== "/watch") return;
  const host = document.createElement("section");
  host.id = ROOT_ID;
  host.setAttribute("aria-label", "Foreteller mention forecasts");
  sidebar.prepend(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = template();
  const mountedPanel = createPanel(shadow, generation);
  panel = mountedPanel;
  await mountedPanel.loadSettings();
  if (generation !== mountGeneration) {
    host.remove();
    return;
  }
  mountedVideoUrl = currentVideoUrl;
  await refresh(generation, mountedPanel);
  if (generation !== mountGeneration) return;
  pollTimer = setInterval(() => void refresh(generation, mountedPanel), 1_000);
  clockTimer = setInterval(() => {
    if (generation === mountGeneration) mountedPanel.updateFooter();
  }, 1_000);
}

function createPanel(root, generation) {
  const elements = {
    title: root.querySelector(".event-title"),
    status: root.querySelector(".connection-status"),
    coverage: root.querySelector(".coverage-status"),
    legend: root.querySelector(".legend"),
    markets: root.querySelector(".markets"),
    footer: root.querySelector(".footer-status"),
    error: root.querySelector(".error"),
    settings: root.querySelector(".settings"),
    settingsButton: root.querySelector(".settings-button"),
    form: root.querySelector("form"),
    eventUrl: root.querySelector('[name="eventUrl"]'),
    serverPort: root.querySelector('[name="serverPort"]'),
    customFields: root.querySelector(".custom-fields"),
    customTitle: root.querySelector('[name="customTitle"]'),
    customTerms: root.querySelector('[name="customTerms"]'),
    speaker: root.querySelector('[name="speaker"]'),
    stopButton: root.querySelector(".stop-button"),
    submitButton: root.querySelector('.settings button[type="submit"]'),
  };
  let snapshot = null;

  elements.settingsButton.addEventListener("click", () => {
    const open = elements.settings.hidden;
    elements.settings.hidden = !open;
    elements.settingsButton.setAttribute("aria-expanded", String(open));
  });
  elements.eventUrl.addEventListener("input", updateCustomFieldVisibility);
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    elements.submitButton.disabled = true;
    elements.submitButton.textContent = "Starting…";
    const settings = readSettings();
    backendPort = settings.serverPort;
    await chrome.storage.sync.set({ foretellerSettings: settings });
    if (generation !== mountGeneration) return;
    const request = api("PUT", {
      youtubeUrl: canonicalVideoUrl(),
      eventUrl: settings.eventUrl,
      customTitle: settings.customTitle,
      customTerms: parseTerms(settings.customTerms),
      speaker: settings.speaker,
    });
    pendingMutations.add(request);
    const response = await request.finally(() => pendingMutations.delete(request));
    if (generation !== mountGeneration) return;
    elements.submitButton.disabled = false;
    elements.submitButton.textContent = "Start forecasting";
    if (!response.ok) {
      setError(response.error);
      return;
    }
    elements.settings.hidden = true;
    elements.settingsButton.setAttribute("aria-expanded", "false");
    render(response.body);
  });
  elements.stopButton.addEventListener("click", async () => {
    elements.stopButton.disabled = true;
    const request = api("DELETE");
    pendingMutations.add(request);
    const response = await request.finally(() => pendingMutations.delete(request));
    if (generation !== mountGeneration) return;
    elements.stopButton.disabled = false;
    if (!response.ok) setError(response.error);
    else await refresh(generation, { render, setError });
  });

  function updateCustomFieldVisibility() {
    const hasEvent = elements.eventUrl.value.trim().length > 0;
    elements.customFields.hidden = hasEvent;
    elements.customTitle.disabled = hasEvent;
    elements.customTerms.disabled = hasEvent;
  }

  function readSettings() {
    return {
      eventUrl: elements.eventUrl.value.trim(),
      serverPort: Number(elements.serverPort.value),
      customTitle: elements.customTitle.value.trim(),
      customTerms: elements.customTerms.value,
      speaker: elements.speaker.value.trim(),
    };
  }

  function setError(message) {
    elements.error.textContent = message;
    elements.error.hidden = message.length === 0;
  }

  function render(nextSnapshot) {
    if (nextSnapshot.youtubeUrl !== null && nextSnapshot.youtubeUrl !== mountedVideoUrl) {
      renderOtherVideo();
      return;
    }
    snapshot = nextSnapshot;
    elements.title.textContent = nextSnapshot.title;
    elements.status.textContent = statusLabel(nextSnapshot.status);
    elements.status.dataset.status = nextSnapshot.status;
    elements.coverage.textContent = nextSnapshot.comparisonCoverage === "partial_event"
      ? "Transcript began after the event window opened; edge labels are hidden"
      : "";
    elements.coverage.hidden = elements.coverage.textContent.length === 0;
    elements.stopButton.hidden = nextSnapshot.status === "idle";
    const hasPolymarket = nextSnapshot.mode === "event";
    elements.legend.hidden = nextSnapshot.status === "idle";
    elements.legend.querySelector(".pm-key").hidden = !hasPolymarket;
    setError(nextSnapshot.error ?? "");
    elements.markets.replaceChildren();
    for (const market of nextSnapshot.markets) {
      elements.markets.append(renderMarket(
        market,
        hasPolymarket,
        nextSnapshot.comparisonCoverage === "full_event",
      ));
    }
    if (nextSnapshot.status === "idle") {
      elements.settings.hidden = false;
      elements.settingsButton.setAttribute("aria-expanded", "true");
    }
    updateFooter();
  }

  /**
   * Forecasts for another live source say nothing about this video, so they are
   * withheld rather than shown against it.
   */
  function renderOtherVideo() {
    snapshot = null;
    elements.title.textContent = "Foreteller 预言家";
    elements.status.textContent = "Monitoring another video";
    elements.status.dataset.status = "idle";
    elements.coverage.textContent = "Starting here replaces the monitored video";
    elements.coverage.hidden = false;
    elements.legend.hidden = true;
    elements.markets.replaceChildren();
    elements.stopButton.hidden = true;
    setError("");
    elements.settings.hidden = false;
    elements.settingsButton.setAttribute("aria-expanded", "true");
    updateFooter();
  }

  function updateFooter() {
    if (snapshot?.startedAtMs === null || snapshot?.startedAtMs === undefined) {
      elements.footer.textContent = "Waiting to start";
      return;
    }
    const elapsed = Math.max(0, Date.now() - snapshot.startedAtMs);
    elements.footer.textContent = `${formatElapsed(elapsed)} elapsed · Jev ${snapshot.forecastUpdateHz.toFixed(2)} Hz`;
  }

  return {
    render,
    updateFooter,
    setError,
    async loadSettings() {
      const stored = await chrome.storage.sync.get("foretellerSettings");
      if (generation !== mountGeneration) return;
      const settings = { ...DEFAULT_SETTINGS, ...(stored.foretellerSettings ?? {}) };
      backendPort = settings.serverPort;
      elements.serverPort.value = String(settings.serverPort);
      elements.eventUrl.value = settings.eventUrl;
      elements.customTitle.value = settings.customTitle;
      elements.customTerms.value = settings.customTerms;
      elements.speaker.value = settings.speaker;
      updateCustomFieldVisibility();
    },
  };
}

function renderMarket(market, hasPolymarket, edgeIsComparable) {
  const row = document.createElement("article");
  row.className = `market${hasPolymarket ? "" : " jev-only"}`;
  const header = document.createElement("div");
  header.className = "market-header";
  const term = document.createElement("span");
  term.className = "term";
  term.textContent = market.term;
  header.append(term);

  if (
    edgeIsComparable &&
    hasPolymarket &&
    market.polymarketYesPrice !== null &&
    market.jevProbability !== null
  ) {
    const difference = market.jevProbability - market.polymarketYesPrice;
    const edge = document.createElement("span");
    edge.className = `edge${difference >= POSITIVE_EDGE_THRESHOLD ? " considerable" : ""}`;
    edge.textContent = `${difference >= 0 ? "+" : ""}${Math.round(difference * 100)} pp`;
    header.append(edge);
  }
  row.append(header);

  const values = document.createElement("div");
  values.className = "values";
  if (hasPolymarket) values.append(valueLabel("PM", market.polymarketYesPrice, "¢"));
  values.append(valueLabel("Jev", market.jevProbability, "%"));
  row.append(values);

  const track = document.createElement("div");
  track.className = "track";
  track.setAttribute("role", "img");
  track.setAttribute("aria-label", marketAriaLabel(market, hasPolymarket));
  if (hasPolymarket && market.polymarketYesPrice !== null && market.jevProbability !== null) {
    const gap = document.createElement("span");
    gap.className = "gap";
    gap.style.left = `${Math.min(market.polymarketYesPrice, market.jevProbability) * 100}%`;
    gap.style.width = `${Math.abs(market.jevProbability - market.polymarketYesPrice) * 100}%`;
    track.append(gap);
  }
  if (hasPolymarket && market.polymarketYesPrice !== null) {
    track.append(marker("pm", market.polymarketYesPrice));
  }
  if (market.jevProbability !== null) track.append(marker("jev", market.jevProbability));
  row.append(track);

  const axis = document.createElement("div");
  axis.className = "axis";
  axis.innerHTML = "<span>0</span><span>0.5</span><span>1</span>";
  row.append(axis);
  return row;
}

function marker(kind, value) {
  const element = document.createElement("span");
  element.className = `marker ${kind}`;
  element.style.left = `${value * 100}%`;
  return element;
}

function valueLabel(name, value, suffix) {
  const label = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = value === null ? "Awaiting data" : `${Math.round(value * 100)}${suffix}`;
  label.append(`${name} `, strong);
  return label;
}

function marketAriaLabel(market, hasPolymarket) {
  const parts = [market.term];
  if (hasPolymarket) {
    parts.push(market.polymarketYesPrice === null
      ? "Polymarket price unavailable"
      : `Polymarket YES ${Math.round(market.polymarketYesPrice * 100)} percent`);
  }
  parts.push(market.jevProbability === null
    ? "Jev forecast unavailable"
    : `Jev forecast ${Math.round(market.jevProbability * 100)} percent`);
  return parts.join(", ");
}

async function refresh(generation, mountedPanel) {
  const response = await api("GET");
  if (generation !== mountGeneration) return;
  if (!response.ok) {
    mountedPanel.setError(response.error);
    return;
  }
  mountedPanel.render(response.body);
}

async function api(method, body) {
  try {
    return await chrome.runtime.sendMessage({
      type: "foreteller-api",
      method,
      port: backendPort,
      body,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : "Foreteller extension context is unavailable",
    };
  }
}

function canonicalVideoUrl() {
  const videoId = new URL(location.href).searchParams.get("v");
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId ?? "")}`;
}

function parseTerms(value) {
  return [...new Set(value.split("\n").map((term) => term.trim()).filter(Boolean))];
}

function statusLabel(status) {
  return {
    idle: "Not running",
    starting: "Starting",
    live: "Live",
    ended: "Event ended",
    error: "Needs attention",
  }[status] ?? "Unknown";
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clearTimers() {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
}

async function findSidebar() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sidebar = document.querySelector("#secondary-inner") ?? document.querySelector("#secondary");
    if (sidebar !== null) return sidebar;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function template() {
  return `
    <style>
      :host { display:block; margin:0 0 16px; color-scheme:light dark; }
      * { box-sizing:border-box; }
      .panel { --bg:light-dark(#fff,#181818); --text:light-dark(#20242c,#f1f1f1); --muted:light-dark(#687080,#aaa); --line:light-dark(#e5e7eb,#383838); --track:light-dark(#edf0f5,#33373f); --pm:light-dark(#2563eb,#72a4ff); --jev:light-dark(#7756d8,#b29aff); --positive:light-dark(#176b45,#83e6ad); --positive-bg:light-dark(#eaf7ef,#17372a); background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:12px; overflow:hidden; font:14px/1.45 Roboto,Arial,sans-serif; box-shadow:0 4px 18px #0000000a; }
      button,input,textarea { font:inherit; }
      button { color:inherit; }
      .header { padding:18px 20px 15px; }
      .top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .settings-button { min-height:36px; padding:7px 9px; border:0; border-radius:8px; background:transparent; }
      .settings-button:hover { background:var(--track); }
      h2 { min-width:0; margin:0; font-size:18px; line-height:1.35; font-weight:500; overflow-wrap:anywhere; letter-spacing:0; }
      .status-row { display:flex; align-items:center; gap:7px; color:var(--muted); font-size:12px; }
      .connection-status::before { content:""; display:inline-block; width:7px; height:7px; margin-right:7px; border-radius:50%; background:var(--muted); }
      .connection-status[data-status="live"]::before { background:var(--positive); box-shadow:0 0 0 3px color-mix(in srgb,var(--positive) 15%,transparent); }
      .connection-status[data-status="error"]::before { background:#d14b4b; }
      .coverage-status { margin-top:7px; color:var(--muted); font-size:12px; }
      .legend { display:flex; gap:17px; margin-top:15px; color:var(--muted); font-size:12px; }
      .legend span { display:flex; align-items:center; gap:7px; }
      .legend i { display:block; width:9px; height:9px; background:var(--jev); border-radius:2px; transform:rotate(45deg); }
      .legend .pm-key i { background:var(--pm); border-radius:50%; transform:none; }
      .market { padding:17px 20px 14px; border-top:1px solid var(--line); }
      .market-header { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
      .term { min-width:0; font-weight:500; overflow-wrap:anywhere; }
      .edge { flex:none; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
      .edge.considerable { padding:3px 7px; color:var(--positive); background:var(--positive-bg); border-radius:6px; font-weight:600; }
      .values { display:flex; flex-wrap:wrap; gap:16px; margin-top:6px; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
      .values strong { color:var(--text); font-weight:500; }
      .track { position:relative; height:4px; margin:22px 7px 13px; border-radius:8px; background:var(--track); }
      .gap { position:absolute; inset-block:0; background:color-mix(in srgb,var(--jev) 28%,transparent); transition:left 600ms cubic-bezier(.2,.8,.2,1),width 600ms cubic-bezier(.2,.8,.2,1); }
      .marker { position:absolute; top:50%; width:11px; height:11px; box-shadow:0 0 0 3px var(--bg); transition:left 600ms cubic-bezier(.2,.8,.2,1); }
      .marker.pm { top:7px; border-radius:50%; background:var(--pm); transform:translate(-50%,-50%); }
      .marker.jev { top:-5px; border-radius:2px; background:var(--jev); transform:translate(-50%,-50%) rotate(45deg); }
      .jev-only .marker.jev { top:50%; border-radius:50%; transform:translate(-50%,-50%); }
      .axis { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
      .settings { padding:17px 20px; border-top:1px solid var(--line); }
      label { display:block; margin-bottom:14px; color:var(--muted); font-size:12px; }
      input,textarea { display:block; width:100%; margin-top:6px; padding:10px 11px; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:7px; outline:none; }
      input:focus,textarea:focus { border-color:var(--jev); box-shadow:0 0 0 2px color-mix(in srgb,var(--jev) 20%,transparent); }
      textarea { min-height:92px; resize:vertical; }
      .hint { display:block; margin-top:4px; color:var(--muted); }
      .actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:9px; }
      .primary,.stop-button { min-height:36px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; }
      .primary { color:var(--bg); background:var(--text); border-color:var(--text); }
      .stop-button { background:transparent; }
      button:disabled { opacity:.55; }
      .error { margin:0 20px 14px; color:light-dark(#b42318,#ffaaa1); font-size:12px; overflow-wrap:anywhere; }
      .footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:13px 20px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
      .footer-status { font-variant-numeric:tabular-nums; }
      [hidden] { display:none !important; }
      @media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
      @media (pointer:coarse) { button { min-height:44px; } input,textarea { font-size:16px; } }
    </style>
    <div class="panel">
      <header class="header">
        <div class="top"><h2 class="event-title">Foreteller 预言家</h2><button class="settings-button" type="button" aria-expanded="false">Settings</button></div>
        <div class="status-row"><span class="connection-status" data-status="idle">Not running</span></div>
        <div class="coverage-status" hidden></div>
        <div class="legend" hidden><span class="pm-key"><i></i>PM YES</span><span><i></i>Jev forecast</span></div>
      </header>
      <div class="markets"></div>
      <p class="error" role="alert" hidden></p>
      <section class="settings" hidden>
        <form>
          <label>Polymarket event URL <span class="hint">Optional</span><input name="eventUrl" type="url" placeholder="https://polymarket.com/event/…"></label>
          <label>Local service port<input name="serverPort" type="number" min="1024" max="65535" required></label>
          <div class="custom-fields">
            <label>Title<input name="customTitle" maxlength="200" required></label>
            <label>Terms <span class="hint">One per line</span><textarea name="customTerms" required></textarea></label>
          </div>
          <label>Speaker<input name="speaker" maxlength="100" required></label>
          <button class="primary" type="submit">Start forecasting</button>
        </form>
      </section>
      <footer class="footer"><span class="footer-status" aria-live="polite">Waiting to start</span><button class="stop-button" type="button" hidden>Stop</button></footer>
    </div>`;
}
