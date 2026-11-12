import { send, todayKey, fmtMinutes, MIN, DAY, REASONS, MOODS, escapeHtml } from "../lib.js";

const $ = (id) => document.getElementById(id);
let data = null;
let filter = "all";

const ENDED = {
  timeup: "Timer",
  done: "Closed",
  "done-early": "Done early",
  "closed-early": "Tab closed",
  closed: "Tab closed",
  reopened: "Reopened",
  expired: "Left open",
  "browser-closed": "Browser closed",
  switched: "Switched video",
};

function siteName(id) {
  return data.settings.sites.find((s) => s.id === id)?.name || id;
}

function sites() {
  return filter === "all" ? data.settings.sites.filter((s) => s.enabled) : data.settings.sites.filter((s) => s.id === filter);
}

function dayUsed(key) {
  const d = data.days[key] || {};
  let used = 0;
  let opens = 0;
  for (const [id, v] of Object.entries(d)) {
    if (filter !== "all" && id !== filter) continue;
    used += v.usedMs + (v.learnUsedMs || 0) + (v.classUsedMs || 0);
    opens += v.opens;
  }
  // Include the currently running session for today.
  if (key === todayKey()) {
    for (const s of Object.values(data.active)) {
      if (filter !== "all" && s.siteId !== filter) continue;
      if (s.dayKey !== key) continue;
      const upTo = s.pausedAt ? Math.min(s.pausedAt, Date.now()) : Date.now();
      used += s.usedMs + Math.max(0, Math.min(upTo, s.endsAt) - s.segStart);
    }
  }
  return { used, opens };
}

function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push({ key: todayKey(d), date: d });
  }
  return out;
}

function logIn(days) {
  const cutoff = Date.now() - days * DAY;
  return data.log.filter((e) => e.start >= cutoff && (filter === "all" || e.siteId === filter));
}

function render() {
  const limitMs = sites().reduce((a, s) => a + (s.dailyLimitMin + (s.learnLimitMin || 0)) * MIN, 0);
  const today = dayUsed(todayKey());
  $("t-used").textContent = fmtMinutes(today.used);
  $("t-used-sub").textContent = limitMs ? `of ${fmtMinutes(limitMs)} budget` : "";
  $("t-opens").textContent = String(today.opens);
  const yKey = todayKey(new Date(Date.now() - DAY));
  const y = dayUsed(yKey);
  $("t-opens-sub").textContent = `${y.opens} yesterday`;

  const week = lastNDays(7).map((d) => dayUsed(d.key));
  const weekUsed = week.reduce((a, d) => a + d.used, 0);
  $("t-week").textContent = fmtMinutes(weekUsed);
  const avg = weekUsed / 7;
  $("t-week-sub").textContent = `${avg > 0 && avg < 30 * 1000 ? "<1 min" : fmtMinutes(avg)} a day on average`;

  renderChart(limitMs);
  renderReasons();
  renderMoods();
  renderRecent();
  renderInsight();
}

function renderChart(limitMs) {
  const days = lastNDays(14).map((d) => ({ ...d, ...dayUsed(d.key) }));
  const maxVal = Math.max(limitMs, ...days.map((d) => d.used), 10 * MIN);
  const chart = $("chart");
  chart.innerHTML = "";
  chart.setAttribute(
    "aria-label",
    `Minutes per day for the last 14 days. ${days.map((d) => `${d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${Math.round(d.used / MIN)}`).join(", ")}`,
  );
  const tKey = todayKey();
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "col" + (d.key === tKey ? " today" : "");
    const b = document.createElement("div");
    b.className = "b" + (d.used < 30 * 1000 ? " zero" : "");
    b.style.height = `${(d.used / maxVal) * 100}%`;
    col.appendChild(b);
    const label = `${d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${fmtMinutes(d.used)} · ${d.opens} open${d.opens === 1 ? "" : "s"}`;
    col.addEventListener("mouseenter", () => showTip(col, label));
    col.addEventListener("mouseleave", hideTip);
    chart.appendChild(col);
  }
  if (limitMs) {
    const line = document.createElement("div");
    line.className = "limit";
    line.style.bottom = `${(limitMs / maxVal) * 172}px`;
    line.innerHTML = `<span>Budget ${fmtMinutes(limitMs)}</span>`;
    chart.appendChild(line);
  }
  let labels = chart.nextElementSibling;
  if (!labels?.classList.contains("xlabels")) {
    labels = document.createElement("div");
    labels.className = "xlabels";
    chart.after(labels);
  }
  labels.innerHTML = days
    .map((d, i) => `<span>${i % 2 === 1 || d.key === tKey ? (d.key === tKey ? "Today" : d.date.toLocaleDateString(undefined, { day: "numeric", month: "short" })) : ""}</span>`)
    .join("");
}

