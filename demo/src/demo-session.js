// demo-session.js
// Encapsulates the common pattern used by every demo:
//   - Load an AFS file
//   - Start audio capture (from a media element in direct mode, or
//     from the microphone in mic mode)
//   - Run a match loop that fingerprints recent audio and reports
//     positions
//   - Dispatch position updates to consumer callbacks
//
// The demo-specific code only needs to:
//   - Tell the session what AFS URL to load
//   - Tell the session what audio source (media element or mic) to use
//   - Provide an onPosition callback
//   - Optionally provide an onStatus callback for the UI

import { parseAFS, chromaprintArrays } from "./afs-parser.js";
import { AFSMatcher, hamming32 } from "./afs-matcher.js";
import { AudioCapture } from "./audio-capture.js";
import { loadChromaprint, fingerprintAudio } from "./chromaprint.js";

const DEFAULT_OPTIONS = {
  // Match every N ms. 250 ms is the default — slower than
  // chromaprint's 124 ms hop, so we sometimes lag by ~one extra hop
  // in steady state. That's fine for subtitles (text alignment is
  // forgiving below ~250 ms misalignment). The schedule-ahead
  // architecture for haptics removes most of this lag anyway by
  // projecting the position forward and firing on wall-clock time
  // rather than on each tick. Tunable for users who want lower
  // latency at higher CPU cost.
  matchIntervalMs: 250,
  // How much of the captured buffer to fingerprint each tick. The
  // matcher needs ~3s of audio for a confident cold-start match.
  matchWindowSeconds: 8,
  // Matcher tuning.
  confidenceThreshold: 60,
  coldStartMinHashes: 24,
  localWindowRadius: 40,
};

export class DemoSession {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.afs = null;
    this.capture = null;
    this.matcher = null;
    this.matchTimer = null;
    this.onPosition = options.onPosition || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onDiagnostic = options.onDiagnostic || null;
    this.running = false;
  }

  // Load and parse an AFS file from a URL.
  async loadAFS(afsUrl) {
    const text = await fetch(afsUrl).then((r) => {
      if (!r.ok) throw new Error(`failed to load ${afsUrl}: ${r.status}`);
      return r.text();
    });
    const parsed = parseAFS(text);
    const { hashes, times } = chromaprintArrays(parsed);
    this.afs = { parsed, hashes, times };
    return this.afs;
  }

  // Start a session attached to an HTMLMediaElement (direct mode).
  async startDirect(mediaElement) {
    this._ensureLoaded();
    await loadChromaprint();
    this.capture = new AudioCapture();
    await this.capture.startFromMediaElement(mediaElement);
    this._startMatchLoop();
  }

  // Start a session attached to the microphone (mic mode).
  async startMic() {
    this._ensureLoaded();
    await loadChromaprint();
    this.capture = new AudioCapture();
    await this.capture.startFromMicrophone();
    this._startMatchLoop();
  }

  // Stop the session and release the audio context / mic.
  stop() {
    this.running = false;
    if (this.matchTimer) {
      clearInterval(this.matchTimer);
      this.matchTimer = null;
    }
    if (this.capture) {
      this.capture.stop();
      this.capture = null;
    }
    this.matcher = null;
  }

  _ensureLoaded() {
    if (!this.afs) {
      throw new Error("call await session.loadAFS(url) first");
    }
  }

  _startMatchLoop() {
    this.matcher = new AFSMatcher(this.afs.hashes, this.afs.times, {
      confidenceThreshold: this.options.confidenceThreshold,
      coldStartMinHashes: this.options.coldStartMinHashes,
      localWindowRadius: this.options.localWindowRadius,
    });
    this.running = true;
    this.matchTimer = setInterval(() => {
      this._tick();
    }, this.options.matchIntervalMs);
  }

  _tick() {
    if (!this.running) return;
    const samples = this.capture.getRecentSamples(
      this.options.matchWindowSeconds,
    );
    if (!samples) {
      const need = 3 * 11025;
      const have = Math.min(this.capture.bufferSamplesWritten, need);
      this.onStatus({
        kind: "buffering",
        progressPct: Math.round((have / need) * 100),
      });
      if (this.onDiagnostic) {
        this.onDiagnostic({
          bufferedSamples: have,
          bufferNeeded: need,
        });
      }
      return;
    }

    // Diagnostic: peak amplitude across captured samples. Helps
    // spot silent-mic problems.
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }

    let hashes;
    try {
      hashes = fingerprintAudio(samples);
    } catch (e) {
      this.onStatus({ kind: "error", message: String(e) });
      return;
    }
    const result = this.matcher.step(hashes, performance.now());

    // Diagnostic: compute hamming-distance histogram between the
    // captured hashes and the AFS hashes at the best-match position.
    let histogram = null;
    if (this.onDiagnostic && result) {
      histogram = new Array(33).fill(0);
      const startIdx = result.storedIndex;
      for (let i = 0; i < hashes.length; i++) {
        const storedIdx = startIdx + i;
        if (storedIdx >= this.afs.hashes.length) break;
        const dist = hamming32(hashes[i], this.afs.hashes[storedIdx]);
        histogram[dist]++;
      }
    }

    if (this.onDiagnostic) {
      this.onDiagnostic({
        peakAmplitude: peak,
        bufferedSamples: samples.length,
        bufferNeeded: 3 * 11025,
        capturedHashes: hashes,
        position: result ? result.time_ms : null,
        confidence: result ? result.confidence : null,
        matcherMode: result ? result.mode : "searching",
        histogram,
      });
    }

    if (result) {
      if (result.ambiguous) {
        // Multiple candidate positions match nearly equally. Don't
        // report a position yet; wait for disambiguation. Show this
        // to the UI so the user gets useful feedback.
        this.onStatus({
          kind: "ambiguous",
          candidates: result.candidates,
          confidence: result.confidence,
        });
      } else {
        this.onPosition(result.time_ms, result.confidence);
        this.onStatus({
          kind: "matched",
          timeMs: result.time_ms,
          confidence: result.confidence,
          mode: result.mode,
        });
      }
    } else {
      this.onStatus({ kind: "searching" });
    }
  }
}
