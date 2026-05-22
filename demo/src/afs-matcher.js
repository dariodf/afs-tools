// afs-matcher.js
// Finds the position in a stored chromaprint hash sequence that best
// matches a sequence of recently captured hashes.
//
// The algorithm:
//   - Hamming distance between two uint32 hashes = popcount(a XOR b),
//     range 0 (identical) to 32 (opposite).
//   - For a window of N captured hashes, the score at offset k in the
//     stored sequence is sum_{i=0..N-1} hamming(captured[i], stored[k+i]).
//   - Lower score = better match.
//   - Average per-hash distance is score / N. Values under ~10 are a
//     confident match for clean audio; under ~14 for noisy environments.
//
// Two matching modes:
//   - coldStart: scan all positions, find global minimum.
//   - steadyState: check expected next position first; if it matches well,
//     return immediately. Otherwise, fall back to coldStart over a window.

import { CHROMAPRINT_INTERVAL_MS_APPROX } from "./chromaprint.js";

// Hamming distance between two uint32 values, via popcount.
// V8 and modern JS engines optimize this well; for hot loops we
// inline this rather than calling it.
export function hamming32(a, b) {
  let x = (a ^ b) >>> 0;
  // Hacker's Delight-style bit count
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

// Total Hamming distance between two equal-length Uint32Arrays.
// Used by the sliding-window inner loop.
function sumHamming(stored, storedOffset, captured, length) {
  let total = 0;
  for (let i = 0; i < length; i++) {
    let x = (stored[storedOffset + i] ^ captured[i]) >>> 0;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    total += (x * 0x01010101) >>> 24;
  }
  return total;
}

// coldStartMatch: search the entire stored array for the best alignment
// of captured. Returns { bestIndex, bestScore, perHash, confidence }.
//
// confidence is a 0-100 number, computed as 100 * (1 - perHash / 32).
// A perHash of 0 means a perfect match (confidence 100); a perHash of
// 16 means random (confidence 50).
export function coldStartMatch(stored, captured) {
  const n = stored.length;
  const m = captured.length;
  if (m === 0 || n < m) {
    return null;
  }
  let bestScore = Infinity;
  let bestIndex = -1;
  const lastOffset = n - m;
  for (let k = 0; k <= lastOffset; k++) {
    const score = sumHamming(stored, k, captured, m);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = k;
    }
  }
  const perHash = bestScore / m;
  const confidence = 100 * (1 - perHash / 32);
  return { bestIndex, bestScore, perHash, confidence };
}

