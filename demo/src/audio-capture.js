// audio-capture.js
// Unified audio capture for direct mode (from a <video>/<audio>
// element) and mic mode (from the microphone).
//
// The capture pipeline:
//   source -> AudioContext -> AudioWorklet (downmix to mono) -> ring buffer
//
// Audio is held in the ring buffer at the AudioContext's NATIVE
// sample rate (typically 48 000 Hz). We deliberately don't
// resample down to 11025 Hz here — chromaprint resamples
// internally with a proper FIR filter, which matches what fpcalc
// does and what the AFS files were fingerprinted with.
//
// The previous version resampled to 11025 Hz in the worklet using
// linear interpolation. That produced aliased audio whose hashes
// didn't match any specific position in the stored AFS — the
// matcher reported "many candidates, none confident" identically
// to the way it does on unrelated audio. Bypassing our resampler
// fixes that.

// Chromaprint's analysis rate. Exported because the spec and some
// docs still reference it; not used for buffer sizing anymore.
export const CHROMAPRINT_SAMPLE_RATE = 11025;

// Default ring-buffer length in seconds. The matcher needs at
// least 3 seconds of audio to attempt a cold-start match; ~8 s of
// headroom is reasonable.
export const DEFAULT_BUFFER_SECONDS = 8;

export class AudioCapture {
  constructor(options = {}) {
    this.bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    this.onSamples = options.onSamples || (() => {});
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.stream = null;
    // The ring buffer is allocated lazily in _ensureContext once
    // we know the AudioContext's sample rate. Until then,
    // `sampleRate` is 0 and `buffer` is null.
    this.sampleRate = 0;
    this.buffer = null;
    this.bufferWritePos = 0;
    this.bufferSamplesWritten = 0;
  }

  async startFromMediaElement(mediaElement) {
    this._ensureContext();
    this.source = this.audioContext.createMediaElementSource(mediaElement);
    // Route to destination so the user still hears it.
    this.source.connect(this.audioContext.destination);
    await this._attachProcessor();
  }

  async startFromMicrophone() {
    this._ensureContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    // Don't connect to destination; we don't want to play back the mic.
    await this._attachProcessor();
  }

  stop() {
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {}
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.bufferWritePos = 0;
    this.bufferSamplesWritten = 0;
  }

  // Get a snapshot of the most recent `seconds` of audio as a
  // Float32Array at the native sample rate. Returns null if not
  // enough audio is buffered. The caller should pass this together
  // with `this.sampleRate` to chromaprint so it can resample
  // properly.
  getRecentSamples(seconds) {
    if (!this.buffer) return null;
    const wanted = Math.floor(seconds * this.sampleRate);
    if (this.bufferSamplesWritten < wanted) return null;
    const result = new Float32Array(wanted);
    const bufLen = this.buffer.length;
    const end = this.bufferWritePos;
    const start = (end - wanted + bufLen) % bufLen;
    if (start + wanted <= bufLen) {
      result.set(this.buffer.subarray(start, start + wanted));
    } else {
      const firstPart = bufLen - start;
      result.set(this.buffer.subarray(start, bufLen), 0);
      result.set(this.buffer.subarray(0, wanted - firstPart), firstPart);
    }
    return result;
  }

  _ensureContext() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.audioContext.sampleRate;
    this.buffer = new Float32Array(this.bufferSeconds * this.sampleRate);
    this.bufferWritePos = 0;
    this.bufferSamplesWritten = 0;
  }

  async _attachProcessor() {
    // Prefer AudioWorklet (modern, off-main-thread); fall back to
    // ScriptProcessorNode (deprecated but universally supported).
    if (this.audioContext.audioWorklet) {
      try {
        await this.audioContext.audioWorklet.addModule(
          new URL("./audio-worklet-processor.js", import.meta.url),
        );
        const node = new AudioWorkletNode(
          this.audioContext,
          "afs-capture-processor",
        );
        node.port.onmessage = (e) => this._writeToBuffer(e.data);
        this.source.connect(node);
        node.connect(this.audioContext.destination);
        this.processor = node;
        return;
      } catch (e) {
        console.warn("AudioWorklet failed, falling back to ScriptProcessor:", e);
      }
    }
    // ScriptProcessor fallback. Buffer size 4096 is typical. We
    // pass samples through at native rate, mono — same contract as
    // the worklet path.
    const bufSize = 4096;
    const proc = this.audioContext.createScriptProcessor(bufSize, 1, 1);
    proc.onaudioprocess = (e) => {
      const channels = e.inputBuffer.numberOfChannels;
      const mono =
        channels === 1
          ? e.inputBuffer.getChannelData(0).slice()
          : downmixToMono(
              Array.from({ length: channels }, (_, c) =>
                e.inputBuffer.getChannelData(c),
              ),
            );
      this._writeToBuffer(mono);
    };
    this.source.connect(proc);
    proc.connect(this.audioContext.destination);
    this.processor = proc;
  }

  _writeToBuffer(samples) {
    if (!this.buffer) return; // not initialized
    const bufLen = this.buffer.length;
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.bufferWritePos] = samples[i];
      this.bufferWritePos = (this.bufferWritePos + 1) % bufLen;
    }
    this.bufferSamplesWritten += samples.length;
    this.onSamples(samples.length);
  }
}

// Kept for any external callers; no longer used internally.
// Simple linear-interpolation resampler. Acceptable only as a
// rough utility — for chromaprint pipelines feed native-rate
// audio to chromaprint instead.
export function resampleMono(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return input.slice();
  }
  const ratio = sourceRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const a = input[srcIdx] ?? 0;
    const b = input[srcIdx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

// Downmix multi-channel audio to mono by averaging channels.
export function downmixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  const n = channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) sum += channels[c][i];
    out[i] = sum / n;
  }
  return out;
}
