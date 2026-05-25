# AFS CLI Tools

Bash scripts for generating and manipulating AFS files. Each tool
lives in its own subdirectory with focused documentation:

- [`afs-generate/`](./afs-generate/) — media file → AFS. The
  everyday tool.
- [`afs-format/`](./afs-format/) — lower-level: `fpcalc -raw`
  output → AFS. Used by `afs-generate` internally; handy on its
  own when you already have an fpcalc stream.
- [`transcribe-generate/`](./transcribe-generate/) — media file →
  time-aligned SRT (via WhisperX) **and** AFS, in one step.
- [`afs-minimize/`](./afs-minimize/) — drop AFS hashes outside
  subtitle coverage windows. Useful for sparse-cue content and
  for distributing AFS files outside HTTP.

System dependencies live in the per-tool READMEs. `afs-generate`
needs `ffmpeg` + `fpcalc` from chromaprint;
[`afs-generate/`](./afs-generate/#install) has install commands
for the common platforms. `transcribe-generate` adds Python +
WhisperX; see [`transcribe-generate/`](./transcribe-generate/).
