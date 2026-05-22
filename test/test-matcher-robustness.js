// test/test-matcher-robustness.js
// Tests for the matcher's robustness improvements:
//
//   1. Multi-candidate cold start — when several stored positions
//      match the captured hashes equally well, the matcher reports
//      ambiguity instead of confidently picking one. Subsequent
//      audio disambiguates by eliminating candidates.
//
//   2. Sliding-buffer cold start — after a skip or while searching,
//      the matcher slides the buffer window forward as new audio
//      arrives instead of accumulating a fresh 3-second buffer each
//      time. Avoids 3-second penalties per failed search.
//
// These tests will FAIL until afs-matcher.js is updated. They
// document the intended new behavior. Run them with:
//   node test/test-matcher-robustness.js

import { AFSMatcher } from "../demo/src/afs-matcher.js";
import { chromaprintCueMs } from "../demo/src/chromaprint.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "expected equal"}: got ${actual}, want ${expected}`);
  }
}

// -----------------------------------------------------------------------
// Test helpers: construct stored-hash sequences with controlled repetition
// -----------------------------------------------------------------------

// Build a stored hash sequence with a "repeated motif" embedded twice.
// Returns { stored, storedTimes, motif, firstOccurrence, secondOccurrence }.
//
// The sequence is N hashes long. The motif (length M) appears at
// firstOccurrence and again at secondOccurrence. Surrounding hashes
// are unique so the matcher can disambiguate given enough context.
function buildRepeatedSequence(opts) {
  const total = opts.total ?? 500;
  const motifLength = opts.motifLength ?? 32;
  const firstOccurrence = opts.firstOccurrence ?? 50;
  const secondOccurrence = opts.secondOccurrence ?? 300;

  const stored = new Uint32Array(total);
  // Fill with a deterministic but unique sequence — every hash distinct.
  // Use index*0x9E3779B1 (golden ratio multiplier) for spread.
  for (let i = 0; i < total; i++) {
    stored[i] = (i * 0x9e3779b1) >>> 0;
  }
  // Replace both occurrence ranges with the same motif hashes.
  const motif = new Uint32Array(motifLength);
  for (let i = 0; i < motifLength; i++) {
    motif[i] = ((i + 1000) * 0xdeadbeef) >>> 0;
  }
  for (let i = 0; i < motifLength; i++) {
    stored[firstOccurrence + i] = motif[i];
    stored[secondOccurrence + i] = motif[i];
  }

  const storedTimes = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    storedTimes[i] = chromaprintCueMs(i);
  }

  return { stored, storedTimes, motif, firstOccurrence, secondOccurrence };
}

// Captures hashes from the stored sequence at a specific position,
// optionally with noise (random bit flips per hash).
function captureFromStored(stored, position, length, noiseBitsPerHash = 0) {
  const captured = new Uint32Array(length);
  for (let i = 0; i < length; i++) {
    let h = stored[position + i];
    for (let b = 0; b < noiseBitsPerHash; b++) {
      const bit = Math.floor(Math.random() * 32);
      h ^= (1 << bit);
    }
    captured[i] = h >>> 0;
  }
  return captured;
}

// -----------------------------------------------------------------------
// Optimistic cold start + parallel-search correction
// -----------------------------------------------------------------------
// Behavior contract: the matcher commits the best candidate as soon as
// it has enough audio to attempt a match, even when alternatives are
// close. On subsequent ticks, while the lock confidence is below the
// "enter" threshold, the matcher runs a parallel cold-start and swaps
// to the alternative if it beats current by `swapMarginConfidence`.
// The earlier "wait for disambiguation" path is gone — we'd rather
// show the wrong subtitle for ~250 ms than show nothing for 2 s.

