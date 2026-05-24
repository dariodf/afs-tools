// app.js
// Main entry point for the AFS demo.
//
// Wires up the UI to the AFS modules. Each demo lives as a separate
// async function that's selected based on the dropdown value.

import { parseAFS } from "./src/afs-parser.js";
import { parseSRT } from "./src/srt-parser.js";
import { DemoSession } from "./src/demo-session.js";
import { SubtitleRenderer } from "./src/subtitle-renderer.js";
import { HapticsEventManager } from "./src/haptics-events.js";
import { writeAFS } from "./src/afs-writer.js";
import { mockFingerprint, estimateMatchLatencyMs } from "./src/chromaprint.js";
import { computeTimeMapping } from "./src/afs-mapping.js";
import { qrCode } from "./src/vendor/qr-code.js";
import { DebugPanel } from "./src/debug-panel.js";

// Debug panel (activated via ?debug=1 URL parameter)
const debugPanel = new DebugPanel();

// -----------------------------------------------------------------------
// Global app state
// -----------------------------------------------------------------------

const state = {
  demoId: null,
  mode: "direct", // "direct" | "mic"
  session: null,
  rafHandle: null,
  els: {},
};

// -----------------------------------------------------------------------
// Wake lock — keep phone screen awake during mic-mode demos
// -----------------------------------------------------------------------

let wakeLock = null;

async function requestWakeLock() {
  // Wake Lock API isn't supported on every browser (notably some
  // older iOS versions). Silent failure is fine; the demo still
  // works, just with the standard sleep timer.
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // Some browsers reject the request (e.g., low battery, OS-level
    // power saver). Not fatal.
    console.warn("wake lock request failed:", err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// Re-acquire wake lock if the page becomes visible again (browsers
// auto-release wake locks when the page loses visibility).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.mode === "mic" && state.session) {
    requestWakeLock();
  }
});

// -----------------------------------------------------------------------
// Status helpers
// -----------------------------------------------------------------------

function setStatus(text, cls = "") {
  const el = state.els.statusText;
  el.textContent = text;
  el.className = "status-value " + cls;
}

function bindSessionStatus(session) {
  session.onStatus = (status) => {
    switch (status.kind) {
      case "buffering":
        if (status.progressPct < 1) {
          // No audio reaching the matcher yet — either the user
          // hasn't pressed play or the mic isn't capturing.
          setStatus(
            state.mode === "mic" ? "waiting for audio (mic)" : "press play to begin",
            "",
          );
        } else {
          // The AFS file is already loaded (we ship them with the
          // built-in demos). What's happening is the matcher is
          // listening to enough audio to recognize the position.
          // "Searching" describes that better than "syncing".
          setStatus("searching for position…", "warn");
        }
        break;
      case "searching":
        setStatus("searching for position...", "warn");
        break;
      case "ambiguous":
        setStatus(
          `multiple possible positions (${status.candidates.length}) — listening for more audio`,
          "warn",
        );
        break;
      case "matched":
        setStatus(
          `in sync · ${formatTimeMs(status.timeMs)} · ${Math.round(status.confidence)}%`,
          "ok",
        );
        break;
      case "approximate":
        // Buffer spans a cut — the matcher's position is roughly
        // right but its tail/head doesn't fully line up. We still
        // pass the position through (the subtitle stays close to
        // accurate) but flag it so the user knows we're crossing
        // an edit boundary.
        setStatus(
          `crossing cut · ${formatTimeMs(status.timeMs)} · ${Math.round(status.confidence)}%`,
          "warn",
        );
        break;
      case "error":
        setStatus(`error: ${status.message}`, "error");
        break;
    }
  };
  // Route diagnostic data to the debug panel (no-op if ?debug=1 isn't set).
  session.onDiagnostic = (data) => debugPanel.update(data);
}

