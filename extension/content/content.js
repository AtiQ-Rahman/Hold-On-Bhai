// Hold On Bhai content script: runs on every page, but only acts on tracked sites.
// Shows the floating timer badge, the "time's up" overlay, hides feeds and
// greys the page out in the last minute.
(() => {
  if (window.top !== window) return;
  if (window.__holdOnBhai) return;
  window.__holdOnBhai = true;

  const HOME_PATHS = {
    facebook: (p) => p === "/" || p === "/home.php",
    youtube: (p) => p === "/" || p === "/feed/trending",
    instagram: (p) => p === "/",
    x: (p) => p === "/home" || p === "/",
    reddit: (p) => p === "/" || /^\/(best|hot|new|top|rising|r\/(popular|all))\/?/.test(p),
  };

  const REASON_LABELS = {
    messages: "Checking DMs",
    specific: "Looking up one thing",
    post: "Posting or replying",
    bored: "Just bored ngl",
    other: "Something else",
    learn: "Learning",
    code: "Grabbing a login code",
  };

  const root = document.documentElement;
  let site = null;
  let view = null;
  let host = null;
  let shadow = null;
  let tickTimer = null;
  let overlayMode = null; // null | "timeup" | "done" | "checkin"
  let lastHref = location.href;
  let nextCheckinAt = 0;
  let checkinSession = null;
  let durationSent = null;
  let timeupAskedAt = 0;
  let wantExtendSent = false;

  function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith("." + domain);
  }

  function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  async function init() {
    const { settings } = await chrome.storage.local.get("settings");
    if (!settings) return;
    const hostname = location.hostname.toLowerCase();
    site = settings.sites.find((s) => s.enabled && s.domains.some((d) => hostMatches(hostname, d)));
    if (!site) return;
    await check();
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) check();
    });
  }

  async function check() {
    root.setAttribute("data-hob-pending", "1");
    let res = await send("gate:check", { url: location.href });
    if (!res) res = await send("gate:check", { url: location.href }); // service worker may be waking up
    if (!res || !res.tracked) {
      root.removeAttribute("data-hob-pending");
      return;
    }
    if (!res.allowed) return; // background is redirecting this tab to the pause screen
    root.removeAttribute("data-hob-pending");
    applyView(res.view);
    reportVisible();
  }

  let visibleWired = false;
  function reportVisible() {
    const send_ = (v) => send("tick:visible", { siteId: site.id, visible: v });
    send_(document.visibilityState === "visible");
    if (visibleWired) return;
    visibleWired = true;
    document.addEventListener("visibilitychange", () => send_(document.visibilityState === "visible"));
    window.addEventListener("pagehide", () => send_(false));
  }

  function applyView(v) {
    view = v;
    if (!view) return;
    if (view.hideFeed) root.setAttribute("data-hob-hidefeed", view.siteId);
    else root.removeAttribute("data-hob-hidefeed");
    ensureUI();
    if (view.phase === "running") {
      if (overlayMode !== "checkin") hideOverlay();
      wantExtendSent = false;
    } else {
      showOverlay("timeup");
    }
    if (!tickTimer) tickTimer = setInterval(tick, 500);
    tick();
  }

  function tick() {
    if (!view) return;
    const isHome = (HOME_PATHS[view.siteId] || (() => false))(location.pathname, location.hash);
    root.setAttribute("data-hob-home", isHome ? "1" : "0");

    const now = Date.now();
    const left = view.endsAt - now;
    if (view.siteId === "youtube") youtubeTick();
    if (view.mode === "learn" && view.spot && !view.spotTitle && view.siteId !== "youtube") reportSpotTitle();
    if (location.href !== lastHref) {
      // SPA navigation: let the background decide if this URL is still allowed.
      lastHref = location.href;
      send("gate:check", { url: location.href }).then((r) => r?.allowed && r.view && applyView(r.view));
    }
    if (view.phase === "running") {
      setBadge(left);
      const gray = view.grayscaleMode === "always" || (view.grayscaleMode === "lastMinute" && left <= 60 * 1000);
      shadow.querySelector(".gray").classList.toggle("on", !!gray && !overlayMode);
      checkinTick(now);
      // Safety net in case the background alarm message is late.
      if (left <= -1500 && now - timeupAskedAt > 5000) {
        timeupAskedAt = now;
        send("session:timeupCheck", { siteId: view.siteId }).then((r) => r?.view && applyView(r.view));
      }
    } else {
      setBadge(0);
      updateOverlayClock();
    }
  }

  // ------------------------------------------------------------------ YouTube

  function youtubeTick() {
    // Shorts -> regular player (no infinite swipe feed).
    const m = location.pathname.match(/^\/shorts\/([\w-]+)/);
    if (m && view.hideFeed) {
      location.replace(`/watch?v=${m[1]}`);
      return;
    }
    // Autoplay off.
    const auto = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (auto && view.hideFeed) auto.click();
    // Report the real length if the background couldn't read it.
    if (view.mode === "learn" && view.needDuration && view.videoId && durationSent !== view.videoId) {
      const player = document.querySelector("#movie_player");
      const video = document.querySelector("video");
      const isAd = player?.classList.contains("ad-showing");
      const vid = new URLSearchParams(location.search).get("v");
      if (video && !isAd && vid === view.videoId && Number.isFinite(video.duration) && video.duration > 0) {
        durationSent = view.videoId;
        send("yt:duration", { siteId: view.siteId, videoId: view.videoId, seconds: Math.round(video.duration) });
      }
    }
  }

  // Learn mode on Facebook: name the locked group/page from the tab title.
  let spotTitleSent = null;
  function reportSpotTitle() {
    if (spotTitleSent === view.spot) return;
    const t = document.title.replace(/^\(\d+\+?\)\s*/, "").replace(/\s*[|\-–]\s*Facebook\s*$/i, "").trim();
    if (!t || /^facebook$/i.test(t)) return;
    spotTitleSent = view.spot;
    view.spotTitle = t;
    send("learn:spotTitle", { siteId: view.siteId, url: location.href, title: t });
  }

  // Learn mode: every N minutes ask if you're still learning.
  function checkinTick(now) {
    const every = (view.learnCheckinMin || 0) * 60 * 1000;
    if (view.mode !== "learn" || !every) return;
    if (checkinSession !== view.start) {
      checkinSession = view.start;
      const elapsed = now - view.start;
      nextCheckinAt = view.start + (Math.floor(elapsed / every) + 1) * every;
    }
    if (now >= nextCheckinAt && !overlayMode && view.endsAt - now > 60 * 1000) {
      nextCheckinAt = now + every;
      // A class only gets a gentle nudge. The video keeps playing.
      if (view.isClass) showToast(`🎓 Still in class? Nice. If you drifted, hit "I'm done".`);
      else showOverlay("checkin");
    }
  }

  // ------------------------------------------------------------------ UI

  function ensureUI() {
    if (host && host.isConnected) return;
    host = document.createElement("hold-on-bhai");
    host.style.cssText = "all: initial; position: fixed; inset: auto; z-index: 2147483647;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="gray"></div>
      <div class="badge" part="badge">
        <span class="dot"></span>
        <span class="clock">--:--</span>
        <span class="why"></span>
        <button class="done" title="I'm done, close it">I'm done</button>
      </div>
      <div class="toast" hidden></div>
      <div class="overlay" hidden>
        <div class="card"></div>
      </div>`;
    (document.body || root).appendChild(host);
    shadow.querySelector(".done").addEventListener("click", () => showOverlay("done"));
    // Re-attach if the site wipes the body (SPAs sometimes do).
    new MutationObserver(() => {
      if (!host.isConnected) (document.body || root).appendChild(host);
    }).observe(root, { childList: true, subtree: false });
  }

  function setBadge(left) {
    if (!shadow) return;
    const clock = shadow.querySelector(".clock");
    clock.textContent = fmtClock(left);
    const why = view.mode === "learn"
      ? `${view.isClass ? "🎓" : "📚"} ${view.reasonText}${view.spot ? ` · locked to this ${view.spotKind || "video"}` : view.siteId === "youtube" ? " · pick a video" : " · pick a group or page"}`
      : view.reasonText || REASON_LABELS[view.reason];
    shadow.querySelector(".why").textContent = why || "";
    const badge = shadow.querySelector(".badge");
    badge.classList.toggle("low", left <= 60 * 1000);
  }

  let toastTimer = null;
  function showToast(text) {
    ensureUI();
    const t = shadow.querySelector(".toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 10000);
  }

  function blockKeys(e) {
    if (!overlayMode) return;
    if (e.composedPath().includes(host)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  window.addEventListener("keydown", blockKeys, true);
  window.addEventListener("keypress", blockKeys, true);

  function pauseMedia() {
    document.querySelectorAll("video, audio").forEach((m) => {
      try { m.pause(); } catch {}
    });
  }

  function hideOverlay() {
    overlayMode = null;
    if (!shadow) return;
    shadow.querySelector(".overlay").hidden = true;
    shadow.querySelector(".badge").hidden = false;
    document.documentElement.style.removeProperty("overflow");
  }

  function reasonLine() {
    const label = REASON_LABELS[view.reason] || "";
    if (view.reasonText) return `The mission was: <b>${esc(view.reasonText)}</b>.`;
    if (view.reason === "bored") return `You came in bored. Feeling any less bored?`;
    return `The mission was: <b>${esc(label.toLowerCase())}</b>.`;
  }

  function moodRow() {
    return `
      <div class="mood">
        <div class="label">How's the vibe after that?</div>
        <div class="moods">
          <button data-mood="better">🙂 Better</button>
          <button data-mood="same">😐 Meh</button>
          <button data-mood="worse">🫠 Worse</button>
        </div>
      </div>`;
  }

  function showOverlay(mode) {
    ensureUI();
    overlayMode = mode;
    pauseMedia();
    const ov = shadow.querySelector(".overlay");
    const card = shadow.querySelector(".card");
    shadow.querySelector(".badge").hidden = true;
    ov.hidden = false;

    if (mode === "checkin") {
      card.innerHTML = `
        <div class="emoji">👀</div>
        <h1>Still learning or vibing?</h1>
        <p>You said you're learning: <b>${esc(view.reasonText)}</b>. Be honest.</p>
        <div class="actions">
          <button class="primary keep">📚 Still learning</button>
          <button class="ghost vibing">🍿 Ok I'm vibing, close it</button>
        </div>`;
      card.querySelector(".keep").addEventListener("click", hideOverlay);
      card.querySelector(".vibing").addEventListener("click", () => {
        send("session:done", { siteId: view.siteId, early: true });
      });
      return;
    }

    if (mode === "done") {
      card.innerHTML = `
        <div class="emoji">🏆</div>
        <h1>Done early? That's a W.</h1>
        <p>${reasonLine()}</p>
        ${moodRow()}
        <div class="actions">
          <button class="primary close">Close it, I'm out</button>
          <button class="ghost back">Nah, not done yet</button>
        </div>`;
      card.querySelector(".back").addEventListener("click", hideOverlay);
      card.querySelector(".close").addEventListener("click", () => {
        send("session:done", { siteId: view.siteId, mood: view.mood, early: true });
      });
      wireMood(card);
      return;
    }

    const budgetDone = !view.canExtend;
    card.innerHTML = `
      <div class="emoji">🔔</div>
      <h1>Time's up, bhai! ⏰</h1>
      <p>${reasonLine()}${view.reason === "bored" ? "" : " Mission accomplished?"}</p>
      ${moodRow()}
      <div class="closing"></div>
      <div class="actions">
        <button class="primary close">Close it, I'm out</button>
      </div>
      ${budgetDone
        ? `<p class="note">That was the last of today's ${esc(view.siteName)} budget. See you tomorrow ✌️</p>`
        : `<div class="extend">
            <button class="ghost ask">Wait, I need ${view.extendMinutes} more min…</button>
            <div class="extend-box" hidden>
              <p class="small">Wait <span class="ext-wait"></span>, then type this out. No copy-paste, nice try 😌</p>
              <p class="phrase">${esc(view.extendPhrase)}</p>
              <input class="phrase-input" type="text" autocomplete="off" spellcheck="false" disabled placeholder="Type it word for word">
              <button class="primary submit" disabled>Give me more time</button>
              <p class="error" hidden></p>
            </div>
          </div>`}
    `;
    card.querySelector(".close").addEventListener("click", () => {
      send("session:done", { siteId: view.siteId, mood: view.mood });
    });
    wireMood(card);
    const ask = card.querySelector(".ask");
    if (ask) {
      ask.addEventListener("click", async () => {
        ask.hidden = true;
        card.querySelector(".extend-box").hidden = false;
        if (!wantExtendSent) {
          wantExtendSent = true;
          const r = await send("session:wantExtend", { siteId: view.siteId });
          if (r?.view) view = r.view;
        }
        updateOverlayClock();
      });
      const input = card.querySelector(".phrase-input");
      const submit = card.querySelector(".submit");
      input.addEventListener("paste", (e) => e.preventDefault());
      input.addEventListener("drop", (e) => e.preventDefault());
      const go = async () => {
        const r = await send("session:extend", { siteId: view.siteId, phrase: input.value });
        if (r?.ok) {
          applyView(r.view);
        } else {
          const err = card.querySelector(".error");
          err.hidden = false;
          err.textContent = r?.error || "Something went wrong.";
        }
      };
      submit.addEventListener("click", go);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !submit.disabled) go();
      });
    }
    updateOverlayClock();
  }

  function wireMood(card) {
    card.querySelectorAll("[data-mood]").forEach((b) => {
      if (b.dataset.mood === view.mood) b.classList.add("picked");
      b.addEventListener("click", () => {
        view.mood = b.dataset.mood;
        card.querySelectorAll("[data-mood]").forEach((x) => x.classList.toggle("picked", x === b));
        send("session:mood", { siteId: view.siteId, mood: view.mood });
      });
    });
  }

  function updateOverlayClock() {
    if (overlayMode !== "timeup" || !shadow) return;
    const card = shadow.querySelector(".card");
    const now = Date.now();
    const closing = card.querySelector(".closing");
    if (closing) {
      if (view.endMode === "strict" && view.graceEndsAt) {
        const left = view.graceEndsAt - now;
        closing.innerHTML = `This tab self-destructs in <b>${Math.max(0, Math.ceil(left / 1000))}s</b> 💥`;
        if (left <= -3000 && now - timeupAskedAt > 4000) {
          timeupAskedAt = now;
          send("session:timeupCheck", { siteId: view.siteId });
        }
      } else if (view.endMode === "soft") {
        closing.textContent = "";
      } else {
        closing.textContent = "Bye bye 👋";
      }
    }
    const box = card.querySelector(".extend-box");
    if (box && !box.hidden && view.timeUpAt) {
      const left = view.timeUpAt + view.extendWaitSeconds * 1000 - now;
      const ready = left <= 0;
      box.querySelector(".ext-wait").textContent = ready ? "(done)" : `${Math.ceil(left / 1000)}s`;
      const input = box.querySelector(".phrase-input");
      if (ready && input.disabled) {
        input.disabled = false;
        box.querySelector(".submit").disabled = false;
        input.focus();
      }
    }
  }

  // ------------------------------------------------------------------ messages

  chrome.runtime.onMessage.addListener((msg) => {
    if (!site || !msg || msg.view?.siteId !== site.id) return;
    if (msg.type === "hob:timeup") {
      view = msg.view;
      applyView(msg.view);
    } else if (msg.type === "hob:extended") {
      applyView(msg.view);
    }
  });

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    [hidden] { display: none !important; }
    .badge {
      position: fixed; right: 18px; bottom: 18px;
      display: flex; align-items: center; gap: 10px;
      max-width: min(420px, calc(100vw - 36px));
      padding: 8px 8px 8px 14px; border-radius: 999px;
      background: #1c1917; color: #fafaf9;
      box-shadow: 0 6px 24px rgba(0,0,0,.28);
      font-size: 13px; line-height: 1.2;
      z-index: 2147483647;
    }
    .gray {
      position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
      backdrop-filter: grayscale(1); -webkit-backdrop-filter: grayscale(1);
      opacity: 0; transition: opacity 1.5s ease;
    }
    .gray.on { opacity: 1; }
    .toast {
      position: fixed; right: 18px; bottom: 72px; z-index: 2147483647;
      max-width: min(360px, calc(100vw - 36px)); padding: 12px 16px; border-radius: 14px;
      background: #1c1917; color: #fafaf9; font-size: 14px; line-height: 1.4;
      box-shadow: 0 6px 24px rgba(0,0,0,.28);
    }
    .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex: none; }
    .badge.low .dot { background: #ef4444; animation: pulse 1s infinite; }
    .badge .clock { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 15px; flex: none; }
    .badge .why { opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .badge .done {
      flex: none; border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer;
      background: #44403c; color: #fafaf9; font-size: 12px; font-weight: 600;
    }
    .badge .done:hover { background: #57534e; }
    @keyframes pulse { 50% { opacity: .3; } }

    .overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(28, 25, 23, .82); backdrop-filter: blur(10px);
      display: grid; place-items: center; padding: 16px;
    }
    .card {
      width: min(460px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      background: #fffbf5; color: #1c1917; border-radius: 20px; padding: 28px;
      box-shadow: 0 24px 60px rgba(0,0,0,.35); text-align: center;
    }
    .emoji { font-size: 40px; line-height: 1; }
    h1 { font-size: 24px; margin: 12px 0 6px; font-weight: 800; letter-spacing: -.01em; }
    p { margin: 6px 0; font-size: 15px; line-height: 1.5; color: #44403c; }
    .small { font-size: 13px; }
    .note { font-size: 13px; color: #78716c; margin-top: 14px; }
    .mood { margin: 18px 0 8px; }
    .mood .label { font-size: 13px; color: #78716c; margin-bottom: 8px; }
    .moods { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    .moods button {
      border: 1.5px solid #e7e5e4; background: #fff; border-radius: 12px; padding: 8px 12px;
      font-size: 14px; cursor: pointer; color: #1c1917;
    }
    .moods button.picked { border-color: #d97706; background: #fef3c7; }
    .closing { margin: 14px 0 4px; font-size: 14px; color: #b45309; min-height: 1em; }
    .actions { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
    button.primary {
      border: 0; border-radius: 12px; padding: 11px 18px; cursor: pointer;
      background: #d97706; color: #fff; font-weight: 700; font-size: 15px;
    }
    button.primary:hover { background: #b45309; }
    button.primary:disabled { background: #d6d3d1; cursor: not-allowed; }
    button.ghost {
      border: 0; background: transparent; color: #57534e; cursor: pointer; font-size: 14px;
      text-decoration: underline; text-underline-offset: 3px; padding: 8px;
    }
    .extend { margin-top: 16px; border-top: 1px solid #e7e5e4; padding-top: 12px; }
    .extend-box { display: grid; gap: 8px; }
    .phrase { font-weight: 700; color: #1c1917; user-select: none; -webkit-user-select: none; }
    .phrase-input {
      width: 100%; padding: 10px 12px; border-radius: 10px; border: 1.5px solid #d6d3d1;
      font-size: 14px; background: #fff; color: #1c1917;
    }
    .phrase-input:focus { outline: none; border-color: #d97706; }
    .error { color: #b91c1c; font-size: 13px; }
  `;

  init();
})();
