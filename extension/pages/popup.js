import { send, fmtMinutes, fmtClock, fmtDuration, fmtHM12, escapeHtml, REASONS, FOCUS_PRESETS, FOCUS_MAX_MIN } from "../lib.js";

let data = null;

// Today across every site: chill vs learn.
function renderTotals() {
  let chillUsed = 0, chillLimit = 0, learnUsed = 0, learnLimit = 0, classUsed = 0;
  for (const s of data.sites) {
    chillUsed += s.limitMs - s.remainingMs;
    chillLimit += s.limitMs;
    learnUsed += s.learnLimitMs - s.learnRemainingMs;
    learnLimit += s.learnLimitMs;
    classUsed += s.classUsedMs || 0;
  }
  const el = document.getElementById("totals");
  el.hidden = !data.sites.length;
  el.innerHTML = `
    <span>🍿 Chill <b class="num">${fmtMinutes(chillUsed)}</b> <span class="muted num">/ ${fmtMinutes(chillLimit)}</span></span>
    ${learnLimit ? `<span>📚 Learn <b class="num">${fmtMinutes(learnUsed)}</b> <span class="muted num">/ ${fmtMinutes(learnLimit)}</span></span>` : ""}
    ${classUsed ? `<span>🎓 Class <b class="num">${fmtMinutes(classUsed)}</b></span>` : ""}`;
}

function render() {
  const el = document.getElementById("sites");
  if (!data.sites.length) {
    el.innerHTML = `<p class="empty muted">No sites are being tracked. Turn some on in Settings.</p>`;
    return;
  }
  const now = Date.now();
  el.innerHTML = data.sites
    .map((s) => {
      // Per site: the chill budget. Learn shows up in the totals at the bottom.
      const limit = s.limitMs;
      const used = limit - s.remainingMs;
      const pct = limit ? Math.min(100, (used / limit) * 100) : 100;
      let live = "";
      if (s.session) {
        const why = s.session.reasonText || REASONS[s.session.reason]?.label || "";
        live =
          s.session.phase === "running"
            ? `<div class="live">${s.session.isClass ? "🎓" : s.session.mode === "learn" ? "📚" : "⏱"} <b class="num">${fmtClock(s.session.endsAt - (s.session.pausedAt || now))}</b> left${s.session.pausedAt ? " · ⏸ paused" : ""} · ${escapeHtml(why)}</div>`
            : `<div class="live">⏰ Time's up</div>`;
      }
      return `
        <div class="site">
          <div class="site-top">
            <b>${escapeHtml(s.name)}</b>
            <span class="num muted">${fmtMinutes(used)} / ${fmtMinutes(limit)} · ${s.opens} open${s.opens === 1 ? "" : "s"}</span>
          </div>
          <div class="bar ${pct >= 100 ? "full" : ""}"><span style="width:${pct}%"></span></div>
          ${live}
        </div>`;
    })
    .join("");
}

// ------------------------------------------------------------------ focus

let focusMin = 50;
let confirmUntil = 0;
let focusError = "";
// The tab you're on, if Focus could keep it open (asked once when the popup opens).
let keepTab = null; // { id, label, ext }
let keepIt = true;
let staysNote = ""; // the tab you're on stays open in Focus anyway (allowlist, PDF viewer...)

