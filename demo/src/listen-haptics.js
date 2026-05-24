// listen-haptics.js
// Entry point for the dedicated "haptics via microphone" page —
// sibling of listen.js but tailored for the haptics demo:
//
//   - No subtitle text, no SRT.
//   - Stage is black; the cannon video stays hidden until a hit fires.
//   - On each detected cannon hit:
//       * Show the (silent) cannon visual briefly
//       * Vibrate the device (best-effort, real haptics on Android)
//       * Shake the whole window — pseudo-haptic for desktops
//   - Optional waveform on the foot, same as listen.html.
//
// Deliberately no audio: an earlier iteration played a synthesized
// or recorded cannon SFX on each fire, but the moment this page
// runs alongside the main demo on the same speakers, the local
// cannon bleeds into the mic and confuses the matcher. The music
// the user is hearing already contains real cannons; we don't
// need to add more.
//
// URL params:
//   afs    — source AFS (default content/overture-finale.afs)
//   events — JSON file of timed events (default content/overture-finale-cannons.json)
//   title  — display title (optional)

import { DemoSession } from "./demo-session.js";
import { HapticsEventManager } from "./haptics-events.js";
import { MicWaveform } from "./mic-waveform.js";

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
};

// Track whether vibration was successfully invoked the first time
// we tried it (inside the user-gesture handler). If false, the
// browser blocked it — system settings, permission, or unsupported.
let vibrationOk = false;

els.sourceTitle.textContent = TITLE;
els.cannonVideo.src = "content/cannon-shot.mp4";

function setState(s) {
  els.stage.dataset.state = s;
}
function setStatus(t) {
  els.status.textContent = t;
}

// fireCannon: invoked by HapticsEventManager on each scheduled
// hit. Silent video, real haptic vibration on touch devices,
// pseudo-haptic window-shake everywhere else.
function fireCannon() {
  // navigator.vibrate returns true if the OS accepted the call,
  // false if it was blocked (no system vibration permission,
  // silent mode without vibrate, or user-gesture requirement
  // not satisfied). We don't surface per-fire failures because
  // the visible flash + window shake still carry the moment;
  // the initial gesture-time probe in startListening() is what
  // tells the user about persistent blockage.
  if (navigator.vibrate) navigator.vibrate(200);

  document.body.classList.add("haptic-shake");
  setTimeout(() => document.body.classList.remove("haptic-shake"), 220);

  els.cannonVideo.classList.add("showing");
  try {
    // Skip past the 480 ms of pre-firing buildup so the visible
    // flash lands on the haptic moment, not 480 ms after it.
    els.cannonVideo.currentTime = 0.48;
    const p = els.cannonVideo.play();
    if (p) p.catch(() => {});
  } catch {}
  const onEnded = () => {
    els.cannonVideo.classList.remove("showing");
    els.cannonVideo.removeEventListener("ended", onEnded);
  };
  els.cannonVideo.addEventListener("ended", onEnded);
  setTimeout(() => els.cannonVideo.classList.remove("showing"), 2000);
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

  // Probe vibration NOW, inside the user-gesture handler — this
  // is the most generous window for the browser to accept it.
  // If even this short probe fails, the device or browser is
  // blocking vibration (system settings, silent mode, or
  // unsupported). We tell the user so they don't think the demo
  // is broken when haptics don't fire.
  if (navigator.vibrate) {
    vibrationOk = navigator.vibrate(40) === true;
  }

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
      // Haptics false-positives are far more disruptive than
      // subtitle false-positives (a phantom cannon BOOM is jarring;
      // a phantom subtitle is just briefly wrong). Tighten the
      // matcher's commit threshold and require higher per-hit
      // confidence before firing anything.
      stayThreshold: 65,
      enterThreshold: 80,
      swapMarginConfidence: 8,
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
    const sourceDurationMs =
      session.afs?.parsed?.metadata?.source?.duration_ms ?? null;

    setStatus("starting microphone…");
    await session.startMic();

    // Mic mode latency between the actual cannon sound and the
    // matcher's report = acoustic propagation + capture buffer +
    // chromaprint hop + match interval. Empirically ~320 ms on a
    // Pixel 10 Pro; varies per device. The schedule-ahead haptics
    // manager fires this many ms BEFORE the projected event time
    // so the visual + vibration land on the heard cannon, not
    // after it. Tune at the URL: ?offset=350 etc.
    const offsetOverride = new URLSearchParams(window.location.search)
      .get("offset");
    const predictionOffsetMs =
      offsetOverride != null ? Number(offsetOverride) : 320;
    const haptics = new HapticsEventManager(
      events,
      () => fireCannon(),
      { predictionOffsetMs },
    );

    // Consumer-side guard against haptic false-positives. The
    // matcher will commit positions at confidence >= stayThreshold
    // (65) for status display, but we only let haptics fire when:
    //   1. The reported confidence is high (>= 80, i.e. above
    //      enterThreshold — "in sync" not "tentative"), AND
    //   2. The position is consistent with the previous tick's
    //      position under real-time playback (within ~500 ms drift).
    //
    // Both conditions together rule out the failure mode you saw
    // with random speech: a one-tick high-confidence false positive
    // won't trigger because there's no consistent neighbor; sustained
    // wrong matches at consistent positions are vanishingly rare
    // against an unrelated source AFS.
    // Per-tick haptic gate (false-positive defense — see comment
    // above near stayThreshold/enterThreshold). The HapticsEventManager
    // itself handles auto-replay via backward-position-jump detection.
    let lastFireablePos = null;
    let lastFireableWall = 0;
    const FIRE_CONFIDENCE_MIN = 80;
    const FIRE_DRIFT_TOLERANCE_MS = 500;
    session.onPosition = (timeMs, confidence) => {
      if (confidence < FIRE_CONFIDENCE_MIN) {
        lastFireablePos = null;
        return;
      }
      const wallNow = performance.now();
      if (lastFireablePos != null) {
        const expectedPos = lastFireablePos + (wallNow - lastFireableWall);
        if (Math.abs(timeMs - expectedPos) < FIRE_DRIFT_TOLERANCE_MS) {
          haptics.step(timeMs, wallNow);
        }
      }
      lastFireablePos = timeMs;
      lastFireableWall = wallNow;
    };

    new MicWaveform(session.capture, els.waveform).start();
    requestWakeLock();

    setStatus(
      vibrationOk
        ? "listening…"
        : "listening… (vibration blocked by this device)",
    );
  } catch (e) {
    setState("error");
    setStatus(`error: ${e.message}`);
    els.startBtn.disabled = false;
    els.startBtn.hidden = false;
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
