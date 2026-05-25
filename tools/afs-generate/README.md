# afs-generate

End-to-end CLI for turning a media file into an AFS v0.1 file.

```bash
# Simplest case: produces movie.afs alongside movie.mp4
./afs-generate movie.mp4

# With metadata
./afs-generate --title "My Movie" --year 2024 --language en movie.mp4

# Custom output path
./afs-generate movie.mp4 -o /tmp/custom.afs

# Skip SHA-256 for faster processing on large files
./afs-generate --no-sha256 movie.mp4
```

## What it does

1. `ffmpeg` extracts the audio track and downmixes to mono at 11025 Hz.
2. `fpcalc -raw -length 0` fingerprints the whole audio stream.
3. The sibling [`afs-format`](../afs-format/README.md) script wraps
   the integer-hash output in AFS v0.1 format with the metadata you
   supplied.

## Options

```
--title TEXT             Source title
--year INT               Source year
--imdb-id TEXT           IMDb identifier
--language CODE          Audio language (ISO 639-1 or 639-3)
--no-sha256              Skip SHA-256 computation
-o, --output PATH        Output file (default: <input>.afs)
-q, --quiet              Suppress progress output
-h, --help               Show built-in help
```

## Install

The script needs `ffmpeg` (audio extraction) and `fpcalc` from
[chromaprint](https://github.com/acoustid/chromaprint) 1.5+
(fingerprinting). One command per platform:

```bash
# macOS (Homebrew)
brew install ffmpeg chromaprint

# Debian / Ubuntu
sudo apt install ffmpeg libchromaprint-tools

# Fedora
sudo dnf install ffmpeg chromaprint-tools

# Arch
sudo pacman -S ffmpeg chromaprint
```

Also required: `bash` 4+ (pre-installed everywhere; macOS users on
system zsh still need bash 5 — `brew install bash`) and either
`sha256sum` (Linux) or `shasum -a 256` (macOS, pre-installed). The
SHA-256 step is skippable with `--no-sha256`.

`fpcalc` is not redistributed by this project; the script calls
whatever version is on your `PATH`.
