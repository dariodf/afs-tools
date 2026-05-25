# Shazam-style landmark fingerprinting — derisk experiment

This folder holds the afternoon-of-glue-code experiment described
in [ROADMAP.md](../../ROADMAP.md): does Wang-2003-style landmark
fingerprinting actually work on our demo content well enough to
justify a v0.2 migration away from chromaprint?

Short answer: **viable, but content-dependent**. The migration is
worth pursuing eventually for the dialogue / movie use case where
mic-mode noise tolerance matters most. It's not a no-trade-offs
upgrade — see findings below.

## Setup

```bash
mkdir -p vendor
git clone --depth 1 https://github.com/adblockradio/stream-audio-fingerprint vendor
cd vendor
npm install
npm run build
cd ..
```

The lib is MPL-2.0 and archived but stable. Its README claims tick
duration of `NFFT / SAMPLING_RATE`, but the source uses
`STEP / SAMPLING_RATE` (with STEP = NFFT/2). Our scripts use the
correct value from source.

## Scripts

### `compare.mjs <audio>`

Fingerprints `<audio>` with both the chromaprint CLI (`fpcalc`) and
the landmark lib. Reports:

- Hash count, density, raw stream size
- Wall-clock fingerprinting cost
- Self-match against the landmark stream (degenerate but quick
  sanity check)

### `match-test.mjs <audio> [noise-db]`

The real test. Fingerprints the full source, builds an inverted
index, then *re-decodes and re-fingerprints* three 5-second slices
of the audio (at 20%, 50%, 80% positions) and looks them up
against the index. Reports the winning time-offset and its margin
over the runner-up.

Set `SLICE_SEC=3` (or 10, etc.) to vary capture length.

If `noise-db` is given (e.g. `-24`), overlays white noise at that
level onto the slice before fingerprinting. -24 dB approximates
room ambient; -18 dB is heavy noise; -12 dB destroys things.

```bash
SLICE_SEC=3 node match-test.mjs ../../demo/content/dialogue-clip.mp4
SLICE_SEC=10 node match-test.mjs ../../demo/content/overture-finale.mp3 -24
```

## What we measured

Tested on three pieces of the demo's actual content:

| Content | 3 s capture | 5 s capture | 10 s capture | -24 dB noise (best capture) |
|---|---|---|---|---|
| Dialogue (Tears of Steel) | **3/3 ∞× margin** | **3/3 ∞×** | **3/3 ∞×** | 2/3 correct |
| Vocal music (Silent Night) | (mixed) | 2/3 correct | **3/3, 5-7× margin** | 3/3, margin holds |
| Orchestral (1812 finale) | (mixed) | 1/3 correct† | **3/3, 1.6-13× margin** | (not tested) |

† the failing slice was the 50% position, which landed on a
different occurrence of a repeating motif and matched 30 s off.

The bug: the lib doesn't weight signal landmarks above noise
landmarks. At -12 dB noise the slice produced 374-432 spurious
landmarks (from a 5-second window that should yield ~25 real
ones), drowning the real signal entirely. -24 dB is fine.

## Head-to-head vs chromaprint (overture-finale.mp3, 71 s)

| | chromaprint v0.1 | Shazam landmark |
|---|---|---|
| Hashes / second | 7.8 | 18.4 |
| Wall-clock fingerprint | 97 ms | 118 ms |
| Raw stream size | 2.2 KB | 10.2 KB |
| Min capture for lock | ~3.5 s | 3 s (dialogue) / 10 s (music) |
| Noise tolerance | ~80 % ceiling | OK to -24 dB; dies at -12 dB |

Landmark file size after gzip is closer to chromaprint (both are
text). For HTTP-served AFS the size difference largely vanishes.

## Honest read on v0.2

The "Shazam is magic" reputation is real **for dialogue**. For our
Subtitles demo's actual content, landmark gives a 3-second
infinity-margin lock-on, which is strictly better than chromaprint
on every axis we care about (latency, noise tolerance, false-
positive rate).

For music it's a wash with chromaprint — sometimes better, often
slower to lock. The "noise tolerance" claim doesn't extend down
to live-concert noise levels; -12 dB destroys it. -24 dB
(typical room ambient) is fine.

If we pursue v0.2:

1. The matcher state machine needs to handle **different lock-on
   latencies per content type**. Movies / dialogue lock in 3 s;
   karaoke / music takes longer.
2. The lib's peak-detection threshold is the obvious tuning
   target for further noise-resilience work. Not explored here.
3. Real-room mic capture (vs. our synthetic noise overlay) is the
   actual test that should decide the migration. The numbers here
   are encouraging but not conclusive.

## Why this lives on its own branch

This is exploratory work. The `shazam-landmark` branch holds it
so the experiment is preserved without polluting `main`. Pick it
up later via `git checkout shazam-landmark`. The branch otherwise
tracks `main` and can be rebased onto it cleanly.
