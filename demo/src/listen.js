// listen.js
// Entry point for the dedicated "listen via microphone" page.
//
// No video, no playback controls — just AFS + SRT loaded from
// URL params, the device's microphone, and a centered subtitle
// stage. This is the cross-device use case: open this URL on a
// phone (typically via QR from the main demo), the phone
// listens to audio playing on some other source (a TV, another
// device, a speaker) and displays the subtitle for what's being
// heard.
//
// URL params:
//   afs    — path to source AFS (required)
//   srt    — path to subtitle SRT (required)
//   title  — display title (optional)
//
// Matcher is tuned for snappy first-match over noisy mic capture:
//   coldStartMinHashes: 8       → first attempt at ~3.5 s of audio
//   matchIntervalMs:    125     → every new chromaprint hash
//   enterThreshold:     75      → tentative below, "in sync" above
//   stayThreshold:      55      → tolerate dips before dropping lock
//   swapMarginConfidence: 6     → parallel cold-start swap margin
//
// The matcher's optimistic-commit contract means we show a
// subtitle as soon as the matcher has ANY guess. If that guess
// turns out wrong, the parallel cold-start running every tick
// will find the better position and we silently swap.

import { parseAFS } from "./afs-parser.js";
import { parseSRT, findActiveCue } from "./srt-parser.js";
import { DemoSession } from "./demo-session.js";
import { MicWaveform } from "./mic-waveform.js";

const params = new URLSearchParams(window.location.search);
const AFS_URL = params.get("afs");
const SRT_URL = params.get("srt");
const TITLE = params.get("title") ?? "AFS Listen";

const els = {
  stage: document.getElementById("listen-stage"),
  sourceTitle: document.getElementById("listen-source-title"),
  status: document.getElementById("listen-status"),
  subtitle: document.getElementById("listen-subtitle"),
  subtitleText: document.getElementById("listen-subtitle-text"),
  startBtn: document.getElementById("listen-start"),
  waveform: document.getElementById("listen-waveform"),
};

els.sourceTitle.textContent = TITLE;

function setState(state) {
  els.stage.dataset.state = state;
}

function setStatus(text) {
  els.status.textContent = text;
}

if (!AFS_URL || !SRT_URL) {
  setState("error");
  setStatus("missing afs= or srt= URL parameter");
  els.subtitleText.textContent = "";
  els.startBtn.hidden = true;
  throw new Error(
    "listen.js: AFS_URL and SRT_URL must both be provided as query parameters",
  );
}

// Load resources up front so the "Start listening" click is just
// the mic-gesture and matcher startup. Failures here surface
// before the user is prompted for permission.
let cues = null;
async function preload() {
  setStatus("loading…");
  const [srtText] = await Promise.all([
    fetch(SRT_URL).then((r) => {
      if (!r.ok) throw new Error(`SRT ${r.status} (${SRT_URL})`);
      return r.text();
    }),
  ]);
  cues = parseSRT(srtText);
  setStatus("tap to listen");
}

preload().catch((e) => {
  setState("error");
  setStatus(`load error: ${e.message}`);
  els.startBtn.hidden = true;
});

// Wall-clock-projected subtitle update. Between matcher ticks we
// extrapolate the source position forward at 1.0 × wall time —
// the listener device has no local playhead to read, so
// performance.now() is the smoothest clock available. The
// projection is wiped any time the matcher reports a fresh
// position (it always resets to the new anchor).
let lastMatchSourceMs = null;
let lastMatchWall = null;
let confirmedMatches = 0; // consecutive non-tentative matches; gate for "in sync"

function currentProjectedSourceMs() {
  if (lastMatchSourceMs == null) return null;
  return lastMatchSourceMs + (performance.now() - lastMatchWall);
}

function startRender() {
  function tick() {
    const t = currentProjectedSourceMs();
    if (t != null && cues) {
      const cue = findActiveCue(cues, t);
      els.subtitleText.textContent = cue ? cue.text : "";
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

els.startBtn.addEventListener("click", async () => {
  els.startBtn.disabled = true;
  setState("starting");
  setStatus("requesting microphone…");

  let session;
  let waveform = null;
  try {
    session = new DemoSession({
      // 16 hashes ≈ 4.5 s of audio for the first cold-start attempt.
      // Tried 8 and it lit up subtitles around 3 s, but the result
      // flickered between candidates for the first second or two as
      // the parallel search kept disagreeing with the initial pick.
      // 16 gives a slightly slower but much steadier first match.
      coldStartMinHashes: 16,
      matchIntervalMs: 125,
      matchWindowSeconds: 8,
      stayThreshold: 55,
      enterThreshold: 75,
      swapMarginConfidence: 6,
    });
    session.onPosition = (timeMs) => {
      lastMatchSourceMs = timeMs;
      lastMatchWall = performance.now();
    };
    session.onStatus = (status) => {
      if (status.kind === "buffering") {
        setStatus(
          status.progressPct < 1
            ? "waiting for audio…"
            : `listening… ${status.progressPct} %`,
        );
        setState("buffering");
      } else if (status.kind === "searching") {
        setStatus("searching…");
        setState("searching");
      } else if (status.kind === "matched" || status.kind === "approximate") {
        if (status.confidence >= 75) {
          confirmedMatches = Math.min(confirmedMatches + 1, 3);
        } else {
          confirmedMatches = 0;
        }
        if (confirmedMatches >= 2) {
          setState("locked");
          setStatus(`in sync · ${Math.round(status.confidence)} %`);
        } else {
          setState("tentative");
          setStatus(`tentative · ${Math.round(status.confidence)} %`);
        }
      } else if (status.kind === "error") {
        setState("error");
        setStatus(`error: ${status.message}`);
      }
    };

    setStatus("loading AFS…");
    await session.loadAFS(AFS_URL);

    setStatus("starting microphone…");
    await session.startMic();

    waveform = new MicWaveform(session.capture, els.waveform);
    waveform.start();

    requestWakeLock();

    setState("searching");
    setStatus("listening…");
    startRender();
  } catch (e) {
    setState("error");
    setStatus(`error: ${e.message}`);
    els.startBtn.disabled = false;
    return;
  }

  els.startBtn.hidden = true;
});

// Wake lock — keep the screen on during a listening session.
// Best-effort: silently no-op on browsers without the API.
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    await navigator.wakeLock.request("screen");
  } catch {
    // permission denied / unsupported / page hidden — fine
  }
}
