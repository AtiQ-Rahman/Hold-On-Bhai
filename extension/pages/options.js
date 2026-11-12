import { send, fmtDuration, fmtDateTime, escapeHtml, FEED_RULE_SITES, BUILTIN_SITE_IDS } from "../lib.js";
import { runBreaths } from "./breath.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
let lock = null;
let lockTimer = null;

async function init() {
  const res = await send("settings:get");
  if (!res?.ok) return;
  fill(res.settings);
  setLock(res.lock);
  $("add-site").addEventListener("click", () => {
    addSite({ id: "", name: "", domains: [], dailyLimitMin: 20, enabled: true, hideFeed: false, messagesUrl: "", breathMode: "fixed", breaths: 3 });
  });
  form.addEventListener("submit", save);
  fillCurfew(res.settings.curfew);
  $("cf-save").addEventListener("click", saveCurfew);
  chrome.action.getUserSettings?.().then((u) => ($("pin-hint").hidden = !!u?.isOnToolbar)).catch(() => {});
  if (location.hash === "#curfew") $("curfew").scrollIntoView();
  $("pending-cancel-all").addEventListener("click", () => cancelPending());
  $("loosen-cancel").addEventListener("click", closeLoosen);
  loadPending();
}

// ------------------------------------------------------------------ looser changes

let retry = null; // (password, strictOnly, breathToken) => Promise<res>
let breathToken = null;
let stopBreaths = null;

// Looser changes: 10 slow breaths first, then the password box shows up.
async function askPassword(loosen, fn) {
  retry = fn;
  $("loosen-list").innerHTML = loosen.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  $("loosen-pw").value = "";
  $("loosen-err").hidden = true;
  $("loosen-strict").hidden = !fn.strictOk;
  $("loosen-pw-row").hidden = true;
  $("loosen-breath").hidden = false;
  $("loosen").hidden = false;
  const r = await send("breath:start");
  breathToken = r?.token;
  stopBreaths?.();
  stopBreaths = runBreaths(
    { ball: $("lb-ball"), count: $("lb-count"), label: $("lb-label"), sub: $("lb-sub") },
    r?.breaths || 10,
    () => {
      $("lb-label").textContent = "Okay. Still want it?";
      $("lb-sub").textContent = "Then type your password.";
      $("loosen-pw-row").hidden = false;
      $("loosen-pw").focus();
    },
    (n, total) => `Breath ${n} of ${total}.`,
  );
}

function closeLoosen() {
  $("loosen").hidden = true;
  stopBreaths?.();
  retry = null;
}

async function runRetry(strictOnly) {
  if (!retry) return;
  const res = await retry(strictOnly ? "" : $("loosen-pw").value, strictOnly, breathToken);
  if (res?.ok) return closeLoosen();
  $("loosen-err").textContent = res?.error || "Couldn't save.";
  $("loosen-err").hidden = false;
}
$("loosen-go").addEventListener("click", () => runRetry(false));
$("loosen-strict").addEventListener("click", () => runRetry(true));
$("loosen-pw").addEventListener("keydown", (e) => e.key === "Enter" && runRetry(false));

async function loadPending() {
  const r = await send("pending:list");
  const list = r?.pending || [];
  $("pending").hidden = !list.length;
  $("pending-list").innerHTML = list
    .map((p) => `<li><span>${escapeHtml(p.label)}<br><span class="muted small">Kicks in ${escapeHtml(fmtDateTime(p.applyAt))} (in ${fmtDuration(p.applyAt - Date.now())})</span></span><button type="button" data-id="${p.id}">Cancel</button></li>`)
    .join("");
  $("pending-list").querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => cancelPending(b.dataset.id)));
}

async function cancelPending(id) {
  await send("pending:cancel", { id });
  loadPending();
}

function status(el, text, ok) {
  el.textContent = text;
  el.className = ok ? "small ok" : "small error";
}

function fillCurfew(c) {
  $("cf-enabled").checked = !!c?.enabled;
  $("cf-start").value = c?.start || "00:00";
  $("cf-end").value = c?.end || "07:00";
}