test("motif-only capture: commits one of the equal candidates immediately", () => {
  // The motif appears at two positions in the stored array. The
  // optimistic-commit design says: pick one and run with it; the
  // parallel search will correct if extended capture proves otherwise.
  // We don't try to detect "tied alternatives" — that signal goes
  // through confidence, not a separate flag.
  const seq = buildRepeatedSequence({});
  const matcher = new AFSMatcher(seq.stored, seq.storedTimes, {
    coldStartMinHashes: 24,
    stayThreshold: 60,
    enterThreshold: 75,
  });

  const captured = captureFromStored(seq.stored, seq.firstOccurrence, seq.motif.length);
  const result = matcher.step(captured, 1000);

  assert(result !== null, "matcher should commit something on motif-only capture");
  const pickedOne =
    result.storedIndex === seq.firstOccurrence ||
    result.storedIndex === seq.secondOccurrence;
  assert(
    pickedOne,
    `expected pick at first (${seq.firstOccurrence}) or second (${seq.secondOccurrence}) occurrence, got ${result.storedIndex}`,
  );
});

test("parallel-search swap: extended capture corrects an initial wrong guess", () => {
  // Audio actually starts at the SECOND occurrence. Initial capture
  // covers only the shared motif — the matcher might commit to either
  // occurrence (the optimistic-commit contract). On the next tick,
  // longer audio reveals the post-motif context unique to occurrence 2,
  // and parallel cold-start swaps the lock to the correct position.
  const seq = buildRepeatedSequence({});
  const matcher = new AFSMatcher(seq.stored, seq.storedTimes, {
    coldStartMinHashes: 24,
    stayThreshold: 60,
    enterThreshold: 75,
    swapMarginConfidence: 4,
  });

  const initial = captureFromStored(seq.stored, seq.secondOccurrence, seq.motif.length);
  matcher.step(initial, 1000);

  const extendedLength = seq.motif.length + 16;
  const extended = captureFromStored(
    seq.stored,
    seq.secondOccurrence,
    extendedLength,
  );
  const result = matcher.step(extended, 2000);

  assert(result !== null, "should still have a lock after extended capture");
  assertEqual(
    result.storedIndex,
    seq.secondOccurrence,
    "extended capture should resolve to the SECOND occurrence (where the audio actually is)",
  );
});

test("disambiguation: picks correct occurrence even when first is checked first", () => {
  // Same as above but the user is actually at the first occurrence.
  // The matcher should pick occurrence 1, not default to occurrence 2.
  const seq = buildRepeatedSequence({});
  const matcher = new AFSMatcher(seq.stored, seq.storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 60,
  });

  const initial = captureFromStored(seq.stored, seq.firstOccurrence, seq.motif.length);
  matcher.step(initial, 1000);

  const extended = captureFromStored(
    seq.stored,
    seq.firstOccurrence,
    seq.motif.length + 16,
  );
  const result = matcher.step(extended, 2000);

  assert(result !== null, "should lock on after disambiguation");
  assertEqual(
    result.storedIndex,
    seq.firstOccurrence,
    "should pick the FIRST occurrence",
  );
});

test("unique-context capture: no ambiguity, locks on immediately", () => {
  // Sanity check: when the capture is unique within the stored
  // sequence, the matcher locks on without flagging ambiguity.
  const seq = buildRepeatedSequence({});
  const matcher = new AFSMatcher(seq.stored, seq.storedTimes, {
    coldStartMinHashes: 24,
  });

  // Capture from a unique region (well away from both motif locations).
  const uniquePosition = 150;
  const captured = captureFromStored(seq.stored, uniquePosition, 24);
  const result = matcher.step(captured, 1000);

  assert(result !== null, "should lock on unique capture");
  assertEqual(result.ambiguous ?? false, false, "should not be ambiguous");
  assertEqual(result.storedIndex, uniquePosition, "should hit the right position");
});

// -----------------------------------------------------------------------
// Sliding-buffer cold start
// -----------------------------------------------------------------------

