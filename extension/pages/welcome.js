import { send, fmtDuration } from "../lib.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const res = await send("welcome:password");
  if (!res?.password) {
    $("no-pw").hidden = false;
    return;
  }
  $("has-pw").hidden = false;
  $("pw").textContent = res.password;

  const tick = () => {
    $("setup-left").textContent = res.lock.state === "setup" ? fmtDuration(res.lock.until - Date.now()) : "few minutes";
  };
  tick();
  setInterval(tick, 1000);

  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(res.password);
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });
  $("saved").addEventListener("change", () => ($("ack").disabled = !$("saved").checked));
  $("ack").addEventListener("click", async () => {
    await send("welcome:ack");
    $("has-pw").hidden = true;
    $("no-pw").hidden = false;
    $("no-pw").querySelector("h2").textContent = "Password hidden. You got this, bhai 💪";
    $("no-pw").querySelector("p").textContent =
      "Finish setting things up in Settings before the setup window closes. After that, stricter changes still save right away, but looser ones need the password and a 24-hour wait.";
  });
}

init();