async function saveCurfew() {
  const curfew = { enabled: $("cf-enabled").checked, start: $("cf-start").value, end: $("cf-end").value };
  const done = (r) => {
    if (!r?.ok) return r;
    fillCurfew(r.curfew);
    status($("cf-status"), r.curfew.enabled ? "Saved ✓ Curfew is on." : "Saved ✓", true);
    loadPending();
    return r;
  };
  const r = await send("curfew:save", { curfew });
  if (r?.needPassword) return askPassword(r.loosen, async (password, _s, breathToken) => done(await send("curfew:save", { curfew: { ...curfew, password, breathToken } })));
  if (!r?.ok) return status($("cf-status"), r?.error || "Couldn't save.", false);
  done(r);
}

// ------------------------------------------------------------------ form

function addSite(s) {
  const node = $("site-tpl").content.firstElementChild.cloneNode(true);
  const set = (k, v) => {
    const el = node.querySelector(`[data-k="${k}"]`);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  };
  set("id", s.id);
  set("name", s.name);
  set("domains", s.domains.join(", "));
  set("dailyLimitMin", s.dailyLimitMin);
  set("learnLimitMin", s.learnLimitMin || 0);
  if (!["youtube", "facebook"].includes(s.id)) node.querySelector(".learn-field").hidden = true;
  else node.querySelector(".chill-label").textContent = "Chill budget (minutes)";
  set("enabled", s.enabled);
  set("hideFeed", s.hideFeed);
  set("messagesUrl", s.messagesUrl);
  set("breathMode", s.breathMode || "fixed");
  set("breaths", s.breaths || 3);

  if (!FEED_RULE_SITES.includes(s.id)) node.querySelector(".feed").hidden = true;
  node.classList.toggle("off", !s.enabled);
  node.querySelector('[data-k="enabled"]').addEventListener("change", (e) => node.classList.toggle("off", !e.target.checked));
  if (BUILTIN_SITE_IDS.includes(s.id)) {
    node.querySelector(".remove").hidden = true; // built-ins can be switched off, not removed
    node.querySelector('[data-k="domains"]').title = "You can add domains. The built-in ones always stay.";
  }
  node.querySelector(".remove").addEventListener("click", () => node.remove());
  $("sites").appendChild(node);
}

function fill(s) {
  $("sites").innerHTML = "";
  s.sites.forEach(addSite);
  form.timerOptions.value = s.timerOptions.join(", ");
  form.boredMaxMin.value = s.boredMaxMin;
  form.grayscaleMode.value = s.grayscaleMode || "always";
  form.grayscaleInLearn.checked = !!s.grayscaleInLearn;
  form.classesPerDay.value = s.classesPerDay ?? 1;
  form.learnCheckinMin.value = s.learnCheckinMin ?? 10;
  form.tickMode.value = s.tickMode || "onSite";
  form.tickVolume.value = s.tickVolume ?? 40;
  form.querySelector(`[name="endMode"][value="${s.endMode}"]`).checked = true;
  form.graceSeconds.value = s.graceSeconds;
  form.extendMinutes.value = s.extendMinutes;
  form.extendBaseWaitSeconds.value = s.extendBaseWaitSeconds;
  form.baseWaitSeconds.value = s.baseWaitSeconds;
  form.maxWaitSeconds.value = s.maxWaitSeconds;
  form.risingWait.checked = s.risingWait;
  form.alternatives.value = s.alternatives.join("\n");
  form.focusAllow.value = (s.focusAllow || []).join(", ");
}

function read() {
  const sites = [...document.querySelectorAll("#sites .site")].map((node) => {
    const v = (k) => node.querySelector(`[data-k="${k}"]`);
    const name = v("name").value.trim();
    return {
      id: v("id").value || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site",
      name: name || "Untitled",
      domains: v("domains").value.split(","),
      dailyLimitMin: v("dailyLimitMin").value,
      learnLimitMin: v("learnLimitMin").value,
      enabled: v("enabled").checked,
      hideFeed: v("hideFeed").checked,
      messagesUrl: v("messagesUrl").value,
      breathMode: v("breathMode").value,
      breaths: v("breaths").value,
    };
  });
  return {
    sites,
    timerOptions: form.timerOptions.value,
    boredMaxMin: form.boredMaxMin.value,
    grayscaleMode: form.grayscaleMode.value,
    grayscaleInLearn: form.grayscaleInLearn.checked,
    classesPerDay: form.classesPerDay.value,
    learnCheckinMin: form.learnCheckinMin.value,
    tickMode: form.tickMode.value,
    tickVolume: form.tickVolume.value,
    endMode: form.querySelector('[name="endMode"]:checked')?.value,
    graceSeconds: form.graceSeconds.value,
    extendMinutes: form.extendMinutes.value,
    extendBaseWaitSeconds: form.extendBaseWaitSeconds.value,
    baseWaitSeconds: form.baseWaitSeconds.value,
    maxWaitSeconds: form.maxWaitSeconds.value,
    risingWait: form.risingWait.checked,
    alternatives: form.alternatives.value,
    focusAllow: form.focusAllow.value,
  };
}

