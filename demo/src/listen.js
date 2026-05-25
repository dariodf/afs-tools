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
const AFS_URL_PARAM = params.get("afs");
const SRT_URL_PARAM = params.get("srt");
const TITLE_PARAM = params.get("title");

// Resolved at preload time. In URL-param mode these are set up front
// from the query string; in file-picker mode they're filled in from
// the user's <input type="file"> selection.
let afsUrl = AFS_URL_PARAM;
let cues = null;

const els = {
  stage: document.getElementById("listen-stage"),
  sourceTitle: document.getElementById("listen-source-title"),
  status: document.getElementById("listen-status"),
  subtitle: document.getElementById("listen-subtitle"),
  subtitleText: document.getElementById("listen-subtitle-text"),
  startBtn: document.getElementById("listen-start"),
  waveform: document.getElementById("listen-waveform"),
  pick: document.getElementById("listen-pick"),
  pickAfsRow: document.getElementById("listen-pick-afs-row"),
  pickAfs: document.getElementById("listen-pick-afs"),
  pickSrtRow: document.getElementById("listen-pick-srt-row"),
  pickSrt: document.getElementById("listen-pick-srt"),
  pickTitleRow: document.getElementById("listen-pick-title-row"),
  pickTitle: document.getElementById("listen-pick-title"),
  pickStatus: document.getElementById("listen-pick-status"),
};

// Fixed subtitle lead — show the cue ~100 ms earlier than the
// matcher's reported source position. The matcher itself is
// already a chromaprint-hop or two behind real audio (capture
// buffer + tick interval); 100 ms of lead nets out a roughly
// "on time" display without bothering the user with a tuner.
// The demo is meant to feel magical; manual fiddling defeats
// that. Override only via ?lead=N for debugging.
const SUBTITLE_LEAD_MS = Number(params.get("lead") ?? 100) || 100;

els.sourceTitle.textContent = TITLE_PARAM ?? "AFS Listen";

function setState(state) {
  els.stage.dataset.state = state;
}

function setStatus(text) {
  els.status.textContent = text;
}

// Mode dispatch. Each of three inputs (AFS, SRT, title) can come
// from a URL query parameter or from the in-page picker; the modes
// mix freely. Layout follows: pre-resolve whatever was provided in
// the URL, hide those rows of the picker, leave the rest visible.
// If everything's provided, the picker is hidden entirely.
//
// Per-slot state. needsX = true means "the picker row is visible
// and the user must still supply this". The Start button stays
// hidden while any slot still needs supplying.
let needsAfs = !AFS_URL_PARAM;
let needsSrt = !SRT_URL_PARAM;

function maybeHidePicker() {
  if (!needsAfs && !needsSrt) {
    els.pick.hidden = true;
    els.startBtn.hidden = false;
    els.pickStatus.textContent = "";
    setStatus("tap to listen");
  } else {
    els.pick.hidden = false;
    els.startBtn.hidden = true;
    updatePickerStatus();
  }
}

function updatePickerStatus() {
  if (needsAfs && needsSrt) {
    els.pickStatus.textContent = "Add an AFS file and a subtitle file.";
  } else if (needsAfs) {
    els.pickStatus.textContent = "Add an AFS file to continue.";
  } else if (needsSrt) {
    els.pickStatus.textContent = "Add a subtitle file to continue.";
  } else {
    els.pickStatus.textContent = "";
  }
  setStatus(els.pick.hidden ? "tap to listen" : "pick your files");
}

// AFS slot — URL value just gets stored; we don't fetch until Start
// (session.loadAFS does the fetch). Filling slot from a picker file
// means making a blob URL.
async function resolveAfsFromPicker(file) {
  afsUrl = URL.createObjectURL(file);
  needsAfs = false;
  els.pickAfsRow.hidden = true;
  // Default the displayed title to the picked AFS file's stem if
  // ?title= wasn't supplied and the user didn't type one.
  if (!TITLE_PARAM && !els.pickTitle.value.trim()) {
    els.sourceTitle.textContent = file.name.replace(/\.[^.]+$/, "");
  }
  maybeHidePicker();
}

// SRT slot — local file is read straight to text. URL value is
// fetched here so a missing/wrong URL surfaces an error at boot
// rather than after the user taps Start.
async function resolveSrtFromUrl(srtUrlStr) {
  const srtText = await fetch(srtUrlStr).then((r) => {
    if (!r.ok) throw new Error(`SRT ${r.status} (${srtUrlStr})`);
    return r.text();
  });
  cues = parseSRT(srtText);
}

async function resolveSrtFromPicker(file) {
  const srtText = await file.text();
  cues = parseSRT(srtText);
  needsSrt = false;
  els.pickSrtRow.hidden = true;
  maybeHidePicker();
}