function showTip(col, text) {
  const tip = $("tooltip");
  const card = col.closest(".chart-card").getBoundingClientRect();
  const r = col.getBoundingClientRect();
  const bar = col.querySelector(".b").getBoundingClientRect();
  tip.textContent = text;
  tip.hidden = false;
  const left = r.left + r.width / 2 - card.left;
  tip.style.left = `${Math.min(Math.max(left, 90), card.width - 90)}px`;
  tip.style.top = `${bar.top - card.top - 8}px`;
}
function hideTip() {
  $("tooltip").hidden = true;
}

function renderReasons() {
  const log = logIn(30);
  const counts = {};
  for (const e of log) counts[e.reason] = (counts[e.reason] || 0) + 1;
  const total = log.length;
  const rows = Object.keys(REASONS)
    .map((k) => ({ k, n: counts[k] || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!rows.length) {
    $("reasons").innerHTML = `<p class="muted small">Nothing yet.</p>`;
    return;
  }
  $("reasons").innerHTML = rows
    .map(({ k, n }) => {
      const pct = Math.round((n / total) * 100);
      return `
        <div title="${n} of ${total} visits">
          <div class="hbar-top"><span>${REASONS[k].emoji} ${escapeHtml(REASONS[k].label)}</span><span class="num muted">${n} · ${pct}%</span></div>
          <div class="bar"><span style="width:${pct}%"></span></div>
        </div>`;
    })
    .join("");
}

function renderMoods() {
  const log = logIn(30).filter((e) => e.mood);
  if (!log.length) {
    $("moods").innerHTML = `<p class="muted small">Answer "How do you feel?" when a visit ends, and the pattern shows up here.</p>`;
    return;
  }
  const by = {};
  for (const e of log) {
    by[e.reason] ??= { better: 0, same: 0, worse: 0 };
    by[e.reason][e.mood] += 1;
  }
  $("moods").innerHTML = Object.entries(by)
    .map(([reason, c]) => {
      const n = c.better + c.same + c.worse;
      return `
        <div class="mood-row">
          <b>${REASONS[reason]?.emoji || ""} ${escapeHtml(REASONS[reason]?.label || reason)}</b>
          <div class="counts num">
            ${Object.keys(MOODS).map((m) => `<span>${MOODS[m].emoji} ${MOODS[m].label} ${Math.round((c[m] / n) * 100)}%</span>`).join("")}
          </div>
        </div>`;
    })
    .join("");
}

function renderRecent() {
  const rows = [...logIn(30)].sort((a, b) => b.start - a.start).slice(0, 25);
  $("recent-empty").hidden = rows.length > 0;
  $("recent").hidden = rows.length === 0;
  $("recent").querySelector("tbody").innerHTML = rows
    .map((e) => {
      let why = e.reasonText ? escapeHtml(e.reasonText) : `${REASONS[e.reason]?.emoji || ""} ${escapeHtml(REASONS[e.reason]?.label || e.reason)}`;
      if (e.mode === "learn") why = `${e.isClass ? "🎓" : "📚"} ${why}${(e.spotTitle || e.videoTitle) ? ` <span class="muted small">· ${escapeHtml(e.spotTitle || e.videoTitle)}</span>` : ""}`;
      const when = new Date(e.start).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
      return `<tr>
        <td>${when}</td>
        <td>${escapeHtml(siteName(e.siteId))}</td>
        <td class="why">${why}</td>
        <td class="r num">${fmtMinutes(e.usedMs)}${e.extensions ? ` <span class="muted small">(+${e.extensions})</span>` : ""}</td>
        <td class="muted">${ENDED[e.endedBy] || e.endedBy}</td>
        <td>${e.mood ? MOODS[e.mood].emoji : ""}</td>
      </tr>`;
    })
    .join("");
}

function renderInsight() {
  const log = logIn(7);
  const el = $("insight");
  if (log.length < 3) {
    el.hidden = true;
    return;
  }
  const bored = log.filter((e) => e.reason === "bored");
  const boredMood = bored.filter((e) => e.mood);
  const worse = boredMood.filter((e) => e.mood === "worse").length;
  let text;
  if (boredMood.length >= 3 && worse / boredMood.length >= 0.5) {
    text = `After "just bored" visits you felt worse <b>${Math.round((worse / boredMood.length) * 100)}%</b> of the time this week. Just saying 👀`;
  } else if (bored.length / log.length >= 0.4) {
    text = `<b>${Math.round((bored.length / log.length) * 100)}%</b> of your visits this week started with "just bored". Hmm 🤔`;
  } else {
    const ext = log.filter((e) => e.extensions > 0).length;
    text = ext
      ? `You asked for more time on <b>${ext}</b> of ${log.length} visits this week.`
      : `<b>${log.length}</b> visits this week and zero extensions. Lowkey proud of you 🫶`;
  }
  el.innerHTML = text;
  el.hidden = false;
}

async function init() {
  data = await send("stats:get");
  if (!data?.ok) return;
  const sel = $("site-filter");
  sel.innerHTML =
    `<option value="all">All sites</option>` +
    data.settings.sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
  sel.value = filter;
  sel.addEventListener("change", () => {
    filter = sel.value;
    render();
  });
  render();
}

init();
