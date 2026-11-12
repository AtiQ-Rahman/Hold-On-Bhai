// Shared helpers used by the background service worker and extension pages.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const UNLOCK_DELAY_MS = 24 * HOUR; // password unlock takes effect after 24h
export const UNLOCK_WINDOW_MS = 1 * HOUR; // ...and stays open for 1h
export const SETUP_WINDOW_MS = 30 * MIN;  // fresh install: settings editable for 30 min
export const MAX_PASSWORD_ATTEMPTS = 5;
export const ATTEMPT_COOLDOWN_MS = 1 * HOUR;

export const REASONS = {
  messages: { label: "Check my DMs", emoji: "💬" },
  specific: { label: "Look up one specific thing", emoji: "🔍" },
  post: { label: "Gotta post or reply", emoji: "📢" },
  bored: { label: "Just bored ngl", emoji: "🫠" },
  other: { label: "Something else", emoji: "✏️" },
  learn: { label: "Learning", emoji: "📚" },
  code: { label: "Grab a login code", emoji: "🔑" },
};

export const CODE_MAX_MIN = 2; // "Grab a login code" gets 2 minutes, tops
// Reasons only some sites offer.
export const SITE_REASONS = { gmail: ["code"] };

// Reasons offered on the normal ("chill") pause screen.
export const CHILL_REASONS = ["code", "messages", "specific", "post", "bored", "other"];

export const LEARN_PAD_MS = 5 * 60 * 1000;     // learn timer = video length + 5 min
export const LEARN_FIND_MS = 5 * 60 * 1000;    // time to find a video when none is picked yet
export const LEARN_SITES = ["youtube", "facebook"];
export const FOCUS_PRESETS = [25, 50, 90, 120]; // minutes
export const FOCUS_MAX_MIN = 12 * 60;
// Learn → 🎓 Class: long sessions (live classes etc.) that don't use the Learn budget.
export const CLASS_OPTIONS = [60, 90, 120, 180]; // minutes
export const CLASS_BREATHS = 3;      // extra breaths before a class starts
export const CLASS_CHECKIN_MIN = 30; // gentle check-in, no pause
export const LEARN_TIMER_OPTIONS = [10, 15, 20, 30]; // Facebook learn sessions (no video length to go by)

export const MOODS = {
  better: { label: "Better", emoji: "🙂" },
  same: { label: "Meh", emoji: "😐" },
  worse: { label: "Worse", emoji: "🫠" },
};

// Sites with built-in "hide the feed" CSS rules (see content/content.css).
export const FEED_RULE_SITES = ["facebook", "youtube", "instagram", "x", "reddit"];

export const DEFAULT_SETTINGS = {
  sites: [
    {
      id: "facebook",
      name: "Facebook",
      domains: ["facebook.com", "messenger.com", "fb.com"],
      dailyLimitMin: 30,
      learnLimitMin: 30,
      enabled: true,
      hideFeed: false,
      messagesUrl: "https://www.facebook.com/messages/",
      breathMode: "fixed",
      breaths: 3,
    },
    {
      id: "youtube",
      name: "YouTube",
      domains: ["youtube.com", "youtu.be"],
      dailyLimitMin: 30,
      learnLimitMin: 120,
      enabled: true,
      hideFeed: false,
      messagesUrl: "",
      breathMode: "fixed",
      breaths: 3,
    },
    {
      id: "gmail",
      name: "Gmail",
      domains: ["mail.google.com"],
      dailyLimitMin: 30,
      enabled: true,
      hideFeed: false,
      messagesUrl: "",
      breathMode: "fixed",
      breaths: 1, // quick, for login codes
    },
    {
      id: "instagram",
      name: "Instagram",
      domains: ["instagram.com"],
      dailyLimitMin: 20,
      enabled: false,
      hideFeed: false,
      messagesUrl: "https://www.instagram.com/direct/inbox/",
      breathMode: "fixed",
      breaths: 3,
    },
    {
      id: "x",
      name: "X / Twitter",
      domains: ["x.com", "twitter.com"],
      dailyLimitMin: 20,
      enabled: false,
      hideFeed: false,
      messagesUrl: "https://x.com/messages",
      breathMode: "fixed",
      breaths: 3,
    },
    {
      id: "reddit",
      name: "Reddit",
      domains: ["reddit.com"],
      dailyLimitMin: 20,
      enabled: false,
      hideFeed: false,
      messagesUrl: "",
      breathMode: "fixed",
      breaths: 3,
    },
  ],
  timerOptions: [2, 5, 10, 15],
  boredMaxMin: 5,
  baseWaitSeconds: 5,
  maxWaitSeconds: 60,
  risingWait: true,
  endMode: "strict", // strict | soft | hard
  graceSeconds: 15,
  extendMinutes: 2,
  extendBaseWaitSeconds: 10,
  grayscaleMode: "always", // always | lastMinute | off
  grayscaleInLearn: false,
  classesPerDay: 1, // Learn mode keeps its colors unless this is on
  learnCheckinMin: 10,
  curfew: { enabled: false, start: "00:00", end: "07:00" },
  // During Focus every website is closed except these (subdomains included).
  focusAllow: ["localhost", "127.0.0.1"],
  tickMode: "onSite", // onSite | always | lastMinute | off
  tickVolume: 40,
  alternatives: [
    "Drink some water, stay hydrated bestie",
    "Stretch for 2 min, your back will thank you",
    "Drop and give me 10 pushups",
    "Touch grass (literally, go outside)",
    "Do the smallest thing on your to-do list",
  ],
};

