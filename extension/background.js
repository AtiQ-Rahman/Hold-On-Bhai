import {
  MIN,
  DAY,
  UNLOCK_DELAY_MS,
  SETUP_WINDOW_MS,
  MAX_PASSWORD_ATTEMPTS,
  ATTEMPT_COOLDOWN_MS,
  DEFAULT_SETTINGS,
  REASONS,
  MOODS,
  FEED_RULE_SITES,
  todayKey,
  findSiteForUrl,
  focusClosesUrl,
  waitSecondsFor,
  extendWaitSeconds,
  extendPhrase,
  generatePassword,
  randomHex,
  hashPassword,
  lockStatus,
  isEditable,
  ytVideoId,
  hasLearnMode,
  LEARN_PAD_MS,
  LEARN_FIND_MS,
  LEARN_SITES,
  learnSpot,
  learnBrowseOk,
  learnSideOk,
  curfewState,
  curfewCovers,
  parseHM,
  FOCUS_MAX_MIN,
  CODE_MAX_MIN,
  SITE_REASONS,
  BREATH_S,
  BUILTIN_SITE_IDS,
  CLASS_OPTIONS,
  CLASS_BREATHS,
  CLASS_CHECKIN_MIN,
  unlockBreaths,
  UNLOCK_BREATHS_RESET_MS,
} from "./lib.js";

const GATE_PAGE = chrome.runtime.getURL("pages/pause.html");
const LOG_KEEP_DAYS = 90;
const START_GRACE_MS = 20 * 1000; // ignore "no tabs left" right after a session starts
const SOFT_EXPIRED_MAX_MS = 30 * MIN;
// A session's clock only runs while one of its site's tabs is on screen. Paused longer than this, it ends.
const PAUSE_LIMIT_MS = 30 * MIN;

// ---------------------------------------------------------------------------
// Storage helpers (serialized so read-modify-write never races)
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function load() {
  const data = await chrome.storage.local.get(["settings", "lock", "days", "log", "active", "focus"]);
  return {
    focus: data.focus || null,
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...(data.settings || {}) },
    lock: data.lock || null,
    days: data.days || {},
    log: data.log || [],
    active: data.active || {},
  };
}

// ---------------------------------------------------------------------------
// Focus mode + curfew: hard blocks with no way around them
// ---------------------------------------------------------------------------

const EXT_PAGES = /^(chrome|brave|edge):\/\/(extensions|settings\/extensions)/i;

function focusActive(state, now = Date.now()) {
  return !!state.focus && state.focus.until > now;
}

// Focus blocks every website except the focus allowlist, and every site on the list (even ones
// switched off, even if allowlisted). Curfew blocks tracked sites.
function blockFor(state, site, now = Date.now()) {
  if (!site) return null;
  if (focusActive(state, now)) return { kind: "focus", until: state.focus.until, start: state.focus.start };
  const c = curfewState(state.settings.curfew, now);
  if (site.enabled && c.active) return { kind: "curfew", until: c.endsAt, start: state.settings.curfew.start, end: state.settings.curfew.end };
  return null;
}

function anySiteForUrl(settings, url) {
  const hit = findSiteForUrl({ sites: settings.sites.map((x) => ({ ...x, enabled: true })) }, url);
  return hit ? siteById(settings, hit.id) : null;
}

// Any other website during Focus: a stand-in "site" so it lands on the focus block screen.
function focusWebSite(settings, url) {
  return focusClosesUrl(settings.focusAllow, url) ? { id: "_focusweb", name: new URL(url).hostname, enabled: true } : null;
}

// The site a URL belongs to, plus the block on it (if any).
function siteAndBlock(state, url, now = Date.now()) {
  const tracked = findSiteForUrl(state.settings, url);
  if (focusActive(state, now)) {
    const site = tracked || anySiteForUrl(state.settings, url) || focusWebSite(state.settings, url);
    return { site, block: site ? blockFor(state, site, now) : null };
  }
  return { site: tracked, block: blockFor(state, tracked, now) };
}

// Sessions can't run into the curfew.
function capToCurfew(state, now, endsAt) {
  const c = curfewState(state.settings.curfew, now);
  return c.startsAt ? Math.min(endsAt, c.startsAt) : endsAt;
}

// End sessions of blocked sites and send their tabs (and, in focus, the extensions page) to the block screen.
async function enforceBlocks() {
  const now = Date.now();
  let state;
  await locked(async () => {
    state = await load();
    let changed = false;
    for (const sess of Object.values(state.active)) {
      if (blockFor(state, siteById(state.settings, sess.siteId), now)) {
        finalizeInState(state, sess, focusActive(state, now) ? "focus" : "curfew", now);
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
  });
  const focus = focusActive(state, now);
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.url) continue;
    if (focus && EXT_PAGES.test(tab.url)) {
      chrome.tabs.update(tab.id, { url: gateUrl("_focus", tab.url) }).catch(() => {});
      continue;
    }
    const { site, block } = siteAndBlock(state, tab.url, now);
    if (site && block) chrome.tabs.update(tab.id, { url: gateUrl(site.id, tab.url) }).catch(() => {});
  }
  updateBadge(state);
  scheduleCurfewAlarm(state);
}

function scheduleCurfewAlarm(state) {
  const c = curfewState(state.settings.curfew);
  if (c.startsAt) chrome.alarms.create("curfew", { when: c.startsAt + 500 });
  else chrome.alarms.clear("curfew");
  if (focusActive(state)) chrome.alarms.create("focusEnd", { when: state.focus.until + 500 });
}

