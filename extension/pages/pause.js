import { runBreaths } from "./breath.js";
import { BREATH_S, fmtHM12, CODE_MAX_MIN, SITE_REASONS, REASONS, CHILL_REASONS, LEARN_TIMER_OPTIONS, send, fmtMinutes, fmtDuration, fmtClock, msUntilMidnight, escapeHtml, ytVideoId, MIN } from "../lib.js";

const params = new URLSearchParams(location.search);
const siteId = params.get("site");
const target = params.get("to") || "";

const $ = (id) => document.getElementById(id);

let info = null;
let mode = null; // "learn" | "chill"
let reason = null;
let minutes = null;
let waitDone = false;
let boredAccepted = false;
let video = null; // { seconds, title } for learn mode with a video link
let videoLoading = false;
let isClass = false;
let classMin = null;
let classBreathDone = false;
let stopClassBreaths = null;

function show(id) {
  for (const s of ["loading", "gate", "blocked", "block", "oops"]) $(s).hidden = s !== id;
}

async function closeTab() {
  await send("gate:closeTab");
  window.close();
}

async function init() {
  if (!siteId) {
    $("oops-text").textContent = "Nothing to open here.";
    return show("oops");
  }
  info = await send("gate:info", { siteId, target });
  if (!info?.ok) {
    $("oops-text").textContent = info?.error || "Something went wrong.";
    return show("oops");
  }
  document.querySelectorAll(".site-name").forEach((el) => (el.textContent = info.site.name));
  document.title = `Hold on, bhai · ${info.site.name}`;
  if (info.block) return showBlock(info.block);
  if (info.released && siteId === "_focusweb" && /^https?:/.test(target)) {
    location.replace(target);
    return;
  }
  if (info.released && siteId === "_focusweb" && /^(chrome|moz)-extension:/.test(target)) {
    // Another extension's page (a PDF viewer): a page can't open it itself, the tabs API can.
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.update(tab.id, { url: target });
    return;
  }
  if (info.released) {
    $("oops-text").textContent = "Focus is over. You made it 🏆 Open that page again if you still need it.";
    return show("oops");
  }

  if (!info.site.enabled) {
    location.replace(target || "about:blank");
    return;
  }
  if (info.running && info.targetAllowed) {
    location.replace(target);
    return;
  }
  const chillOk = info.remainingMs >= 30 * 1000;
  const learnBudgetOk = info.learn && info.learnRemainingMs >= 30 * 1000;
  const classOk = info.learn && info.classesLeft > 0;
  const learnOk = learnBudgetOk || classOk;
  if (!chillOk && !learnOk) return showBlocked();

  const n = info.opensToday + 1;
  $("opens-line").textContent = n === 1 ? "First visit today" : `Visit #${n} today 👀`;
  if (n >= 3) $("lead").innerHTML = `You're about to open <b>${escapeHtml(info.site.name)}</b>. Again?`;

  if (info.running && !info.targetAllowed && info.lockedSpot) {
    $("locked-note").hidden = false;
    $("locked-note").innerHTML = `🔒 You're locked to <b>${escapeHtml(info.lockedSpot)}</b>. Starting something new ends that session.`;
  }
  if (siteId === "facebook") $("learn-text").placeholder = "e.g. React group Q&A, IELTS speaking tips";

  wire();
  renderReasons();
  if (info.learn) {
    $("step-mode").hidden = false;
    $("learn-left").textContent = learnBudgetOk
      ? `${fmtMinutes(info.learnRemainingMs)} left of ${info.site.learnLimitMin} min`
      : classOk ? "Budget used up, a class is still OK" : "Used up for today";
    $("class-box").hidden = !classOk;
    $("class-left").textContent = `${info.classesLeft} of ${info.classesPerDay} left today. Doesn't use your Learn budget. Check-ins every ${info.classCheckinMin} min, no pausing.`;
    if (!learnBudgetOk && classOk) {
      // Only a class is possible: start with it ticked.
      $("is-class").checked = true;
      isClass = true;
    }
    $("chill-left").textContent = chillOk ? `${fmtMinutes(info.remainingMs)} left of ${info.site.dailyLimitMin} min` : "Used up for today";
    document.querySelector('[data-mode="learn"]').dataset.ok = learnOk ? "1" : "";
    document.querySelector('[data-mode="chill"]').dataset.ok = chillOk ? "1" : "";
    if (siteId === "youtube" && ytVideoId(target)) loadVideo();
  } else {
    mode = "chill";
  }
  renderToday();
  update();
  show("gate");
  startWait();
}