test("sliding buffer: after failed cold start, sliding new audio in finds match", () => {
  // Setup: a long stored sequence. The user "starts listening" but
  // their first 24 hashes happen to be from a totally different
  // (unmatched) source. Then they start hearing audio that matches.
  //
  // The matcher should slide forward as new hashes arrive and find
  // the match without needing another full 3-second wait.
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) {
    stored[i] = (i * 0x9e3779b1) >>> 0;
  }
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) {
    storedTimes[i] = chromaprintCueMs(i);
  }

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 80,
  });

  // 24 hashes of garbage (random, won't match anywhere).
  const garbage = new Uint32Array(24);
  for (let i = 0; i < 24; i++) {
    garbage[i] = ((i + 9999) * 0x12345678) >>> 0;
  }
  let result = matcher.step(garbage, 1000);
  assert(result === null, "garbage shouldn't match");

  // Now new audio arrives. Each new hash is added to a sliding window
  // of size 24 (oldest dropped). After enough real-content hashes have
  // slid in, the matcher should find the match.
  //
  // The interface: caller passes captured = the *current sliding window*,
  // and the matcher tries again. Caller manages the slide; matcher
  // just searches.
  //
  // Pure test: we slide one hash at a time and confirm the matcher
  // locks on the moment enough real hashes are in the window.

  // Start from stored position 100 — that's where the real audio is.
  const realPosition = 100;
  const window = new Uint32Array(24);
  // Pre-populate window with garbage.
  window.set(garbage);

  let foundAt = -1;
  // Slide in 30 real hashes one at a time.
  for (let i = 0; i < 30; i++) {
    // Shift window left, drop oldest.
    window.copyWithin(0, 1);
    // Add new real hash at end.
    window[23] = stored[realPosition + i];
    const r = matcher.step(window, 1100 + i * 124);
    if (r !== null && !r.ambiguous) {
      foundAt = i;
      // The window now contains stored[realPosition + i - 23 ..
      // realPosition + i]. Best match should be at realPosition + i - 23.
      assertEqual(
        r.storedIndex,
        realPosition + i - 23,
        `match position should reflect the current window contents`,
      );
      break;
    }
  }
  assert(
    foundAt >= 0 && foundAt < 30,
    `should find match within 30 sliding hashes, found at iter ${foundAt}`,
  );
});

test("sliding buffer: matcher does not require fresh 3s buffer after a failed match", () => {
  // After step() returns null with a full buffer, calling step() again
  // immediately with the same buffer + 1 new hash should still try a
  // search, not refuse until the buffer is "fresh."
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 80,
  });

  // Initial buffer of garbage.
  const buf = new Uint32Array(24);
  for (let i = 0; i < 24; i++) buf[i] = ((i + 9999) * 0x12345678) >>> 0;

  // First call: no match.
  let result = matcher.step(buf, 1000);
  assert(result === null, "garbage buffer shouldn't match");

  // Second call right after, same buffer plus one new real hash slid in.
  buf.copyWithin(0, 1);
  buf[23] = stored[100];

  // Matcher should attempt a search (return a result or null), not
  // refuse the request. The current implementation requires the FULL
  // coldStartMinHashes count of NEW data, which is the bug.
  // The fix: with coldStartMinHashes already met once, every
  // subsequent step() with a buffer of >= coldStartMinHashes hashes
  // should perform a search.

  // What we want to verify: searches DO happen on every step once
  // the buffer is large enough. We test indirectly: a hand-crafted
  // buffer that DOES match should be found on the very next step,
  // not several steps later.
  const matching = new Uint32Array(24);
  for (let i = 0; i < 24; i++) matching[i] = stored[100 + i];
  result = matcher.step(matching, 1100);
  assert(result !== null, "matching buffer should be found immediately");
  assertEqual(result.storedIndex, 100, "should match at the right position");
});

test("post-skip recovery: matcher abandons stale lastMatch and re-cold-starts", () => {
  // User is at position 100, skips to position 300. The matcher's
  // lastMatch is now wrong. After enough failed local-search ticks,
  // it should abandon the lastMatch and re-cold-start.
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    localWindowRadius: 40,
    confidenceThreshold: 80,
  });

  // First, establish a match at position 100.
  let captured = new Uint32Array(24);
  for (let i = 0; i < 24; i++) captured[i] = stored[100 + i];
  let result = matcher.step(captured, 1000);
  assert(result !== null, "initial match should succeed");
  assertEqual(result.storedIndex, 100);

  // Now simulate a skip to position 300. The matcher's local search
  // (radius 40 around its expected next position) won't find anything.
  // It should fall through to cold-start search.
  for (let i = 0; i < 24; i++) captured[i] = stored[300 + i];
  // The "expected" position after 124ms wall clock would be ~101 in
  // the stored array, with a local window of 40 covering 61..141.
  // Position 300 is way outside that window — must trigger cold start.
  result = matcher.step(captured, 1124);
  assert(result !== null, "should find new position via cold-start fallback");
  assertEqual(
    result.storedIndex,
    300,
    "should find the new position after skip",
  );
});