// Pre-resolve URL-provided slots; show / hide picker rows
// accordingly. Title slot is purely cosmetic (display title);
// preserve any existing input the user typed when re-evaluating.
async function init() {
  // AFS slot.
  if (AFS_URL_PARAM) {
    afsUrl = AFS_URL_PARAM;
    els.pickAfsRow.hidden = true;
  }
  // Title slot — if URL supplied a title, drop the input row.
  if (TITLE_PARAM) {
    els.pickTitleRow.hidden = true;
  }
  // SRT slot. Done last because it's async (fetch + parse).
  if (SRT_URL_PARAM) {
    els.pickSrtRow.hidden = true;
    try {
      setStatus("loading subtitles…");
      await resolveSrtFromUrl(SRT_URL_PARAM);
    } catch (e) {
      setState("error");
      setStatus(`SRT load failed: ${e.message}`);
      els.startBtn.hidden = true;
      return;
    }
  }
  maybeHidePicker();
}

els.pickAfs.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (f) await resolveAfsFromPicker(f);
});
els.pickSrt.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    await resolveSrtFromPicker(f);
  } catch (err) {
    els.pickStatus.textContent = `Couldn't read subtitle file: ${err.message}`;
  }
});
els.pickTitle.addEventListener("input", () => {
  const v = els.pickTitle.value.trim();
  if (v) els.sourceTitle.textContent = v;
});

init();

// Wall-clock-projected subtitle update. Between matcher ticks we
// extrapolate the source position forward at 1.0 × wall time —
// the listener device has no local playhead to read, so
// performance.now() is the smoothest clock available. The
// projection is wiped any time the matcher reports a fresh
// position (it always resets to the new anchor).
let lastMatchSourceMs = null;
let lastMatchWall = null;
let confirmedMatches = 0; // consecutive non-tentative matches; gate for "in sync"

// Forward-projection cap. Between confident matcher reports we
// extrapolate the source position at 1× wall-clock. The cap exists
// to stop projecting "into the future" if the matcher's gone silent
// for a long time — but pause-detection is now handled by the
// silence-ticks gate below (lastPeak < SILENCE_PEAK_THRESHOLD →
// goLost() after SILENCE_TICKS_BEFORE_LOST ticks ≈ 2 s).
//
// With a separate pause detector, the cap's only job is bounding
// how long we keep showing cues if the source is still playing but
// chromaprint can't lock on for stretches (noisy mic capture, soft
// dialogue, music underlay). 1000 ms is half the silence-gate
// threshold — projection freezes well before the page actually
// drops to LOST, so paused content stops scrolling subtitles
// quickly. Trade-off: shorter caps make missed cues more common in
// real-room mic capture, but the responsiveness gain on pause is
// the priority here.
const PROJECT_MAX_MS = 1000;
function currentProjectedSourceMs() {
  if (lastMatchSourceMs == null) return null;
  const elapsed = Math.min(
    performance.now() - lastMatchWall,
    PROJECT_MAX_MS,
  );
  return lastMatchSourceMs + elapsed + SUBTITLE_LEAD_MS;
}

