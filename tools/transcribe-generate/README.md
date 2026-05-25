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
```

Produces `<basename>.srt` and `<basename>.afs` next to the input
file.

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
(karaoke), expect 1–2 misheard words per phrase plus occasional
dropped soft passages. The word-level *timings* are still
accurate; what's unreliable is the *text*.

Recommended karaoke workflow: run `transcribe-generate`, then open
the produced `.srt` in any editor and replace the lyric text with
the canonical lyrics, keeping the timings. The Silent Night demo
content in [`demo/content/`](../../demo/content/) was authored
this way; `demo/content/silent-night.srt` is what the corrected
pair looks like.
