import { BREATH_IN_S, BREATH_OUT_S, BREATH_S } from "../lib.js";

// Breathing exercise: the ball grows while you breathe in (4s) and shrinks while you breathe out (6s).
// els: { ball, count, label, sub } (sub optional). Calls onDone after the last breath. Returns a stop function.
// Tell the offscreen document to play the in/out breath sound.
function sound(phase, seconds) {
  chrome.runtime.sendMessage({ type: "breath:sound", phase, seconds }).catch(() => {});
}

export function runBreaths(els, breaths, onDone, subText = (n, total) => `Breath ${n} of ${total}`) {
  const start = Date.now();
  let lastPhase = null;
  const total = breaths * BREATH_S * 1000;
  const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
  let stopped = false;
  const step = () => {
    if (stopped) return;
    const elapsed = Date.now() - start;
    if (elapsed >= total) {
      sound("stop");
      els.ball.style.transform = "";
      els.count.textContent = "✓";
      return onDone?.();
    }
    const inCycle = (elapsed / 1000) % BREATH_S;
    const n = Math.floor(elapsed / 1000 / BREATH_S) + 1;
    const inhale = inCycle < BREATH_IN_S;
    // One sound per phase change: "in" lasts 4s, "out" lasts 6s.
    const phaseKey = `${Math.floor(elapsed / 1000 / BREATH_S)}:${inhale ? "in" : "out"}`;
    if (phaseKey !== lastPhase) {
      lastPhase = phaseKey;
      sound(inhale ? "in" : "out", inhale ? BREATH_IN_S - inCycle : BREATH_S - inCycle);
    }
    const t = inhale ? inCycle / BREATH_IN_S : (inCycle - BREATH_IN_S) / BREATH_OUT_S;
    els.ball.style.transform = `scale(${(0.45 + 0.55 * (inhale ? ease(t) : 1 - ease(t))).toFixed(3)})`;
    els.count.textContent = String(Math.ceil(inhale ? BREATH_IN_S - inCycle : BREATH_S - inCycle));
    els.label.textContent = inhale ? "Breathe in…" : "Breathe out…";
    if (els.sub) els.sub.textContent = subText(n, breaths);
    requestAnimationFrame(step);
  };
  step();
  window.addEventListener("pagehide", () => sound("stop"), { once: true });
  return () => {
    if (!stopped) sound("stop");
    stopped = true;
  };
}
