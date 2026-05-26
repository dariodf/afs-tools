# Shazam-style landmark fingerprinting — derisk experiment

This folder holds the afternoon-of-glue-code experiment described
in [ROADMAP.md](../../ROADMAP.md): does Wang-2003-style landmark
fingerprinting actually work on our demo content well enough to
justify a v0.2 migration away from chromaprint?

Findings live in [FINDINGS.md](./FINDINGS.md). This README covers
setup and running the tests.

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
of the audio (at 20 %, 50 %, 80 % positions) and looks them up
against the index. Reports the winning time-offset and its margin
over the runner-up.

Set `SLICE_SEC=3` (or 10, etc.) to vary capture length.

If `noise-db` is given (e.g. `-24`), overlays white noise at that
level onto the slice before fingerprinting. -24 dB approximates
room ambient; -18 dB is heavy noise; -12 dB destroys things.

```bash
SLICE_SEC=3  node match-test.mjs ../../demo/content/dialogue-clip.mp4
SLICE_SEC=10 node match-test.mjs ../../demo/content/overture-finale.mp3 -24
```

## Why this lives on its own branch

Exploratory work. The `shazam-landmark` branch holds it so the
experiment is preserved without polluting `main`. Pick it up later
via `git checkout shazam-landmark`. The branch otherwise tracks
`main` and can be rebased onto it cleanly.
