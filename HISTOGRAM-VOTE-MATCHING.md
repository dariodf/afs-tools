# Histogram-vote matching — design note

This is a design note, not a current implementation. It describes a
different approach to the matcher that has theoretical advantages
over the current window-slide minimum-Hamming-distance algorithm,
and explains the trade-offs.

The current matcher (sliding window + per-hash candidate tracking)
works and passes its tests. This note exists so that if real-world
testing reveals fragility, the alternative is documented and
implementable without re-deriving it.

## How the current matcher works

To recap: the captured-hashes window is compared against every
candidate position in the stored sequence by computing the *total
Hamming distance* (sum of per-hash bit differences) between the
window and the slice of stored hashes at that position. The
candidate with the lowest total score is the best match. The recent
addition of candidate tracking extends this to handle ambiguity: all
positions within K bits-per-hash of the best are tracked across
subsequent steps, and the surviving candidate locks on.

This is conceptually simple and works well when:

- The captured audio is similar enough to the stored audio that
  per-hash distance averages somewhere in the 0-10 range.
- The captured window is short enough (10s of hashes, not hundreds)
  that one badly-degraded hash doesn't dominate the average.
- The source content doesn't have long stretches of near-identical
  audio.

## The failure mode it's vulnerable to

When some captured hashes are *very* corrupted (room noise during a
loud moment, packet loss, transient mic interference), those hashes
have Hamming distance close to 16 (random) against the *correct*
stored position. A few such hashes can dominate the total score,
making the correct position look as bad as wrong positions. The
window-minimum approach has no way to ignore corrupted hashes.

Concretely: imagine a 24-hash window where 20 hashes match perfectly
(distance 2 each) and 4 hashes are corrupted (distance 18 each at
the correct position because the bursts happened during those
intervals). Total score at correct position: 20*2 + 4*18 = 112.
Average per-hash: ~4.7. Sounds good, except a *wrong* position
elsewhere might have 24 hashes at distance 8 each (random-ish),
total 192, average 8. The matcher correctly picks the correct
position here, but the *margin* is thin (112 vs 192), and that
margin shrinks fast as corruption grows.

In real-world mic capture, transient noise is common (a chair
scraping, a cough, a car passing) and these corruption events affect
*some* captured hashes, not all of them.

## The histogram-vote alternative

Different idea: instead of scoring whole windows against whole
positions, treat each captured hash as an independent voter.

For each captured hash i in the window, find all stored positions k
where the per-hash Hamming distance is below some threshold (say,
8 bits — generous). Each such match is a vote: capture[i] at
window-index i appearing at stored[k] suggests the window-start
position is k - i.

Collect all these votes into a histogram keyed by `offset = k - i`.
The histogram peak is the answer: the offset that received the most
votes is the most likely alignment of the window in the stored
sequence.

```
For each captured hash c at window position i:
  For each stored hash s at position k with hamming(c, s) < T:
    histogram[k - i] += 1

Best offset = argmax(histogram)
```

### Why this is better for noise robustness

A noisy hash doesn't reduce the score at the correct offset — it
just fails to vote there. The other 20 good hashes still pile votes
on the correct offset, and that pile is the answer. The corrupt
hashes might cast some random votes elsewhere, but those scatter and
don't accumulate.

In the example above: 20 good hashes generate 20 votes for the
correct offset. 4 corrupt hashes generate maybe 4 scattered votes
distributed across random offsets. The correct offset has a histogram
value of 20; the runner-up has 1 or 2. Decisive.

### Why it's also better for repeated motifs

When a motif appears twice in the source, each captured motif hash
matches BOTH stored occurrences below the threshold. Both occurrence
offsets get votes. But the *surrounding context hashes* (the audio
before and after the motif) only match their actual occurrence.

So the histogram naturally shows two peaks during the motif itself
(equal heights), with the correct occurrence's peak growing as
context is added. The disambiguation logic falls out for free —
just watch which peak grows.

