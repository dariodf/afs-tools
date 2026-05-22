// afs-mapping.js
// Pre-computed time mapping between two AFS files.
//
// Use case: you have a local copy of both the source's AFS and the
// derived (edited / re-encoded / trimmed) media's AFS. Instead of
// fingerprinting the playing audio live every tick, you can match
// the two AFS hash streams against each other *once*, build a
// table of (derivedMs → sourceMs) anchors plus a block model that
// describes the cuts, and then look up the current source position
// from the local media element's currentTime. This is what a real
// local player would do — it's cheaper, more accurate, and
// doesn't require running the audio graph at all.
//
// The derived AFS is generated from a re-cut / re-encoded /
// trimmed view of the same source content. Within each contiguous
// block (between cuts), source-time and derived-time advance at
// 1:1, separated only by a constant offset. At cut boundaries the
// source-time jumps. The mapping is therefore piecewise-linear
// with slope exactly 1 inside each block.
//
// Algorithm: feed the derived hash stream through an AFSMatcher
// against the source hashes — exactly the same matcher the live
// demo uses, just driven by stored hashes rather than live audio.
// The matcher's state machine (cold-start → local-search →
// re-acquisition after a cut) handles cuts naturally: it tracks
// continuity within each block via local search, and re-acquires
// via cold-start across each cut. Each successful step yields an
// anchor; the post-process groups anchors with similar offsets
// into blocks.

import { chromaprintArrays } from "./afs-parser.js";
import { AFSMatcher } from "./afs-matcher.js";

const DEFAULT_OPTIONS = {
  // Window length, in derived hashes, passed to the matcher per
  // step. ~3 s of context gives the matcher enough information to
  // disambiguate hash collisions that single-second chunks can
  // suffer near re-encoded boundaries.
  windowHashes: 24,
  // Stride between successive matcher steps. ~0.5 s — dense
  // enough to leave anchors close to every cut.
  strideHashes: 4,
  // Matcher confidence floor. The live demo uses 60 for noisy mic
  // capture; here we have clean stored hashes so we can be stricter.
  minConfidence: 80,
  // Tolerance for clustering anchors into blocks by their implied
  // offset (sourceMs − derivedMs).
  blockOffsetToleranceMs: 150,
};

/**
 * Build a time mapping from the derived AFS to the source AFS.
 *
 * @param {object} sourceAfs  parseAFS() output for the source clip
 * @param {object} derivedAfs parseAFS() output for the derived clip
 * @param {object} [options]
 * @returns {{
 *   anchors: Array<{derivedMs, sourceMs, confidence, mode}>,
 *   blocks: Array<{derivedStart, derivedEnd, offset, anchorCount}>,
 *   lookup: (derivedMs: number) => number | null,
 * }}
 */
export function computeTimeMapping(sourceAfs, derivedAfs, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const { hashes: srcHashes, times: srcTimes } = chromaprintArrays(sourceAfs);
  const { hashes: drvHashes, times: drvTimes } = chromaprintArrays(derivedAfs);

  // -- Pass 1: walk the derived hashes through a matcher --
  // The matcher is the same algorithm the live demo runs, just fed
  // the stored derived hashes instead of live-captured audio. Its
  // state machine handles cuts via local-search-then-cold-start
  // re-acquisition. We use the derived hash times as the "wall
  // clock" so the matcher's expected-position math sees a real-
  // time-like progression.
  const matcher = new AFSMatcher(srcHashes, srcTimes, {
    confidenceThreshold: opts.minConfidence,
    coldStartMinHashes: Math.min(opts.windowHashes, 16),
  });

  const anchors = [];
  for (
    let endIdx = opts.windowHashes;
    endIdx <= drvHashes.length;
    endIdx += opts.strideHashes
  ) {
    const startIdx = endIdx - opts.windowHashes;
    const window = drvHashes.slice(startIdx, endIdx);
    const wallTime = drvTimes[startIdx];
    const result = matcher.step(window, wallTime);
    if (!result || result.ambiguous) continue;
    if (result.confidence < opts.minConfidence) continue;
    anchors.push({
      derivedMs: drvTimes[startIdx],
      sourceMs: result.time_ms,
      confidence: result.confidence,
      mode: result.mode,
    });
  }

  // -- Pass 2: cluster anchors into blocks by implied offset. --
  // Inside a block, sourceMs − derivedMs is constant. A jump in
  // that offset between adjacent anchors signals a cut. We grow a
  // block while consecutive anchors share an offset within
  // tolerance; a divergence closes the current block and opens a
  // new one.
  const blocks = [];
  if (anchors.length > 0) {
    let current = {
      derivedStart: anchors[0].derivedMs,
      derivedEnd: anchors[0].derivedMs,
      offset: anchors[0].sourceMs - anchors[0].derivedMs,
      anchorCount: 1,
    };
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i];
      const aOffset = a.sourceMs - a.derivedMs;
      if (Math.abs(aOffset - current.offset) <= opts.blockOffsetToleranceMs) {
        current.derivedEnd = a.derivedMs;
        current.anchorCount += 1;
      } else {
        blocks.push(current);
        current = {
          derivedStart: a.derivedMs,
          derivedEnd: a.derivedMs,
          offset: aOffset,
          anchorCount: 1,
        };
      }
    }
    blocks.push(current);
  }

  // Drop solo-anchor blocks: those are almost always cut-stragglers
  // that snuck past the confidence filter. A real block has
  // multiple consecutive anchors agreeing on offset.
  const stableBlocks = blocks.filter((b) => b.anchorCount >= 2);

  // -- Lookup --
  // Strategy:
  //   1. If the derivedMs falls inside a block, return derivedMs +
  //      block.offset (the exact 1:1 mapping).
  //   2. If it falls between two blocks (in a cut "gap" where no
  //      anchors landed), pick whichever neighbouring block's
  //      extrapolation gives a sensible source-time: split the gap
  //      in half — anything before the midpoint belongs to the
  //      previous block, anything after to the next.
  //   3. Before the first block / after the last block, extrapolate
  //      from the nearest block's offset.
  function lookup(derivedMs) {
    if (stableBlocks.length === 0) return null;
    if (derivedMs < stableBlocks[0].derivedStart) {
      return derivedMs + stableBlocks[0].offset;
    }
    for (let i = 0; i < stableBlocks.length; i++) {
      const b = stableBlocks[i];
      if (derivedMs >= b.derivedStart && derivedMs <= b.derivedEnd) {
        return derivedMs + b.offset;
      }
      if (i + 1 < stableBlocks.length) {
        const next = stableBlocks[i + 1];
        if (derivedMs > b.derivedEnd && derivedMs < next.derivedStart) {
          const mid = (b.derivedEnd + next.derivedStart) / 2;
          return derivedMs + (derivedMs <= mid ? b.offset : next.offset);
        }
      }
    }
    const last = stableBlocks[stableBlocks.length - 1];
    return derivedMs + last.offset;
  }

  return { anchors, blocks: stableBlocks, lookup };
}