// Sites that ship with the extension. They can be switched off, never removed.
export const BUILTIN_SITE_IDS = DEFAULT_SETTINGS.sites.map((s) => s.id);

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function msUntilMidnight(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next - now;
}

export function hostMatches(hostname, domain) {
  hostname = hostname.toLowerCase();
  domain = domain.toLowerCase().trim();
  if (!domain) return false;
  return hostname === domain || hostname.endsWith("." + domain);
}

// Focus mode: is this URL a website that has to close? (http/https and not on the allowlist)
export function focusClosesUrl(allow, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !(allow || []).some((d) => hostMatches(u.hostname, d));
}

export function findSiteForUrl(settings, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  for (const site of settings.sites) {
    if (!site.enabled) continue;
    if (site.domains.some((d) => hostMatches(u.hostname, d))) return site;
  }
  return null;
}

// The pause screen wait is a breathing exercise: in for 4s, out for 6s.
export const BREATH_IN_S = 4;
export const BREATH_OUT_S = 6;
export const BREATH_S = BREATH_IN_S + BREATH_OUT_S;

// Loosening a setting: breathe first. 10 breaths, then 10 more each time (within a week), up to 60.
export const UNLOCK_BREATHS_STEP = 10;
export const UNLOCK_BREATHS_MAX = 60;
export const UNLOCK_BREATHS_RESET_MS = 7 * 24 * 60 * 60 * 1000;

export function unlockBreaths(recentLoosens) {
  return Math.min(UNLOCK_BREATHS_MAX, UNLOCK_BREATHS_STEP * (recentLoosens + 1));
}

// Per-site breathing. "fixed": the same count every visit. "rising": starts at that same count
// and grows with each visit today (up to the Longest wait), so rising is never easier than fixed.
export function waitSecondsFor(opensToday, settings, site = null) {
  const floor = site ? Math.max(1, Number(site.breaths) || 3) : 0;
  if (site && site.breathMode !== "rising") return floor * BREATH_S;
  const base = Math.max(0, settings.baseWaitSeconds);
  let w = base;
  if (settings.risingWait) {
    w = Math.min(Math.max(base, base * Math.pow(2, Math.min(opensToday, 10))), Math.max(base, settings.maxWaitSeconds));
  }
  // Whole breaths, never below the site's own count.
  const breaths = Math.max(floor, w > 0 ? Math.ceil(w / BREATH_S) : 0);
  return breaths * BREATH_S;
}

export function extendWaitSeconds(extensionsSoFar, settings) {
  return Math.min(120, settings.extendBaseWaitSeconds * Math.pow(2, extensionsSoFar));
}

export function extendPhrase(minutes) {
  return `I choose to spend ${minutes} more minute${minutes === 1 ? "" : "s"} here`;
}

export function fmtDuration(ms) {
  ms = Math.max(0, ms);
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0 && s === 0) return `${m} min`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtMinutes(ms) {
  const m = Math.round(Math.max(0, ms) / MIN);
  return `${m} min`;
}

export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PW_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function generatePassword() {
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  }
  return out;
}

export function randomHex(nBytes = 16) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Lock state machine:
//   setup    -> fresh install, editable until setupUntil
//   unlocked -> password accepted 24h ago, editable until unlockedUntil
//   pending  -> password accepted, waiting for unlockAt
//   locked   -> read-only
export function lockStatus(lock, now = Date.now()) {
  if (!lock) return { state: "locked" };
  if (lock.setupUntil && now < lock.setupUntil) return { state: "setup", until: lock.setupUntil };
  if (lock.unlockAt) {
    const until = lock.unlockAt + UNLOCK_WINDOW_MS;
    if (now < lock.unlockAt) return { state: "pending", at: lock.unlockAt };
    if (now < until) return { state: "unlocked", until };
  }
  return { state: "locked" };
}

export function isEditable(lock, now = Date.now()) {
  const s = lockStatus(lock, now).state;
  return s === "setup" || s === "unlocked";
}

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// YouTube video id from any of its URL shapes, or null.
export function ytVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^www\.|^m\./, "");
  if (h === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!h.endsWith("youtube.com")) return null;
  if (u.pathname === "/watch") return u.searchParams.get("v");
  const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
  return m ? m[2] : null;
}

export function hasLearnMode(site) {
  return !!site && LEARN_SITES.includes(site.id) && site.learnLimitMin > 0;
}