function updateBadge(state) {
  const now = Date.now();
  let text = "";
  let color = "#d97706";
  if (focusActive(state, now)) {
    const mins = Math.ceil((state.focus.until - now) / MIN);
    text = mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`;
    color = "#dc2626";
  } else if (curfewState(state.settings.curfew, now).active) {
    text = "zz";
    color = "#4f46e5";
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

async function startFocus(minutes) {
  const mins = Math.round(Number(minutes));
  if (!Number.isFinite(mins) || mins < 1 || mins > FOCUS_MAX_MIN) return { ok: false, error: `Pick 1 to ${FOCUS_MAX_MIN} minutes.` };
  const res = await locked(async () => {
    const state = await load();
    const now = Date.now();
    const until = now + mins * MIN;
    // You can make a running focus longer, never shorter.
    const focus = focusActive(state, now)
      ? { ...state.focus, until: Math.max(state.focus.until, until) }
      : { start: now, until };
    const focusLog = (await chrome.storage.local.get("focusLog")).focusLog || [];
    if (!focusActive(state, now)) focusLog.push({ start: now, plannedMin: mins });
    await chrome.storage.local.set({ focus, focusLog: focusLog.slice(-500) });
    return { ok: true, focus };
  });
  await enforceBlocks();
  return res;
}

async function saveCurfew(input) {
  return locked(async () => {
    const state = await load();
    const next = {
      enabled: !!input?.enabled,
      start: parseHM(input?.start) !== null ? input.start.padStart(5, "0") : state.settings.curfew.start,
      end: parseHM(input?.end) !== null ? input.end.padStart(5, "0") : state.settings.curfew.end,
    };
    if (next.enabled && next.start === next.end) return { ok: false, error: "Start and end can't be the same time." };
    const { lock } = await chrome.storage.local.get("lock");
    if (isEditable(lock) || curfewCovers(next, state.settings.curfew)) {
      state.settings.curfew = next;
      await chrome.storage.local.set({ settings: state.settings });
      return { ok: true, curfew: next };
    }
    const fmt = (c) => (c.enabled ? `${c.start} to ${c.end}` : "off");
    const label = `Curfew: ${fmt(state.settings.curfew)} → ${fmt(next)}`;
    if (!input?.password) return { ok: false, needPassword: true, loosen: [label] };
    if (!(await breathOk(input.breathToken))) return { ok: false, needPassword: true, loosen: [label], error: "Finish the breaths first." };
    const pw = await checkPassword(input.password);
    if (!pw.ok) return { ...pw, needPassword: true, loosen: [label] };
    await noteLoosen();
    const { pendingChanges = [] } = await chrome.storage.local.get("pendingChanges");
    const applyAt = Date.now() + UNLOCK_DELAY_MS;
    const kept = pendingChanges.filter((p) => !(p.path?.[0] === "curfew" && !p.site));
    await chrome.storage.local.set({ pendingChanges: [...kept, { id: randomHex(6), path: ["curfew"], value: next, label, applyAt }] });
    return { ok: true, curfew: state.settings.curfew, scheduled: [label], applyAt };
  }).then(async (r) => {
    if (r.ok) await enforceBlocks();
    return r;
  });
}

function siteById(settings, id) {
  return settings.sites.find((s) => s.id === id) || null;
}

function dayEntry(days, siteId, key = todayKey()) {
  days[key] ??= {};
  days[key][siteId] ??= { usedMs: 0, opens: 0, extensions: 0 };
  days[key][siteId].learnUsedMs ??= 0;
  days[key][siteId].classUsedMs ??= 0;
  days[key][siteId].classes ??= 0;
  return days[key][siteId];
}

// Classes have no daily minute budget (only a count), so extensions only stop at the curfew.
function sessRemaining(state, site, sess, now = Date.now()) {
  if (sess?.isClass) return capToCurfew(state, now, now + DAY) - now;
  return remainingMs(state, site, now, sess?.mode || "chill");
}

function classesLeft(state, site) {
  const done = state.days[todayKey()]?.[site.id]?.classes || 0;
  return Math.max(0, (state.settings.classesPerDay ?? 1) - done);
}

// Paused time (pausedAt set) doesn't count as used.
function sessionUsedMs(sess, now = Date.now()) {
  const upTo = sess.pausedAt ? Math.min(sess.pausedAt, now) : now;
  return sess.usedMs + Math.max(0, Math.min(upTo, sess.endsAt) - sess.segStart);
}

// Each site has a "chill" budget; YouTube also has a separate "learn" budget.
function remainingMs(state, site, now = Date.now(), mode = "chill") {
  const day = state.days[todayKey()]?.[site.id] || {};
  const used = (mode === "learn" ? day.learnUsedMs : day.usedMs) || 0;
  const limitMin = mode === "learn" ? site.learnLimitMin || 0 : site.dailyLimitMin;
  const sess = state.active[site.id];
  // Active session usage is added to the day only when the session is finalized.
  const activeUsed = sess && !sess.isClass && sess.dayKey === todayKey() && (sess.mode || "chill") === mode ? sessionUsedMs(sess, now) : 0;
  return Math.max(0, limitMin * MIN - used - activeUsed);
}

// Key of the spot (video, group, page) a learn session is locked to, if any.
function sessSpot(sess) {
  return sess?.spot || (sess?.videoId ? `yt:${sess.videoId}` : null);
}

// Learn sessions are locked to one spot. Chill sessions can go anywhere on the site.
function allowedInSession(sess, url) {
  if (!sess || sess.mode !== "learn") return true;
  const spot = learnSpot(sess.siteId, url);
  const locked = sessSpot(sess);
  if (locked) return spot?.key === locked || learnSideOk(sess.siteId, url);
  if (spot) return true; // first spot opened: it becomes the locked one
  return learnBrowseOk(sess.siteId, url);
}

function needsLock(sess, url) {
  return sess?.mode === "learn" && !sessSpot(sess) && !!learnSpot(sess.siteId, url);
}

// Length and title of a YouTube video, read from its watch page.
const videoCache = new Map();
async function fetchVideoInfo(id) {
  if (!id) return null;
  if (videoCache.has(id)) return videoCache.get(id);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, { credentials: "omit" });
    const html = await res.text();
    const len = html.match(/"lengthSeconds":"(\d+)"/);
    const title = html.match(/<meta name="title" content="([^"]*)"/) || html.match(/<title>(.*?)(?: - YouTube)?<\/title>/);
    const info = {
      seconds: len ? Number(len[1]) : null,
      title: title ? decodeEntities(title[1]) : "",
    };
    if (info.seconds) videoCache.set(id, info);
    return info;
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function pruneOld(state) {
  const cutoff = Date.now() - LOG_KEEP_DAYS * DAY;
  state.log = state.log.filter((e) => e.start >= cutoff);
  const cutoffKey = todayKey(new Date(cutoff));
  for (const k of Object.keys(state.days)) if (k < cutoffKey) delete state.days[k];
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await locked(async () => {
    const data = await chrome.storage.local.get(["settings", "lock"]);
    if (!data.settings) await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS) });
    else if (details.reason === "update") {
      // v1.1: YouTube gets Learn/Chill mode and is tracked by default.
      const yt = data.settings.sites?.find((x) => x.id === "youtube");
      if (yt && yt.learnLimitMin === undefined) {
        yt.learnLimitMin = 120;
        yt.enabled = true;
        yt.hideFeed = true;
        await chrome.storage.local.set({ settings: data.settings });
      }
      // v1.2: Facebook gets Learn mode too (30 min, locked to one group or page).
      const { migrations = [] } = await chrome.storage.local.get("migrations");
      if (!migrations.includes("fbLearn")) {
        const fb = data.settings.sites?.find((x) => x.id === "facebook");
        if (fb && !fb.learnLimitMin) fb.learnLimitMin = 30;
        migrations.push("fbLearn");
        await chrome.storage.local.set({ settings: data.settings, migrations });
      }
      // v1.1: Gmail is tracked too (adding a site only makes things stricter).
      if (!migrations.includes("gmail")) {
        if (!data.settings.sites?.some((x) => x.id === "gmail")) {
          const gmail = structuredClone(DEFAULT_SETTINGS.sites.find((x) => x.id === "gmail"));
          const yt = data.settings.sites.findIndex((x) => x.id === "youtube");
          data.settings.sites.splice(yt >= 0 ? yt + 1 : data.settings.sites.length, 0, gmail);
        }
        migrations.push("gmail");
        await chrome.storage.local.set({ settings: data.settings, migrations });
      }
      // v1.1: Chill shows the feed. Hiding it in Chill is now opt-in.
      if (!migrations.includes("chillFeed")) {
        for (const x of data.settings.sites || []) x.hideFeed = false;
        migrations.push("chillFeed");
        await chrome.storage.local.set({ settings: data.settings, migrations });
      }
      // v1.1: fixed breaths. 3 for every site, 1 for Gmail (login codes).
      if (!migrations.includes("fixedBreaths")) {
        for (const x of data.settings.sites || []) Object.assign(x, { breathMode: "fixed", breaths: x.id === "gmail" ? 1 : 3 });
        migrations.push("fixedBreaths");
        await chrome.storage.local.set({ settings: data.settings, migrations });
      }
    }
    if (!data.lock) {
      const password = generatePassword();
      const salt = randomHex();
      const hash = await hashPassword(password, salt);
      await chrome.storage.local.set({
        lock: { salt, hash, setupUntil: Date.now() + SETUP_WINDOW_MS, unlockAt: null },
        pendingPassword: password,
      });
    }
  });
  chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/welcome.html") });
  }
  await sweepOpenTabs();
  await enforceBlocks();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
  // Sessions from a previous browser run: count usage up to the last heartbeat.
  await locked(async () => {
    const state = await load();
    for (const sess of Object.values(state.active)) {
      finalizeInState(state, sess, "browser-closed", Math.min(sess.lastSeen || sess.segStart, sess.endsAt));
    }
    await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
  });
  await enforceBlocks();
});

// Redirect already-open tabs of tracked sites (e.g. right after install).
async function sweepOpenTabs() {
  const state = await load();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    const site = findSiteForUrl(state.settings, tab.url);
    if (site && !isRunning(state.active[site.id])) {
      chrome.tabs.update(tab.id, { url: gateUrl(site.id, tab.url) }).catch(() => {});
    }
  }
}

function gateUrl(siteId, target) {
  return `${GATE_PAGE}?site=${encodeURIComponent(siteId)}&to=${encodeURIComponent(target)}`;
}

// A paused session is still running: its clock just isn't moving.
function isRunning(sess, now = Date.now()) {
  return !!sess && sess.phase === "running" && (sess.pausedAt ?? now) < sess.endsAt;
}

// Restart a paused session's clock: the end moves forward by however long it sat paused.
function resumeInState(state, sess, now = Date.now()) {
  if (!sess.pausedAt) return false;
  const gap = Math.max(0, now - sess.pausedAt);
  sess.segStart += gap;
  sess.endsAt = capToCurfew(state, now, sess.endsAt + gap);
  delete sess.pausedAt;
  chrome.alarms.create(`end:${sess.siteId}`, { when: sess.endsAt });
  scheduleTickAlarm(sess);
  return true;
}

function pauseInState(sess, now = Date.now()) {
  if (sess.pausedAt) return false;
  sess.pausedAt = now;
  chrome.alarms.clear(`end:${sess.siteId}`);
  chrome.alarms.clear(`tick:${sess.siteId}`);
  return true;
}

// Sites with a tab on screen right now (the content scripts report page visibility).
async function visibleSiteIds() {
  const { visible = {} } = await chrome.storage.session.get("visible");
  return new Set(Object.values(visible));
}

// Pause the running sessions whose site isn't on screen and resume the ones that are.
// A session left paused for PAUSE_LIMIT_MS ends quietly and its tabs go back to the pause screen.
async function syncPauses() {
  const resumed = [];
  const left = [];
  let settings;
  await locked(async () => {
    const state = await load();
    settings = state.settings;
    const seen = await visibleSiteIds();
    const now = Date.now();
    let changed = false;
    for (const sess of Object.values(state.active)) {
      if (!isRunning(sess, now)) continue;
      if (seen.has(sess.siteId)) {
        if (resumeInState(state, sess, now)) {
          resumed.push(sess.siteId);
          changed = true;
        }
      } else if (sess.pausedAt) {
        if (now - sess.pausedAt >= PAUSE_LIMIT_MS) {
          finalizeInState(state, sess, "left", sess.pausedAt);
          left.push(sess.siteId);
          changed = true;
        }
      } else if (now - sess.start >= START_GRACE_MS) {
        // Right after starting, the site's tab may not have reported yet.
        changed = pauseInState(sess, now) || changed;
      }
    }
    if (changed) await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
    for (const siteId of resumed) {
      const view = await sessionView(state, siteId);
      if (view) broadcast(settings, siteId, { type: "hob:extended", view });
    }
  });
  for (const siteId of left) {
    for (const t of await tabsForSite(settings, siteId)) {
      chrome.tabs.update(t.id, { url: gateUrl(siteId, t.url) }).catch(() => {});
    }
  }
  if (resumed.length || left.length) setTimeout(updateTicking, 300);
}

// ---------------------------------------------------------------------------
// Tabs belonging to a site
// ---------------------------------------------------------------------------

async function tabsForSite(settings, siteId) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url && findSiteForUrl(settings, t.url)?.id === siteId);
}

async function broadcast(settings, siteId, msg) {
  for (const t of await tabsForSite(settings, siteId)) {
    chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  }
}

// When the last tab of a site goes away, the session ends early.
async function checkSiteAbandoned() {
  await locked(async () => {
    const state = await load();
    let changed = false;
    for (const sess of Object.values(state.active)) {
      if (Date.now() - sess.start < START_GRACE_MS) continue;
      const tabs = await tabsForSite(state.settings, sess.siteId);
      if (tabs.length === 0) {
        finalizeInState(state, sess, sess.phase === "running" ? "closed-early" : "closed");
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  checkSiteAbandoned();
  setTabVisible(tabId, null, false);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url) return;
  checkSiteAbandoned();
  // Catch in-app navigations into a tracked site that the content script might miss.
  (async () => {
    const state = await load();
    if (focusActive(state) && EXT_PAGES.test(info.url)) {
      chrome.tabs.update(tabId, { url: gateUrl("_focus", info.url) }).catch(() => {});
      return;
    }
    const { site, block } = siteAndBlock(state, info.url);
    if (!site) return;
    if (block) {
      if (state.active[site.id]) await enforceBlocks();
      chrome.tabs.update(tabId, { url: gateUrl(site.id, info.url) }).catch(() => {});
      return;
    }
    const sess = state.active[site.id];
    // No session: gate. During grace/expired the page overlay handles it.
    if (!sess) {
      chrome.tabs.update(tabId, { url: gateUrl(site.id, info.url) }).catch(() => {});
      return;
    }
    if (!isRunning(sess)) return;
    if (needsLock(sess, info.url)) {
      await lockSpot(site.id, info.url);
    } else if (!allowedInSession(sess, info.url)) {
      chrome.tabs.update(tabId, { url: gateUrl(site.id, info.url) }).catch(() => {});
    }
  })();
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function finalizeInState(state, sess, endedBy, at = Date.now()) {
  const used = sessionUsedMs(sess, at);
  const entry = dayEntry(state.days, sess.siteId, sess.dayKey);
  if (sess.isClass) entry.classUsedMs += used;
  else if (sess.mode === "learn") entry.learnUsedMs += used;
  else entry.usedMs += used;
  state.log.push({
    id: sess.id,
    siteId: sess.siteId,
    dayKey: sess.dayKey,
    start: sess.start,
    end: at,
    usedMs: used,
    plannedMin: sess.plannedMin,
    reason: sess.reason,
    reasonText: sess.reasonText,
    extensions: sess.extensions,
    mood: sess.mood || null,
    mode: sess.mode || "chill",
    isClass: !!sess.isClass,
    videoId: sess.videoId || null,
    videoTitle: sess.videoTitle || "",
    spot: sessSpot(sess),
    spotTitle: sess.spotTitle || sess.videoTitle || "",
    endedBy,
  });
  delete state.active[sess.siteId];
  chrome.alarms.clear(`end:${sess.siteId}`);
  chrome.alarms.clear(`grace:${sess.siteId}`);
  chrome.alarms.clear(`tick:${sess.siteId}`);
  setTimeout(updateTicking, 300);
  pruneOld(state);
}

async function startSession({ siteId, mode = "chill", reason, reasonText, minutes, token, target, isClass = false }) {
  isClass = mode === "learn" && !!isClass;
  // Network lookup happens before taking the storage lock.
  const vid = mode === "learn" && siteId === "youtube" ? ytVideoId(target || "") : null;
  const video = vid ? await fetchVideoInfo(vid) : null;

  return locked(async () => {
    const state = await load();
    const site = siteById(state.settings, siteId);
    if (!site || !site.enabled) return { ok: false, error: "This site isn't tracked." };
    if (mode === "learn" && !hasLearnMode(site)) return { ok: false, error: "Learn mode is off for this site." };
    if (mode !== "learn") mode = "chill";

    const now = Date.now();
    const blk = blockFor(state, site, now);
    if (blk) return { ok: false, error: blk.kind === "focus" ? "Focus mode is on. Nope." : "It's curfew. Go sleep, bhai." };
    const { tokens = {} } = await chrome.storage.session.get("tokens");
    const tk = tokens[token];
    if (!tk || tk.siteId !== siteId) return { ok: false, error: "Reload this page and try again." };
    if (now - tk.issuedAt < tk.waitSeconds * 1000 - 500) return { ok: false, error: "Wait for the countdown, bhai." };
    if (isClass) {
      if (now - tk.issuedAt < (tk.waitSeconds + CLASS_BREATHS * BREATH_S) * 1000 - 1500) return { ok: false, error: "Finish the class breaths first." };
      if (classesLeft(state, site) < 1) return { ok: false, error: "No classes left today." };
    }
    delete tokens[token];
    await chrome.storage.session.set({ tokens });

    if (mode === "learn") {
      reason = "learn";
      if (!String(reasonText || "").trim()) return { ok: false, error: "Type what you're learning." };
    } else {
      if (!REASONS[reason] || reason === "learn") return { ok: false, error: "Pick a mission first." };
      if (reason === "code" && !SITE_REASONS[siteId]?.includes("code")) return { ok: false, error: "Pick a mission first." };
      if (reason === "other" && !String(reasonText || "").trim()) return { ok: false, error: "Type out the mission." };
    }

    // An existing session is reused if it covers this URL; otherwise it ends here.
    const prev = state.active[siteId];
    if (prev) {
      if (isRunning(prev, now) && (prev.mode || "chill") === mode && allowedInSession(prev, target || "")) {
        return { ok: true, alreadyRunning: true };
      }
      finalizeInState(state, prev, isRunning(prev, now) ? "switched" : "reopened", now);
    }

    const remaining = isClass ? DAY : remainingMs(state, site, now, mode);
    if (remaining < 30 * 1000) return { ok: false, error: "Today's budget is used up." };

    let durMs;
    let needDuration = false;
    const spot = mode === "learn" ? learnSpot(siteId, target || "") : null;
    if (isClass) {
      const mins = Number(minutes);
      if (!CLASS_OPTIONS.includes(mins)) return { ok: false, error: "Pick how long the class is." };
      durMs = mins * MIN;
    } else if (mode === "learn" && siteId !== "youtube") {
      // No video length to go by: you pick the timer, like chill mode.
      const mins = Number(minutes);
      if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: "Pick a timer." };
      durMs = mins * MIN;
    } else if (mode === "learn") {
      if (vid && video?.seconds) durMs = video.seconds * 1000 + LEARN_PAD_MS;
      else if (vid) {
        // Length unknown for now; the page reports it once the player loads.
        durMs = 30 * MIN;
        needDuration = true;
      } else durMs = LEARN_FIND_MS;
    } else {
      let mins = Number(minutes);
      if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: "Pick a timer." };
      if (reason === "bored") mins = Math.min(mins, state.settings.boredMaxMin);
      if (reason === "code") mins = Math.min(mins, CODE_MAX_MIN);
      durMs = mins * MIN;
    }
    durMs = Math.min(durMs, remaining, capToCurfew(state, now, now + durMs) - now);
    if (durMs < 30 * 1000) return { ok: false, error: "Curfew starts in under a minute. Not today." };

    const sess = {
      id: randomHex(8),
      siteId,
      mode,
      dayKey: todayKey(),
      start: now,
      segStart: now,
      endsAt: now + durMs,
      usedMs: 0,
      plannedMin: Math.round(durMs / MIN * 10) / 10,
      reason,
      reasonText: String(reasonText || "").slice(0, 200),
      videoId: vid || null,
      videoTitle: video?.title || "",
      spot: spot?.key || null,
      spotKind: spot?.kind || null,
      spotTitle: video?.title || "",
      needDuration: isClass ? false : needDuration,
      isClass,
      extensions: 0,
      phase: "running",
      lastSeen: now,
      mood: null,
    };
    state.active[siteId] = sess;
    dayEntry(state.days, siteId).opens += 1;
    if (isClass) dayEntry(state.days, siteId).classes += 1;
    await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
    chrome.alarms.create(`end:${siteId}`, { when: sess.endsAt });
    scheduleTickAlarm(sess);
    setTimeout(updateTicking, 300);
    return { ok: true, session: sess };
  });
}

// Learn session without a spot yet: the first video/group/page opened becomes the
// locked one. On YouTube the timer also resets to that video's length + 5 min.
async function lockSpot(siteId, url) {
  const spot = learnSpot(siteId, url);
  if (!spot) return;
  if (siteId !== "youtube") {
    let view = null;
    let settings;
    await locked(async () => {
      const state = await load();
      settings = state.settings;
      const sess = state.active[siteId];
      if (!sess || sess.mode !== "learn" || sessSpot(sess) || !isRunning(sess)) return;
      sess.spot = spot.key;
      sess.spotKind = spot.kind;
      await chrome.storage.local.set({ active: state.active });
      view = await sessionView(state, siteId);
    });
    if (view) broadcast(settings, siteId, { type: "hob:extended", view });
    return;
  }
  const vid = ytVideoId(url);
  const video = await fetchVideoInfo(vid);
  let view = null;
  let settings;
  await locked(async () => {
    const state = await load();
    settings = state.settings;
    const site = siteById(state.settings, siteId);
    const sess = state.active[siteId];
    if (!site || !sess || sess.mode !== "learn" || sessSpot(sess) || !isRunning(sess)) return;
    const now = Date.now();
    resumeInState(state, sess, now);
    sess.usedMs += Math.max(0, now - sess.segStart);
    sess.segStart = now;
    sess.videoId = vid;
    sess.videoTitle = video?.title || "";
    sess.spot = spot.key;
    sess.spotKind = "video";
    sess.spotTitle = sess.videoTitle;
    if (sess.isClass) {
      // A class keeps the length you picked.
      sess.needDuration = false;
      await chrome.storage.local.set({ active: state.active });
      view = await sessionView(state, siteId);
      return;
    }
    sess.needDuration = !video?.seconds;
    const remaining = remainingMs(state, site, now, "learn") + 0;
    const want = video?.seconds ? video.seconds * 1000 + LEARN_PAD_MS : 30 * MIN;
    sess.endsAt = capToCurfew(state, now, now + Math.min(want, remaining));
    sess.plannedMin = Math.round((sess.usedMs + sess.endsAt - now) / MIN * 10) / 10;
    await chrome.storage.local.set({ active: state.active });
    chrome.alarms.create(`end:${siteId}`, { when: sess.endsAt });
    scheduleTickAlarm(sess);
    view = await sessionView(state, siteId);
  });
  if (view) {
    broadcast(settings, siteId, { type: "hob:extended", view });
    setTimeout(updateTicking, 300);
  }
}

// The page reports the real video length when the watch page couldn't be read.
async function setDuration(siteId, videoId, seconds) {
  let view = null;
  let settings;
  await locked(async () => {
    const state = await load();
    settings = state.settings;
    const site = siteById(state.settings, siteId);
    const sess = state.active[siteId];
    if (!site || !sess || !sess.needDuration || sess.videoId !== videoId || !isRunning(sess)) return;
    const secs = Number(seconds);
    if (!Number.isFinite(secs) || secs <= 0 || secs > 12 * 3600) return;
    const now = Date.now();
    resumeInState(state, sess, now);
    sess.usedMs += Math.max(0, now - sess.segStart);
    sess.segStart = now;
    sess.needDuration = false;
    const elapsed = sess.usedMs;
    const want = Math.max(MIN, secs * 1000 + LEARN_PAD_MS - elapsed);
    sess.endsAt = capToCurfew(state, now, now + Math.min(want, remainingMs(state, site, now, "learn")));
    sess.plannedMin = Math.round((elapsed + sess.endsAt - now) / MIN * 10) / 10;
    await chrome.storage.local.set({ active: state.active });
    chrome.alarms.create(`end:${siteId}`, { when: sess.endsAt });
    scheduleTickAlarm(sess);
    view = await sessionView(state, siteId);
  });
  if (view) broadcast(settings, siteId, { type: "hob:extended", view });
  return { ok: true, view };
}

// The page reports a readable name for the locked group/page (from its title).
async function setSpotTitle(siteId, url, title) {
  return locked(async () => {
    const state = await load();
    const sess = state.active[siteId];
    const spot = learnSpot(siteId, url || "");
    if (!sess || !spot || spot.key !== sessSpot(sess) || sess.spotTitle) return { ok: false };
    sess.spotTitle = String(title || "").trim().slice(0, 120);
    await chrome.storage.local.set({ active: state.active });
    return { ok: true };
  });
}

async function timeUp(siteId) {
  let toBroadcast = null;
  let closeNow = false;
  let settings;
  await locked(async () => {
    const state = await load();
    settings = state.settings;
    const sess = state.active[siteId];
    if (!sess || sess.phase !== "running" || sess.pausedAt) return;
    const now = Date.now();
    if (now < sess.endsAt - 1000) {
      chrome.alarms.create(`end:${siteId}`, { when: sess.endsAt });
      return;
    }
    const mode = state.settings.endMode;
    sess.phase = mode === "soft" ? "expired" : "grace";
    sess.timeUpAt = now;
    sess.graceEndsAt = mode === "strict" ? now + state.settings.graceSeconds * 1000 : now;
    await chrome.storage.local.set({ active: state.active });
    if (mode === "hard") closeNow = true;
    toBroadcast = await sessionView(state, siteId);
  });
  if (!toBroadcast) return;
  beep();
  updateTicking();
  await broadcast(settings, siteId, { type: "hob:timeup", view: toBroadcast });
  if (closeNow) {
    await closeSiteTabs(siteId, "timeup");
  } else if (settings.endMode === "strict") {
    const delay = settings.graceSeconds * 1000;
    chrome.alarms.create(`grace:${siteId}`, { when: Date.now() + Math.max(delay, 30 * 1000) });
    setTimeout(() => graceOver(siteId), delay);
  }
}

async function graceOver(siteId) {
  const state = await load();
  const sess = state.active[siteId];
  if (!sess || sess.phase !== "grace") return;
  if (Date.now() < sess.graceEndsAt - 500) return;
  await closeSiteTabs(siteId, "timeup");
}

async function closeSiteTabs(siteId, endedBy) {
  let tabIds = [];
  await locked(async () => {
    const state = await load();
    const sess = state.active[siteId];
    tabIds = (await tabsForSite(state.settings, siteId)).map((t) => t.id);
    if (sess) {
      finalizeInState(state, sess, endedBy);
      await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
    }
  });
  if (tabIds.length) {
    // Keep the browser window alive if these are its only tabs.
    const all = await chrome.tabs.query({});
    if (all.length === tabIds.length) await chrome.tabs.create({ url: "chrome://newtab" }).catch(() => {});
    await chrome.tabs.remove(tabIds).catch(() => {});
  }
}

async function extendSession({ siteId, phrase }) {
  return locked(async () => {
    const state = await load();
    const site = siteById(state.settings, siteId);
    const sess = state.active[siteId];
    if (!site || !sess) return { ok: false, error: "No active session." };
    if (sess.phase === "running") return { ok: false, error: "Your timer is still running." };

    const now = Date.now();
    const needWait = extendWaitSeconds(sess.extensions, state.settings) * 1000;
    if (now - (sess.timeUpAt || 0) < needWait - 500) return { ok: false, error: "Wait for the countdown." };

    if (blockFor(state, site, now)) return { ok: false, error: "No extensions during focus or curfew." };
    const remaining = Math.min(sessRemaining(state, site, sess, now), capToCurfew(state, now, now + DAY) - now);
    const mins = Math.min(state.settings.extendMinutes, Math.floor(remaining / MIN));
    if (mins < 1) return { ok: false, error: "Today's budget is used up. No more extensions." };
    const expected = extendPhrase(mins).toLowerCase();
    if (String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ") !== expected) {
      return { ok: false, error: "Type the sentence exactly." };
    }

    sess.usedMs += Math.max(0, sess.endsAt - sess.segStart);
    sess.segStart = now;
    sess.endsAt = now + mins * MIN;
    sess.extensions += 1;
    sess.phase = "running";
    sess.timeUpAt = null;
    sess.graceEndsAt = null;
    dayEntry(state.days, siteId).extensions += 1;
    await chrome.storage.local.set({ active: state.active, days: state.days });
    chrome.alarms.clear(`grace:${siteId}`);
    chrome.alarms.create(`end:${siteId}`, { when: sess.endsAt });
    scheduleTickAlarm(sess);
    setTimeout(updateTicking, 300);
    const view = await sessionView(state, siteId);
    broadcast(state.settings, siteId, { type: "hob:extended", view });
    return { ok: true, view };
  });
}

// In strict mode the grace window may be shorter than the extend countdown.
// Asking to extend stretches the grace window just enough to type the sentence.
async function wantExtend(siteId) {
  let delay = 0;
  const res = await locked(async () => {
    const state = await load();
    const sess = state.active[siteId];
    if (!sess) return { ok: false };
    if (sess.phase === "grace" && !sess.graceStretched) {
      const needed = (sess.timeUpAt || Date.now()) + extendWaitSeconds(sess.extensions, state.settings) * 1000 + 30 * 1000;
      if (needed > sess.graceEndsAt) {
        sess.graceEndsAt = needed;
        delay = needed - Date.now();
      }
      sess.graceStretched = true;
      await chrome.storage.local.set({ active: state.active });
    }
    return { ok: true, view: await sessionView(state, siteId) };
  });
  if (delay > 0) {
    chrome.alarms.create(`grace:${siteId}`, { when: Date.now() + Math.max(delay, 30 * 1000) });
    setTimeout(() => graceOver(siteId), delay);
  }
  return res;
}

async function setMood({ siteId, mood }) {
  if (!MOODS[mood]) return { ok: false };
  return locked(async () => {
    const state = await load();
    const sess = state.active[siteId];
    if (sess) {
      sess.mood = mood;
      await chrome.storage.local.set({ active: state.active });
    }
    return { ok: true };
  });
}

async function sessionView(state, siteId) {
  const site = siteById(state.settings, siteId);
  const sess = state.active[siteId];
  if (!site || !sess) return null;
  const now = Date.now();
  const remaining = sessRemaining(state, site, sess, now);
  const extMins = Math.min(state.settings.extendMinutes, Math.floor(remaining / MIN));
  return {
    siteId,
    siteName: site.name,
    mode: sess.mode || "chill",
    videoId: sess.videoId || null,
    videoTitle: sess.videoTitle || "",
    spot: sessSpot(sess),
    spotKind: sess.spotKind || (sess.videoId ? "video" : null),
    spotTitle: sess.spotTitle || sess.videoTitle || "",
    needDuration: !!sess.needDuration,
    learnCheckinMin: sess.isClass ? CLASS_CHECKIN_MIN : state.settings.learnCheckinMin,
    isClass: !!sess.isClass,
    start: sess.start,
    phase: sess.phase,
    endsAt: sess.endsAt,
    graceEndsAt: sess.graceEndsAt || null,
    timeUpAt: sess.timeUpAt || null,
    reason: sess.reason,
    reasonText: sess.reasonText,
    mood: sess.mood,
    endMode: state.settings.endMode,
    remainingBudgetMs: remaining,
    canExtend: extMins >= 1,
    extendMinutes: extMins,
    extendPhrase: extMins >= 1 ? extendPhrase(extMins) : "",
    extendWaitSeconds: extendWaitSeconds(sess.extensions, state.settings),
    // Chill = your time, the feed shows (unless you turn hiding on). Learn always hides it.
    hideFeed: FEED_RULE_SITES.includes(site.id) && ((sess.mode || "chill") === "learn" || !!site.hideFeed),
    // Learn keeps its colors by default.
    grayscaleMode: (sess.mode || "chill") === "learn" && !state.settings.grayscaleInLearn ? "off" : state.settings.grayscaleMode,
    now,
  };
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("end:")) return timeUp(alarm.name.slice(4));
  if (alarm.name.startsWith("grace:")) return graceOver(alarm.name.slice(6));
  if (alarm.name.startsWith("tick:")) return updateTicking();
  if (alarm.name === "heartbeat") return heartbeat();
  if (alarm.name === "curfew" || alarm.name === "focusEnd") return enforceBlocks();
});

async function heartbeat() {
  const now = Date.now();
  const due = [];
  await locked(async () => {
    const state = await load();
    let changed = false;
    for (const sess of Object.values(state.active)) {
      if (sess.phase === "running") {
        sess.lastSeen = now;
        changed = true;
        if (!sess.pausedAt && now >= sess.endsAt) due.push(["timeup", sess.siteId]);
      } else if (sess.phase === "grace" && now >= sess.graceEndsAt) {
        due.push(["grace", sess.siteId]);
      } else if (sess.phase === "expired" && now - sess.timeUpAt > SOFT_EXPIRED_MAX_MS) {
        finalizeInState(state, sess, "expired");
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ active: state.active, days: state.days, log: state.log });
  });
  for (const [kind, siteId] of due) {
    if (kind === "timeup") await timeUp(siteId);
    else await graceOver(siteId);
  }
  // Also catches a paused session that sat too long.
  await syncPauses();
  await applyDueChanges();
  await enforceBlocks();
}

// ---------------------------------------------------------------------------
// Sound (offscreen document)
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function offscreenExists() {
  const url = chrome.runtime.getURL("pages/offscreen.html");
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  return existing.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "pages/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play the ticking clock and the time's-up beep.",
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

// Breathing exercise sound (pause screen + settings). Uses the tick volume.
async function breathSound(phase, seconds) {
  try {
    const { settings } = await load();
    if (phase !== "stop" && !(settings.tickVolume > 0)) return;
    if (phase === "stop" && !(await offscreenExists())) return;
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "offscreen:breath", phase, seconds: Number(seconds) || 4, volume: settings.tickVolume });
  } catch (e) {
    console.warn("breath sound failed", e);
  }
}

async function beep() {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "offscreen:beep" });
  } catch (e) {
    console.warn("beep failed", e);
  }
}

// Ticking clock. tickMode:
//   onSite     -> tick while a tab of the site is visible
//   always     -> tick for the whole session, even on other tabs
//   lastMinute -> tick only in the final minute
//   off
async function updateTicking() {
  try {
    const state = await load();
    const { tickMode, tickVolume } = state.settings;
    const now = Date.now();
    let endsAt = 0;
    if (tickMode && tickMode !== "off") {
      const { visible = {} } = await chrome.storage.session.get("visible");
      const visibleSites = new Set(Object.values(visible));
      for (const sess of Object.values(state.active)) {
        if (!isRunning(sess, now) || sess.pausedAt) continue;
        const on =
          tickMode === "always" ||
          (tickMode === "onSite" && visibleSites.has(sess.siteId)) ||
          (tickMode === "lastMinute" && sess.endsAt - now <= 60 * 1000);
        if (on) endsAt = Math.max(endsAt, sess.endsAt);
      }
    }
    if (endsAt) {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ type: "offscreen:tick", on: true, endsAt, volume: tickVolume });
    } else if (await offscreenExists()) {
      await chrome.runtime.sendMessage({ type: "offscreen:tick", on: false });
    }
  } catch (e) {
    console.warn("tick failed", e);
  }
}

function scheduleTickAlarm(sess) {
  const at = sess.endsAt - 60 * 1000;
  if (at > Date.now()) chrome.alarms.create(`tick:${sess.siteId}`, { when: at });
}

async function setTabVisible(tabId, siteId, visible) {
  const { visible: map = {} } = await chrome.storage.session.get("visible");
  if (visible && siteId) map[tabId] = siteId;
  else delete map[tabId];
  await chrome.storage.session.set({ visible: map });
  await syncPauses();
  await updateTicking();
}

// ---------------------------------------------------------------------------
// Settings + lock
// ---------------------------------------------------------------------------

// Built-in sites always stay on the list, with their own domains (you can add more).
function keepBuiltins(settings, current) {
  for (const id of BUILTIN_SITE_IDS) {
    const def = DEFAULT_SETTINGS.sites.find((x) => x.id === id);
    let site = settings.sites.find((x) => x.id === id);
    if (!site) {
      site = structuredClone(current.sites.find((x) => x.id === id) || def);
      settings.sites.splice(Math.min(BUILTIN_SITE_IDS.indexOf(id), settings.sites.length), 0, site);
    }
    site.domains = [...new Set([...def.domains, ...site.domains])];
  }
}

function sanitizeSettings(input) {
  const d = DEFAULT_SETTINGS;
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  const seen = new Set();
  const sites = (Array.isArray(input.sites) ? input.sites : []).map((s, i) => {
    let id = String(s.id || "").trim() || `site-${i}`;
    id = id.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    while (seen.has(id)) id += "-x";
    seen.add(id);
    const domains = (Array.isArray(s.domains) ? s.domains : String(s.domains || "").split(","))
      .map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter(Boolean);
    let messagesUrl = String(s.messagesUrl || "").trim();
    if (messagesUrl && !/^https:\/\//.test(messagesUrl)) messagesUrl = "";
    return {
      id,
      name: String(s.name || id).slice(0, 40),
      domains,
      dailyLimitMin: num(s.dailyLimitMin, 0, 24 * 60, 30),
      learnLimitMin: LEARN_SITES.includes(id) ? num(s.learnLimitMin, 0, 24 * 60, 0) : 0,
      enabled: !!s.enabled,
      hideFeed: !!s.hideFeed,
      messagesUrl,
      breathMode: s.breathMode === "rising" ? "rising" : "fixed",
      breaths: num(s.breaths, 1, 30, 3),
    };
  }).filter((s) => s.domains.length > 0);

  const timerOptions = [...new Set((Array.isArray(input.timerOptions) ? input.timerOptions : String(input.timerOptions || "").split(","))
    .map((x) => num(x, 1, 240, 0)).filter((x) => x > 0))].sort((a, b) => a - b).slice(0, 6);

  return {
    sites,
    timerOptions: timerOptions.length ? timerOptions : d.timerOptions,
    boredMaxMin: num(input.boredMaxMin, 1, 240, d.boredMaxMin),
    baseWaitSeconds: num(input.baseWaitSeconds, 0, 300, d.baseWaitSeconds),
    maxWaitSeconds: num(input.maxWaitSeconds, 0, 600, d.maxWaitSeconds),
    risingWait: !!input.risingWait,
    endMode: ["strict", "soft", "hard"].includes(input.endMode) ? input.endMode : d.endMode,
    graceSeconds: num(input.graceSeconds, 5, 120, d.graceSeconds),
    extendMinutes: num(input.extendMinutes, 1, 30, d.extendMinutes),
    extendBaseWaitSeconds: num(input.extendBaseWaitSeconds, 0, 120, d.extendBaseWaitSeconds),
    grayscaleMode: ["always", "lastMinute", "off"].includes(input.grayscaleMode) ? input.grayscaleMode : d.grayscaleMode,
    grayscaleInLearn: !!input.grayscaleInLearn,
    classesPerDay: num(input.classesPerDay, 0, 5, d.classesPerDay),
    learnCheckinMin: num(input.learnCheckinMin, 0, 120, d.learnCheckinMin),
    tickMode: ["onSite", "always", "lastMinute", "off"].includes(input.tickMode) ? input.tickMode : d.tickMode,
    tickVolume: num(input.tickVolume, 0, 100, d.tickVolume),
    focusAllow: [...new Set((Array.isArray(input.focusAllow) ? input.focusAllow : String(input.focusAllow || "").split(/[,\n]/))
      .map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, ""))
      .filter(Boolean))].slice(0, 100),
    alternatives: (Array.isArray(input.alternatives) ? input.alternatives : String(input.alternatives || "").split("\n"))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Stricter changes apply now. Looser ones need the password and apply 24h later.
// ---------------------------------------------------------------------------

const RANKS = {
  endMode: { soft: 0, strict: 1, hard: 2 },
  grayscaleMode: { off: 0, lastMinute: 1, always: 2 },
  breathMode: { fixed: 0, rising: 1 }, // rising starts at the fixed count, so it's never looser
};

// How to tell if a new value is looser than the old one.
const GLOBAL_RULES = {
  timerOptions: ["maxLower", "Timer choices"],
  boredMaxMin: ["lower", "Max minutes when bored"],
  baseWaitSeconds: ["higher", "First wait of the day"],
  maxWaitSeconds: ["higher", "Longest wait"],
  risingWait: ["higher", "Doubling wait"],
  endMode: ["rank", "When time's up"],
  graceSeconds: ["lower", "Grace period"],
  extendMinutes: ["lower", "Minutes per extension"],
  extendBaseWaitSeconds: ["higher", "Extension wait"],
  grayscaleMode: ["rank", "Black & white mode"],
  grayscaleInLearn: ["higher", "Black & white in Learn"],
  classesPerDay: ["lower", "Classes per day"],
  learnCheckinMin: ["checkin", "Learn check-in"],
  tickMode: ["neutral"],
  tickVolume: ["neutral"],
  alternatives: ["neutral"],
  focusAllow: ["subset", "Open during Focus"],
};
const SITE_RULES = {
  name: ["neutral"],
  domains: ["superset", "domains"],
  dailyLimitMin: ["lower", "budget"],
  learnLimitMin: ["lower", "learn budget"],
  enabled: ["higher", "tracking"],
  hideFeed: ["higher", "hide the feed"],
  messagesUrl: ["msgUrl", "messages link"],
  breathMode: ["rank", "breathing"],
  breaths: ["higher", "breaths"],
};
const SITE_DEFAULTS = { learnLimitMin: 0, breathMode: "fixed", breaths: 3, messagesUrl: "", hideFeed: false };

function isLooser(rule, key, oldV, newV) {
  switch (rule) {
    case "lower": return Number(newV) > Number(oldV);
    case "higher": return Number(newV) < Number(oldV);
    case "rank": return (RANKS[key][newV] ?? 0) < (RANKS[key][oldV] ?? 0);
    case "maxLower": return Math.max(...newV) > Math.max(...oldV);
    case "checkin": return oldV > 0 && (newV === 0 || newV > oldV);
    case "superset": return oldV.some((d) => !newV.includes(d));
    case "subset": return newV.some((d) => !oldV.includes(d));
    case "msgUrl": return newV !== oldV && newV !== "";
    case "curfew": return !curfewCovers(newV, oldV);
    case "changed": return newV !== oldV;
    default: return false;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

// Split a full settings edit into what applies now and what has to wait.
function splitChanges(cur, next) {
  const applied = structuredClone(cur);
  const patches = [];
  for (const [key, [rule, label]] of Object.entries(GLOBAL_RULES)) {
    if (same(cur[key], next[key])) continue;
    if (isLooser(rule, key, cur[key], next[key])) {
      patches.push({ path: [key], value: next[key], label: `${label}: ${show(cur[key])} → ${show(next[key])}` });
    } else applied[key] = next[key];
  }
  for (const ns of next.sites) {
    const i = applied.sites.findIndex((x) => x.id === ns.id);
    if (i < 0) {
      applied.sites.push(ns); // a new site is always stricter
      continue;
    }
    const cs = cur.sites.find((x) => x.id === ns.id);
    for (const [key, [rule, label]] of Object.entries(SITE_RULES)) {
      const ov = cs[key] ?? SITE_DEFAULTS[key];
      if (same(ov, ns[key])) continue;
      if (isLooser(rule, key, ov, ns[key])) {
        patches.push({ site: ns.id, path: [key], value: ns[key], label: `${cs.name} ${label}: ${show(ov)} → ${show(ns[key])}` });
      } else applied.sites[i][key] = ns[key];
    }
  }
  for (const cs of cur.sites) {
    if (BUILTIN_SITE_IDS.includes(cs.id)) continue; // built-in sites can't be removed
    if (!next.sites.some((x) => x.id === cs.id)) patches.push({ site: cs.id, remove: true, label: `Remove ${cs.name}` });
  }
  return { applied, patches };
}

function applyPatch(settings, p) {
  if (p.site) {
    const i = settings.sites.findIndex((x) => x.id === p.site);
    if (i < 0) return;
    if (p.remove) settings.sites.splice(i, 1);
    else settings.sites[i][p.path[0]] = p.value;
  } else settings[p.path[0]] = p.value;
}

async function checkPassword(password) {
  const { lock, attempts = { count: 0, until: 0 } } = await chrome.storage.local.get(["lock", "attempts"]);
  if (!lock) return { ok: false, error: "No password set." };
  const now = Date.now();
  if (attempts.until > now) return { ok: false, error: "Too many wrong attempts. Try again later." };
  const hash = await hashPassword(String(password || ""), lock.salt);
  if (hash !== lock.hash) {
    attempts.count += 1;
    if (attempts.count >= MAX_PASSWORD_ATTEMPTS) {
      attempts.until = now + ATTEMPT_COOLDOWN_MS;
      attempts.count = 0;
    }
    await chrome.storage.local.set({ attempts });
    return { ok: false, error: "Wrong password." };
  }
  await chrome.storage.local.set({ attempts: { count: 0, until: 0 } });
  return { ok: true };
}

// Before a password is even accepted for loosening, you breathe. The count grows each time.
async function recentLoosens() {
  const { loosenLog = [] } = await chrome.storage.local.get("loosenLog");
  const now = Date.now();
  // The streak resets after a full week with no loosening.
  const sorted = loosenLog.filter((t) => t <= now).sort((a, b) => b - a);
  let n = 0;
  let prev = now;
  for (const t of sorted) {
    if (prev - t > UNLOCK_BREATHS_RESET_MS) break;
    n++;
    prev = t;
  }
  return n;
}

async function breathStart() {
  const breaths = unlockBreaths(await recentLoosens());
  const token = randomHex(8);
  await chrome.storage.session.set({ breathToken: { token, issuedAt: Date.now(), seconds: breaths * BREATH_S } });
  return { ok: true, token, breaths };
}

async function breathOk(token) {
  const { breathToken } = await chrome.storage.session.get("breathToken");
  if (!breathToken || breathToken.token !== token) return false;
  return Date.now() - breathToken.issuedAt >= breathToken.seconds * 1000 - 1500;
}

async function noteLoosen() {
  const { loosenLog = [] } = await chrome.storage.local.get("loosenLog");
  loosenLog.push(Date.now());
  await chrome.storage.local.set({ loosenLog: loosenLog.slice(-50) });
  await chrome.storage.session.remove("breathToken");
}

// Save stricter parts now; schedule looser parts (breaths + password) for 24h later.
async function saveWithRules(state, next, password, strictOnly = false, breathToken = null) {
  const { applied, patches } = splitChanges(state.settings, next);
  if (strictOnly) {
    await chrome.storage.local.set({ settings: applied });
    return { ok: true, settings: applied, dropped: patches.map((p) => p.label) };
  }
  if (patches.length && !password) {
    return { ok: false, needPassword: true, loosen: patches.map((p) => p.label) };
  }
  if (patches.length) {
    if (!(await breathOk(breathToken))) return { ok: false, needPassword: true, loosen: patches.map((p) => p.label), error: "Finish the breaths first." };
    const pw = await checkPassword(password);
    if (!pw.ok) return { ...pw, needPassword: true, loosen: patches.map((p) => p.label) };
    await noteLoosen();
  }
  await chrome.storage.local.set({ settings: applied });
  let applyAt = null;
  if (patches.length) {
    applyAt = Date.now() + UNLOCK_DELAY_MS;
    const { pendingChanges = [] } = await chrome.storage.local.get("pendingChanges");
    const key = (p) => `${p.site || ""}:${p.remove ? "remove" : p.path.join(".")}`;
    const fresh = patches.map((p) => ({ ...p, id: randomHex(6), applyAt }));
    const kept = pendingChanges.filter((p) => !fresh.some((f) => key(f) === key(p)));
    await chrome.storage.local.set({ pendingChanges: [...kept, ...fresh] });
  }
  return { ok: true, settings: applied, scheduled: patches.map((p) => p.label), applyAt };
}

async function applyDueChanges() {
  return locked(async () => {
    const { pendingChanges = [] } = await chrome.storage.local.get("pendingChanges");
    if (!pendingChanges.length) return;
    const state = await load();
    if (focusActive(state)) return; // wait until focus is over
    const now = Date.now();
    const due = pendingChanges.filter((p) => p.applyAt <= now);
    if (!due.length) return;
    for (const p of due) applyPatch(state.settings, p);
    await chrome.storage.local.set({ settings: state.settings, pendingChanges: pendingChanges.filter((p) => p.applyAt > now) });
  });
}

async function cancelPending(id) {
  return locked(async () => {
    const { pendingChanges = [] } = await chrome.storage.local.get("pendingChanges");
    const left = id ? pendingChanges.filter((p) => p.id !== id) : [];
    await chrome.storage.local.set({ pendingChanges: left });
    return { ok: true, pending: left };
  });
}

async function lockView() {
  const { lock, attempts } = await chrome.storage.local.get(["lock", "attempts"]);
  const st = lockStatus(lock);
  const blockedUntil = attempts && attempts.until > Date.now() ? attempts.until : null;
  return { ...st, attemptsBlockedUntil: blockedUntil, unlockDelayHours: UNLOCK_DELAY_MS / 3600000 };
}

async function requestUnlock(password) {
  return locked(async () => {
    const { lock, attempts = { count: 0, until: 0 } } = await chrome.storage.local.get(["lock", "attempts"]);
    if (!lock) return { ok: false, error: "No password set." };
    const now = Date.now();
    if (attempts.until > now) return { ok: false, error: "Too many wrong attempts. Try again later." };
    const st = lockStatus(lock, now);
    if (st.state !== "locked") return { ok: false, error: "An unlock is already pending or active." };
    const hash = await hashPassword(String(password || ""), lock.salt);
    if (hash !== lock.hash) {
      attempts.count += 1;
      if (attempts.count >= MAX_PASSWORD_ATTEMPTS) {
        attempts.until = now + ATTEMPT_COOLDOWN_MS;
        attempts.count = 0;
      }
      await chrome.storage.local.set({ attempts });
      return { ok: false, error: "Wrong password." };
    }
    lock.unlockAt = now + UNLOCK_DELAY_MS;
    await chrome.storage.local.set({ lock, attempts: { count: 0, until: 0 } });
    return { ok: true };
  });
}

async function relock() {
  return locked(async () => {
    const { lock } = await chrome.storage.local.get("lock");
    if (!lock) return { ok: false };
    lock.unlockAt = null;
    lock.setupUntil = null;
    await chrome.storage.local.set({ lock });
    await chrome.storage.local.remove("pendingPassword");
    return { ok: true };
  });
}

async function newPassword() {
  return locked(async () => {
    const { lock } = await chrome.storage.local.get("lock");
    if (!isEditable(lock)) return { ok: false, error: "Settings are locked." };
    const password = generatePassword();
    lock.salt = randomHex();
    lock.hash = await hashPassword(password, lock.salt);
    await chrome.storage.local.set({ lock });
    return { ok: true, password };
  });
}

async function saveSettings(input, password, strictOnly, breathToken) {
  const res = await locked(async () => {
    const { lock } = await chrome.storage.local.get("lock");
    const state = await load();
    if (focusActive(state)) return { ok: false, error: "Focus mode is on. Settings can wait." };
    const settings = sanitizeSettings(input || {});
    settings.curfew = state.settings.curfew; // the curfew has its own save (curfew:save)
    keepBuiltins(settings, state.settings);
    if (isEditable(lock)) {
      await chrome.storage.local.set({ settings });
      return { ok: true, settings };
    }
    return saveWithRules(state, settings, password, strictOnly, breathToken);
  });
  if (res.ok) {
    setTimeout(updateTicking, 300);
    sweepOpenTabs();
  }
  return res;
}

// ---------------------------------------------------------------------------
// Gate (pause page) info
// ---------------------------------------------------------------------------

async function gateInfo(siteId, target) {
  const state = await load();
  const now = Date.now();
  if (siteId === "_focus") {
    return { ok: true, site: { id: "_focus", name: "Extensions", enabled: true }, block: focusActive(state, now) ? blockFor(state, {}, now) : null, released: !focusActive(state, now) };
  }
  if (siteId === "_focusweb") {
    let name = "This site";
    try {
      name = new URL(target).hostname || name;
    } catch {}
    const closed = focusActive(state, now) && focusClosesUrl(state.settings.focusAllow, target || "");
    return { ok: true, site: { id: "_focusweb", name, enabled: true }, block: closed ? blockFor(state, {}, now) : null, released: !closed };
  }
  const site = siteById(state.settings, siteId);
  if (!site) return { ok: false, error: "Unknown site." };
  const block = blockFor(state, site, now);
  if (block) return { ok: true, site: { id: site.id, name: site.name, enabled: true }, block };
  const opens = state.days[todayKey()]?.[siteId]?.opens || 0;
  const remaining = remainingMs(state, site, now);
  const learn = hasLearnMode(site);
  const learnRemaining = learn ? remainingMs(state, site, now, "learn") : 0;
  const waitSeconds = waitSecondsFor(opens, state.settings, site);
  const token = randomHex(8);
  const { tokens = {} } = await chrome.storage.session.get("tokens");
  for (const [k, v] of Object.entries(tokens)) if (now - v.issuedAt > 60 * MIN) delete tokens[k];
  tokens[token] = { siteId, issuedAt: now, waitSeconds };
  await chrome.storage.session.set({ tokens });
  return {
    ok: true,
    token,
    site: { id: site.id, name: site.name, dailyLimitMin: site.dailyLimitMin, learnLimitMin: site.learnLimitMin || 0, messagesUrl: site.messagesUrl, enabled: site.enabled, breathMode: site.breathMode || "rising" },
    learn,
    learnRemainingMs: learnRemaining,
    learnUsedMs: learn ? site.learnLimitMin * MIN - learnRemaining : 0,
    learnPadMin: LEARN_PAD_MS / MIN,
    learnFindMin: LEARN_FIND_MS / MIN,
    targetSpot: learn ? learnSpot(siteId, target || "") : null,
    classesLeft: learn ? classesLeft(state, site) : 0,
    classesPerDay: state.settings.classesPerDay ?? 1,
    classOptions: CLASS_OPTIONS,
    classBreaths: CLASS_BREATHS,
    classCheckinMin: CLASS_CHECKIN_MIN,
    opensToday: opens,
    usedMs: site.dailyLimitMin * MIN - remaining,
    remainingMs: remaining,
    waitSeconds,
    timerOptions: state.settings.timerOptions,
    boredMaxMin: state.settings.boredMaxMin,
    alternatives: state.settings.alternatives,
    running: isRunning(state.active[siteId], now),
    targetAllowed: allowedInSession(state.active[siteId], target || ""),
    lockedSpot: lockedSpotLabel(state.active[siteId]),
  };
}

function lockedSpotLabel(sess) {
  if (sess?.mode !== "learn" || !sessSpot(sess)) return null;
  const kind = sess.spotKind || "video";
  return sess.spotTitle || sess.videoTitle || `that ${kind}`;
}

async function popupInfo() {
  const state = await load();
  const now = Date.now();
  const sites = state.settings.sites.filter((s) => s.enabled).map((s) => {
    const sess = state.active[s.id];
    return {
      id: s.id,
      name: s.name,
      limitMs: s.dailyLimitMin * MIN,
      remainingMs: remainingMs(state, s, now),
      learnLimitMs: hasLearnMode(s) ? s.learnLimitMin * MIN : 0,
      learnRemainingMs: hasLearnMode(s) ? remainingMs(state, s, now, "learn") : 0,
      opens: state.days[todayKey()]?.[s.id]?.opens || 0,
      classUsedMs: (state.days[todayKey()]?.[s.id]?.classUsedMs || 0) + (sess?.isClass && isRunning(sess, now) ? sessionUsedMs(sess, now) : 0),
      session: sess ? { phase: sess.phase, endsAt: sess.endsAt, pausedAt: sess.pausedAt || null, reason: sess.reason, reasonText: sess.reasonText, mode: sess.mode || "chill", isClass: !!sess.isClass } : null,
    };
  });
  return {
    ok: true,
    sites,
    now,
    focus: focusActive(state, now) ? state.focus : null,
    volume: state.settings.tickVolume ?? 40,
    curfew: { ...state.settings.curfew, ...curfewState(state.settings.curfew, now) },
  };
}

async function statsInfo() {
  const state = await load();
  return {
    ok: true,
    settings: state.settings,
    days: state.days,
    log: state.log,
    active: state.active,
    now: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || msg.type.startsWith("offscreen:")) return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "gate:check": {
      const state = await load();
      const { site, block } = siteAndBlock(state, msg.url);
      if (!site) return { tracked: false };
      if (block) {
        if (state.active[site.id]) await enforceBlocks();
        if (sender.tab) chrome.tabs.update(sender.tab.id, { url: gateUrl(site.id, msg.url) }).catch(() => {});
        return { tracked: true, allowed: false };
      }
      const sess = state.active[site.id];
      if (isRunning(sess)) {
        if (needsLock(sess, msg.url)) {
          await lockSpot(site.id, msg.url);
          const s2 = await load();
          return { tracked: true, allowed: true, view: await sessionView(s2, site.id) };
        }
        if (allowedInSession(sess, msg.url)) return { tracked: true, allowed: true, view: await sessionView(state, site.id) };
        if (sender.tab) chrome.tabs.update(sender.tab.id, { url: gateUrl(site.id, msg.url) }).catch(() => {});
        return { tracked: true, allowed: false };
      }
      if (sess && sess.phase === "grace" && sender.tab) {
        // Time is up but the grace window is open: show the overlay, not the gate.
        return { tracked: true, allowed: true, view: await sessionView(state, site.id) };
      }
      if (sender.tab) chrome.tabs.update(sender.tab.id, { url: gateUrl(site.id, msg.url) }).catch(() => {});
      return { tracked: true, allowed: false };
    }
    case "gate:info":
      return gateInfo(msg.siteId, msg.target);
    case "gate:start": {
      const res = await startSession(msg);
      if (!res.ok) return res;
      const state = await load();
      const site = siteById(state.settings, msg.siteId);
      let target = msg.target;
      if (msg.mode !== "learn" && msg.reason === "messages" && site.messagesUrl) target = site.messagesUrl;
      // Facebook learn without a group/page yet: start at "your groups", not the feed.
      if (msg.mode === "learn" && site.id === "facebook" && !learnSpot(site.id, target || "") && !learnBrowseOk(site.id, target || "")) {
        target = "https://www.facebook.com/groups/joins/";
      }
      if (!findSiteForUrl(state.settings, target || "")) target = `https://${site.domains[0]}/`;
      return { ok: true, target };
    }
    case "gate:closeTab":
      if (sender.tab) chrome.tabs.remove(sender.tab.id).catch(() => {});
      return { ok: true };
    case "gate:videoInfo": {
      const info = await fetchVideoInfo(ytVideoId(msg.url || ""));
      return { ok: true, video: info };
    }
    case "learn:spotTitle":
      return setSpotTitle(msg.siteId, msg.url, msg.title);
    case "yt:duration":
      return setDuration(msg.siteId, msg.videoId, msg.seconds);
    case "tick:visible":
      if (sender.tab) await setTabVisible(sender.tab.id, msg.siteId, !!msg.visible);
      return { ok: true };
    case "session:get": {
      const state = await load();
      return { ok: true, view: await sessionView(state, msg.siteId) };
    }
    case "session:timeupCheck": {
      const state = await load();
      const sess = state.active[msg.siteId];
      if (sess && sess.phase === "running" && !sess.pausedAt && Date.now() >= sess.endsAt) await timeUp(msg.siteId);
      else if (sess && sess.phase === "grace" && Date.now() >= sess.graceEndsAt) await graceOver(msg.siteId);
      const s2 = await load();
      return { ok: true, view: await sessionView(s2, msg.siteId) };
    }
    case "session:wantExtend":
      return wantExtend(msg.siteId);
    case "session:extend":
      return extendSession(msg);
    case "session:mood":
      return setMood(msg);
    case "session:done":
      if (msg.mood) await setMood(msg);
      await closeSiteTabs(msg.siteId, msg.early ? "done-early" : "done");
      return { ok: true };
    case "focus:start":
      return startFocus(msg.minutes);
    case "curfew:save":
      return saveCurfew(msg.curfew);
    case "popup:info":
      return popupInfo();
    case "stats:get":
      return statsInfo();
    case "settings:get": {
      const state = await load();
      return { ok: true, settings: state.settings, lock: await lockView(), defaults: DEFAULT_SETTINGS };
    }
    case "settings:save":
      return saveSettings(msg.settings, msg.password, !!msg.strictOnly, msg.breathToken);
    case "breath:start":
      return breathStart();
    case "volume:set":
      // Sound volume is neither stricter nor looser: no password, works anytime (even in focus).
      return locked(async () => {
        const state = await load();
        const v = Math.round(Number(msg.volume));
        if (!Number.isFinite(v)) return { ok: false };
        state.settings.tickVolume = Math.max(0, Math.min(100, v));
        await chrome.storage.local.set({ settings: state.settings });
        setTimeout(updateTicking, 100);
        return { ok: true, volume: state.settings.tickVolume };
      });
    case "breath:sound":
      breathSound(msg.phase, msg.seconds);
      return { ok: true };
    case "pending:list": {
      const { pendingChanges = [] } = await chrome.storage.local.get("pendingChanges");
      return { ok: true, pending: pendingChanges };
    }
    case "pending:cancel":
      return cancelPending(msg.id);
    case "lock:status":
      return { ok: true, lock: await lockView() };
    case "lock:request":
      return requestUnlock(msg.password);
    case "lock:relock":
      return relock();
    case "lock:newPassword":
      return newPassword();
    case "welcome:password": {
      const { pendingPassword, lock } = await chrome.storage.local.get(["pendingPassword", "lock"]);
      const st = lockStatus(lock);
      // Once the setup window is over the password is gone for good, acknowledged or not.
      if (pendingPassword && st.state !== "setup") {
        await chrome.storage.local.remove("pendingPassword");
        return { ok: true, password: null, lock: st };
      }
      return { ok: true, password: pendingPassword || null, lock: st };
    }
    case "welcome:ack":
      await chrome.storage.local.remove("pendingPassword");
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message ${msg.type}` };
  }
}
