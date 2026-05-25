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

## Dependencies

- `bash` 4+
- `ffmpeg`
- `fpcalc` from chromaprint (1.5+)
- `sha256sum` (Linux) or `shasum -a 256` (macOS) — optional
  with `--no-sha256`

See the top-level [README's install table](../../README.md#system-binaries).