// Facebook paths that are not a group, page or profile.
const FB_RESERVED = new Set([
  "", "home.php", "messages", "watch", "reel", "reels", "stories", "marketplace", "gaming", "notifications",
  "friends", "bookmarks", "search", "events", "saved", "memories", "groups", "photo", "photo.php", "photos",
  "permalink.php", "story.php", "share", "settings", "help", "login", "login.php", "pages", "feeds", "live",
  "hashtag", "ads", "business", "profile.php", "people", "l.php", "plugins", "dialog", "sharer", "sharer.php",
  "privacy", "policies", "me", "find-friends", "fundraisers", "jobs", "news", "offers", "latest", "checkpoint",
  "recover", "logout.php", "games", "media", "video.php", "videos", "lite", "composer", "notes", "ajax", "api",
]);

function fbUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (!(h === "facebook.com" || h.endsWith(".facebook.com") || h === "fb.com" || h.endsWith(".fb.com"))) return null;
    return u;
  } catch {
    return null;
  }
}

// The one "spot" a learn session is locked to: a YouTube video, or a Facebook
// group, page, profile or video. Returns { key, kind } or null.
export function learnSpot(siteId, url) {
  if (siteId === "youtube") {
    const v = ytVideoId(url);
    return v ? { key: `yt:${v}`, kind: "video" } : null;
  }
  if (siteId !== "facebook") return null;
  const u = fbUrl(url);
  if (!u) return null;
  const parts = u.pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
  const first = (parts[0] || "").toLowerCase();
  const q = u.searchParams;
  if (first === "groups" && parts[1] && !["feed", "discover", "joins", "create", "notifications", "search", "you"].includes(parts[1].toLowerCase())) {
    return { key: `fb:group:${parts[1].toLowerCase()}`, kind: "group" };
  }
  if (first === "watch" && q.get("v")) return { key: `fb:video:${q.get("v")}`, kind: "video" };
  if (first === "profile.php" && q.get("id")) return { key: `fb:page:${q.get("id")}`, kind: "page" };
  if (first === "people" && parts[2]) return { key: `fb:page:${parts[2]}`, kind: "page" };
  if ((first === "permalink.php" || first === "story.php") && q.get("id")) return { key: `fb:page:${q.get("id")}`, kind: "page" };
  if ((first === "photo" || first === "photo.php") && /^g\.\d+/.test(q.get("set") || "")) {
    return { key: `fb:group:${q.get("set").slice(2)}`, kind: "group" };
  }
  if (first && !FB_RESERVED.has(first) && !first.includes(".")) {
    if (parts[1] === "videos" && parts[2]) return { key: `fb:video:${parts[parts.length - 1]}`, kind: "video" };
    return { key: `fb:page:${first}`, kind: "page" };
  }
  return null;
}

// Learn session, nothing locked yet: where you may go to find your spot.
export function learnBrowseOk(siteId, url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "") || "/";
    if (siteId === "youtube") return p === "/" || p === "/results";
    if (siteId === "facebook") return /^\/(search(\/.*)?|groups\/joins|groups|bookmarks|saved)$/.test(p);
  } catch {}
  return false;
}

// Learn session, spot locked: pages that open on top of it (photo viewer etc).
export function learnSideOk(siteId, url) {
  if (siteId !== "facebook") return false;
  const u = fbUrl(url);
  return !!u && /^\/(photo(\.php)?|photos)\/?/.test(u.pathname);
}

export const SPOT_WORD = { video: "video", group: "group", page: "page" };

// ---------------------------------------------------------------------------
// Curfew: a daily window (e.g. 00:00 to 07:00) when tracked sites stay closed.
// ---------------------------------------------------------------------------

export function parseHM(v) {
  const m = String(v || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// 12-hour label like "12:00 AM".
export function fmtHM12(v) {
  const m = parseHM(v);
  if (m === null) return v;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// Minutes of the day covered by the curfew, as a 1440-long array of booleans.
function curfewMinutes(c) {
  const out = new Array(1440).fill(false);
  if (!c?.enabled) return out;
  const a = parseHM(c.start);
  const b = parseHM(c.end);
  if (a === null || b === null || a === b) return out;
  for (let m = a; m !== b; m = (m + 1) % 1440) out[m] = true;
  return out;
}

// True if curfew `next` blocks at least every minute `prev` blocks (it's stricter or equal).
export function curfewCovers(next, prev) {
  const n = curfewMinutes(next);
  return curfewMinutes(prev).every((on, i) => !on || n[i]);
}

// { active, endsAt } when the curfew is on right now; otherwise { active: false, startsAt }.
export function curfewState(c, now = Date.now()) {
  const mins = curfewMinutes(c);
  if (!mins.includes(true)) return { active: false, startsAt: null };
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const at = (k) => {
    const t = new Date(now);
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + k);
    return t.getTime();
  };
  if (mins[cur]) {
    let k = 1;
    while (k < 1440 && mins[(cur + k) % 1440]) k++;
    return { active: true, endsAt: at(k) };
  }
  let k = 1;
  while (k < 1440 && !mins[(cur + k) % 1440]) k++;
  return { active: false, startsAt: at(k) };
}