async function save(e) {
  e.preventDefault();
  const settings = read();
  const st = $("save-status");
  const done = (res) => {
    if (!res?.ok) return res;
    fill(res.settings);
    status(st, "Saved ✓", true);
    loadPending();
    setTimeout(() => (st.textContent = ""), 6000);
    return res;
  };
  const res = await send("settings:save", { settings });
  if (res?.needPassword) {
    const fn = async (password, strictOnly, breathToken) => done(await send("settings:save", { settings, password, strictOnly, breathToken }));
    fn.strictOk = true;
    return askPassword(res.loosen, fn);
  }
  if (!res?.ok) return status(st, res?.error || "Couldn't save.", false);
  done(res);
}

// ------------------------------------------------------------------ lock

function setLock(l) {
  lock = l;
  renderLock();
  clearInterval(lockTimer);
  lockTimer = setInterval(async () => {
    const until = lock.until || lock.at;
    if (until && Date.now() >= until) {
      const r = await send("lock:status");
      if (r?.ok) {
        lock = r.lock;
      }
    }
    renderLock(true);
  }, 1000);
}

function renderLock(timeOnly = false) {
  const now = Date.now();
  const editable = lock.state === "setup" || lock.state === "unlocked";
  $("lock").classList.toggle("open", editable);
  $("lock-icon").textContent = editable ? "🔓" : lock.state === "pending" ? "⏳" : "🔒";

  const title = $("lock-title");
  const text = $("lock-text");
  if (lock.state === "setup") {
    title.textContent = "Setup window is open";
    text.textContent = `Change anything you like for the next ${fmtDuration(lock.until - now)}. After that, settings lock.`;
  } else if (lock.state === "unlocked") {
    title.textContent = "Settings are unlocked";
    text.textContent = `They lock again in ${fmtDuration(lock.until - now)}.`;
  } else if (lock.state === "pending") {
    title.textContent = "Unlock requested";
    text.textContent = `Unlocks in ${fmtDuration(lock.at - now)} (${fmtDateTime(lock.at)}). Still want to? Most cravings don't survive a day.`;
  } else {
    title.textContent = "Settings are locked 🔒";
    text.textContent = lock.attemptsBlockedUntil && lock.attemptsBlockedUntil > now
      ? `Too many wrong passwords. Try again in ${fmtDuration(lock.attemptsBlockedUntil - now)}.`
      : `Stricter changes save right away: add a site, lower a budget, longer waits, a longer curfew. Looser ones need 10 slow breaths, then your password.`;
  }
  if (timeOnly && $("lock-actions").dataset.state === lock.state) return;
  $("lock-actions").dataset.state = lock.state;

  const actions = $("lock-actions");
  actions.innerHTML = "";
  if (editable) {
    actions.append(button("Lock now", async () => {
      if (lock.state === "setup" && !confirm("Lock settings now? Make sure you've saved your password first.")) return;
      const r = await send("lock:relock");
      if (r?.ok) refreshLock();
    }));
    actions.append(button("Generate a new password", async () => {
      if (!confirm("Replace your password with a new one? The old one stops working.")) return;
      const r = await send("lock:newPassword");
      if (r?.ok) {
        $("newpw").hidden = false;
        $("newpw-value").textContent = r.password;
      } else showLockError(r?.error);
    }, "ghost"));
  } else if (lock.state === "pending") {
    actions.append(button("Cancel the unlock", async () => {
      const r = await send("lock:relock");
      if (r?.ok) refreshLock();
    }));
  }
}

function button(label, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function showLockError(msg) {
  const el = $("lock-error");
  el.textContent = msg || "Something went wrong.";
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 4000);
}

async function refreshLock() {
  const r = await send("lock:status");
  if (r?.ok) {
    lock = r.lock;
    $("lock-actions").dataset.state = "";
    renderLock();
  }
}

init();
