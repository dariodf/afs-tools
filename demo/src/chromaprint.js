// chromaprint.js
// Thin wrapper around @unimusic/chromaprint — the AcoustID chromaprint
// library compiled to WebAssembly via Emscripten. We call the WASM C
// API directly (not the package's high-level wrapper, which has a bug
// in its raw-output path: it reads the data pointer before the
// chromaprint call populates it).
//
// Chromaprint is designed to tolerate noise. Shazam matches songs from
// mic capture at parties; our task is the simpler version of the same
// problem (single known source, not a database of millions).
// Differences between chromaprint implementations — fpcalc in the CLI,
// this WASM build in the browser — produce hashes that are slightly
// different but well within the algorithm's design margins. The
// matcher works on Hamming distances and finds the right position
// regardless.
//
// The WASM build's Emscripten glue asserts ENVIRONMENT_IS_WEB at
// module-evaluation time and throws under Node. We therefore load it
// with a dynamic `import()` inside loadChromaprint(), so Node-side
// tests (which only use mockFingerprint) never trigger the load.

let cpModule = null;
let loadPromise = null;

// AFS v0.1 uses chromaprint's default algorithm (Test2 = 1).
export const CHROMAPRINT_ALGORITHM = 1;

// Chromaprint's hop interval, derived from the canonical parameters:
//   sample rate 11025 Hz, FFT window 4096, overlap 2/3
//   step = 4096 - 4096 * 2/3 = 4096 / 3 ≈ 1365.333 samples
//   step_ms = 4096_000 / 33075 ≈ 123.83 ms
// The exact value is irrational, so per-step addition accumulates
// rounding error. SPEC.md §A.1 recommends computing the i-th cue
// directly from the sample index:
//   cue_ms(i) = round(i * 4096000 / 33075)
// This bounds per-cue error to < 0.5 ms regardless of file length.
export const CHROMAPRINT_STEP_NUMERATOR = 4096000; // step_samples * 1000
export const CHROMAPRINT_STEP_DENOMINATOR = 33075; // sample_rate * 3
export const CHROMAPRINT_INTERVAL_MS_APPROX =
  CHROMAPRINT_STEP_NUMERATOR / CHROMAPRINT_STEP_DENOMINATOR;

// Compute the AFS time cue for the i-th chromaprint hash, in
// milliseconds, with cumulative-correct rounding. Use this anywhere
// you need to map a hash index to a time cue.
export function chromaprintCueMs(i) {
  return Math.round((i * CHROMAPRINT_STEP_NUMERATOR) / CHROMAPRINT_STEP_DENOMINATOR);
}

// Load the chromaprint WASM module. Lazy-loaded on first use so the
// rest of the demo can render before WASM is ready. Idempotent and
// concurrent-safe.
export async function loadChromaprint() {
  if (cpModule) return cpModule;
  if (!loadPromise) {
    loadPromise = (async () => {
      // Dynamic import so Node-side test entry points that never
      // reach loadChromaprint() don't blow up at module evaluation
      // (the Emscripten glue asserts ENVIRONMENT_IS_WEB).
      const mod = await import("@unimusic/chromaprint/dist/chromaprint.js");
      cpModule = await mod.default();
      return cpModule;
    })();
  }
  return loadPromise;
}

// fingerprintAudio: takes a Float32Array of mono samples at 11025 Hz
// and returns a Uint32Array of chromaprint raw hashes. The
// audio-capture module already downmixes and resamples to 11025 Hz
// before calling this. Requires loadChromaprint() to have resolved.
export function fingerprintAudio(samples) {
  if (!cpModule) {
    throw new Error(
      "chromaprint not loaded — call await loadChromaprint() first",
    );
  }

  // Convert Float32 [-1, 1] to Int16 [-32768, 32767].
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Allocate WASM heap for the input PCM and copy it in.
  const inputPtr = cpModule._malloc(int16.length * 2);
  cpModule.HEAP16.set(int16, inputPtr / 2);

  const ctx = cpModule._chromaprint_new(CHROMAPRINT_ALGORITHM);
  if (!ctx) {
    cpModule._free(inputPtr);
    throw new Error("chromaprint_new returned null");
  }

  try {
    if (!cpModule._chromaprint_start(ctx, 11025, 1)) {
      throw new Error("chromaprint_start failed");
    }
    if (!cpModule._chromaprint_feed(ctx, inputPtr, int16.length)) {
      throw new Error("chromaprint_feed failed");
    }
    if (!cpModule._chromaprint_finish(ctx)) {
      throw new Error("chromaprint_finish failed");
    }

    // Read the raw fingerprint. The C API writes:
    //   - the number of uint32 hashes into *sizePtr
    //   - a pointer to a uint32 buffer into *dataPtrPtr
    // Both must be read AFTER the call populates them. The
    // @unimusic high-level wrapper's bug is reading dataPtrPtr's
    // value before the call returns.
    const sizePtr = cpModule._malloc(4);
    const dataPtrPtr = cpModule._malloc(4);
    try {
      if (!cpModule._chromaprint_get_raw_fingerprint(ctx, dataPtrPtr, sizePtr)) {
        throw new Error("chromaprint_get_raw_fingerprint failed");
      }
      const size = cpModule.HEAP32[sizePtr >> 2];
      const dataPtr = cpModule.HEAP32[dataPtrPtr >> 2];
      if (size <= 0 || dataPtr === 0) {
        return new Uint32Array(0);
      }
      // Copy out the uint32 array (unsigned read so the high-bit
      // values come through as their uint32 equivalents instead of
      // negative int32s).
      const out = new Uint32Array(size);
      const heapU32 = new Uint32Array(cpModule.HEAP32.buffer);
      for (let i = 0; i < size; i++) {
        out[i] = heapU32[(dataPtr >> 2) + i];
      }
      // chromaprint allocated the raw buffer via its internal
      // allocator (libc malloc, which Emscripten maps to _malloc/
      // _free); release it.
      cpModule._free(dataPtr);
      return out;
    } finally {
      cpModule._free(sizePtr);
      cpModule._free(dataPtrPtr);
    }
  } finally {
    cpModule._chromaprint_free(ctx);
    cpModule._free(inputPtr);
  }
}

// mockFingerprint: deterministic synthetic fingerprinter for tests
// and pre-WASM development. Hashes samples in blocks of 1365
// (chromaprint's frame step at 11025 Hz) via a rolling XOR. Not a
// real fingerprint, but deterministic enough that the matcher can
// find a segment of an audio buffer in the AFS made from the whole
// buffer.
//
// IMPORTANT: this mock does NOT have chromaprint's noise tolerance.
// Captured audio must align exactly to block boundaries (multiples
// of 1365 samples from the source start) for the matcher to find
// the position. Real chromaprint produces overlapping windows with
// FFT analysis that tolerates frame misalignment. The mock is only
// useful for testing the matcher's data flow, not for simulating
// real-world capture conditions. Swap in the WASM fingerprinter
// for any test that involves arbitrary slicing.
export function mockFingerprint(samples) {
  const stepSamples = 1365;
  const numHashes = Math.floor(samples.length / stepSamples);
  const out = new Uint32Array(numHashes);
  for (let h = 0; h < numHashes; h++) {
    let acc = 0;
    const offset = h * stepSamples;
    for (let i = 0; i < stepSamples; i++) {
      const s = samples[offset + i];
      const bits = (s * 0x7fffffff) | 0;
      acc = (acc ^ (bits + i)) >>> 0;
    }
    out[h] = acc;
  }
  return out;
}
