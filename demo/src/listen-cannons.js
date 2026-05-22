// listen-cannons.js
// Entry point for the dedicated "listen to cannons via microphone"
// page. Sibling of listen.js but tailored for the haptics demo:
//
//   - No subtitle text, no SRT.
//   - Stage is black; the cannon video stays hidden until a hit fires.
//   - On each detected cannon hit:
//       * Show the cannon video (plays its visual once, then hides)
//       * Play a synthesized cannon-boom SFX (cannon-shot.mp4 has no
//         audio of its own; see cannon-boom.js)
//       * Flash the screen
//       * Vibrate the device (best-effort)
//   - Optional waveform on the foot, same as listen.html.
//
// URL params:
//   afs    — source AFS (default content/overture-finale.afs)
//   events — JSON file of timed events (default content/overture-finale-cannons.json)
//   title  — display title (optional)
//
// Matcher tuning matches listen.js: coldStartMinHashes 16, tick
// every chromaprint hop. The HapticsEventManager handles the
// schedule-ahead timing for actual cannon firing.

import { DemoSession } from "./demo-session.js";
import { HapticsEventManager } from "./haptics-events.js";
import { MicWaveform } from "./mic-waveform.js";
import { playCannonBoom } from "./cannon-boom.js";

const params = new URLSearchParams(window.location.search);
const AFS_URL = params.get("afs") ?? "content/overture-finale.afs";
const EVENTS_URL =
  params.get("events") ?? "content/overture-finale-cannons.json";
const TITLE = params.get("title") ?? "1812 Overture · finale";

const els = {
  stage: document.getElementById("listen-stage"),
  sourceTitle: document.getElementById("listen-source-title"),
  status: document.getElementById("listen-status"),
  startBtn: document.getElementById("listen-start"),
  waveform: document.getElementById("listen-waveform"),
  cannonVideo: document.getElementById("cannon-video"),
  flashEl: document.getElementById("cannon-flash"),
};

els.sourceTitle.textContent = TITLE;
els.cannonVideo.src = "content/cannon-shot.mp4";

function setState(s) {
  els.stage.dataset.state = s;
}
function setStatus(t) {
  els.status.textContent = t;
}

// fireCannon: invoked by HapticsEventManager on each scheduled hit.
// Mirrors the inline fireCannon() in app.js but adds the synthesized
// boom (the mic-mode user isn't necessarily near the audio source's
// speakers — the local SFX is what sells the impact).
function fireCannon(audioContext) {
  if (navigator.vibrate) navigator.vibrate(200);

  els.flashEl.classList.add("firing");
  setTimeout(() => els.flashEl.classList.remove("firing"), 220);

  els.cannonVideo.classList.add("showing");
  try {
    els.cannonVideo.currentTime = 0;
    const p = els.cannonVideo.play();
    if (p) p.catch(() => {});
  } catch {
    // Browser denied — the flash + boom carry the moment.
  }
  const onEnded = () => {
    els.cannonVideo.classList.remove("showing");
    els.cannonVideo.removeEventListener("ended", onEnded);
  };
  els.cannonVideo.addEventListener("ended", onEnded);
  // Safety hide in case "ended" doesn't fire (some browsers).
  setTimeout(() => els.cannonVideo.classList.remove("showing"), 1800);

  try {
    playCannonBoom(audioContext);
  } catch {
    // Audio context could be in a weird state; the visual still fires.
  }
}

async function preload() {
  setStatus("loading…");
  const events = await fetch(EVENTS_URL).then((r) => {
    if (!r.ok) throw new Error(`events ${r.status}`);
    return r.json();
  });
  return events.events || events;
}

let eventsPromise = preload().catch((e) => {
  setState("error");
  setStatus(`load error: ${e.message}`);
  els.startBtn.hidden = true;
  throw e;
});

els.startBtn.addEventListener("click", async () => {
  els.startBtn.disabled = true;
  setState("starting");
  setStatus("requesting microphone…");

  let events;
  try {
    events = await eventsPromise;
  } catch {
    return;
  }

  let session;
  try {
    session = new DemoSession({
      coldStartMinHashes: 16,
      matchIntervalMs: 125,
      matchWindowSeconds: 8,
      stayThreshold: 55,
      enterThreshold: 75,
      swapMarginConfidence: 6,
    });
    session.onStatus = (s) => {
      if (s.kind === "buffering") {
        setStatus(
          s.progressPct < 1
            ? "waiting for audio…"
            : `listening… ${s.progressPct} %`,
        );
        setState("buffering");
      } else if (s.kind === "searching") {
        setStatus("searching for the finale…");
        setState("searching");
      } else if (s.kind === "matched" || s.kind === "approximate") {
        setStatus(`in sync · ${Math.round(s.confidence)} %`);
        setState("locked");
      } else if (s.kind === "error") {
        setState("error");
        setStatus(`error: ${s.message}`);
      }
    };

    setStatus("loading AFS…");
    await session.loadAFS(AFS_URL);

    setStatus("starting microphone…");
    await session.startMic();

    // Mic mode has ~220 ms of extra latency between actual cannon
    // sound and the matcher's report, due to the acoustic path +
    // capture buffer + chromaprint hop. The schedule-ahead haptics
    // manager fires this many ms BEFORE the projected event time
    // so the local SFX lines up with what the user is hearing.
    const haptics = new HapticsEventManager(
      events,
      () => fireCannon(session.capture.audioContext),
      { predictionOffsetMs: 220 },
    );
    session.onPosition = (timeMs) => {
      haptics.step(timeMs, performance.now());
    };

    new MicWaveform(session.capture, els.waveform).start();

    requestWakeLock();

    setStatus("listening…");
  } catch (e) {
    setState("error");
    setStatus(`error: ${e.message}`);
    els.startBtn.disabled = false;
    return;
  }

  els.startBtn.hidden = true;
});

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    await navigator.wakeLock.request("screen");
  } catch {
    /* unsupported or denied — fine */
  }
}
