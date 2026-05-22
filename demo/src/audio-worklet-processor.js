// audio-worklet-processor.js
// AudioWorklet processor that downmixes to mono and posts batches
// of native-rate Float32 samples back to the main thread.
//
// We deliberately do NOT resample here. Chromaprint resamples
// internally — and properly band-limits when it does — so feeding
// it native-rate audio yields hashes that match the fpcalc-
// generated reference AFS files. The previous linear-interpolation
// resampler in this file produced aliased audio whose hashes were
// uncorrelated with fpcalc's output (matcher reported "many
// possible positions" the same way it does on unrelated audio).

class AFSCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Batch ~50 ms of audio per postMessage to keep IPC traffic
    // reasonable. `sampleRate` is a global provided to all
    // AudioWorkletProcessors and equals the AudioContext's rate.
    this.flushIntervalSamples = Math.floor(sampleRate * 0.05);
    this.outputBuffer = new Float32Array(this.flushIntervalSamples * 4);
    this.outputPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelCount = input.length;
    const blockLength = input[0].length;

    // Downmix to mono and append to the output batch in one pass.
    if (channelCount === 1) {
      const src = input[0];
      for (let i = 0; i < blockLength; i++) {
        if (this.outputPos === this.outputBuffer.length) this._flush();
        this.outputBuffer[this.outputPos++] = src[i];
      }
    } else {
      for (let i = 0; i < blockLength; i++) {
        let sum = 0;
        for (let c = 0; c < channelCount; c++) {
          sum += input[c][i];
        }
        if (this.outputPos === this.outputBuffer.length) this._flush();
        this.outputBuffer[this.outputPos++] = sum / channelCount;
      }
    }

    if (this.outputPos >= this.flushIntervalSamples) this._flush();
    return true;
  }

  _flush() {
    if (this.outputPos === 0) return;
    const out = this.outputBuffer.slice(0, this.outputPos);
    this.port.postMessage(out, [out.buffer]);
    this.outputBuffer = new Float32Array(this.flushIntervalSamples * 4);
    this.outputPos = 0;
  }
}

registerProcessor("afs-capture-processor", AFSCaptureProcessor);