// -----------------------------------------------------------------------
// Pause / resume
// -----------------------------------------------------------------------

test("pause/resume: long wall-clock gap doesn't shift source position", () => {
  // The user pauses playback for 30 seconds. Wall clock advances,
  // source position does NOT. When they resume, the captured audio
  // matches the SAME source position as before the pause.
  //
  // The current matcher's steady-state branch expects the source to
  // have advanced by elapsedWallTimeMs * drift. After a 30-second
  // pause, it will look 30 seconds ahead of the actual position. The
  // local search window (40 hashes ≈ 5 seconds) won't reach back to
  // the real position. Should fall through to cold-start search and
  // re-acquire near the original position.
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    localWindowRadius: 40,
    confidenceThreshold: 80,
  });

  // Initial match at position 100.
  let captured = new Uint32Array(24);
  for (let i = 0; i < 24; i++) captured[i] = stored[100 + i];
  let result = matcher.step(captured, 1000);
  assertEqual(result.storedIndex, 100);

  // 30 seconds of wall clock pass. Captured audio still at position 100
  // (paused, then resumed exactly where left off — same hashes).
  result = matcher.step(captured, 31000);
  assert(result !== null, "should recover position after pause");
  assertEqual(
    result.storedIndex,
    100,
    "position should be the same — playback was paused, not advanced",
  );
});

// -----------------------------------------------------------------------
// Wrong AFS loaded
// -----------------------------------------------------------------------

test("wrong AFS: captured audio matches nothing — should NOT lock on garbage", () => {
  // The user loaded AFS file A but their playing audio is B. Captured
  // hashes have no real relationship to the stored sequence. The
  // matcher's best score will still be SOMETHING — pure chance gives
  // ~16 bits/hash average. The matcher must reject this as
  // low-confidence, not report a confident position.
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 60, // ~12 bits/hash
  });

  // 24 totally unrelated hashes (different seed).
  const captured = new Uint32Array(24);
  for (let i = 0; i < 24; i++) {
    captured[i] = ((i * 0x12345678) ^ 0xdeadbeef) >>> 0;
  }

  const result = matcher.step(captured, 1000);
  assert(
    result === null,
    `unrelated hashes shouldn't match (got result with confidence ${result?.confidence}%, mode ${result?.mode})`,
  );
});

// -----------------------------------------------------------------------
// End of source
// -----------------------------------------------------------------------

test("end of source: playback past last AFS hash doesn't crash, doesn't lock on", () => {
  // The stored AFS covers 0..30 seconds. User plays through to 32s
  // (the source file is longer than the AFS, e.g., AFS produced from
  // a clip but they're playing the full thing). Captured audio
  // corresponds to nothing in the stored sequence.
  //
  // The matcher must:
  //   - Not crash on out-of-bounds access.
  //   - Not lock on the last few hashes spuriously.
  const stored = new Uint32Array(240); // ~30 seconds at 124ms intervals
  for (let i = 0; i < 240; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(240);
  for (let i = 0; i < 240; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 80,
  });

  // First, normal match in the middle of the source.
  let captured = new Uint32Array(24);
  for (let i = 0; i < 24; i++) captured[i] = stored[100 + i];
  let result = matcher.step(captured, 1000);
  assertEqual(result.storedIndex, 100);

  // Now playback is past the end of the source. The captured audio
  // is from a continuation of the source that wasn't fingerprinted
  // — unrelated hashes from the matcher's perspective.
  for (let i = 0; i < 24; i++) {
    captured[i] = ((i * 0x12345678) ^ 0xcafebabe) >>> 0;
  }
  // Wall time advanced by ~17 seconds, so the matcher expects to be
  // way past the end of stored.
  result = matcher.step(captured, 18000);
  assert(
    result === null,
    `should NOT match unrelated post-EOF audio (got confidence ${result?.confidence}%, mode ${result?.mode})`,
  );
});

