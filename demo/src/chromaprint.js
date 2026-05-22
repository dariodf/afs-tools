// chromaprint.js
// Thin wrapper around the chromaprint-wasm npm package.
//
// Chromaprint is designed to tolerate noise. Shazam matches songs
// from mic capture at parties; our task is the simpler version of
// the same problem (single known source, not a database of millions).
// Differences between chromaprint implementations — fpcalc in the
// CLI, chromaprint-wasm in the browser — produce hashes that are
// slightly different but well within the algorithm's design margins.
// The matcher works on Hamming distances and finds the right
// position regardless.
//
// Smoke test before shipping: generate an AFS with the CLI, play
// the source, point a phone at the speakers, confirm the matcher
// locks on. If that works, the ecosystem is coherent.

let wasmReady = null;
let cpModule = null;

// AFS v0.1 uses chromaprint's default algorithm and parameters.
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
// rest of the demo can render before WASM is ready.
export async function loadChromaprint() {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    // Integration sketch for chromaprint-wasm:
    //   const cp = await import("chromaprint-wasm");
    //   await cp.default(); // initialize WASM
    //   cpModule = cp;
    throw new Error(
      "chromaprint WASM not yet integrated — see TODO in chromaprint.js",
    );
  })();
  return wasmReady;
}

// fingerprintAudio: takes a Float32Array of mono samples at 11025 Hz
// and returns a Uint32Array of chromaprint hashes. The audio-capture
// module already downmixes and resamples to 11025 Hz before calling.
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
  // TODO: hand off to the loaded chromaprint WASM module here and
  // return its Uint32Array of hashes.
  throw new Error("fingerprintAudio: WASM call not yet wired up");
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
