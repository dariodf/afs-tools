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
  // Both the QR and the click-to-open link encode mic mode — the
  // companion device (phone, second laptop, anything with a
  // microphone) opens listening for the audio. The current device
  // can be in either mode independently.
  const url = new URL(window.location.href);
  url.searchParams.set("demo", state.demoId);
  url.searchParams.set("mode", "mic");
  const href = url.toString();
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

  // Direct mode: side-by-side comparison with INDEPENDENT playback
  // for each video. These are two different files (one with cuts);
  // forcing shared transport would lock them together when the
  // visceral demo value comes from being able to scrub / pause each
  // one on its own.
  state.els.playerArea.innerHTML = `
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
      matter what was cut. Play each video independently to compare.
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
  // on its side. The SubtitleRenderer already falls back to raw
  // time when AFS mode is on but no AFS position has arrived yet,
  // so toggling early just shows the raw-timed (drifted) subtitle
  // until the matcher locks on, instead of going blank.
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

  // The matcher fingerprints the edited audio and locates it inside
  // the ORIGINAL clip's AFS. That gives a position in original-time,
  // which is what the SRT is keyed to. Cuts in the edited audio
  // become "skips" the matcher recovers from via re-acquisition.
  const session = new DemoSession({
    onPosition: (timeMs) => {
      rendererEdit.setAfsTimeMs(timeMs);
    },
  });
  state.session = session;
  bindSessionStatus(session);

  // Load the ORIGINAL clip's AFS, not the edited one. The matcher
  // fingerprints the edited audio (which the user is hearing) and
  // matches against the original AFS to recover the *original*
  // source position — which is exactly the time the SRT is keyed
  // to. After each cut the matcher's local search will miss and
  // fall through to a cold-start re-acquisition; that's the
  // recovery behavior the demo is meant to show.
  await session.loadAFS("content/dialogue-clip.afs");
  await session.startDirect(videoEdit);

  startRafLoop(() => {
    rendererOrig.setRawTimeMs(videoOrig.currentTime * 1000);
    rendererEdit.setRawTimeMs(videoEdit.currentTime * 1000);
  });
}

// -----------------------------------------------------------------------
// Cannons demo: 1812 Overture finale + cannon visual + vibration
// -----------------------------------------------------------------------

async function startHapticsDemo() {
  const isMic = state.mode === "mic";

  state.els.playerArea.innerHTML = `
    <div class="haptics-stage ${isMic ? "fullscreen" : ""}">
      ${
        isMic
          ? `<div class="mic-listening">listening for the finale...</div>`
          : `<audio id="demo-audio" controls preload="metadata"></audio>
             <p class="haptics-instructions">Listen for the cannons. The video below fires on each hit.</p>`
      }
      <video id="cannon-video" class="cannon-video ${isMic ? "fullscreen" : "inline"}" muted playsinline></video>
      <div class="cannon-flash" id="cannon-flash"></div>
    </div>
  `;

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