function startRender() {
  function tick() {
    const t = currentProjectedSourceMs();
    if (t != null && cues) {
      const cue = findActiveCue(cues, t);
      els.subtitleText.textContent = cue ? cue.text : "";
    } else {
      // LOST (or never anchored) — show nothing rather than the
      // last cue from before we lost sync.
      els.subtitleText.textContent = "";
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
    // Position tracker with a small state machine. Three states:
    //
    //   LOST — no trusted anchor. Any confident match is accepted
    //     and promotes us straight to TRACKING. This is the entry
    //     state and the recovery state when we go long enough
    //     without a forward-consistent match.
    //
    //   TRACKING — we have a trusted anchor and project it forward
    //     by elapsed wall time. New reports within
    //     CONTINUITY_TOLERANCE_MS of the projection are accepted
    //     (steady-state). Reports outside that window are treated
    //     as a JUMP — they require a corroborating second report
    //     before we move the anchor (this is what keeps random
    //     noise from yanking the subtitles to a wrong cue).
    //
    //   The matcher itself can find the right position even after
    //   the user seeks (it falls through to cold-start when local
    //   search fails), so consistency-based jump confirmation
    //   handles both intentional seek-back and seek-forward.
    //
    // If we haven't promoted ANY report in LOST_TIMEOUT_MS we
    // fall back to LOST so a single re-acquisition can grab us
    // again.
    const POSITION_CONFIDENCE_MIN = 65;
    const CONTINUITY_TOLERANCE_MS = 1500;
    const LOST_TIMEOUT_MS = 6000;
    // Silence gate. The matcher will happily commit a position
    // against ambient room noise — speech, fan, anything — because
    // chromaprint hashes are well-defined even on low-energy
    // signals. We refuse to update the subtitle if the captured
    // audio's peak amplitude is below this threshold for the
    // current tick. 0.02 ≈ -34 dBFS — anything quieter than a
    // half-loud spoken word in a normal room.
    const SILENCE_PEAK_THRESHOLD = 0.02;
    // After this many consecutive quiet ticks, drop back to LOST
    // entirely so the next REAL audio re-acquires from scratch.
    const SILENCE_TICKS_BEFORE_LOST = 16; // ≈ 2 s at 125 ms tick
    let trustedPos = null;      // last accepted source position
    let trustedWall = 0;        // wall time of trustedPos
    let pendingJumpPos = null;  // candidate position waiting for confirmation
    let pendingJumpWall = 0;
    let lastAcceptWall = 0;     // wall time of the most recent accepted report
    let lastPeak = 0;           // updated from onDiagnostic
    let silenceTicks = 0;

    function goLost() {
      trustedPos = null;
      pendingJumpPos = null;
      lastMatchSourceMs = null;
      lastMatchWall = null;
    }

    session.onDiagnostic = (d) => {
      if (d.peakAmplitude != null) {
        lastPeak = d.peakAmplitude;
        if (lastPeak < SILENCE_PEAK_THRESHOLD) {
          silenceTicks += 1;
          if (silenceTicks >= SILENCE_TICKS_BEFORE_LOST) goLost();
        } else {
          silenceTicks = 0;
        }
      }
      // Time-based LOST trigger. The matcher might keep reporting
      // low-confidence garbage we always filter out (so onPosition's
      // own timeout check never runs), OR stop reporting entirely.
      // The diagnostic callback fires every tick regardless, so we
      // do the staleness check here.
      if (
        trustedPos != null &&
        lastAcceptWall > 0 &&
        performance.now() - lastAcceptWall > LOST_TIMEOUT_MS
      ) {
        goLost();
      }
    };

    session.onPosition = (timeMs, confidence) => {
      if (confidence != null && confidence < POSITION_CONFIDENCE_MIN) return;
      // Don't accept matches while the room is quiet. Even with
      // high reported confidence, the matcher latches onto random
      // positions when fed near-silence; gating here keeps the
      // subtitle from showing wrong cues over the user's living
      // room background.
      if (lastPeak < SILENCE_PEAK_THRESHOLD) return;
      const wallNow = performance.now();

      // Fall back to LOST if too long since the last accepted report.
      if (
        trustedPos != null &&
        lastAcceptWall > 0 &&
        wallNow - lastAcceptWall > LOST_TIMEOUT_MS
      ) {
        trustedPos = null;
        pendingJumpPos = null;
      }

      if (trustedPos === null) {
        // LOST: any confident match anchors us.
        trustedPos = timeMs;
        trustedWall = wallNow;
        pendingJumpPos = null;
        lastAcceptWall = wallNow;
        lastMatchSourceMs = timeMs;
        lastMatchWall = wallNow;
        return;
      }

      // TRACKING: compare against forward-projected anchor.
      const projected = trustedPos + (wallNow - trustedWall);
      const driftMs = Math.abs(timeMs - projected);

      if (driftMs <= CONTINUITY_TOLERANCE_MS) {
        // Continuing forward — refresh the anchor.
        trustedPos = timeMs;
        trustedWall = wallNow;
        pendingJumpPos = null;
        lastAcceptWall = wallNow;
        lastMatchSourceMs = timeMs;
        lastMatchWall = wallNow;
        return;
      }

      // JUMP: needs corroboration. If a pending jump is forward-
      // consistent with THIS report, accept (it's a real seek or
      // re-acquisition). Otherwise keep the latest one as the
      // new pending and wait one more tick.
      if (pendingJumpPos != null) {
        const pendingProjected =
          pendingJumpPos + (wallNow - pendingJumpWall);
        if (Math.abs(timeMs - pendingProjected) <= CONTINUITY_TOLERANCE_MS) {
          trustedPos = timeMs;
          trustedWall = wallNow;
          pendingJumpPos = null;
          lastAcceptWall = wallNow;
          lastMatchSourceMs = timeMs;
          lastMatchWall = wallNow;
          return;
        }
      }
      pendingJumpPos = timeMs;
      pendingJumpWall = wallNow;
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
    await session.loadAFS(afsUrl);
    var sourceDurationMs =
      session.afs?.parsed?.metadata?.source?.duration_ms ?? null;

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