function renderFocus() {
  const el = document.getElementById("focus");
  const now = Date.now();
  if (data.focus && data.focus.until > now) {
    if (el.dataset.mode !== "on") {
      el.dataset.mode = "on";
      el.innerHTML = `
        <h2>🎯 Focus mode is ON</h2>
        <div class="clock num" id="f-clock"></div>
        <div class="row">
          <span id="f-until"></span>
          <button class="more" id="f-more">+15 min</button>
        </div>
        ${data.focus.keep ? `<p style="margin:8px 0 0">📖 Kept open: <b>${escapeHtml(data.focus.keep.label || data.focus.keep.host)}</b> (that one tab only)</p>` : ""}
        <p style="margin:8px 0 0">No cancel button. That's the whole point 😌</p>`;
      el.querySelector("#f-more").addEventListener("click", async () => {
        const left = Math.ceil((data.focus.until - Date.now()) / 60000);
        const r = await send("focus:start", { minutes: Math.min(FOCUS_MAX_MIN, left + 15) });
        if (r?.ok) load();
      });
    }
    const left = data.focus.until - now;
    el.querySelector("#f-clock").textContent = left >= 3600 * 1000 ? fmtDuration(left) : fmtClock(left);
    el.querySelector("#f-until").textContent = `Until ${new Date(data.focus.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return;
  }
  if (el.dataset.mode !== "off") {
    el.dataset.mode = "off";
    el.innerHTML = `
      <h2>🎯 Focus mode</h2>
      <p>Every website closes, except the ones you allow in Settings. No cancel, no override.</p>
      <div class="chips">
        ${FOCUS_PRESETS.map((m) => `<button data-m="${m}">${m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}</button>`).join("")}
        <input id="f-custom" type="number" min="1" max="${FOCUS_MAX_MIN}" placeholder="min">
      </div>
      ${keepTab ? `<label class="keep"><input type="checkbox" id="f-keep" ${keepIt ? "checked" : ""}> Keep this tab open: <b>${escapeHtml(keepTab.label)}</b></label>` : ""}
      ${staysNote ? `<p class="keep-note">${staysNote}</p>` : ""}
      <button class="lockin" id="f-go"></button>
      <div class="err" id="f-err" hidden></div>`;
    el.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        focusMin = Number(b.dataset.m);
        el.querySelector("#f-custom").value = "";
        confirmUntil = 0;
        renderFocus();
      }),
    );
    el.querySelector("#f-custom").addEventListener("input", (e) => {
      const v = Math.round(Number(e.target.value));
      if (v > 0) focusMin = Math.min(FOCUS_MAX_MIN, v);
      confirmUntil = 0;
      renderFocus();
    });
    el.querySelector("#f-keep")?.addEventListener("change", (e) => {
      keepIt = e.target.checked;
      confirmUntil = 0;
      renderFocus();
    });
    el.querySelector("#f-go").addEventListener("click", async () => {
      if (Date.now() > confirmUntil) {
        confirmUntil = Date.now() + 5000;
        return renderFocus();
      }
      confirmUntil = 0;
      const r = await send("focus:start", { minutes: focusMin, keepTabId: keepTab && keepIt ? keepTab.id : undefined });
      focusError = r?.ok ? "" : r?.error || "Couldn't start focus.";
      load();
    });
  }
  el.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("selected", Number(b.dataset.m) === focusMin));
  const go = el.querySelector("#f-go");
  const label = focusMin >= 60 ? fmtDuration(focusMin * 60000) : `${focusMin} min`;
  const confirming = Date.now() < confirmUntil;
  go.classList.toggle("confirm", confirming);
  go.textContent = confirming ? `Sure? No undo for ${label}. Tap again` : `🔒 Lock in for ${label}`;
  const err = el.querySelector("#f-err");
  err.hidden = !focusError;
  err.textContent = focusError;
}

function renderCurfew() {
  const el = document.getElementById("curfew");
  const c = data.curfew;
  el.classList.toggle("on", !!c?.active);
  if (!c?.enabled) {
    el.innerHTML = `<span>🌙 Curfew is off</span><a href="options.html#curfew" target="_blank">Set it</a>`;
  } else if (c.active) {
    el.innerHTML = `<span>🌙 Curfew on, sites closed until ${fmtHM12(c.end)}</span>`;
  } else {
    el.innerHTML = `<span>🌙 Curfew ${fmtHM12(c.start)} to ${fmtHM12(c.end)}</span><a href="options.html#curfew" target="_blank">Edit</a>`;
  }
}

// Sound volume (ticking + breathing). No password: it's not stricter or looser.
const vol = document.getElementById("volume");
function showVolume(v) {
  document.getElementById("vol-num").textContent = v ? `${v}%` : "off";
  document.getElementById("vol-icon").textContent = v ? "🔊" : "🔇";
}
vol.addEventListener("input", () => showVolume(Number(vol.value)));
vol.addEventListener("change", async () => {
  const r = await send("volume:set", { volume: Number(vol.value) });
  if (r?.ok) showVolume(r.volume);
});

async function load() {
  data = await send("popup:info");
  if (data?.ok && document.activeElement !== vol) {
    vol.value = data.volume;
    showVolume(data.volume);
  }
  if (data?.ok) {
    renderFocus();
    renderCurfew();
    render();
    renderTotals();
  }
}

async function findKeepTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab) return;
  const r = await send("focus:keepable", { tabId: tab.id });
  if (r?.host) keepTab = { id: tab.id, label: r.label, ext: r.ext };
  else if (r?.stays === "allowlist") staysNote = "✓ This tab stays open in Focus (it's on your allowlist).";
  else if (r?.stays === "notweb") staysNote = "✓ This tab stays open in Focus (it's a file on your computer).";
  else return;
  // Re-draw the off-state card so the checkbox shows up.
  const el = document.getElementById("focus");
  if (el.dataset.mode === "off") {
    el.dataset.mode = "";
    renderFocus();
  }
}

load();
findKeepTab();
setInterval(() => {
  if (!data?.ok) return;
  render();
  renderFocus();
}, 1000);
setInterval(load, 15000);
