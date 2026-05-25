# AFS Tools

Reference implementation and demo for [AFS — Audio Fingerprint Sync](https://github.com/dariodf/afs).

## What's here

```
afs-tools/
├── tools/                     # CLI generator scripts (bash)
│   ├── afs-generate           # Media file → .afs (uses ffmpeg + fpcalc + afs-format)
│   ├── afs-format             # fpcalc output → AFS v0.1 format
│   └── transcribe-generate    # Media → .srt + .afs (uses WhisperX + afs-generate)
├── demo/                      # Browser-based AFS player and demos
│   ├── index.html             # Three demos: subtitles, karaoke, haptics + your-own-files
│   ├── app.js                 # UI orchestration
│   ├── style.css
│   └── src/                   # Reusable modules (parser, matcher, capture, etc.)
└── test/                      # Test runner and tests
```

## Quick start

### Generate an AFS file

```bash
# Requires ffmpeg and fpcalc (from chromaprint) on PATH.
./tools/afs-generate movie.mp4
# Produces movie.afs
```

### Generate an AFS + time-aligned SRT in one step

For new demo content (subtitles, karaoke, etc.):

```bash
# Requires WhisperX in a local virtualenv (see tools/README.md).
./tools/transcribe-generate movie.mp4
# Produces movie.srt and movie.afs
```

The script transcribes the audio with [WhisperX](https://github.com/m-bain/whisperX)
for word-level timings, then runs `afs-generate` for the fingerprint
stream. Works for both speech (excellent) and singing (good timings,
expect to hand-edit the text). See `tools/README.md` for the full
workflow.

### Run the demo locally

The demo is a static site. From the repo root:

```bash
npm install
# Copy npm-installed deps where the import map expects them
mkdir -p demo/vendor/smol-toml demo/vendor/qrcode-generator
cp node_modules/smol-toml/dist/*.js demo/vendor/smol-toml/
cp node_modules/qrcode-generator/dist/qrcode.mjs demo/vendor/qrcode-generator/index.mjs

cd demo && python3 -m http.server 8000
```

Then open <http://localhost:8000> in a browser. For microphone access
on most browsers, `localhost` is treated as a secure context; deployed
versions require HTTPS.

### Deploy to GitHub Pages

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`)
deploys the demo to GitHub Pages automatically on push to `main`. It
runs the test suite first; if tests fail, the deploy is blocked.

To set up Pages for your fork: in repo settings → Pages, set "Source"
to "GitHub Actions". The next push to main will trigger a build and
publish the demo at `https://<username>.github.io/afs-tools/`.

### Run the tests

```bash
node test/test-runner.js
```

The test suite covers the AFS parser, matcher (offset-locked
rendering, cut consistency, mic/direct capture, drift over long
sources), SRT parser, writer, and the haptics event scheduler.

## Status

v0.1 release candidate. The AFS parser, matcher, SRT parser, writer,
and haptics event scheduler are implemented and tested. CLI tools
(`afs-format`, `afs-generate`, `transcribe-generate`) are implemented. The browser demo runs three live
demos (subtitles desync, karaoke, haptics), all driven by real-time
chromaprint fingerprinting in WebAssembly (via
`@unimusic/chromaprint`). A companion `listen.html` page works on
a second device's microphone for cross-device sync.

Known gaps before broader release:
- Long-form video (1–2 h source AFS) — chromaprint's per-tick
  matcher cost is O(N) in the source length; verified-on-short-
  form, longer content pending. See `ROADMAP.md`.
- A potential v0.2 migration to Shazam-style landmark fingerprinting
  is documented in `ROADMAP.md` but deferred. v0.1 ships with
  chromaprint because of its existing ecosystem (libchromaprint,
  fpcalc, language bindings) — anyone writing a plugin for VLC,
  mpv, or similar already has a chromaprint library available.

## Dependencies

### System binaries

The CLI tools shell out to `ffmpeg` (audio extraction) and `fpcalc`
from [chromaprint](https://github.com/acoustid/chromaprint) 1.5+
(fingerprinting). Install both with one command for your platform:

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
the system zsh still need bash — `brew install bash` for v5) and
either `sha256sum` (Linux) or `shasum -a 256` (macOS, pre-installed).

We do **not** redistribute `fpcalc`; the script calls whatever
version is on your `PATH`. The browser demo ships a separate
WASM build of chromaprint under `demo/vendor/` (see `NOTICE` for
the LGPL-2.1 attribution and replacement procedure).

Optional (only for `tools/transcribe-generate`): Python 3.10–3.12
plus a local virtualenv with `whisperx`. See `tools/README.md`
for the setup. Demo visitors never need this.

### Demo (browser side)

- Modern browser with Web Audio API and AudioWorklet support.
- HTTPS (or `localhost`) for microphone access.
- The browser uses [`@unimusic/chromaprint`](https://github.com/unimusic-app/unimusic-chromaprint)
  (Emscripten WASM build of chromaprint) for in-browser
  fingerprinting. Bundled via `demo/vendor/` by the deploy
  workflow; no install needed by the visitor.

## License

Apache License 2.0.
