// audio-capture.js
// Unified audio capture for direct mode (from a <video>/<audio> element)
// and mic mode (from the microphone).
//
// The capture pipeline:
//   source -> AudioContext -> ScriptProcessor/AudioWorklet -> chunk callback
//
// Captured audio is converted to mono Float32 at chromaprint's expected
// sample rate (11025 Hz) before being passed to the chromaprint module.
//
// We use a circular buffer to hold the most recent N seconds of audio.
// The matcher consumes hashes derived from this buffer.

// Chromaprint expects 11025 Hz mono. The browser's AudioContext typically
// runs at 44100 or 48000 Hz, so we resample.
export const CHROMAPRINT_SAMPLE_RATE = 11025;

// Default buffer length in seconds. The matcher needs at least 3 seconds
// to attempt a cold-start match, so we keep ~8 seconds for safety.
export const DEFAULT_BUFFER_SECONDS = 8;

export class AudioCapture {
  constructor(options = {}) {
    this.bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
    this.onSamples = options.onSamples || (() => {});
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.stream = null;
    // Circular buffer for resampled mono Float32 samples at 11025 Hz.
    this.buffer = new Float32Array(
      this.bufferSeconds * CHROMAPRINT_SAMPLE_RATE,
    );
    this.bufferWritePos = 0;
    this.bufferSamplesWritten = 0;
  }

  // Start capturing from a MediaStream (from getUserMedia, for mic mode)
  // or from an HTMLMediaElement (for direct mode).
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
  // Float32Array at 11025 Hz. Returns null if not enough audio buffered.
  getRecentSamples(seconds) {
    const wanted = Math.floor(seconds * CHROMAPRINT_SAMPLE_RATE);
    if (this.bufferSamplesWritten < wanted) return null;
    const result = new Float32Array(wanted);
    const bufLen = this.buffer.length;
    // The most recent sample is at (bufferWritePos - 1) mod bufLen.
    // We want the last `wanted` samples ending there.
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
          {
            processorOptions: {
              targetSampleRate: CHROMAPRINT_SAMPLE_RATE,
              sourceSampleRate: this.audioContext.sampleRate,
            },
          },
        );
        node.port.onmessage = (e) => this._onWorkletSamples(e.data);
        this.source.connect(node);
        node.connect(this.audioContext.destination);
        this.processor = node;
        return;
      } catch (e) {
        console.warn("AudioWorklet failed, falling back to ScriptProcessor:", e);
      }
    }
    // ScriptProcessor fallback. Buffer size 4096 is typical.
    const bufSize = 4096;
    const proc = this.audioContext.createScriptProcessor(bufSize, 1, 1);
    proc.onaudioprocess = (e) => this._onScriptProcessor(e);
    this.source.connect(proc);
    proc.connect(this.audioContext.destination);
    this.processor = proc;
  }

  _onScriptProcessor(event) {
    const input = event.inputBuffer.getChannelData(0);
    const sourceRate = this.audioContext.sampleRate;
    const resampled = resampleMono(input, sourceRate, CHROMAPRINT_SAMPLE_RATE);
    this._writeToBuffer(resampled);
  }

  _onWorkletSamples(resampled) {
    this._writeToBuffer(resampled);
  }

  _writeToBuffer(samples) {
    const bufLen = this.buffer.length;
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.bufferWritePos] = samples[i];
      this.bufferWritePos = (this.bufferWritePos + 1) % bufLen;
    }
    this.bufferSamplesWritten += samples.length;
    this.onSamples(samples.length);
  }
}

// Simple linear-interpolation resampler. Acceptable for chromaprint's
// purposes since it tolerates minor frequency distortion; a higher-quality
// resampler would marginally improve hash stability but isn't necessary.
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