function formatTimeMs(ms) {
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const millis = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// -----------------------------------------------------------------------
// QR code rendering
// -----------------------------------------------------------------------

// Per-demo target URL for the "open on companion device" QR
// code and link. The subtitles demo points to the dedicated
// listen.html page (no video on the companion device; it just
// listens via mic and shows subtitles). The cannons demo keeps
// using the main app's ?mode=mic flow because the cannons
// experience IS the audio + haptics page — there's nothing on
// it that wouldn't make sense in mic mode.
function companionUrlFor(demoId) {
  const url = new URL(window.location.href);
  if (demoId === "desync-video") {
    // Subtitles demo: companion goes to listen.html (no video,
    // just mic + subtitles).
    url.pathname = url.pathname.replace(/[^/]*$/, "listen.html");
    url.search = "";
    url.searchParams.set("afs", "content/dialogue-clip.afs");
    url.searchParams.set("srt", "content/dialogue-clip.en.srt");
    url.searchParams.set("title", "Dialogue clip");
  } else if (demoId === "haptics") {
    // Haptics demo: companion goes to listen-haptics.html (black
    // stage, cannon visual + vibration on detected hits).
    url.pathname = url.pathname.replace(/[^/]*$/, "listen-haptics.html");
    url.search = "";
    url.searchParams.set("afs", "content/overture-finale.afs");
    url.searchParams.set("events", "content/overture-finale-cannons.json");
    url.searchParams.set("title", "1812 Overture · finale");
  } else {
    // Custom files: stays on the main app for now.
    url.searchParams.set("demo", demoId);
    url.searchParams.set("mode", "mic");
  }
  return url.toString();
}

function renderQRCodeForCurrentDemo() {
  const href = companionUrlFor(state.demoId);
  state.els.qrCode.innerHTML = qrCode(href, { size: 220 });
  if (state.els.qrLink) {
    state.els.qrLink.href = href;
  }
}

// -----------------------------------------------------------------------
// Mode-aware audio source acquisition
// -----------------------------------------------------------------------

async function startSessionFor(session, mediaElementOrNull) {
  if (state.mode === "mic") {
    await session.startMic();
    // Keep the screen awake. Especially important on phones where
    // the demo might run for the length of an entire piece of audio.
    requestWakeLock();
  } else {
    if (!mediaElementOrNull) {
      throw new Error("direct mode requires a media element");
    }
    await session.startDirect(mediaElementOrNull);
  }
}

// -----------------------------------------------------------------------
// Subtitles demo: original + edited video side-by-side, shared SRT
// -----------------------------------------------------------------------

async function startDesyncVideoDemo() {
  // ------------------------------------------------------------
  // Static UI. The mode toggle below the videos lets the user
  // pick between the three ways AFS can locate the current source
  // position:
  //
  //   - "Pre-calc" (Mode 1, default): both AFS files were
  //     pre-computed; we build a derived→source time mapping
  //     once and drive subtitles via mediaElement.currentTime.
  //     No audio capture, no microphone, no matcher running
  //     per tick. This is what a real local player would do.
  //
  //   - "Listen here" (Mode 2): live fingerprinting from the
  //     <video> element's own audio. The matcher runs every
  //     tick. Demonstrates that AFS works without any pre-
  //     computed mapping — useful when you don't have the
  //     derived clip's AFS, only the source's.
  //
  //   - "Microphone" (Mode 3): live fingerprinting from
  //     getUserMedia. The killer use case — a second device
  //     can listen via mic and stay in sync without any data
  //     connection between devices.
  // ------------------------------------------------------------
  state.els.playerArea.innerHTML = `
    <div class="afs-mode-row" role="tablist" aria-label="AFS source">
      <span class="afs-mode-label">AFS source:</span>
      <button class="afs-mode-btn" role="tab" data-afs-mode="precalc">Pre-calculated</button>
      <button class="afs-mode-btn" role="tab" data-afs-mode="listen">Listen · audio output</button>
      <span class="afs-mode-detail" id="afs-mode-detail"></span>
    </div>
    <div class="video-pair">
      <div class="video-column">
        <div class="video-label">Original</div>
        <video id="video-orig" controls preload="metadata" playsinline></video>
        <div class="subtitle-track-label">Subtitles · in sync (reference)</div>
        <div class="subtitle-track" id="sub-orig"></div>
      </div>
      <div class="video-column">
        <div class="video-label">Edited · 3 cuts in first 20 s</div>
        <video id="video-edit" controls preload="metadata" playsinline></video>
        <div class="subtitle-track-label">
          <label><input type="checkbox" id="afs-edit"> Use AFS to correct timing</label>
        </div>
        <div class="subtitle-track" id="sub-edit"></div>
      </div>
    </div>
    <div class="demo-explanation">
      The right-hand video has three short scenes removed in the
      first 20 s. Both share the same correctly-timed SRT (timed for
      the original). Without AFS the edited video's subtitles fall
      progressively behind at each cut. With AFS, fingerprinting
      finds the true source position so subtitles stay correct no
      matter what was cut.
    </div>
  `;

  const videoOrig = document.getElementById("video-orig");
  const videoEdit = document.getElementById("video-edit");
  videoOrig.src = "content/dialogue-clip.mp4";
  videoEdit.src = "content/dialogue-clip-edited.mp4";

  const srtText = await fetch("content/dialogue-clip.en.srt").then((r) =>
    r.text(),
  );
  const cues = parseSRT(srtText);

  // The original is the reference — its subtitles always use raw
  // (video-element) time and never need AFS correction. The edited
  // video is the one whose subtitles drift; AFS toggling lives only
  // on its side.
  const rendererOrig = new SubtitleRenderer(
    document.getElementById("sub-orig"),
    cues,
  );
  const rendererEdit = new SubtitleRenderer(
    document.getElementById("sub-edit"),
    cues,
  );

  document.getElementById("afs-edit").addEventListener("change", (e) => {
    rendererEdit.setUseAfs(e.target.checked);
  });

  // ------------------------------------------------------------
  // Mode dispatch
  // ------------------------------------------------------------

  // Driver functions update the edit-side subtitle's AFS time
  // from whichever source the active mode supplies.
  let activeMode = null;

  function setModeDetail(text) {
    document.getElementById("afs-mode-detail").textContent = text;
  }

  function syncModeButtons(mode) {
    for (const btn of document.querySelectorAll("[data-afs-mode]")) {
      btn.classList.toggle("active", btn.dataset.afsMode === mode);
      btn.setAttribute(
        "aria-selected",
        btn.dataset.afsMode === mode ? "true" : "false",
      );
    }
  }

  async function teardownActiveMode() {
    stopRafLoop();
    if (state.session) {
      state.session.stop();
      state.session = null;
    }
    if (state.afsSeekListener) {
      videoEdit.removeEventListener("seeking", state.afsSeekListener);
      state.afsSeekListener = null;
    }
  }

  // Shared helper for the two live-matcher modes (audio-output and
  // microphone). Implements the offset-locked rendering strategy:
  // the matcher provides intermittent (source - playhead) offsets
  // on confident matches; the rAF loop computes the current source
  // position as videoEdit.currentTime + lastGoodOffset every frame.
  //
  // Why this beats "matcher reports a position, renderer uses it":
  //   - The matcher fires at ~250 ms, the display refreshes at 60 fps.
  //     Driving the subtitle off video.currentTime smooths the
  //     intermediate frames automatically.
  //   - When the buffer spans a cut (matcher returns ambiguous=true,
  //     onPosition isn't called), the offset stays put. The subtitle
  //     keeps advancing with the playhead, just stale-by-the-cut
  //     amount, rather than jumping backward to the matcher's
  //     dominant-block report.
  //   - A seek invalidates the offset; the next confident match
  //     re-establishes it. During the gap the renderer falls back to
  //     its raw-time path (no AFS time set), which gracefully shows
  //     the SRT cue at the local timeline.
  function startLiveMatcherWithOffset(session) {
    let afsOffsetMs = null;
    const onSeek = () => { afsOffsetMs = null; };
    videoEdit.addEventListener("seeking", onSeek);
    state.afsSeekListener = onSeek;
    session.onPosition = (timeMs) => {
      // timeMs is where the source is at the END of the matcher's
      // captured buffer (already projected forward by buffer duration
      // in demo-session.js). videoEdit.currentTime read here aligns
      // closely enough with that moment that the offset is accurate
      // to within a frame or two.
      afsOffsetMs = timeMs - videoEdit.currentTime * 1000;
    };
    startRafLoop(() => {
      const editedMs = videoEdit.currentTime * 1000;
      rendererOrig.setRawTimeMs(videoOrig.currentTime * 1000);
      rendererEdit.setRawTimeMs(editedMs);
      if (afsOffsetMs != null) {
        rendererEdit.setAfsTimeMs(editedMs + afsOffsetMs);
      }
    });
  }

  // Mode 1 — pre-calculated time mapping. No matcher, no audio
  // capture. We fetch both AFS files, compute a mapping once,
  // and on each frame look up the source position from the edited
  // <video>'s currentTime.
  async function startPrecalcMode() {
    const [sourceAfs, derivedAfs] = await Promise.all([
      fetch("content/dialogue-clip.afs").then((r) => r.text()).then(parseAFS),
      fetch("content/dialogue-clip-edited.afs")
        .then((r) => r.text())
        .then(parseAFS),
    ]);
    const mapping = computeTimeMapping(sourceAfs, derivedAfs);
    setModeDetail(
      `${mapping.blocks.length} blocks · ${mapping.anchors.length} anchors`,
    );
    setStatus("ready · press play", "");
    startRafLoop(() => {
      const editedMs = videoEdit.currentTime * 1000;
      rendererOrig.setRawTimeMs(videoOrig.currentTime * 1000);
      rendererEdit.setRawTimeMs(editedMs);
      const sourceMs = mapping.lookup(editedMs);
      if (sourceMs != null) rendererEdit.setAfsTimeMs(sourceMs);
    });
  }

  // Mode 2 — live fingerprinting from the <video>'s own audio,
  // matched against the source AFS. The matcher runs every tick;
  // cuts trigger re-acquisition. Display position is computed
  // from videoEdit.currentTime + last good (source - playhead)
  // offset every frame — see startLiveMatcherWithOffset.
  async function startListenHereMode() {
    const session = new DemoSession();
    state.session = session;
    bindSessionStatus(session);
    setModeDetail("matcher running against source AFS");
    await session.loadAFS("content/dialogue-clip.afs");
    await session.startDirect(videoEdit);
    startLiveMatcherWithOffset(session);
  }

  async function switchMode(newMode) {
    if (activeMode === newMode) return;
    activeMode = newMode;
    syncModeButtons(newMode);
    await teardownActiveMode();
    setStatus("idle");
    try {
      if (newMode === "precalc") await startPrecalcMode();
      else if (newMode === "listen") await startListenHereMode();
    } catch (e) {
      console.error(e);
      setStatus(`error: ${e.message}`, "error");
    }
  }

  for (const btn of document.querySelectorAll("[data-afs-mode]")) {
    btn.addEventListener("click", () => switchMode(btn.dataset.afsMode));
  }

  // Initial mode: pre-calc by default. Mic mode lives on its own
  // page (listen.html) accessed via the QR code; there's no
  // ?mode=mic path on the main subtitles demo any more.
  await switchMode("precalc");
}

// -----------------------------------------------------------------------
// Haptics demo: 1812 Overture finale, vibration + silent cannon visual
// -----------------------------------------------------------------------

async function startHapticsDemo() {
  // Mic mode is on its own page (listen-haptics.html). The main
  // demo offers two timing sources, matching the subtitles demo's
  // pattern:
  //
  //   Pre-calculated — uses the hand-annotated cannon-events JSON
  //     directly off the local audio's currentTime. No matcher,
  //     no chromaprint, no audio capture. What a local player
  //     would do once it has the timing track for the file.
  //
  //   Listen · audio output — live fingerprint the audio element
  //     and drive haptics from the matcher's reported position.
  //     Demonstrates the offset adaptation pipeline.
  //
  // Important: the cannon visual is silent on this page. An
  // earlier iteration played a Fort Snelling cannon SFX over the
  // music for impact, but that created a feedback path when a
  // separate device (or window) was listening via mic — its
  // capture got dirtied by THIS device's local cannon. Removing
  // the audio leaves the music's own embedded cannons audible and
  // keeps the mic flow clean for cross-device demos.
  state.els.playerArea.innerHTML = `
    <div class="afs-mode-row" role="tablist" aria-label="AFS source">
      <span class="afs-mode-label">AFS source:</span>
      <button class="afs-mode-btn" role="tab" data-afs-mode="precalc">Pre-calculated</button>
      <button class="afs-mode-btn" role="tab" data-afs-mode="listen">Listen · audio output</button>
      <span class="afs-mode-detail" id="afs-mode-detail"></span>
    </div>
    <div class="haptics-stage">
      <audio id="demo-audio" controls preload="metadata"></audio>
      <p class="haptics-instructions">Press play. Cannons fire as Tchaikovsky intended.</p>
      <video id="cannon-video" class="cannon-video inline" muted playsinline preload="auto"></video>
      <details class="cannon-annotator">
        <summary>Annotate cannon timings</summary>
        <div class="annotator-row">
          <span class="annotator-timer" id="annotator-timer">0:00.000</span>
          <button class="annotator-btn annotator-mark" id="annotator-mark" type="button">Mark cannon · SPACE</button>
          <button class="annotator-btn annotator-undo" id="annotator-undo" type="button">Undo</button>
          <button class="annotator-btn annotator-clear" id="annotator-clear" type="button">Clear</button>
          <button class="annotator-btn annotator-copy" id="annotator-copy" type="button">Copy JSON</button>
        </div>
        <label class="annotator-comp">
          Tap-reaction comp:
          <input type="number" id="annotator-comp" value="150" min="0" max="500" step="10">
          ms <span class="annotator-comp-hint">(subtracted from each mark; humans tap ~150 ms after hearing)</span>
        </label>
        <pre class="annotator-output" id="annotator-output">// play the audio, press SPACE on each cannon</pre>
      </details>
    </div>
  `;

  const audioEl = document.getElementById("demo-audio");
  audioEl.src = "content/overture-finale.mp3";
  const cannonVideo = document.getElementById("cannon-video");
  cannonVideo.src = "content/cannon-shot.mp4";

  // When the audio reaches its natural end, reset the haptics
  // manager's `fired` set + clear the cannon visual. Without this,
  // pressing play again replays the audio but every event is
  // already in `fired` and no cannons would fire.
  audioEl.addEventListener("ended", () => {
    if (haptics) haptics.reset();
    cannonVideo.classList.remove("showing");
    cannonVideo.pause();
  });
  // Same on seek-to-start so the user can scrub back and re-trigger.
  audioEl.addEventListener("seeked", () => {
    if (audioEl.currentTime < 0.5 && haptics) haptics.reset();
  });

  // -------- Annotator: hand-mark cannon timestamps as the audio plays --
  setupCannonAnnotator(audioEl);

  const events = await fetch("content/overture-finale-cannons.json")
    .then((r) => r.json())
    .then((d) => d.events || []);

  let activeMode = null;
  let haptics = null;

  function setModeDetail(text) {
    document.getElementById("afs-mode-detail").textContent = text;
  }

  function syncModeButtons(mode) {
    for (const btn of document.querySelectorAll("[data-afs-mode]")) {
      btn.classList.toggle("active", btn.dataset.afsMode === mode);
      btn.setAttribute(
        "aria-selected",
        btn.dataset.afsMode === mode ? "true" : "false",
      );
    }
  }

  async function teardown() {
    stopRafLoop();
    if (state.session) {
      state.session.stop();
      state.session = null;
    }
    if (haptics) {
      haptics.reset();
      haptics = null;
    }
  }

  // Pre-calc mode: cannons are scheduled from cannon-events JSON
  // against the audio element's currentTime. No matcher, no AFS.
  async function startPrecalcMode() {
    setModeDetail("");
    haptics = new HapticsEventManager(
      events,
      () => fireCannon(cannonVideo),
      { predictionOffsetMs: 0 },
    );
    startRafLoop(() => {
      if (!audioEl.paused && audioEl.currentTime > 0) {
        haptics.step(audioEl.currentTime * 1000, performance.now());
      }
    });
    setStatus("ready · press play", "");
  }

  // Listen mode: matcher reads the audio output via Web Audio,
  // adaptive offset compensation tunes the schedule-ahead lead time
  // from observed lag against audioEl.currentTime.
  async function startListenMode() {
    setModeDetail("");
    const offsetOverride = new URLSearchParams(window.location.search).get(
      "offset",
    );
    const initialOffsetMs = offsetOverride != null ? Number(offsetOverride) : 190;
    haptics = new HapticsEventManager(
      events,
      () => fireCannon(cannonVideo),
      { predictionOffsetMs: initialOffsetMs },
    );

    let computedDefaultMs = initialOffsetMs;
    let smoothedOffsetMs = initialOffsetMs;
    const EMA_ALPHA = 0.1;
    const ADAPT_CAP_MS = 100;

    const session = new DemoSession({
      onPosition: (timeMs) => {
        haptics.step(timeMs, performance.now());
        if (
          offsetOverride == null &&
          audioEl.currentTime > 0 &&
          !audioEl.paused
        ) {
          const observed = audioEl.currentTime * 1000 - timeMs;
          smoothedOffsetMs =
            EMA_ALPHA * observed + (1 - EMA_ALPHA) * smoothedOffsetMs;
          const lo = computedDefaultMs - ADAPT_CAP_MS;
          const hi = computedDefaultMs + ADAPT_CAP_MS;
          const capped = Math.round(Math.max(lo, Math.min(hi, smoothedOffsetMs)));
          haptics.setOffset(capped);
        }
      },
    });
    state.session = session;
    bindSessionStatus(session);

    await session.loadAFS("content/overture-finale.afs");
    await session.startDirect(audioEl);

    // Reuse the matcher's AudioContext for SFX playback so we don't
    // spin up a second context just to play cannon shots.
    if (session.capture?.audioContext) {
      cannonSfx.attach(session.capture.audioContext);
    }

    if (offsetOverride == null && session.capture?.audioContext) {
      computedDefaultMs = estimateMatchLatencyMs(session.capture.audioContext, {
        matchIntervalMs: session.options.matchIntervalMs,
        isMic: false,
      });
      smoothedOffsetMs = computedDefaultMs;
      haptics.setOffset(computedDefaultMs);
    }
  }

  async function switchMode(newMode) {
    if (activeMode === newMode) return;
    activeMode = newMode;
    syncModeButtons(newMode);
    await teardown();
    setStatus("idle");
    try {
      if (newMode === "precalc") await startPrecalcMode();
      else if (newMode === "listen") await startListenMode();
    } catch (e) {
      console.error(e);
      setStatus(`error: ${e.message}`, "error");
    }
  }

  for (const btn of document.querySelectorAll("[data-afs-mode]")) {
    btn.addEventListener("click", () => switchMode(btn.dataset.afsMode));
  }

  await switchMode("precalc");
}

// setupCannonAnnotator: live timer + tap-to-mark UI for hand-
// timing cannon events against the audio. Output formatted as the
// `events` array of overture-finale-cannons.json — copyable
// directly into the file.
function setupCannonAnnotator(audioEl) {
  const timerEl = document.getElementById("annotator-timer");
  const outputEl = document.getElementById("annotator-output");
  const markBtn = document.getElementById("annotator-mark");
  const undoBtn = document.getElementById("annotator-undo");
  const clearBtn = document.getElementById("annotator-clear");
  const copyBtn = document.getElementById("annotator-copy");
  if (!timerEl || !outputEl) return;

  const marks = [];

  function formatTime(ms) {
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const milli = Math.floor(ms % 1000);
    return `${m}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
  }

  function render() {
    if (marks.length === 0) {
      outputEl.textContent = "// play the audio, press SPACE on each cannon";
      return;
    }
    const lines = marks.map(
      (ms, i) =>
        `  { "time_ms": ${ms}, "type": "cannon", "label": "Cannon ${i + 1}" }`,
    );
    outputEl.textContent = `"events": [\n${lines.join(",\n")}\n]`;
  }

  function getCompMs() {
    const inp = document.getElementById("annotator-comp");
    const v = inp ? Number(inp.value) : 0;
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }

  function mark() {
    if (audioEl.readyState < 1) return;
    const ms = Math.max(0, Math.round(audioEl.currentTime * 1000 - getCompMs()));
    marks.push(ms);
    render();
    // Briefly highlight the mark button so the click feels acknowledged.
    markBtn.classList.add("annotator-pulse");
    setTimeout(() => markBtn.classList.remove("annotator-pulse"), 120);
  }

  function undo() {
    marks.pop();
    render();
  }

  function clear() {
    marks.length = 0;
    render();
  }

  async function copy() {
    if (marks.length === 0) return;
    try {
      await navigator.clipboard.writeText(outputEl.textContent);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy JSON"), 1200);
    } catch {
      // Clipboard API failed (older browser / no permission). Select
      // the output element so the user can Cmd/Ctrl-C themselves.
      const range = document.createRange();
      range.selectNodeContents(outputEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  markBtn.addEventListener("click", mark);
  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clear);
  copyBtn.addEventListener("click", copy);

  // SPACE-anywhere shortcut, but stay out of the way when the user
  // is typing into an input or interacting with the native audio
  // controls. (The <audio> element doesn't take SPACE focus by
  // default, so we don't need a special-case for it here.)
  function onKeydown(e) {
    if (e.code !== "Space" || e.repeat) return;
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    ) {
      return;
    }
    e.preventDefault();
    mark();
  }
  document.addEventListener("keydown", onKeydown);

  // Live timer. requestAnimationFrame keeps it smooth without
  // burning a setInterval; we just show audioEl.currentTime in the
  // same format as the JSON it produces.
  function tick() {
    if (!document.body.contains(timerEl)) {
      // Demo switched away; stop the loop and detach the listener.
      document.removeEventListener("keydown", onKeydown);
      return;
    }
    timerEl.textContent = formatTime(audioEl.currentTime * 1000);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// fireCannon: show the cannon clip silently, vibrate on touch
// devices, and shake the whole window so desktop visitors get a
// pseudo-haptic feedback (since they have no vibration motor).
function fireCannon(videoEl) {
  if (navigator.vibrate) navigator.vibrate(200);

  // Window shake — a small jolt of the whole document. The real
  // haptic motor handles touch devices; this is the visual stand-
  // in for everyone else.
  document.body.classList.add("haptic-shake");
  setTimeout(() => document.body.classList.remove("haptic-shake"), 220);

  videoEl.classList.add("showing");
  try {
    // Skip past the cannon-shot.mp4's 480 ms of pre-firing buildup
    // straight to the visible firing frame. The JSON we ship has
    // *audible* firing times; if we played the video from t=0 the
    // visible flash would land ~480 ms after the audible boom.
    videoEl.currentTime = 0.48;
    const playPromise = videoEl.play();
    if (playPromise) playPromise.catch(() => {});
  } catch {}
  const onEnded = () => {
    videoEl.classList.remove("showing");
    videoEl.removeEventListener("ended", onEnded);
  };
  videoEl.addEventListener("ended", onEnded);
  // Safety hide that covers the clip's audible duration (~1.9 s
  // from currentTime=0.48 to end-of-clip).
  setTimeout(() => videoEl.classList.remove("showing"), 2000);
}

// -----------------------------------------------------------------------
// Custom-files demo: upload your own
// -----------------------------------------------------------------------

async function startCustomDemo() {
  // Custom files demo only makes sense in direct mode (the user is
  // both playing and listening on the same device with their own
  // files).
  if (state.mode !== "direct") {
    setMode("direct");
    state.els.qrArea.hidden = true;
  }

  state.els.customFiles.hidden = false;
  state.els.playerArea.innerHTML = `
    <div class="custom-instructions">
      <p>Use the file pickers above to load:</p>
      <ol>
        <li>A media file (any format your browser can play)</li>
        <li>A subtitle file (optional, SRT or VTT)</li>
        <li>An AFS file (optional — one will be generated if not provided)</li>
      </ol>
      <p>Files never leave your device. Generated AFS files can be
      downloaded for later use or sharing.</p>
      <div id="custom-status"></div>
      <div class="subtitle-track subtitle-large" id="custom-subtitle"></div>
    </div>
  `;

  document
    .getElementById("custom-media")
    .addEventListener("change", handleCustomMedia);
  document
    .getElementById("custom-srt")
    .addEventListener("change", handleCustomSrt);
  document
    .getElementById("custom-afs")
    .addEventListener("change", handleCustomAfs);
}

let customMediaFile = null;
let customSrtFile = null;
let customAfsBlob = null;
let customSubtitleRenderer = null;

async function handleCustomMedia(e) {
  customMediaFile = e.target.files[0];
  await maybeStartCustom();
}

async function handleCustomSrt(e) {
  customSrtFile = e.target.files[0];
  if (customSubtitleRenderer && customSrtFile) {
    const text = await customSrtFile.text();
    customSubtitleRenderer.cues = parseSRT(text);
    customSubtitleRenderer.update();
  } else {
    await maybeStartCustom();
  }
}

async function handleCustomAfs(e) {
  customAfsBlob = e.target.files[0];
  await maybeStartCustom();
}

async function maybeStartCustom() {
  if (!customMediaFile) return;
  const statusEl = document.getElementById("custom-status");

  // Stop any prior session so the user can replace their files.
  if (state.session) {
    state.session.stop();
    state.session = null;
    stopRafLoop();
  }

  // Build a playback element.
  const mediaUrl = URL.createObjectURL(customMediaFile);
  const isVideo = customMediaFile.type.startsWith("video/");
  statusEl.innerHTML = "";
  const el = document.createElement(isVideo ? "video" : "audio");
  el.controls = true;
  el.src = mediaUrl;
  el.preload = "metadata";
  el.playsInline = true;
  statusEl.appendChild(el);

  let afsBlob = customAfsBlob;
  if (!afsBlob) {
    const genStatus = document.createElement("p");
    genStatus.id = "gen-status";
    genStatus.textContent =
      "generating AFS file from your media (this may take a moment)...";
    statusEl.appendChild(genStatus);
    setStatus("generating AFS file…", "warn");
    try {
      afsBlob = await generateAFSFromFile(customMediaFile);
      genStatus.remove();
      const link = document.createElement("p");
      const dlUrl = URL.createObjectURL(afsBlob);
      link.innerHTML = `AFS ready. <a href="${dlUrl}" download="${stripExtension(customMediaFile.name)}.afs">Download .afs</a>`;
      statusEl.appendChild(link);
    } catch (err) {
      genStatus.textContent = `AFS generation failed: ${err.message}`;
      setStatus(`error: ${err.message}`, "error");
      return;
    }
  }

  // Read the AFS as text and feed to a session.
  const afsText = await afsBlob.text();
  const blobUrl = URL.createObjectURL(
    new Blob([afsText], { type: "text/plain" }),
  );

  // Set up the subtitle renderer if an SRT was provided.
  let cues = [];
  if (customSrtFile) {
    cues = parseSRT(await customSrtFile.text());
  }
  customSubtitleRenderer = new SubtitleRenderer(
    document.getElementById("custom-subtitle"),
    cues,
  );
  customSubtitleRenderer.setUseAfs(true);

  const session = new DemoSession({
    onPosition: (timeMs) => {
      customSubtitleRenderer.setAfsTimeMs(timeMs);
    },
  });
  state.session = session;
  bindSessionStatus(session);
  await session.loadAFS(blobUrl);
  await session.startDirect(el);
}

// generateAFSFromFile: decode audio, fingerprint, return an AFS blob.
//
// Uses the browser's AudioContext.decodeAudioData for decoding, then
// the WASM chromaprint module (or mockFingerprint until WASM is wired
// up). Returns a Blob containing the AFS file content.
async function generateAFSFromFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Downmix to mono and resample to 11025 Hz.
  const targetRate = 11025;
  const sourceRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  // Downmix.
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += ch[i] / numChannels;
  }
  // Resample.
  const ratio = sourceRate / targetRate;
  const resampledLength = Math.floor(length / ratio);
  const resampled = new Float32Array(resampledLength);
  for (let i = 0; i < resampledLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = mono[idx] ?? 0;
    const b = mono[idx + 1] ?? a;
    resampled[i] = a + (b - a) * frac;
  }

  // Fingerprint. mockFingerprint is used until chromaprint-wasm is
  // wired in chromaprint.js; the call site is the same so swapping
  // is a one-line change.
  const hashes = mockFingerprint(resampled);

  const afsText = writeAFS(hashes, {
    audio: {
      sample_rate_hz: sourceRate,
      channels: numChannels,
    },
    source: {
      title: stripExtension(file.name),
      duration_ms: Math.round((length / sourceRate) * 1000),
    },
  });
  audioContext.close().catch(() => {});
  return new Blob([afsText], { type: "text/plain" });
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

// -----------------------------------------------------------------------
// Demo dispatch
// -----------------------------------------------------------------------

const demos = {
  "desync-video": startDesyncVideoDemo,
  haptics: startHapticsDemo,
  custom: startCustomDemo,
};

// -----------------------------------------------------------------------
// rAF loop management
// -----------------------------------------------------------------------

function startRafLoop(fn) {
  stopRafLoop();
  const loop = () => {
    fn();
    state.rafHandle = requestAnimationFrame(loop);
  };
  state.rafHandle = requestAnimationFrame(loop);
}

function stopRafLoop() {
  if (state.rafHandle != null) {
    cancelAnimationFrame(state.rafHandle);
    state.rafHandle = null;
  }
}

// -----------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------

async function startSelectedDemo() {
  if (!state.demoId) return;
  stopCurrentDemo();
  // Reset the status so it doesn't carry "in sync · 00:01:23" or
  // an error message from the previous demo. Each demo will then
  // update the status as it loads / waits for play / locks on.
  setStatus("idle");

  // QR is available on every built-in demo as a "try on your phone"
  // affordance. The custom-files demo uses user-uploaded files so a
  // QR pointing the phone at this device wouldn't make sense.
  if (state.demoId !== "custom") {
    state.els.qrArea.hidden = false;
    renderQRCodeForCurrentDemo();
  } else {
    state.els.qrArea.hidden = true;
  }

  const handler = demos[state.demoId];
  if (!handler) {
    setStatus(`unknown demo: ${state.demoId}`, "error");
    return;
  }
  try {
    await handler();
  } catch (e) {
    console.error(e);
    setStatus(`failed to start: ${e.message}`, "error");
  }
}

function stopCurrentDemo() {
  stopRafLoop();
  releaseWakeLock();
  if (state.session) {
    state.session.stop();
    state.session = null;
  }
  state.els.playerArea.innerHTML = "";
  state.els.customFiles.hidden = true;
  state.els.qrArea.hidden = true;
}

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------

// Reflect the active demo in the tab DOM. The canonical state lives
// on state.demoId; this helper just syncs the visual `.active` class
// on the tabs.
function setActiveDemo(demoId) {
  state.demoId = demoId;
  for (const btn of state.els.demoBtns) {
    btn.classList.toggle("active", btn.dataset.demo === demoId);
    btn.setAttribute("aria-selected", btn.dataset.demo === demoId ? "true" : "false");
  }
}

// Mode is no longer exposed as a UI toggle on the desktop — it's
// driven by URL param (?mode=mic), which is how the QR-code flow
// puts a scanning phone into mic mode. Desktop defaults to direct.
function setMode(mode) {
  state.mode = mode === "mic" ? "mic" : "direct";
}

function init() {
  state.els = {
    demoBtns: document.querySelectorAll(".tab[data-demo]"),
    statusText: document.getElementById("status-text"),
    playerArea: document.getElementById("player-area"),
    qrArea: document.getElementById("qr-area"),
    qrCode: document.getElementById("qr-code"),
    qrLink: document.getElementById("qr-link"),
    customFiles: document.getElementById("custom-files"),
  };

  // Click on a demo tab: activate it and start it. The click itself
  // is the user gesture browsers require for audio autoplay /
  // getUserMedia, so no separate Start button is needed.
  for (const btn of state.els.demoBtns) {
    btn.addEventListener("click", () => {
      setActiveDemo(btn.dataset.demo);
      startSelectedDemo();
    });
  }

  // The "Open in a new window" link uses window.open with explicit
  // size/position so browsers spawn a real popup window (not a
  // tab) — the whole point is to have the two side by side. If the
  // browser refuses (popup blocker), fall back to target="_blank".
  if (state.els.qrLink) {
    state.els.qrLink.addEventListener("click", (e) => {
      const href = state.els.qrLink.href;
      const w = Math.max(420, Math.floor(window.screen.availWidth / 2));
      const h = window.screen.availHeight;
      const left = window.screen.availWidth - w;
      const features = `popup=yes,width=${w},height=${h},left=${left},top=0`;
      const opened = window.open(href, "afs-companion", features);
      if (opened) {
        e.preventDefault();
      }
      // If window.open returned null (blocked), let the default
      // target="_blank" behavior fire.
    });
  }

  // Read URL parameters (used by QR codes). If neither is present,
  // open the page on a default demo so the visitor immediately sees
  // AFS at work rather than an empty page. The default is the
  // shifted-subtitles demo: most readable, most obviously
  // "something is happening" without needing audio output.
  const params = new URLSearchParams(window.location.search);
  setMode(params.get("mode") || "direct");
  const demo = params.has("demo") ? params.get("demo") : "desync-video";
  setActiveDemo(demo);
  // Defer one tick so the DOM has settled and any layout-dependent
  // setup inside the demo handlers can run normally.
  setTimeout(() => startSelectedDemo(), 100);

  setStatus("idle");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