// coldStartCandidates: find all positions whose score is within
// `ambiguityMargin` bits-per-hash of the best position. Returns the
// list sorted by score ascending (best first). Useful for detecting
// repeated motifs where multiple positions match equally well.
//
// `ambiguityMargin` is in average bits per hash. E.g., a margin of 2
// means "include any position whose per-hash score is within 2 bits
// of the best position's per-hash score." For a window of 24 hashes,
// that's a total score margin of 48 bits.
//
// Returns an array of { storedIndex, score, perHash, confidence }
// objects. Empty if no position meets the absolute confidence
// threshold. Single-element array if the best position is clearly
// better than all others. Multi-element if multiple positions match
// near-equally well — caller should disambiguate over time.
export function coldStartCandidates(stored, captured, options = {}) {
  const ambiguityMargin = options.ambiguityMargin ?? 2;
  const minConfidence = options.minConfidence ?? 0;

  const n = stored.length;
  const m = captured.length;
  if (m === 0 || n < m) {
    return [];
  }

  // Two-pass: first find the global minimum score, then collect all
  // positions within the margin.
  const lastOffset = n - m;
  let bestScore = Infinity;
  for (let k = 0; k <= lastOffset; k++) {
    const score = sumHamming(stored, k, captured, m);
    if (score < bestScore) bestScore = score;
  }
  const bestPerHash = bestScore / m;
  if (bestPerHash >= 32) return [];

  const bestConfidence = 100 * (1 - bestPerHash / 32);
  if (bestConfidence < minConfidence) return [];

  // Second pass: collect all positions within the margin.
  const scoreMargin = ambiguityMargin * m;
  const cutoff = bestScore + scoreMargin;
  const candidates = [];
  for (let k = 0; k <= lastOffset; k++) {
    const score = sumHamming(stored, k, captured, m);
    if (score <= cutoff) {
      const perHash = score / m;
      candidates.push({
        storedIndex: k,
        score,
        perHash,
        confidence: 100 * (1 - perHash / 32),
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}

// localMatch: search a small window around an expected index. Returns
// the same shape as coldStartMatch. windowRadius is in hash slots.
export function localMatch(stored, captured, expectedIndex, windowRadius) {
  const n = stored.length;
  const m = captured.length;
  if (m === 0 || n < m) {
    return null;
  }
  const start = Math.max(0, expectedIndex - windowRadius);
  const end = Math.min(n - m, expectedIndex + windowRadius);
  let bestScore = Infinity;
  let bestIndex = -1;
  for (let k = start; k <= end; k++) {
    const score = sumHamming(stored, k, captured, m);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = k;
    }
  }
  if (bestIndex === -1) return null;
  const perHash = bestScore / m;
  const confidence = 100 * (1 - perHash / 32);
  return { bestIndex, bestScore, perHash, confidence };
}

// AFSMatcher: stateful wrapper that uses local matching after a cold start.
//
// Configuration:
//   - confidenceThreshold: minimum confidence to accept a match (0-100).
//     Default 60 (per-hash distance < ~12.8) which is reasonable for
//     mic capture with some noise.
//   - coldStartMinHashes: how many captured hashes are required before
//     attempting a cold-start match. Default 24 (~3 seconds of audio
//     at chromaprint defaults).
//   - localWindowRadius: how far around the expected index to look in
//     steady state. Default 40 (~5 seconds either side).
//   - expectedDriftPerSecond: how fast we expect the position to advance
//     per second of wall clock. Default 1.0 (real-time playback).
//   - ambiguityMargin: how many bits per hash counts as "tied" with
//     the best match. Default 2. If multiple positions are within
//     this margin, the matcher tracks them as pending candidates and
//     waits for more audio to disambiguate, rather than picking one.
export class AFSMatcher {
  constructor(stored, storedTimes, options = {}) {
    if (!(stored instanceof Uint32Array)) {
      throw new Error("stored must be a Uint32Array");
    }
    if (!(storedTimes instanceof Float64Array)) {
      throw new Error("storedTimes must be a Float64Array");
    }
    if (stored.length !== storedTimes.length) {
      throw new Error("stored and storedTimes must have the same length");
    }
    this.stored = stored;
    this.storedTimes = storedTimes; // in milliseconds
    this.confidenceThreshold = options.confidenceThreshold ?? 60;
    this.coldStartMinHashes = options.coldStartMinHashes ?? 24;
    this.localWindowRadius = options.localWindowRadius ?? 40;
    this.expectedDriftPerSecond = options.expectedDriftPerSecond ?? 1.0;
    this.ambiguityMargin = options.ambiguityMargin ?? 2;

    // State.
    this.lastMatch = null; // { storedIndex, time_ms, wallTimeMs, confidence }
    // Pending candidates from a cold-start that found multiple
    // equally-good positions. Each entry: { storedIndex, wallTimeMs }.
    // wallTimeMs is the wall-clock time of the capture that suggested
    // this candidate, so we can compute "expected position now" from
    // it and re-verify on later steps.
    this.pendingCandidates = [];
  }

  // Reset state, e.g., when the user seeks or switches content.
  reset() {
    this.lastMatch = null;
    this.pendingCandidates = [];
  }

  // Step the matcher with a new captured-hash window. The captured
  // sequence should be the most recent N hashes from the live audio.
  // wallTimeMs is performance.now() at the moment the latest hash was
  // captured.
  //
  // Returns null if no confident match, otherwise:
  //   { time_ms, storedIndex, confidence, mode: "cold" | "local" | "candidate",
  //     ambiguous?: boolean, candidates?: number[] }
  //
  // When `ambiguous` is true, the matcher found multiple positions
  // matching nearly equally and is waiting for more audio to
  // disambiguate. In that case `candidates` lists the stored indices
  // still under consideration. The caller can choose to display
  // "syncing..." or hold off on any position-dependent action.
  step(captured, wallTimeMs) {
    const m = captured.length;

    // Steady-state path: have a previous match, try local search first.
    if (this.lastMatch) {
      const elapsedMs = wallTimeMs - this.lastMatch.wallTimeMs;
      const captureWindowDurationMs = (m - 1) * CHROMAPRINT_INTERVAL_MS_APPROX;
      const expectedPositionMs =
        this.lastMatch.time_ms +
        elapsedMs * this.expectedDriftPerSecond -
        captureWindowDurationMs;
      const expectedIndex = this._timeMsToIndex(expectedPositionMs);

      const result = localMatch(
        this.stored,
        captured,
        expectedIndex,
        this.localWindowRadius,
      );
      if (result && result.confidence >= this.confidenceThreshold) {
        this.lastMatch = {
          storedIndex: result.bestIndex,
          time_ms: this.storedTimes[result.bestIndex],
          wallTimeMs,
          confidence: result.confidence,
        };
        this.pendingCandidates = [];
        return {
          time_ms: this.lastMatch.time_ms,
          storedIndex: result.bestIndex,
          confidence: result.confidence,
          mode: "local",
        };
      }
      // Local search failed; fall through to cold start.
    }

    // Disambiguation path: if we have pending candidates from a
    // previous tick, re-check each of them at their expected new
    // position. The capture window is longer now, so the surrounding
    // context that was missing before may now be present.
    if (this.pendingCandidates.length > 0 && m >= this.coldStartMinHashes) {
      const survivors = this._evaluateCandidates(captured, wallTimeMs);
      if (survivors.length === 1) {
        // Disambiguated. Lock on.
        const winner = survivors[0];
        this.lastMatch = {
          storedIndex: winner.storedIndex,
          time_ms: this.storedTimes[winner.storedIndex],
          wallTimeMs,
          confidence: winner.confidence,
        };
        this.pendingCandidates = [];
        return {
          time_ms: this.lastMatch.time_ms,
          storedIndex: winner.storedIndex,
          confidence: winner.confidence,
          mode: "candidate",
        };
      }
      if (survivors.length > 1) {
        // Still ambiguous. Update pending list and report.
        this.pendingCandidates = survivors.map((s) => ({
          storedIndex: s.storedIndex,
          wallTimeMs,
        }));
        return {
          time_ms: this.storedTimes[survivors[0].storedIndex],
          storedIndex: survivors[0].storedIndex,
          confidence: survivors[0].confidence,
          mode: "candidate",
          ambiguous: true,
          candidates: survivors.map((s) => s.storedIndex),
        };
      }
      // All candidates eliminated. Fall through to a fresh cold start.
      this.pendingCandidates = [];
    }

    // Cold-start path: need enough captured hashes to attempt this.
    if (m < this.coldStartMinHashes) {
      return null;
    }
    const candidates = coldStartCandidates(this.stored, captured, {
      ambiguityMargin: this.ambiguityMargin,
      minConfidence: this.confidenceThreshold,
    });
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      // Unambiguous match. Lock on.
      const c = candidates[0];
      this.lastMatch = {
        storedIndex: c.storedIndex,
        time_ms: this.storedTimes[c.storedIndex],
        wallTimeMs,
        confidence: c.confidence,
      };
      return {
        time_ms: this.lastMatch.time_ms,
        storedIndex: c.storedIndex,
        confidence: c.confidence,
        mode: "cold",
      };
    }
    // Multiple equally-good candidates. Remember them and wait for
    // more audio to disambiguate.
    this.pendingCandidates = candidates.map((c) => ({
      storedIndex: c.storedIndex,
      wallTimeMs,
    }));
    return {
      time_ms: this.storedTimes[candidates[0].storedIndex],
      storedIndex: candidates[0].storedIndex,
      confidence: candidates[0].confidence,
      mode: "cold",
      ambiguous: true,
      candidates: candidates.map((c) => c.storedIndex),
    };
  }

  // _evaluateCandidates: for each pending candidate, score the
  // current captured window at the candidate's "expected position now."
  // Returns the survivors — candidates whose score is competitive with
  // the best.
  _evaluateCandidates(captured, wallTimeMs) {
    const m = captured.length;

    // For each candidate, compute its "expected stored index at this
    // wall time." If the user is at this candidate's position, then
    // elapsed wall time since the candidate's anchor corresponds to
    // forward movement in the stored array.
    const scored = [];
    for (const cand of this.pendingCandidates) {
      const elapsedMs = wallTimeMs - cand.wallTimeMs;
      // The capture window's start is (m-1) intervals before "now".
      // Advance the candidate by elapsedMs of playback, then subtract
      // the window length to get the window's start position.
      const candidateNowIdx =
        cand.storedIndex +
        Math.round(elapsedMs / CHROMAPRINT_INTERVAL_MS_APPROX);
      const windowStartIdx = candidateNowIdx - (m - 1);
      // Score this position. If it's out of bounds, score it as worst.
      if (windowStartIdx < 0 || windowStartIdx + m > this.stored.length) {
        continue;
      }
      const score = sumHamming(this.stored, windowStartIdx, captured, m);
      const perHash = score / m;
      const confidence = 100 * (1 - perHash / 32);
      scored.push({
        storedIndex: windowStartIdx,
        score,
        perHash,
        confidence,
      });
    }

    if (scored.length === 0) return [];

    // Keep candidates whose score is within the ambiguity margin of
    // the best, and which meet the confidence threshold.
    scored.sort((a, b) => a.score - b.score);
    const bestScore = scored[0].score;
    const scoreMargin = this.ambiguityMargin * m;
    return scored.filter(
      (s) =>
        s.score <= bestScore + scoreMargin &&
        s.confidence >= this.confidenceThreshold,
    );
  }

  // Estimate current position by interpolating from the last match using
  // the expected drift. Useful between actual match callbacks for
  // smooth subtitle display.
  estimatedTimeMs(wallTimeMs) {
    if (!this.lastMatch) return null;
    const elapsedMs = wallTimeMs - this.lastMatch.wallTimeMs;
    return this.lastMatch.time_ms + elapsedMs * this.expectedDriftPerSecond;
  }

  // Internal: binary search the storedTimes array for the index whose
  // time is closest to timeMs.
  _timeMsToIndex(timeMs) {
    const arr = this.storedTimes;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < timeMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