function renderToday() {
  const learn = mode === "learn";
  const limit = learn ? info.site.learnLimitMin : info.site.dailyLimitMin;
  const remaining = learn ? info.learnRemainingMs : info.remainingMs;
  const label = info.learn ? (learn ? " (learn)" : mode === "chill" ? " (chill)" : " (chill)") : "";
  $("left-line").textContent = `${fmtMinutes(remaining)} left of ${limit} min${label}`;
  $("used-bar").style.width = `${Math.min(100, ((limit * MIN - remaining) / (limit * MIN || 1)) * 100)}%`;
}

async function loadVideo() {
  videoLoading = true;
  update();
  const r = await send("gate:videoInfo", { url: target });
  video = r?.video || null;
  videoLoading = false;
  update();
}

function showBlocked() {
  const total = info.site.dailyLimitMin + (info.learn ? info.site.learnLimitMin : 0);
  $("blocked-limit").textContent = `${total} minutes`;
  const tick = () => ($("reset-in").textContent = fmtDuration(msUntilMidnight()));
  tick();
  setInterval(tick, 1000);
  show("blocked");
}

function showBlock(b) {
  const focus = b.kind === "focus";
  $("block").className = `center ${b.kind}`;
  $("block-emoji").textContent = focus ? "🎯" : "🌙";
  $("block-title").textContent = focus ? "Focus mode is on." : "It's curfew, bhai.";
  $("block-text").innerHTML = focus
    ? `${siteId === "_focus" ? "The extensions page" : `<b>${escapeHtml(info.site.name)}</b>`} stays closed until focus ends. No cancel, no override, no cap.`
    : `<b>${escapeHtml(info.site.name)}</b> is closed from ${fmtHM12(b.start)} to ${fmtHM12(b.end)}. Phone down, lights off, go sleep 😴`;
  $("block-sub").textContent = focus ? "Close this tab and get back to it. You got this 💪" : "Tomorrow-you says thanks.";
  document.title = focus ? "Focus mode 🎯" : "Curfew 🌙";
  const tick = () => {
    const left = b.until - Date.now();
    $("block-clock").textContent = left >= 3600 * 1000 ? fmtDuration(left) : fmtClock(left);
    if (left <= 0) {
      clearInterval(timer);
      if (/^https?:/.test(target)) location.replace(target);
      else location.reload(); // reloads into the release path above (extension pages included)
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
  show("block");
}

// The wait is a breathing exercise (see breath.js).
function startWait() {
  const breaths = Math.round(info.waitSeconds / BREATH_S);
  const els = { ball: $("breath-ball"), count: $("breath-count"), label: $("wait-num"), sub: $("wait-text") };
  const finish = () => {
    waitDone = true;
    $("wait").classList.add("done");
    $("wait-num").textContent = "Okay, spill.";
    $("wait-text").textContent =
      info.site.breathMode === "fixed"
        ? "Be honest. Your stats are watching."
        : info.opensToday >= 1 ? "More breaths every time you come back today. Just saying." : "Be honest. Your stats are watching.";
    document.querySelectorAll("#reasons button").forEach((b) => (b.disabled = false));
    document.querySelectorAll(".mode-btn").forEach((b) => (b.disabled = !b.dataset.ok));
    update();
  };
  if (breaths <= 0) {
    $("wait").hidden = true;
    return finish();
  }
  runBreaths(els, breaths, finish, (n, total) => (total > 1 ? `Breath ${n} of ${total}. Why are we here?` : "One slow breath. Why are we here?"));
}

function wire() {
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      document.querySelectorAll(".mode-btn").forEach((x) => x.classList.toggle("selected", x === b));
      reason = null;
      minutes = null;
      document.querySelectorAll("#reasons button").forEach((x) => x.classList.remove("selected"));
      $("other-box").hidden = true;
      renderToday();
      update();
      if (mode === "learn") $("learn-text").focus();
      if (mode === "learn" && isClass && !classBreathDone) startClassBreaths();
    });
  });
  $("learn-text").addEventListener("input", update);
  $("is-class").addEventListener("change", (e) => {
    const learnBudgetOk = info.learnRemainingMs >= 30 * 1000;
    if (!e.target.checked && !learnBudgetOk) {
      e.target.checked = true; // Learn budget is gone, only a class is left
      return;
    }
    isClass = e.target.checked;
    classMin = null;
    if (isClass) startClassBreaths();
    else stopClassBreaths?.();
    update();
  });
  $("learn-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("go").disabled) go();
  });
  $("other-text").addEventListener("input", update);
  $("bored-close").addEventListener("click", closeTab);
  $("bored-continue").addEventListener("click", () => {
    boredAccepted = true;
    update();
  });
  $("close").addEventListener("click", closeTab);
  $("go").addEventListener("click", go);
  // https links in the list become clickable (opened in this tab, away from the site).
  const linkify = (t) => escapeHtml(t).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u.replace(/^https:\/\/(www\.)?/, "")}</a>`);
  $("alternatives").innerHTML = info.alternatives.map((a) => `<li>${linkify(a)}</li>`).join("");
}

function renderReasons() {
  const keys = CHILL_REASONS.filter((k) => (k !== "messages" || info.site.messagesUrl) && (k !== "code" || SITE_REASONS[siteId]?.includes("code")));
  $("reasons").innerHTML = keys
    .map((k) => `<button data-reason="${k}" disabled><span class="emoji">${REASONS[k].emoji}</span>${escapeHtml(REASONS[k].label)}</button>`)
    .join("");
  $("reasons").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      reason = b.dataset.reason;
      boredAccepted = false;
      minutes = null;
      $("reasons").querySelectorAll("button").forEach((x) => x.classList.toggle("selected", x === b));
      $("other-box").hidden = reason !== "other";
      if (reason === "other") $("other-text").focus();
      update();
    });
  });
}

// Learn on YouTube times itself from the video. Elsewhere you pick a timer. A class has its own lengths.
const pickedLearnTimer = () => mode === "learn" && siteId !== "youtube" && !isClass;

function startClassBreaths() {
  classBreathDone = false;
  stopClassBreaths?.();
  stopClassBreaths = runBreaths(
    { ball: $("cb-ball"), count: $("cb-count"), label: $("cb-label"), sub: $("cb-sub") },
    info.classBreaths,
    () => {
      classBreathDone = true;
      $("cb-label").textContent = "Ready for class.";
      $("cb-sub").textContent = "Locked to one video or group. Go learn something 🎓";
      update();
    },
    (n, total) => `Class breath ${n} of ${total}. Two hours is a commitment.`,
  );
}

function renderClassTimers() {
  $("class-timers").innerHTML = info.classOptions
    .map((m) => `<button data-cmin="${m}" class="${m === classMin ? "selected" : ""}">${m % 60 ? `${(m / 60).toFixed(1)}h` : `${m / 60}h`}</button>`)
    .join("");
  $("class-timers").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      classMin = Number(b.dataset.cmin);
      update();
    }),
  );
}

function timerChoices() {
  const learn = mode === "learn";
  const base = learn ? LEARN_TIMER_OPTIONS : info.timerOptions;
  const maxMin = Math.floor((learn ? info.learnRemainingMs : info.remainingMs) / MIN);
  const cap = learn ? maxMin : reason === "bored" ? Math.min(maxMin, info.boredMaxMin) : reason === "code" ? Math.min(maxMin, CODE_MAX_MIN) : maxMin;
  let opts = base.filter((m) => m <= cap);
  if (opts.length === 0) opts = [Math.max(1, cap)];
  if (!learn && (reason === "bored" || reason === "code") && !opts.includes(cap) && cap < Math.max(...base)) opts.push(cap);
  return [...new Set(opts)].sort((a, b) => a - b);
}

const SPOT_NAMES = { group: "group", page: "page", video: "video" };

function learnTimerText() {
  if (isClass) {
    const spot = info.targetSpot;
    return spot
      ? `🎓 Class locked to this ${SPOT_NAMES[spot.kind] || "page"}. Live streams work too. You get a gentle nudge every ${info.classCheckinMin} min.`
      : `🎓 Open your class video or group. The first one you open becomes the lock. You get a gentle nudge every ${info.classCheckinMin} min.`;
  }
  if (siteId !== "youtube") {
    const spot = info.targetSpot;
    if (spot) return `🔒 Locked to this ${SPOT_NAMES[spot.kind] || "page"}. Feed, reels, other groups and pages won't open in this session.`;
    return `🔎 Find your group or page. You'll start at "Your groups" (search works too). The first group, page or video you open becomes the lock. No feed, no reels.`;
  }
  const leftMin = Math.floor(info.learnRemainingMs / MIN);
  if (!ytVideoId(target)) {
    return `🔎 Find your video. You get ${info.learnFindMin} min to pick one, then the timer locks to that video's length + ${info.learnPadMin} min. Other videos won't open in this session.`;
  }
  if (videoLoading) return "🎬 Checking the video length…";
  if (!video?.seconds) {
    return `🎬 Couldn't read the video length yet. It gets set once the player loads (length + ${info.learnPadMin} min). Locked to this one video.`;
  }
  const want = Math.max(1, Math.round(video.seconds / 60 + info.learnPadMin));
  const capped = Math.min(want, leftMin);
  return `🎬 <b>${escapeHtml(video.title || "This video")}</b> · ${fmtClock(video.seconds * 1000)}<br>Timer: <b>${capped} min</b> (video + ${info.learnPadMin} min${capped < want ? ", capped by what's left today" : ""}). Locked to this one video.`;
}

