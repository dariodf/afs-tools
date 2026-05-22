// app.js
// Main entry point for the AFS demo.
//
// Wires up the UI to the AFS modules. Each demo lives as a separate
// async function that's selected based on the dropdown value.

import { parseSRT } from "./src/srt-parser.js";
import { DemoSession } from "./src/demo-session.js";
import { SubtitleRenderer } from "./src/subtitle-renderer.js";
import { HapticsEventManager } from "./src/haptics-events.js";
import { writeAFS } from "./src/afs-writer.js";
import { mockFingerprint, estimateMatchLatencyMs } from "./src/chromaprint.js";
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
        setStatus(`syncing... ${status.progressPct}%`, "warn");
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

function renderQRCodeForCurrentDemo() {
  const url = new URL(window.location.href);
  url.searchParams.set("demo", state.demoId);
  url.searchParams.set("mode", state.mode);
  state.els.qrCode.innerHTML = qrCode(url.toString(), { size: 220 });
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
// Demo 1: shifted SRT (one video, two SRT tracks)
// -----------------------------------------------------------------------

async function startDesyncSrtDemo() {
  state.els.playerArea.innerHTML = `
    <video id="demo-video" controls preload="metadata" playsinline></video>
    <div class="subtitle-row">
      <div class="subtitle-track-label">
        Correctly timed
        <label><input type="checkbox" id="afs-correct"> AFS mode</label>
      </div>
      <div class="subtitle-track" id="sub-correct"></div>
    </div>
    <div class="subtitle-row">
      <div class="subtitle-track-label">
        Shifted +2 seconds
        <label><input type="checkbox" id="afs-shifted"> AFS mode</label>
      </div>
      <div class="subtitle-track" id="sub-shifted"></div>
    </div>
    <div class="demo-explanation">
      The bottom subtitle file has every timestamp shifted by 2 seconds.
      Without AFS, it shows every line 2 seconds late. Toggle AFS mode on
      the bottom track to see it snap into sync with the dialogue.
    </div>
  `;

  const video = document.getElementById("demo-video");
  video.src = "content/dialogue-clip.mp4";

  const [srtCorrect, srtShifted] = await Promise.all([
    fetch("content/dialogue-clip.en.srt").then((r) => r.text()),
    fetch("content/dialogue-clip.en.shifted.srt").then((r) => r.text()),
  ]);
  const cuesCorrect = parseSRT(srtCorrect);
  const cuesShifted = parseSRT(srtShifted);

  const rendererCorrect = new SubtitleRenderer(
    document.getElementById("sub-correct"),
    cuesCorrect,
  );
  const rendererShifted = new SubtitleRenderer(
    document.getElementById("sub-shifted"),
    cuesShifted,
  );

  document.getElementById("afs-correct").addEventListener("change", (e) => {
    rendererCorrect.setUseAfs(e.target.checked);
  });
  document.getElementById("afs-shifted").addEventListener("change", (e) => {
    rendererShifted.setUseAfs(e.target.checked);
  });

  const session = new DemoSession({
    onPosition: (timeMs) => {
      rendererCorrect.setAfsTimeMs(timeMs);
      rendererShifted.setAfsTimeMs(timeMs);
    },
  });
  state.session = session;
  bindSessionStatus(session);

  await session.loadAFS("content/dialogue-clip.afs");
  await startSessionFor(session, video);

  startRafLoop(() => {
    const rawMs = video.currentTime * 1000;
    rendererCorrect.setRawTimeMs(rawMs);
    rendererShifted.setRawTimeMs(rawMs);
  });
}

// -----------------------------------------------------------------------
// Demo 2: edited video (two videos side-by-side, shared SRT)
// -----------------------------------------------------------------------

async function startDesyncVideoDemo() {
  const isMic = state.mode === "mic";

  if (isMic) {
    // Mic mode: the phone (or whichever device this is on) only
    // hears the edited video being played somewhere else. No
    // side-by-side comparison is possible here; show the synced
    // subtitles for the edited video alone.
    state.els.playerArea.innerHTML = `
      <div class="mic-listening">
        Listening for the edited video...
        <div class="mic-instructions">
          Play <code>content/dialogue-clip-edited.mp4</code> on another
          device. This phone will sync to its audio.
        </div>
      </div>
      <div class="subtitle-track subtitle-large" id="sub-mic"></div>
      <div class="demo-explanation">
        The video being played has three short cuts in the first 20
        seconds. Despite the cuts, AFS keeps these subtitles in sync
        with the audio.
      </div>
    `;
    const srtText = await fetch("content/dialogue-clip.en.srt").then((r) =>
      r.text(),
    );
    const cues = parseSRT(srtText);
    const renderer = new SubtitleRenderer(
      document.getElementById("sub-mic"),
      cues,
    );
    renderer.setUseAfs(true);

    const session = new DemoSession({
      onPosition: (timeMs) => renderer.setAfsTimeMs(timeMs),
    });
    state.session = session;
    bindSessionStatus(session);
    await session.loadAFS("content/dialogue-clip-edited.afs");
    await startSessionFor(session, null);
    return;
  }

  // Direct mode: side-by-side comparison.
  state.els.playerArea.innerHTML = `
    <div class="video-pair">
      <div class="video-column">
        <div class="video-label">Original</div>
        <video id="video-orig" controls preload="metadata" playsinline></video>
        <div class="subtitle-track-label">
          <label><input type="checkbox" id="afs-orig"> AFS mode</label>
        </div>
        <div class="subtitle-track" id="sub-orig"></div>
      </div>
      <div class="video-column">
        <div class="video-label">Edited (3 cuts in first 20s)</div>
        <video id="video-edit" controls preload="metadata" playsinline></video>
        <div class="subtitle-track-label">
          <label><input type="checkbox" id="afs-edit"> AFS mode</label>
        </div>
        <div class="subtitle-track" id="sub-edit"></div>
      </div>
    </div>
    <div class="demo-explanation">
      The bottom video has three short scenes removed in the first 20
      seconds. Both videos share the same correctly-timed SRT (timed
      for the original). In raw mode the edited video's subtitles fall
      progressively behind at each cut. AFS mode uses audio
      fingerprinting to find your actual position in the source, so
      subtitles stay correct no matter what was cut.
      <br><br>
      Play both videos to compare. The AFS in this demo follows the
      <em>edited</em> video.
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

  const rendererOrig = new SubtitleRenderer(
    document.getElementById("sub-orig"),
    cues,
  );
  const rendererEdit = new SubtitleRenderer(
    document.getElementById("sub-edit"),
    cues,
  );

  document.getElementById("afs-orig").addEventListener("change", (e) => {
    rendererOrig.setUseAfs(e.target.checked);
  });
  document.getElementById("afs-edit").addEventListener("change", (e) => {
    rendererEdit.setUseAfs(e.target.checked);
  });

  // The matcher follows the edited video.
  const session = new DemoSession({
    onPosition: (timeMs) => {
      rendererEdit.setAfsTimeMs(timeMs);
      rendererOrig.setAfsTimeMs(timeMs);
    },
  });
  state.session = session;
  bindSessionStatus(session);

  await session.loadAFS("content/dialogue-clip-edited.afs");
  await session.startDirect(videoEdit);

  startRafLoop(() => {
    rendererOrig.setRawTimeMs(videoOrig.currentTime * 1000);
    rendererEdit.setRawTimeMs(videoEdit.currentTime * 1000);
  });
}

// -----------------------------------------------------------------------
// Demo 3: haptics (1812 Overture finale + cannon visual + vibration)
// -----------------------------------------------------------------------

async function startHapticsDemo() {
  const isMic = state.mode === "mic";

  state.els.playerArea.innerHTML = `
    <div class="haptics-stage ${isMic ? "fullscreen" : ""}">
      ${
        isMic
          ? `<div class="mic-listening">listening to the 1812 Overture finale...</div>`
          : `<audio id="demo-audio" controls preload="metadata"></audio>
             <div class="haptics-instructions">
               Cannons fire at 8 moments in the finale. Each one triggers a
               visual flash here and a phone vibration if you're on a phone
               (Android browsers only; iOS does not support
               <code>navigator.vibrate</code>).
             </div>`
      }
      <video id="cannon-video" class="cannon-video" muted playsinline></video>
      <div class="cannon-flash" id="cannon-flash"></div>
    </div>
  `;
  // Style class adjustments for mic-mode haptics.
  if (isMic) {
    document.getElementById("cannon-video").classList.add("fullscreen");
  }

  let audioEl = null;
  if (!isMic) {
    audioEl = document.getElementById("demo-audio");
    audioEl.src = "content/overture-finale.mp3";
  }

  const cannonVideo = document.getElementById("cannon-video");
  cannonVideo.src = "content/cannon-shot.mp4";
  const flashEl = document.getElementById("cannon-flash");

  // Load the cannon-event timings (hand-annotated JSON).
  const events = await fetch("content/overture-finale-cannons.json")
    .then((r) => r.json())
    .then((d) => d.events || []);

  // Latency compensation for the schedule-ahead haptics manager.
  // The accurate value depends on AudioContext.baseLatency, which is
  // only readable after a session has started (the context doesn't
  // exist before then). So we start with a coarse default at
  // construction and refine via setOffset once the session is up.
  // A URL param `?offset=N` overrides both, for live tuning.
  const offsetOverride = new URLSearchParams(window.location.search).get(
    "offset",
  );
  const initialOffsetMs = offsetOverride != null
    ? Number(offsetOverride)
    : isMic
      ? 220
      : 190;

  const haptics = new HapticsEventManager(events, (event) => {
    fireCannon(cannonVideo, flashEl, isMic);
  }, { predictionOffsetMs: initialOffsetMs });

  // Adaptive-offset state. In direct mode, mediaElement.currentTime
  // is the ground truth for where the audio actually is, so we can
  // measure the matcher's lag directly each tick and EMA-smooth it.
  // In mic mode no such reference exists, so we trust the Step 2
  // computed default. If the user supplied ?offset=N we honor that
  // and skip adaptation entirely.
  let computedDefaultMs = initialOffsetMs;
  let smoothedOffsetMs = initialOffsetMs;
  const EMA_ALPHA = 0.1;
  const ADAPT_CAP_MS = 100; // cap drift from computed default

  const session = new DemoSession({
    onPosition: (timeMs) => {
      haptics.step(timeMs, performance.now());

      // Step 3: refine offset from observed lag in direct mode.
      if (
        offsetOverride == null &&
        !isMic &&
        audioEl &&
        audioEl.currentTime > 0 &&
        !audioEl.paused
      ) {
        const observed = audioEl.currentTime * 1000 - timeMs;
        smoothedOffsetMs = EMA_ALPHA * observed + (1 - EMA_ALPHA) * smoothedOffsetMs;
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
  await startSessionFor(session, audioEl);

  // Step 2: now that the AudioContext exists, refine the default
  // offset using AudioContext.baseLatency + tick + hop averages.
  // This becomes the baseline that Step 3's adaptive offset can
  // drift ±ADAPT_CAP_MS away from.
  if (offsetOverride == null && session.capture?.audioContext) {
    computedDefaultMs = estimateMatchLatencyMs(session.capture.audioContext, {
      matchIntervalMs: session.options.matchIntervalMs,
      isMic,
    });
    smoothedOffsetMs = computedDefaultMs;
    haptics.setOffset(computedDefaultMs);
  }

  // In mic mode, auto-enter fullscreen so the cannon visual takes
  // the full phone screen. The user's click on "Start" satisfies
  // the user-gesture requirement for the Fullscreen API.
  if (isMic && document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen rejected (e.g., iOS Safari quirks). Continue
      // without it; the demo still works, just with browser chrome.
    }
  }
}

// fireCannon: play the cannon clip once, flash the screen, vibrate.
// Show-play-hide (no looping). Restarts if called again while still
// playing so each cannon event fires its own visual.
function fireCannon(videoEl, flashEl, fullscreen) {
  if (navigator.vibrate) {
    navigator.vibrate(200);
  }
  flashEl.classList.add("firing");
  setTimeout(() => flashEl.classList.remove("firing"), 200);

  videoEl.classList.add("showing");
  if (fullscreen) videoEl.classList.add("fullscreen");
  try {
    videoEl.currentTime = 0;
    const playPromise = videoEl.play();
    if (playPromise) playPromise.catch(() => {});
  } catch {}
  const onEnded = () => {
    videoEl.classList.remove("showing");
    videoEl.removeEventListener("ended", onEnded);
  };
  videoEl.addEventListener("ended", onEnded);
  // Safety: hide after 2s regardless of "ended" firing.
  setTimeout(() => videoEl.classList.remove("showing"), 2000);
}

// -----------------------------------------------------------------------
// Demo 4: custom files (upload your own)
// -----------------------------------------------------------------------

async function startCustomDemo() {
  // Custom files demo only makes sense in direct mode (the user is
  // both playing and listening on the same device with their own
  // files). Force direct mode and update the UI to reflect it.
  if (state.mode !== "direct") {
    setActiveMode("direct");
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
      "generating AFS from your file (this may take a moment)...";
    statusEl.appendChild(genStatus);
    try {
      afsBlob = await generateAFSFromFile(customMediaFile);
      genStatus.remove();
      const link = document.createElement("p");
      const dlUrl = URL.createObjectURL(afsBlob);
      link.innerHTML = `AFS ready. <a href="${dlUrl}" download="${stripExtension(customMediaFile.name)}.afs">Download .afs</a>`;
      statusEl.appendChild(link);
    } catch (err) {
      genStatus.textContent = `AFS generation failed: ${err.message}`;
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
  "desync-srt": startDesyncSrtDemo,
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

  if (state.mode === "mic") {
    state.els.qrArea.hidden = false;
    renderQRCodeForCurrentDemo();
  } else {
    state.els.qrArea.hidden = true;
  }

  state.els.fullscreenBtn.hidden = false;

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

// Reflect the active demo/mode in the segmented-control DOM. The
// canonical state lives on state.demoId / state.mode; these helpers
// just sync the visual `.active` class on the buttons.
function setActiveDemo(demoId) {
  state.demoId = demoId;
  for (const btn of state.els.demoBtns) {
    btn.classList.toggle("active", btn.dataset.demo === demoId);
    btn.setAttribute("aria-selected", btn.dataset.demo === demoId ? "true" : "false");
  }
}

function setActiveMode(mode) {
  state.mode = mode;
  for (const btn of state.els.modeBtns) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
    btn.setAttribute("aria-selected", btn.dataset.mode === mode ? "true" : "false");
  }
}

function init() {
  state.els = {
    demoBtns: document.querySelectorAll(".seg-btn[data-demo]"),
    modeBtns: document.querySelectorAll(".seg-btn[data-mode]"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),
    statusText: document.getElementById("status-text"),
    playerArea: document.getElementById("player-area"),
    qrArea: document.getElementById("qr-area"),
    qrCode: document.getElementById("qr-code"),
    customFiles: document.getElementById("custom-files"),
  };

  state.els.fullscreenBtn.addEventListener("click", () => {
    const area = state.els.playerArea;
    if (area.requestFullscreen) area.requestFullscreen();
  });

  // Click on a demo tab: activate it and start it. The click itself
  // is the user gesture browsers require for audio autoplay /
  // getUserMedia, so no separate Start button is needed.
  for (const btn of state.els.demoBtns) {
    btn.addEventListener("click", () => {
      setActiveDemo(btn.dataset.demo);
      startSelectedDemo();
    });
  }

  // Click on a mode tab: change mode, and if a demo is already
  // selected, restart it under the new mode.
  for (const btn of state.els.modeBtns) {
    btn.addEventListener("click", () => {
      setActiveMode(btn.dataset.mode);
      if (state.demoId) startSelectedDemo();
    });
  }

  // Read URL parameters (used by QR codes).
  const params = new URLSearchParams(window.location.search);
  const mode = params.has("mode") ? params.get("mode") : "direct";
  setActiveMode(mode);
  if (params.has("demo")) {
    setActiveDemo(params.get("demo"));
    setTimeout(() => startSelectedDemo(), 100);
  }

  setStatus("idle");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