// -----------------------------------------------------------------------
// Partial overlap (joining in progress)
// -----------------------------------------------------------------------

test("partial overlap: first part of capture is garbage, later part matches", () => {
  // User joins mid-playback. The audio capture buffer is initially
  // filled with whatever silence/garbage was in the room before the
  // playback started. Then audio starts. After a few seconds, the
  // capture window contains a mix of pre-audio garbage and real audio.
  //
  // The matcher should be patient: still find no match while the
  // window is contaminated, then lock on once enough real audio has
  // slid through.
  const stored = new Uint32Array(500);
  for (let i = 0; i < 500; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(500);
  for (let i = 0; i < 500; i++) storedTimes[i] = chromaprintCueMs(i);

  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
    confidenceThreshold: 80,
  });

  const realPosition = 200;
  const window = new Uint32Array(24);
  // Initial window: 24 hashes of pre-playback garbage.
  for (let i = 0; i < 24; i++) {
    window[i] = ((i + 7777) * 0xfeedface) >>> 0;
  }

  // Try once with the garbage window.
  let result = matcher.step(window, 1000);
  assert(result === null, "all-garbage window shouldn't match");

  // Now real audio starts. Slide it in, one hash per tick. The
  // window contains MORE garbage than real audio at first, then
  // transitions to all real audio.
  let foundAt = -1;
  for (let i = 0; i < 30; i++) {
    window.copyWithin(0, 1);
    window[23] = stored[realPosition + i];
    const r = matcher.step(window, 1100 + i * 124);
    if (r !== null && !r.ambiguous) {
      foundAt = i;
      // The match should be at a position consistent with the
      // current window contents: stored[realPosition + i - 23 ..
      // realPosition + i].
      const expectedStoredIdx = realPosition + i - 23;
      assertEqual(
        r.storedIndex,
        expectedStoredIdx,
        `position should reflect current window (iter ${i})`,
      );
      // It should take at least some iterations to find — the first
      // few have too much garbage.
      assert(
        i >= 5,
        `should NOT lock on too early (locked at iter ${i}, expected >= 5)`,
      );
      break;
    }
  }
  assert(
    foundAt >= 0,
    `should eventually lock on after garbage flushes out (foundAt=${foundAt})`,
  );
});

// -----------------------------------------------------------------------
// Edge cases that shouldn't crash
// -----------------------------------------------------------------------

test("safety: empty captured array doesn't crash", () => {
  const stored = new Uint32Array(100);
  for (let i = 0; i < 100; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(100);
  for (let i = 0; i < 100; i++) storedTimes[i] = chromaprintCueMs(i);
  const matcher = new AFSMatcher(stored, storedTimes);
  // Should return null, not throw.
  const result = matcher.step(new Uint32Array(0), 1000);
  assertEqual(result, null);
});

test("safety: captured window larger than stored doesn't crash", () => {
  const stored = new Uint32Array(20);
  for (let i = 0; i < 20; i++) stored[i] = (i * 0x9e3779b1) >>> 0;
  const storedTimes = new Float64Array(20);
  for (let i = 0; i < 20; i++) storedTimes[i] = chromaprintCueMs(i);
  const matcher = new AFSMatcher(stored, storedTimes, {
    coldStartMinHashes: 24,
  });
  const huge = new Uint32Array(100);
  for (let i = 0; i < 100; i++) huge[i] = (i * 0x9e3779b1) >>> 0;
  // Should return null, not throw or report a bogus position.
  const result = matcher.step(huge, 1000);
  assertEqual(result, null);
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log("");
if (failed === 0) {
  console.log(`${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(1);
}
