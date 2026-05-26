# Shazam-style landmark fingerprinting — findings

What we measured by running the spike scripts on the demo's three
content pieces. Setup + how to run is in [README.md](./README.md);
this doc is the writeup.

## Bottom line

Viable, but content-dependent. The migration is worth pursuing
eventually for the dialogue / movie use case where mic-mode noise
tolerance matters most. It is **not** a no-trade-offs upgrade
over chromaprint, and the "Shazam is universally magic"
reputation doesn't hold uniformly across content types.

## Results by content type

Tested on three pieces of the demo's actual content. Each entry is
the result of `match-test.mjs` at different capture lengths.

| Content | 3 s capture | 5 s capture | 10 s capture | -24 dB noise (best capture) |
|---|---|---|---|---|
| Dialogue (Tears of Steel)  | **3/3 ∞× margin** | **3/3 ∞×** | **3/3 ∞×** | 2/3 correct |
| Vocal music (Silent Night) | (mixed)            | 2/3 correct        | **3/3, 5-7× margin**  | 3/3, margin holds |
| Orchestral (1812 finale)   | (mixed)            | 1/3 correct†       | **3/3, 1.6-13× margin** | (not tested) |

† The failing slice was the 50 % position. It landed on a different
occurrence of a repeating motif and matched 30 s off the truth.

### Notes on each

- **Dialogue**: every test correct, with no competing offsets at
  any window size. Speech transients + formants are uniquely
  distinctive; the algorithm shines.
- **Vocal music**: needs ~10 s captures for reliable lock.
  Sustained tones give weaker landmarks than transients.
- **Orchestral**: also ~10 s. Repeating themes create collateral
  matches at short captures; the path-monotonicity protection
  doesn't apply because match-test.mjs is a single-shot lookup,
  not a continuous alignment.

## The noise failure

At -12 dB overlay noise (heavy but not destructive musically), the
slice fingerprinting produced 374-432 spurious landmarks from a
5-second window that should yield ~25 real ones. The flood
drowned the real signal entirely. Across all three positions,
zero correct matches.

At -24 dB (typical room ambient), the landmarks held up: 2/3 to
3/3 correct depending on content.

The root cause: the adblockradio library doesn't weight signal-
landmarks above noise-landmarks. A peak-detection threshold tuned
for clean studio audio admits too many spurious peaks once noise
is added. Tuning that threshold is the obvious next step if
real-world mic capture exhibits the same failure.

## Head-to-head vs chromaprint (overture-finale.mp3, 71 s)

| | chromaprint v0.1 | Shazam landmark |
|---|---|---|
| Hashes / second | 7.8 | 18.4 |
| Wall-clock fingerprint | 97 ms | 118 ms |
| Raw stream size | 2.2 KB | 10.2 KB |
| Min capture for lock (dialogue) | ~3.5 s | ~3 s |
| Min capture for lock (music) | ~3.5 s | ~10 s |
| Noise tolerance | ~80 % confidence ceiling | OK to -24 dB; collapses at -12 dB |

Landmark stream size after gzip is closer to chromaprint (both are
text-encodable). For HTTP-served AFS the size difference largely
vanishes; for offline transfer (AirDrop, USB) it's a real ~5×
cost.

## Where Shazam-landmark beats chromaprint

For **dialogue content**: clean 3-second infinity-margin lock-on,
strictly better than chromaprint on every measured axis. Sentences
like "subtitles for the movie I'm watching" are exactly the
strong case.

## Where it doesn't

For **music** (vocal or orchestral): chromaprint is comparable,
sometimes faster to lock. Landmark wins on noise tolerance up to
-24 dB but the "noise robustness" claim doesn't extend to
concert-hall levels where -12 dB+ ambient is normal.

## Implications for a v0.2 migration

If we pursue this:

1. The matcher state machine needs **content-aware lock-on
   latency** — dialogue locks in 3 s; karaoke / music takes 10 s+.
2. The lib's **peak-detection threshold** is the tuning target
   for real-room noise robustness. Not explored here.
3. The actual deciding test is **real-room mic capture**, not
   synthetic noise overlay. Numbers here are encouraging but not
   conclusive for the live use case.
4. AFS v0.2 spec change: `[fingerprint].algorithm = "shazam-landmark"`,
   body lines store landmark pairs instead of 32-bit hashes,
   matcher swaps `sumHamming` for an inverted-index lookup with
   time-offset histogram.

## Honest re-recommendation

Ship v0.1 with chromaprint as planned. The landmark migration is
real but it's a **better-for-dialogue / neutral-for-music** trade,
not a universal upgrade. Whether it's worth doing depends on what
the v0.1 telemetry (if any) shows about which use cases matter
most.

If dialogue / movie sync is the dominant use case and the mic-
mode noise ceiling is the dominant complaint, v0.2 with landmark
is the right move. If music / karaoke is the dominant case,
chromaprint isn't the bottleneck and effort is better spent
elsewhere.
