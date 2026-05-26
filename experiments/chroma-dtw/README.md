# Chroma + DTW exploration

Spike code for cross-performance audio alignment via chroma
vectors and dynamic time warping. The setting question: can AFS
sync against a *different performance* of the same piece, not
just the same recording?

Findings live in [FINDINGS.md](./FINDINGS.md). This README covers
setup and running the tests.

## Setup

The spike uses the existing `.venv-whisperx` virtualenv (the one
the karaoke content-authoring pipeline uses) with `librosa` and
`matplotlib` added.

```bash
# From the repo root
.venv-whisperx/bin/pip install librosa matplotlib
```

That's it. WhisperX is also useful (for verifying alignments by
transcribing recordings) but optional.

## Running

```bash
cd experiments/chroma-dtw
~/dariodf/afs-tools/.venv-whisperx/bin/python spike.py [test_number]
```

Tests:

- `spike.py 1` — controlled self-DTW (time-stretched copy of
  Silent Night). Sanity check: should produce a clean diagonal
  path at the expected slope.
- `spike.py 2` — 1990 vs 2006 USAF Silent Night, subseq-DTW.
  Demonstrates the strophic-verse failure case.
- `spike.py 3` — Lazzaro 1926 vs Cortis 1929 Nessun dorma,
  full DTW. Through-composed: should align cleanly.
- `spike.py 4` — Beethoven 5 1st movement, two performances.
  Motif-saturated: tests whether path-monotonicity prevents
  jumps between motif occurrences. Also compares chroma-only
  vs chroma+onset features.
- `spike.py 5` — localization stress: extract slices from a
  reference and ask subseq-DTW to find them. Varies capture
  window sizes (5/15/30 s) to test whether longer context
  resolves ambiguity.

`spike.py` with no argument runs all five.

Test fixtures (audio files) get downloaded to `/tmp/afs-chroma-dtw/`
on first run. ~30 MB total across all five tests.

## Plots

Each test that runs DTW writes an alignment plot to
`/tmp/afs-chroma-dtw/`. The path overlaid on the cost matrix
shows visually whether the alignment is well-behaved (diagonal,
monotonic) or pathological (horizontal stalls, jumps).
