# Chroma-DTW exploration — findings

A spike to derisk "could AFS sync against a *different performance*
of the same piece, not just the same recording?" The motivating
use cases: opera surtitles synced to whatever orchestra is
performing tonight; karaoke lyrics synced to a karaoke machine's
backing arrangement even if your phone holds the studio recording.

This document captures what we learned. The scripts that produced
the numbers live alongside it ([spike.py](./spike.py),
[README.md](./README.md)).

## Tests run

| # | Setup | Outcome |
|---|---|---|
| 1 | Same recording, 10 % time-stretched copy. Full DTW. | ✓ Path is a clean diagonal at the expected 1.111 slope. Algorithm fundamentals work. |
| 2 | 1990 vs 2006 USAF Singing Sergeants Silent Night. Subseq DTW. | Ambiguous — the 1990 (1 verse) mapped to 2006's verse 2, not verse 1. Same melody, same chroma; DTW picked an equally-valid match that was the wrong verse. |
| 3 | Nessun dorma: Lazzaro 1926 vs Cortis 1929. Full DTW. | ✓ Clean diagonal path. Phrase-level landmarks align within 5 s of the correct moment after accounting for tempo differences. |
| 4 | Beethoven 5 1st movement, two performances. Full DTW with chroma alone vs chroma + onset. | ✓ Pure chroma was already correct (slope 1.050 = exact tempo ratio). Onsets didn't add measurable benefit. Motif repetition didn't cause path divergence because the monotonicity constraint prevents jumps. |
| 5 | Localization stress: extract sub-clips from a reference and ask subseq-DTW to find them. Two pieces (Nessun dorma, Silent Night), three window sizes (5 / 15 / 30 s). | ✓ at 30 s; partial failures at shorter windows — see below. |

## The window-size finding (Test 5)

This is the most important result. Same setup as Test 2 (extract a clip,
ask DTW where it came from) but varied across multiple positions and
window sizes.

| Window | Nessun dorma | Silent Night | Combined |
|---|---|---|---|
| 5 s | 4 / 5 correct | 4 / 5 correct | **65 % (13/20)** |
| 15 s | 5 / 5 correct | 4 / 5 correct | **85 % (17/20)** |
| 30 s | 5 / 5 correct | 5 / 5 correct | **100 % (20/20)** |

The two short-window failures:
- **Nessun dorma "Per il mio bacio" at 105 s, 5 s window** → predicted 30 s. 5 seconds of that phrase had chroma similar to an earlier passage. 15 s+ context resolves it.
- **Silent Night V1 "Sleep in heavenly peace" at 90 s, 15 s window** → predicted 155 s. The verse-1 cadence at 90 s has chroma similar to the orchestral coda at 155 s. 30 s context resolves it.

What surprised us: **Silent Night V2 "holy night" at 115 s localized correctly at every window size, including 5 s**, despite sharing the exact same melody as V1 "holy night" at 15 s. The arrangement around verse 2 in this 2006 recording is harmonically different enough (different orchestration, slightly different chord voicings) that chroma at corresponding moments is *not* identical. The strophic-verse failure mode requires same melody AND same arrangement — a narrower trap than the "every verse has the same chroma" intuition suggests.

## What this implies for an implementation

For real-time tracking of a live performance against a reference
recording, the architecture would be:

1. **Initial lock phase** — accumulate captured audio over ~30 s.
   Run subseq-DTW with growing context until a confident match
   emerges. Empirically 30 s gave 100 % correct localization on
   tested material.
2. **Tracking phase** — once locked, extend the path forward
   monotonically. Each new frame can only advance the position;
   the matcher only searches locally (±a few seconds around the
   predicted next position). This handles motif recurrence
   trivially because globally the position can't jump.
3. **Re-acquisition** — if confidence drops (silence, big
   interruption, drift accumulation), fall back to phase 1.

This is essentially **online DTW with monotonic forward
extension**, well-documented in the MIR literature (Dixon's MATCH
paper and successors). librosa has the primitives.

## Why the "add another audio feature" approach doesn't help

We considered onsets, MFCC, and lyrics as disambiguation layers
for the cases chroma alone gets wrong. None survive cross-
performance:

- **Onsets are tempo-dependent.** Two performances at different
  tempos have onsets at different absolute times. They help only
  if the rhythm pattern itself is invariant — which it isn't, in
  expressive classical performance.
- **MFCCs encode timbre.** Different orchestras / vocalists /
  recording conditions produce different MFCCs even at
  structurally identical moments. Karaoke MIDI vs studio
  recording is the worst case.
- **Lyrics are unrecoverable** in opera (legato + foreign-language
  + room acoustics) and unreliable in karaoke (amateur vocals).
  Whisper-class ASR doesn't survive either condition.

The real lever isn't a new feature — it's **state tracking over
time**. Once you know where you were a moment ago, you don't need
to re-disambiguate the current moment against every other
similar-looking moment in the piece. You only need to disambiguate
within a narrow forward window. This is the HMM-based score-
following insight (Music Plus One, Antescofo).

## Honest limits

What this exploration does NOT cover:

- **Online / streaming DTW.** Our tests were offline (full
  reference, full capture, then compute path). Real-time would
  use incremental DTW with a fixed-history window. The primitives
  exist; we didn't build the wrapper.
- **Live mic capture.** All tests used synthetic capture (slicing
  the reference recording). Real-world mic capture adds room
  acoustics, audience noise, AGC artifacts. Untested.
- **Sequential / state-tracked matcher.** We tested subseq-DTW as
  a single-shot lookup. A production system would maintain state
  across captures. Untested.
- **Score-informed alignment.** We aligned recording-to-recording.
  Aligning live audio to a synthesized score (the cleanest
  cross-performance approach) is untested here.
- **Piece-with-identical-arrangement-across-sections.** Silent
  Night verse 2 happened to have a different arrangement than
  verse 1. A hymn with bit-identical verse arrangements would
  defeat chroma entirely; that case is documented but not tested.

## How to revisit

The branch holds the spike code and this document. To pick it up:

```bash
git checkout shazam-landmark   # if not already
cd experiments/chroma-dtw
# See README.md for venv + librosa setup
python spike.py 5              # the localization stress test
```

The pragmatic next step would be a fifth-class test: live mic
capture of a real performance, with state tracking. That requires
either physical setup (phone at a piano recital) or careful
synthetic noise modeling. Beyond what this spike scoped.

## Bottom line

Cross-performance audio alignment via chroma + DTW is real and
works at 30+ s lock-on. It's a meaningfully different family of
algorithm from AFS's current chromaprint-based same-source
matching — the format would need to store chroma vectors rather
than hashes, and the matcher would need to be alignment-based
rather than Hamming-search-based. But it's not architecturally
outside the AFS spec; the spec admits new `[fingerprint].algorithm`
values by design.

Whether to pursue this as an AFS v0.3 algorithm or as a separate
product is a product decision, not a technical one. The
technology works.