function update() {
  const learn = mode === "learn";
  const chill = mode === "chill";
  $("step-learn").hidden = !(waitDone && learn);
  if (learn) $("video-line").innerHTML = learnTimerText();
  $("class-step").hidden = !(learn && isClass);
  if (learn && isClass) renderClassTimers();
  // Chill reasons: always visible on single-mode sites, only after picking Chill on YouTube.
  $("step-reason").hidden = info.learn ? !(waitDone && chill) : false;

  const bored = chill && reason === "bored";
  $("bored-box").hidden = !bored || boredAccepted;
  const showTimer = waitDone && ((chill && reason && (!bored || boredAccepted)) || pickedLearnTimer());
  $("step-timer").hidden = !showTimer;

  if (showTimer) {
    const opts = timerChoices();
    if (minutes && !opts.includes(minutes)) minutes = null;
    $("timers").innerHTML = opts
      .map((m) => `<button data-min="${m}" class="${m === minutes ? "selected" : ""}">${m} min</button>`)
      .join("");
    $("timers").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        minutes = Number(b.dataset.min);
        update();
      });
    });
    const maxMin = Math.floor((learn ? info.learnRemainingMs : info.remainingMs) / MIN);
    $("timer-note").textContent = bored
      ? `Bored visits are capped at ${info.boredMaxMin} min. No cap.`
      : reason === "code"
        ? `Grab the code and dip. ${CODE_MAX_MIN} min, tops.`
      : maxMin < Math.max(...(learn ? LEARN_TIMER_OPTIONS : info.timerOptions))
        ? `Only ${maxMin} min left in today's budget, use it wisely.`
        : "";
  }

  const goBtn = $("go");
  let ready = false;
  if (!waitDone) goBtn.textContent = "Hold on…";
  else if (!mode) goBtn.textContent = "Learn or chill?";
  else if (learn) {
    const topicOk = $("learn-text").value.trim().length > 0;
    if (isClass) {
      ready = topicOk && !!classMin && classBreathDone;
      goBtn.textContent = !topicOk ? "Type the class name" : !classMin ? "How long is the class?" : !classBreathDone ? "Breathe first…" : `Start the ${classMin / 60}h class →`;
    } else {
      const timerOk = !pickedLearnTimer() || !!minutes;
      ready = topicOk && timerOk && !videoLoading && info.learnRemainingMs >= 30 * 1000;
      goBtn.textContent = !topicOk ? "Type what you're learning" : !timerOk ? "Pick a timer" : pickedLearnTimer() ? `Start learning for ${minutes} min →` : "Start learning →";
    }
  } else {
    const otherOk = reason !== "other" || $("other-text").value.trim().length > 0;
    ready = !!(reason && otherOk && minutes && (!bored || boredAccepted));
    if (!reason) goBtn.textContent = "Pick a mission first";
    else if (!otherOk) goBtn.textContent = "Type out the mission";
    else if (bored && !boredAccepted) goBtn.textContent = "Side quest or go in?";
    else if (!minutes) goBtn.textContent = "Pick a timer";
    else goBtn.textContent = `Let me in for ${minutes} min →`;
  }
  goBtn.disabled = !ready;
}

async function go() {
  $("go").disabled = true;
  $("error").hidden = true;
  const learn = mode === "learn";
  const res = await send("gate:start", {
    siteId,
    mode: learn ? "learn" : "chill",
    reason: learn ? "learn" : reason,
    reasonText: learn ? $("learn-text").value.trim() : reason === "other" ? $("other-text").value.trim() : "",
    minutes: learn && isClass ? classMin : minutes,
    isClass: learn && isClass,
    token: info.token,
    target,
  });
  if (!res?.ok) {
    $("error").textContent = res?.error || "Something went wrong.";
    $("error").hidden = false;
    $("go").disabled = false;
    return;
  }
  location.replace(res.target);
}

$("oops-close").addEventListener("click", closeTab);
$("block-close").addEventListener("click", closeTab);
$("blocked-close").addEventListener("click", closeTab);
init();
