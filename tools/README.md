# AFS CLI Tools

Bash scripts for generating AFS files and manipulating subtitle files.

## Dependencies

The CLI tools currently use the system `fpcalc` for fingerprinting,
which is fast and reliable but adds a system-level dependency. A
future version can use the same `chromaprint-wasm` package the demo
uses, running under Node.js, which would:

- Drop the `fpcalc` / `chromaprint` system dependency.
- Guarantee fingerprint consistency between the CLI and the browser
  demo (they use the exact same code path).
- Simplify cross-platform installation (especially Windows).

The trade-off is slightly slower fingerprinting (WASM in Node is
fast but not as fast as native libchromaprint). For typical media
files this is well within tolerable; the bottleneck is usually
audio decoding, not fingerprinting.

The current dependencies:

| Tool | Required by | Install |
|------|-------------|---------|
| `bash` 4+ | all | usually pre-installed; on macOS, `brew install bash` for v5 |
| `ffmpeg` | `afs-generate` | `apt install ffmpeg` / `brew install ffmpeg` |
| `fpcalc` | `afs-generate`, `afs-format` | comes with chromaprint: `apt install libchromaprint-tools` / `brew install chromaprint` |
| `sha256sum` or `shasum` | `afs-generate` (optional, can `--no-sha256`) | pre-installed on Linux/macOS |
| `awk` | `afs-format` | pre-installed everywhere |

## afs-generate

End-to-end: media file in, AFS file out.

```bash
# Simplest case: produces movie.afs alongside movie.mp4
afs-generate movie.mp4

# With metadata
afs-generate --title "My Movie" --year 2024 --language en movie.mp4

# Custom output path
afs-generate movie.mp4 -o /tmp/custom.afs

# Skip SHA-256 for faster processing on large files
afs-generate --no-sha256 movie.mp4
```

The pipeline internally runs:

1. `ffmpeg` extracts the audio track and downmixes to mono at 11025 Hz.
2. `fpcalc -raw -length 0` fingerprints the whole audio.
3. `afs-format` wraps the output in AFS v0.1 format with metadata.

## afs-format

Lower-level: takes `fpcalc -raw` output on stdin, writes AFS on stdout.

```bash
fpcalc -raw -length 0 audio.wav | afs-format --title "My Audio" > audio.afs
```

Useful when you already have an `fpcalc` output or want to script
something custom. The `afs-generate` script uses this internally.

### Options

```
--title TEXT             Source title
--year INT               Source year
--imdb-id TEXT           IMDb identifier
--language CODE          Audio language (ISO 639-1 or 639-3)
--sha256 HEX             Pre-computed SHA-256 of source file
--duration-ms INT        Source duration in ms (otherwise computed)
--generator-name TEXT    Override the "generator" metadata string
```

## transcribe-generate

Given an audio or video file, produces a time-aligned `.srt` (via
[WhisperX](https://github.com/m-bain/whisperX)) **and** a `.afs`
(via `afs-generate`) in one step. The output is the matched pair a
typical demo needs: a stream of fingerprints + a stream of synced
text.

```bash
# Audio: dialogue, podcast, lecture, song
transcribe-generate interview.mp3

# Video: movie, talk, vlog
transcribe-generate documentary.mp4

# Just the SRT
transcribe-generate --no-afs interview.mp3

# Just the AFS (skip transcription)
transcribe-generate --no-srt movie.mp4

# Different language / model
transcribe-generate --language es --model medium telenovela.mp4
```

Produces `<basename>.srt` and `<basename>.afs` next to the input
file.

### Setup

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

### A note on sung content

WhisperX is tuned for speech and produces excellent results for
dialogue, podcasts, lectures, and similar. For **sung** content
(karaoke), expect 1–2 misheard words per phrase plus occasional
dropped soft passages. The word-level *timings* are still accurate;
what's unreliable is the *text*.

Recommended karaoke workflow: run `transcribe-generate`, then open
the produced `.srt` in any editor and replace the lyric text with
the canonical lyrics, keeping the timings. (The Silent Night demo
content in `demo/content/` was authored this way — see
`demo/content/MEDIA-CHOICES.md`.)

## Examples directory walkthrough

To reproduce the demo content from raw sources:

```bash
# 1. Download Tears of Steel from mango.blender.org (CC-BY 3.0)
curl -o tearsofsteel.mp4 https://download.blender.org/durian/movies/sintel-1024-stereo.mp4

# 2. Trim to a 90-second dialogue-rich window with ffmpeg
ffmpeg -i tearsofsteel.mp4 -ss 180 -to 270 -c copy dialogue-clip.mp4

# 3. Generate AFS
afs-generate --title "Tears of Steel (excerpt)" --year 2012 --language en dialogue-clip.mp4

# 4. Trim the matching SRT to the same window (manual editing — SRT
#    timestamps are absolute, so the offset has to be applied by hand
#    or with a one-off awk script).

# 5. Cut three short segments out of the video for the Subtitles demo's
#    "edited" cut
ffmpeg -i dialogue-clip.mp4 -filter_complex "
  [0:v]trim=0:5,setpts=PTS-STARTPTS[v1];
  [0:v]trim=7:12,setpts=PTS-STARTPTS[v2];
  [0:v]trim=14:18,setpts=PTS-STARTPTS[v3];
  [0:v]trim=20:90,setpts=PTS-STARTPTS[v4];
  [v1][v2][v3][v4]concat=n=4:v=1[v];
  [0:a]atrim=0:5,asetpts=PTS-STARTPTS[a1];
  [0:a]atrim=7:12,asetpts=PTS-STARTPTS[a2];
  [0:a]atrim=14:18,asetpts=PTS-STARTPTS[a3];
  [0:a]atrim=20:90,asetpts=PTS-STARTPTS[a4];
  [a1][a2][a3][a4]concat=n=4:v=0:a=1[a]" \
  -map "[v]" -map "[a]" dialogue-clip-edited.mp4

afs-generate --title "Tears of Steel (edited)" dialogue-clip-edited.mp4
```
