// generate.js
// Browser-side AFS generator. Takes a media file the user picks
// (audio or video), decodes it via the browser's AudioContext,
// downmixes to mono at the source rate, fingerprints with the same
// WASM chromaprint the demo's matcher uses, and serializes to AFS
// v0.1. Result: a download link to a .afs file.
//
// No upload, no playback, no preview. Everything happens in this
// tab. The user transfers the .afs (and their existing SRT) to a
// second device by whatever means — AirDrop, email, etc. — then
// loads them via listen.html's file-picker.
//
// Sample rate handling: we pass NATIVE-rate mono to fingerprintAudio
// rather than resampling to 11025 Hz in JS. Chromaprint resamples
// internally with a higher-quality resampler than a cheap linear
// pass would produce; running a JS resampler first introduced hash
// drift that broke matching against fpcalc-generated AFS. See
// demo/src/chromaprint.js for the historical note.

import { writeAFS } from "./afs-writer.js";
import {
  fingerprintAudio,
  loadChromaprint,
} from "./chromaprint.js";
import { downmixToMono } from "./audio-utils.js";
import { qrCode } from "./vendor/qr-code.js";

const els = {
  drop: document.getElementById("generate-drop"),
  input: document.getElementById("generate-input"),
  progress: document.getElementById("generate-progress"),
  progressLabel: document.getElementById("generate-progress-label"),
  progressFill: document.getElementById("generate-progress-fill"),
  result: document.getElementById("generate-result"),
  metaName: document.getElementById("generate-meta-name"),
  metaDuration: document.getElementById("generate-meta-duration"),
  metaHashes: document.getElementById("generate-meta-hashes"),
  metaSha256: document.getElementById("generate-meta-sha256"),
  download: document.getElementById("generate-download"),
  error: document.getElementById("generate-error"),
  errorText: document.getElementById("generate-error-text"),
  qrCode: document.getElementById("generate-qr-code"),
  qrLink: document.getElementById("generate-qr-link"),
};

// Wire the QR + fallback link to the listen page on the same origin.
// listen.html with no params shows the file-picker, which is what we
// want the phone-side flow to land on.
(function renderListenQr() {
  if (!els.qrCode) return;
  const listenUrl = new URL("listen.html", window.location.href).toString();
  els.qrCode.innerHTML = qrCode(listenUrl, { size: 180 });
  if (els.qrLink) els.qrLink.href = listenUrl;
})();

let lastObjectUrl = null;

function showProgress(label, ratio) {
  els.progress.hidden = false;
  els.error.hidden = true;
  els.result.hidden = true;
  els.progressLabel.textContent = label;
  els.progressFill.style.width = `${Math.round(ratio * 100)}%`;
}

function showResult() {
  els.progress.hidden = true;
  els.error.hidden = true;
  els.result.hidden = false;
}

function showError(message) {
  els.progress.hidden = true;
  els.result.hidden = true;
  els.error.hidden = false;
  els.errorText.textContent = message;
}

function fmtDuration(seconds) {
  if (!isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

// crypto.subtle requires a secure context (HTTPS or localhost).
// On a LAN IP over plain HTTP it's undefined; we treat SHA-256 as
// best-effort and return null in that case so generation still
// produces a valid AFS (the sha256 metadata field is optional).
async function sha256Hex(arrayBuffer) {
  if (!globalThis.crypto?.subtle?.digest) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  } catch {
    return null;
  }
}

async function processFile(file) {
  if (!file) return;

  // Keep the drop zone disabled while we work. Re-enable when the
  // result is shown — the user can pick another file to replace.
  els.drop.classList.add("busy");

  let arrayBuffer;
  try {
    showProgress("Reading file…", 0.05);
    arrayBuffer = await file.arrayBuffer();
  } catch (e) {
    showError(`Couldn't read the file: ${e.message}`);
    els.drop.classList.remove("busy");
    return;
  }

  // Hash and decode are independent. Run them in parallel but keep
  // their error reporting separate so we don't blame audio decode
  // for a crypto.subtle issue, or vice-versa.
  const audioContext = new (window.AudioContext ||
    window.webkitAudioContext)();

  showProgress("Decoding audio…", 0.2);

  // decodeAudioData consumes its ArrayBuffer in some browsers, so
  // we slice() a copy for the hash. arrayBuffer.slice(0) is fast.
  const hashBuf = arrayBuffer.slice(0);

  const [decodeResult, hashResult] = await Promise.allSettled([
    audioContext.decodeAudioData(arrayBuffer),
    sha256Hex(hashBuf),
  ]);

  if (decodeResult.status === "rejected") {
    audioContext.close().catch(() => {});
    const msg = decodeResult.reason?.message || String(decodeResult.reason);
    showError(
      `Couldn't decode audio: ${msg}. Make sure the file format is supported by your browser.`,
    );
    els.drop.classList.remove("busy");
    return;
  }
  const audioBuffer = decodeResult.value;
  // sha256 is best-effort; missing is fine (it's optional in AFS).
  // crypto.subtle is undefined on non-secure contexts (LAN IP over
  // plain HTTP, for example) — we just omit the field there.
  const sha256 = hashResult.status === "fulfilled" ? hashResult.value : null;

  let hashes;
  try {
    showProgress("Loading chromaprint…", 0.4);
    await loadChromaprint();

    showProgress("Fingerprinting…", 0.6);
    const mono = downmixToMono(audioBuffer);
    // Native rate; chromaprint resamples internally.
    hashes = fingerprintAudio(mono, audioBuffer.sampleRate);
  } catch (e) {
    audioContext.close().catch(() => {});
    showError(`Fingerprinting failed: ${e.message}`);
    els.drop.classList.remove("busy");
    return;
  }

  showProgress("Writing AFS…", 0.9);

  const durationMs = Math.round(
    (audioBuffer.length / audioBuffer.sampleRate) * 1000,
  );
  const stem = stripExtension(file.name) || "output";

  const afsText = writeAFS(hashes, {
    audio: {
      sample_rate_hz: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    },
    source: {
      title: stem,
      duration_ms: durationMs,
      sha256,
    },
  });

  audioContext.close().catch(() => {});

  // Build the download link.
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  const blob = new Blob([afsText], { type: "text/plain" });
  lastObjectUrl = URL.createObjectURL(blob);
  els.download.href = lastObjectUrl;
  els.download.download = `${stem}.afs`;

  els.metaName.textContent = file.name;
  els.metaDuration.textContent = fmtDuration(durationMs / 1000);
  els.metaHashes.textContent = hashes.length.toLocaleString();
  els.metaSha256.textContent =
    sha256 ?? "(omitted — crypto.subtle unavailable in this context)";

  showResult();
  els.drop.classList.remove("busy");
}

// ----------------------------------------------------------------
// Wire up drop zone + file input
// ----------------------------------------------------------------

els.drop.addEventListener("click", () => {
  if (!els.drop.classList.contains("busy")) els.input.click();
});

els.drop.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && !els.drop.classList.contains("busy")) {
    e.preventDefault();
    els.input.click();
  }
});

els.input.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) processFile(f);
  // Reset so the same filename can be re-picked.
  els.input.value = "";
});

els.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("dragover");
});

els.drop.addEventListener("dragleave", () => {
  els.drop.classList.remove("dragover");
});

els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("dragover");
  if (els.drop.classList.contains("busy")) return;
  const f = e.dataTransfer?.files?.[0];
  if (f) processFile(f);
});
