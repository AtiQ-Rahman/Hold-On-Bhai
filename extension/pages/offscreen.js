// Audio for Hold On Bhai: the ticking clock during a session and the
// "peep peep" when time runs out. Lives in an offscreen document because MV3
// service workers can't play audio.

let ctx;
let noise;
let tickTimer = null;
let tickEndsAt = 0;
let tickVolume = 0.4;
let tock = false;

function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  if (!noise) {
    // A short burst of white noise, filtered, sounds like a mechanical clock.
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

function tone(at, freq, dur, vol = 0.35) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(vol, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function click(vol, high) {
  const c = audio();
  const at = c.currentTime + 0.01;
  const src = c.createBufferSource();
  src.buffer = noise;
  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = high ? 3400 : 2600;
  band.Q.value = 6;
  const gain = c.createGain();
  gain.gain.setValueAtTime(Math.max(0.0001, vol), at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
  src.connect(band).connect(gain).connect(c.destination);
  src.start(at);
  src.stop(at + 0.05);
}

function scheduleTick() {
  const left = tickEndsAt - Date.now();
  if (left <= 0) {
    stopTicking();
    return;
  }
  const lastMinute = left <= 60 * 1000;
  // Louder in the last minute, and double speed in the last 10 seconds.
  const vol = tickVolume * (lastMinute ? 1.6 : 1) * 1.5;
  click(vol, tock);
  tock = !tock;
  tickTimer = setTimeout(scheduleTick, left <= 10 * 1000 ? 500 : 1000);
}

function startTicking(endsAt, volume) {
  tickEndsAt = endsAt;
  tickVolume = Math.max(0, Math.min(100, volume ?? 40)) / 100;
  if (tickTimer) return; // already ticking; endsAt/volume updated in place
  scheduleTick();
}

function stopTicking() {
  clearTimeout(tickTimer);
  tickTimer = null;
}

async function peepPeep() {
  stopTicking();
  const c = audio();
  const t = c.currentTime + 0.05;
  for (const offset of [0, 0.9]) {
    tone(t + offset, 1320, 0.14);
    tone(t + offset + 0.22, 1320, 0.14);
  }
}

// Breathing: soft "air" noise. Inhale swells and brightens over 4s, exhale fades and darkens over 6s.
let airBuf = null;
let breathNodes = null;

function stopBreath() {
  if (!breathNodes) return;
  const { src, gain } = breathNodes;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setTargetAtTime(0.0001, t, 0.08);
  src.stop(t + 0.4);
  breathNodes = null;
}

function breath(phase, seconds, volume) {
  const c = audio();
  stopBreath();
  if (phase !== "in" && phase !== "out") return;
  if (!airBuf) {
    // Brown-ish noise sounds more like breath than white noise.
    airBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = airBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.06 * (Math.random() * 2 - 1)) / 1.06;
      d[i] = last * 4 + (Math.random() * 2 - 1) * 0.25;
    }
  }
  const vol = Math.max(0, Math.min(100, volume ?? 40)) / 100 * 0.5;
  const at = c.currentTime + 0.02;
  const end = at + seconds;
  const src = c.createBufferSource();
  src.buffer = airBuf;
  src.loop = true;
  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.8;
  const low = c.createBiquadFilter();
  low.type = "lowpass";
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  if (phase === "in") {
    band.frequency.setValueAtTime(450, at);
    band.frequency.exponentialRampToValueAtTime(1500, end);
    low.frequency.setValueAtTime(1800, at);
    low.frequency.exponentialRampToValueAtTime(4000, end);
    gain.gain.exponentialRampToValueAtTime(vol, at + seconds * 0.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
  } else {
    band.frequency.setValueAtTime(1200, at);
    band.frequency.exponentialRampToValueAtTime(300, end);
    low.frequency.setValueAtTime(3000, at);
    low.frequency.exponentialRampToValueAtTime(900, end);
    gain.gain.exponentialRampToValueAtTime(vol * 0.85, at + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
  }
  src.connect(band).connect(low).connect(gain).connect(c.destination);
  src.start(at);
  src.stop(end + 0.1);
  breathNodes = { src, gain };
  src.onended = () => {
    if (breathNodes?.src === src) breathNodes = null;
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "offscreen:breath") breath(msg.phase, msg.seconds, msg.volume);
  else if (msg?.type === "offscreen:beep") peepPeep();
  else if (msg?.type === "offscreen:tick") {
    if (msg.on && msg.volume > 0) startTicking(msg.endsAt, msg.volume);
    else stopTicking();
  }
});