This is essentially what Shazam's "constellation map" approach does,
adapted for our continuous-tracking case.

## What it costs

- **More compute per step.** The current matcher does N
  comparisons (where N is the number of stored positions). The
  histogram approach does N comparisons per *captured hash*, so
  total comparisons are M * N (M captured hashes). For a 24-hash
  window against a 1000-hash stored sequence, that's 24,000
  comparisons instead of ~1000. Still fast — sub-millisecond on a
  phone — but 20x more work.

- **More memory.** A histogram of size N (one bucket per possible
  offset). Trivial for our scales (a few KB) but worth noting.

- **More complexity.** Two thresholds to tune (per-hash distance
  threshold and minimum vote count) instead of one (whole-window
  per-hash average). And the histogram peak-detection has its own
  subtleties: sharp peaks vs broad peaks, secondary peaks, etc.

- **An index for performance.** To avoid O(M*N) comparisons,
  production systems pre-index the stored hashes: for each possible
  hash value, store a list of (position, exact hash) pairs. Then
  for each captured hash, look up positions with similar stored
  hashes via LSH (locality-sensitive hashing) or just by varying
  bits of the hash. This is a substantial implementation effort —
  it's the difference between "a clever 50-line algorithm" and "a
  small audio-fingerprinting database."

## When to switch

The current matcher is good enough if:

- Real-world tests show > 90% lock-on success on first cold start.
- The ambiguity-tracking logic resolves repeated motifs in < 5
  seconds in typical content.
- Noise robustness is acceptable (matcher locks on through a
  reasonably noisy room).

Switch to the histogram-vote approach if:

- Lock-on success rate is poor (matcher frequently fails or picks
  wrong positions).
- Real audio shows persistent ambiguity that the current logic
  can't resolve.
- Long content (multi-hour) creates pathological match candidates
  with high score but spurious correlation.

The current matcher's tests document its expected behavior, so the
switchover is testable: implement the histogram approach, run it
against `test/test-matcher-robustness.js`, confirm the same tests
pass (or better, that previously-flaky behavior becomes deterministic).

## Implementation sketch

```javascript
// histogram-vote-match.js
// Match a captured window against a stored sequence by anchor voting.

export function histogramVoteMatch(stored, captured, options = {}) {
  const perHashThreshold = options.perHashThreshold ?? 8;
  const m = captured.length;
  const n = stored.length;

  // Build the histogram: map from offset (k - i) to vote count.
  // Use a typed array for speed; offset can range from -(m-1) to n-1.
  const minOffset = -(m - 1);
  const offsetRange = n + m - 1;
  const histogram = new Uint32Array(offsetRange);

  for (let i = 0; i < m; i++) {
    const c = captured[i];
    for (let k = 0; k < n; k++) {
      if (hamming32(c, stored[k]) <= perHashThreshold) {
        const offset = k - i;
        histogram[offset - minOffset]++;
      }
    }
  }

  // Find histogram peak(s).
  let peakValue = 0;
  let peakOffset = 0;
  for (let h = 0; h < offsetRange; h++) {
    if (histogram[h] > peakValue) {
      peakValue = histogram[h];
      peakOffset = h + minOffset;
    }
  }

  // Confidence: fraction of captured hashes that voted for the peak.
  const confidence = (peakValue / m) * 100;

  return { offset: peakOffset, confidence, votes: peakValue };
}
```

For production use, the inner loop needs an index to avoid O(M*N).
The pre-indexing step (one-time, when the AFS is loaded) builds a
hash → positions map. The match-time lookup becomes O(M *
positions_per_hash), which for chromaprint's 32-bit hashes with a
1000-position stored sequence is roughly O(M * 1) = O(M).

## Bottom line

The histogram approach is theoretically superior for noise
robustness and repeated content. It's also more code, slower (or
requires indexing), and has more knobs. Don't switch unless
real-world testing shows the current approach is failing.

If it does fail, this note is the starting point.
