// audio-worklet-processor.js
// AudioWorklet processor that downmixes to mono, resamples to the target
// sample rate (typically chromaprint's 11025 Hz), and posts batches of
// samples back to the main thread.
//
// Loaded by audio-capture.js via audioContext.audioWorklet.addModule().

class AFSCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceSampleRate || sampleRate;
    this.targetRate = opts.targetSampleRate || 11025;
    this.ratio = this.sourceRate / this.targetRate;
    // Fractional position into the source stream, used to resample
    // continuously across process() calls.
    this.srcPos = 0;
    // Last source sample of the previous block, for interpolation
    // across block boundaries.
    this.lastSample = 0;
    // Buffer batched output samples and flush every ~50ms to keep
    // postMessage frequency reasonable.
    this.flushIntervalSamples = Math.floor(this.targetRate * 0.05);
    this.outputBuffer = new Float32Array(this.flushIntervalSamples * 4);
    this.outputPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Downmix to mono in-place (allocate once).
    const channelCount = input.length;
    const blockLength = input[0].length;
    const mono = new Float32Array(blockLength);
    if (channelCount === 1) {
      mono.set(input[0]);
    } else {
      for (let i = 0; i < blockLength; i++) {
        let sum = 0;
        for (let c = 0; c < channelCount; c++) {
          sum += input[c][i];
        }
        mono[i] = sum / channelCount;
      }
    }

    // Resample to target rate using linear interpolation across the
    // boundary between blocks.
    while (this.srcPos < blockLength) {
      const idx = Math.floor(this.srcPos);
      const frac = this.srcPos - idx;
      const a = idx === 0 ? this.lastSample : mono[idx - 1];
      const b = mono[idx] ?? a;
      const sample = a + (b - a) * frac;
      this.outputBuffer[this.outputPos++] = sample;
      this.srcPos += this.ratio;
      if (this.outputPos >= this.outputBuffer.length) {
        this._flush();
      }
    }
    this.srcPos -= blockLength;
    this.lastSample = mono[blockLength - 1];

    // Flush every ~50ms.
    if (this.outputPos >= this.flushIntervalSamples) {
      this._flush();
    }

    return true;
  }

  _flush() {
    if (this.outputPos === 0) return;
    const out = this.outputBuffer.slice(0, this.outputPos);
    this.port.postMessage(out, [out.buffer]);
    // Allocate a fresh buffer (the previous one was transferred).
    this.outputBuffer = new Float32Array(this.flushIntervalSamples * 4);
    this.outputPos = 0;
  }
}

registerProcessor("afs-capture-processor", AFSCaptureProcessor);
