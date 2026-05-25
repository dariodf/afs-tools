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

### Use the listen page with your own files

`demo/listen.html` is a self-contained AFS player: open it in a
browser, point it at an AFS + SRT pair, and a second device's
microphone follows along with whatever audio it hears. The page is
usable without any of the bundled demos, so you can host your own
AFS file somewhere and share a one-link experience.

Two ways to point it at files:

**1. URL parameters** (best for shareable links):

```
https://<your-deploy>/listen.html
  ?afs=https://example.com/my-movie.afs
  &srt=https://example.com/my-movie.en.srt
  &title=My%20Movie
```

All three params (`afs`, `srt`, `title`) are independent — supply
any subset; the page will show file pickers for the missing ones.

**2. Local files** (best for "I generated an AFS, transferred it
to my phone"): open `listen.html` with no parameters and use the
file pickers to load `.afs` and `.srt` from local storage. Nothing
uploads.

**CORS caveat.** When using URL parameters that point to a
different origin than the page is hosted on, your file server must
return `Access-Control-Allow-Origin` headers permitting the page's
origin. GitHub Pages, Netlify, Vercel, and most public S3 buckets
do this by default. Private servers or strict CDN setups may
block the fetch with a CORS error — that's on the file host to
configure, not on the player.

### AFS file size and HTTP compression

AFS files are plain text — a TOML header followed by one
`time_ms <hash>` line per chromaprint frame (~8 per second). Each
hash is encoded as a decimal integer, so the file has a lot of
structural redundancy that gzip absorbs easily.

Measured on a 113-minute feature film:

| | Raw | gzip | xz |
|---|---|---|---|
| AFS file | 963 KB | **418 KB (43 %)** | 298 KB (31 %) |

GitHub Pages, Netlify, Vercel, and every modern CDN apply
gzip (or brotli) on `Content-Encoding` automatically for text
responses, so a visitor's phone downloads the compressed
version even though the file on disk looks bigger. A 2-hour
movie's AFS arrives over the wire as ~300-400 KB — smaller
than a moderately compressed image.

If you're moving AFS files outside HTTP (AirDrop, email, USB),
plain `gzip` cuts the file to ~43 % of its raw size with no
information loss. `tools/afs-minimize` can shave a further few
percent for dialogue-driven content; the win grows substantially
for *sparse* subtitle content (karaoke, audiobooks with chapter
breaks). See `tools/README.md`.

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
