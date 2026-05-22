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
    // Hysteresis: two thresholds for the lock state.
    //   - stayThreshold: minimum confidence to keep using a match.
    //     Below this, we drop the lock and let the next tick try
    //     cold-start fresh.
    //   - enterThreshold: confidence at which a match is considered
    //     "in sync" (high trust). Below this, the result is flagged
    //     `tentative: true` — useful for letting the UI show a
    //     "still confirming" indicator while the matcher polishes
    //     its first guess via parallel cold-starts.
    // Legacy `confidenceThreshold` maps to stayThreshold for back-compat.
    this.stayThreshold =
      options.stayThreshold ?? options.confidenceThreshold ?? 60;
    this.enterThreshold = options.enterThreshold ?? 75;
    // Cold-start in parallel with local search costs O(stored). When
    // local is comfortably above enterThreshold we skip the cold-start
    // — saves work in steady state. When local is below it, parallel
    // cold-start runs and we swap to its result if it beats local by
    // this margin in confidence points. A small margin means quick
    // re-acquisition after a seek/cut; too small means jumpy locks
    // when noise pushes alternatives close to local.
    this.swapMarginConfidence = options.swapMarginConfidence ?? 8;
    this.confidenceThreshold = this.stayThreshold; // back-compat alias
    this.coldStartMinHashes = options.coldStartMinHashes ?? 24;
    this.localWindowRadius = options.localWindowRadius ?? 40;
    this.expectedDriftPerSecond = options.expectedDriftPerSecond ?? 1.0;
    this.ambiguityMargin = options.ambiguityMargin ?? 2;

    // State.
    this.lastMatch = null; // { storedIndex, time_ms, wallTimeMs, confidence }
  }

  // Reset state, e.g., when the user seeks or switches content.
  reset() {
    this.lastMatch = null;
  }

  // Step the matcher with a new captured-hash window. The captured
  // sequence should be the most recent N hashes from the live audio.
  // wallTimeMs is performance.now() at the moment the latest hash was
  // captured.
  //
  // Returns null if no confident match, otherwise:
  //   {
  //     time_ms, storedIndex, confidence,
  //     mode: "cold" | "local",
  //     tentative?: boolean,    // true if confidence < enterThreshold —
  //                             // matcher's best guess so far, may still
  //                             // get refined by upcoming parallel
  //                             // cold-starts
  //     ambiguous?: boolean,    // true when the buffer's edges don't
  //                             // line up with the matched window —
  //                             // typically means we're spanning a cut.
  //                             // Position is still approximately right.
  //   }
  //
  // Design intent: show something on screen as fast as possible. We
  // commit the best candidate at cold-start even when alternatives
  // are close, marking the result `tentative`. Subsequent ticks run
  // a parallel cold-start whenever local-search confidence is below
  // the enterThreshold, and swap to the alternative if it beats
  // local by `swapMarginConfidence`. The matcher self-corrects an
  // initial wrong guess without ever leaving the consumer with a
  // blank screen.
  step(captured, wallTimeMs) {
    const m = captured.length;
    if (m === 0) return null;

    // Phase 1: local search around the last committed match.
    let local = null;
    let localEdges = null;
    if (this.lastMatch) {
      const elapsedMs = wallTimeMs - this.lastMatch.wallTimeMs;
      const expectedPositionMs =
        this.lastMatch.time_ms + elapsedMs * this.expectedDriftPerSecond;
      const expectedIndex = this._timeMsToIndex(expectedPositionMs);
      local = localMatch(
        this.stored,
        captured,
        expectedIndex,
        this.localWindowRadius,
      );
      // Inspect local's edges — if the buffer doesn't line up cleanly
      // at this position, treat local as "weak" regardless of its
      // averaged confidence and let cold-start try to find a better
      // alignment. This is what catches the case where local search
      // gets stuck on a wrong-but-confident position because the
      // captured audio's prefix happens to match.
      if (local) {
        localEdges = this._verifyEdges(captured, local.bestIndex);
      }
    }

    // Phase 2: cold-start when we either have no lock yet, OR our
    // local result is below the "in sync" threshold, OR local's
    // edges don't agree (which signals "we may be on the wrong
    // anchor — try elsewhere"). Skipping cold-start in steady state
    // is the main CPU win once we're confidently locked.
    const haveStrongLocal =
      local && local.confidence >= this.enterThreshold && localEdges && localEdges.ok;
    const canColdStart = m >= this.coldStartMinHashes;
    let cold = null;
    if (!haveStrongLocal && canColdStart) {
      cold = coldStartMatch(this.stored, captured);
    }

    // Phase 3: pick the winner. Prefer local when both candidates
    // exist (cheaper, smoother) unless cold is clearly better.
    let winner = null;
    let mode = null;
    if (local && cold) {
      if (cold.confidence > local.confidence + this.swapMarginConfidence) {
        winner = cold;
        mode = "cold";
      } else {
        winner = local;
        mode = "local";
      }
    } else if (local) {
      winner = local;
      mode = "local";
    } else if (cold) {
      winner = cold;
      mode = "cold";
    }

    if (!winner) return null;

    // stayThreshold gates whether we report anything at all. Below
    // this, drop the lock so the next tick can try cold-start from
    // scratch.
    if (winner.confidence < this.stayThreshold) {
      this.lastMatch = null;
      return null;
    }

    // Edge check: useful for direct-mode consumers that want to
    // know "I'm crossing a cut, my offset is approximate." Doesn't
    // prevent committing — the position is still our best guess
    // and the consumer is free to use it as-is.
    const edges = this._verifyEdges(captured, winner.bestIndex);

    this.lastMatch = {
      storedIndex: winner.bestIndex,
      time_ms: this.storedTimes[winner.bestIndex],
      wallTimeMs,
      confidence: winner.confidence,
    };

    const result = {
      time_ms: this.lastMatch.time_ms,
      storedIndex: winner.bestIndex,
      confidence: winner.confidence,
      mode,
    };
    if (winner.confidence < this.enterThreshold) result.tentative = true;
    if (!edges.ok) {
      result.ambiguous = true;
      result.edgeMismatch = { headMean: edges.headMean, tailMean: edges.tailMean };
    }
    return result;
  }

  // Estimate current position by interpolating from the last match using
  // the expected drift. Useful between actual match callbacks for
  // smooth subtitle display.
  estimatedTimeMs(wallTimeMs) {
    if (!this.lastMatch) return null;
    const elapsedMs = wallTimeMs - this.lastMatch.wallTimeMs;
    return this.lastMatch.time_ms + elapsedMs * this.expectedDriftPerSecond;
  }

  // Internal: verify that the FIRST and LAST K hashes of the
  // captured window match the source at the expected edge
  // positions. A clean match has both edges aligning with the
  // source; a cut-spanning buffer has audio at one or both edges
  // that comes from a different source segment than the
  // matcher's window-start picked. The matcher's per-window
  // confidence is an average and survives a localised
  // mismatch — but for the position to reflect "where the
  // playhead is now" we need the trailing edge to be at the
  // right source spot, and for it to reflect "the matcher
  // anchored the right way around" we need the leading edge to
  // be there too. Threshold tuned so clean dialogue/orchestral
  // matches (per-hash ~0-4) pass and cut-spanning random
  // alignment (per-hash ~14-16) fails.
  _verifyEdges(captured, storedIndex) {
    const m = captured.length;
    // K = ~1 s of hashes. Small enough to be sensitive to a cut
    // near either buffer edge; large enough that one or two stray
    // mismatched hashes don't trip the check on clean audio.
    const K = Math.min(8, m);

    const inBounds = (idx) => idx >= 0 && idx + K <= this.stored.length;

    function popsumXor(a, aOff, b, bOff, k) {
      let total = 0;
      for (let i = 0; i < k; i++) {
        let x = (a[aOff + i] ^ b[bOff + i]) >>> 0;
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        total += (x * 0x01010101) >>> 24;
      }
      return total;
    }

    let headMean = 0;
    let tailMean = 0;
    const headStored = storedIndex;
    const tailStored = storedIndex + (m - K);

    if (inBounds(headStored)) {
      headMean = popsumXor(captured, 0, this.stored, headStored, K) / K;
    }
    if (inBounds(tailStored)) {
      tailMean = popsumXor(captured, m - K, this.stored, tailStored, K) / K;
    }
    // If either edge runs off the source we can't verify it; rather
    // than penalize, fall back to whichever edge IS in bounds.
    const inHead = inBounds(headStored);
    const inTail = inBounds(tailStored);
    if (!inHead && !inTail) return { ok: true, headMean: 0, tailMean: 0 };
    const worst = Math.max(inHead ? headMean : 0, inTail ? tailMean : 0);
    // 10 bits/hash ≈ 68.75 % confidence — below typical clean-
    // match per-hash distance (0-6) and above cut-spanning
    // random-alignment distance (~14-16).
    return { ok: worst < 10, headMean, tailMean };
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
