# transcribe-generate

Given an audio or video file, produces a time-aligned `.srt` (via
[WhisperX](https://github.com/m-bain/whisperX)) **and** a `.afs`
(via [`afs-generate`](../afs-generate/README.md)) in one step. The
output is the matched pair a typical demo needs: a stream of
fingerprints + a stream of synced text.

```bash
# Audio: dialogue, podcast, lecture, song
./transcribe-generate interview.mp3

# Video: movie, talk, vlog
./transcribe-generate documentary.mp4

# Just the SRT
./transcribe-generate --no-afs interview.mp3

# Just the AFS (skip transcription)
./transcribe-generate --no-srt movie.mp4

# Different language / model
./transcribe-generate --language es --model medium telenovela.mp4

# You already have the transcript — align it instead of transcribing
./transcribe-generate --transcript screenplay.txt movie.mp4
./transcribe-generate --transcript existing.srt movie.mp4
```

Produces `<basename>.srt` and `<basename>.afs` next to the input
file.

## --transcript: align an authoritative transcript

If you already have the words — an official screenplay, known song
lyrics, an existing SRT with bad timings — feed them in with
`--transcript PATH` and the script skips Whisper's ASR stage,
running only WhisperX's wav2vec2 forced-alignment.

Alignment quality is excellent because the model only has to find
*when* each known word occurs, not *what* was said. Whisper mishears
words; alignment doesn't (it works with the text you gave it).

Accepted transcript formats:

- **`.srt`** — segmentation and rough timings are used as initial
  estimates; alignment refines them. Existing-but-drifted SRTs are
  the canonical use case.
- **anything else** — treated as plain text. Sentences are split
  heuristically; initial timings are distributed evenly across the
  audio. The alignment model is robust to large initial offsets, so
  this works even if the text has no timing info at all.

This is the preferred workflow for karaoke and any case where the
authoritative text exists — better than transcribing and then
hand-editing.

## Setup

WhisperX is a heavier dependency than the rest of the CLI. Install
it into a project-local virtualenv so the script picks it up
automatically:

```bash
# From the repo root.
python3 -m venv .venv-whisperx
.venv-whisperx/bin/pip install --upgrade pip wheel
.venv-whisperx/bin/pip install whisperx
```

WhisperX requires Python 3.10–3.12. If your `python3` is newer,
install 3.12 first (asdf, pyenv, mise). First run downloads model
weights (~150 MB for `small`, ~1.5 GB for `large-v3`) into your
user cache.

## A note on sung content

WhisperX is tuned for speech and produces excellent results for
dialogue, podcasts, lectures, and similar. For **sung** content
(karaoke), Whisper's ASR mishears 1–2 words per phrase and
sometimes drops soft passages. The word-level *timings* are still
accurate; what's unreliable is the *text*.

The clean fix is to skip ASR entirely:

```bash
./transcribe-generate --transcript silent-night.txt silent-night.mp3
```

Paste the canonical lyrics into a text file (one sentence per line
is fine; the alignment model handles segmentation) and pass them
in. The alignment stage runs against your text instead of guessing,
producing a `.srt` with both correct lyrics *and* correct timings
in one shot.

The Silent Night demo content in
[`demo/content/`](../../demo/content/) was originally authored by
running full transcription and then hand-editing the lyric text;
`--transcript` is the equivalent without the hand-edit step.
