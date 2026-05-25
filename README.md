# AFS Tools

Reference implementation and demo for
[AFS — Audio Fingerprint Sync](https://github.com/dariodf/afs).

**What AFS does.** AFS fingerprints any audio into a small stream of
time cues. Any device hearing that audio — through its own speakers,
or through a microphone listening to another device — matches the
fingerprints to its current position and stays in sync with the
source in real time. No network connection between the devices, no
clock sync, no companion app: just audio.

**What's in this repo.** Three demos that show what that enables:

- **Subtitles** — a 90-second movie clip whose subtitles stay
  correct even after three short cuts shift the timeline.
- **Karaoke** — a 1:55 Silent Night recording; open the listen page
  on your phone and the lyrics appear in sync with whatever device
  is playing the song.
- **Haptics** — the 1812 Overture finale; your phone vibrates and
  flashes a cannon on every cannon hit.

Plus a browser-side **Generate** tool for making your own AFS files
from media you have locally, a standalone **listen.html** page any
device can use as a microphone-driven sync player, and a small Bash
CLI in `tools/`.

## What's here

```
afs-tools/
├── tools/                       # Bash CLIs, one folder per tool
│   ├── afs-format/              # fpcalc raw output → AFS v0.1
│   ├── afs-generate/            # media file → AFS
│   ├── afs-minimize/            # drop AFS hashes outside subtitle windows
│   └── transcribe-generate/     # media → SRT + AFS (uses WhisperX)
├── demo/                        # Browser-based AFS player and demos
│   ├── index.html               # Subtitles, Karaoke, Haptics, Generate tabs
│   ├── generate.html            # Browser-side AFS generator
│   ├── listen.html              # Standalone mic-mode listener
│   ├── app.js
│   ├── style.css
│   └── src/                     # Reusable modules (parser, matcher, capture, etc.)
└── test/                        # Test runner and tests
```

## Quick start

### Generate an AFS file

```bash
# Requires ffmpeg and fpcalc (from chromaprint) on PATH.
./tools/afs-generate/afs-generate movie.mp4
# Produces movie.afs
```

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

## Use the listen page with your own files

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
do this by default. Private servers or strict CDN setups may block
the fetch with a CORS error — that's on the file host to configure,
not on the player.

## Status

v0.1 release candidate. The AFS parser, matcher, SRT parser,
writer, and haptics event scheduler are implemented and tested.
The browser demo runs three live demos (subtitles desync, karaoke,
haptics), all driven by real-time chromaprint fingerprinting in
WebAssembly (via `@unimusic/chromaprint`). A companion
`listen.html` page works on a second device's microphone for
cross-device sync, and a `generate.html` page produces AFS files
in the browser for your own content.

AFS files are plain text and gzip-friendly — a 2-hour movie's AFS
is ~1 MB raw, ~400 KB over `Content-Encoding: gzip` (which every
modern CDN applies automatically).

A potential v0.2 migration to Shazam-style landmark fingerprinting
is documented in `ROADMAP.md` but deferred. v0.1 ships with
chromaprint because of its existing ecosystem (libchromaprint,
fpcalc, language bindings) — anyone writing a plugin for VLC, mpv,
or similar already has a chromaprint library available.

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
version is on your `PATH`. The browser demo ships a separate WASM
build of chromaprint under `demo/vendor/` (see `NOTICE` for the
LGPL-2.1 attribution and replacement procedure).

Optional (only for `transcribe-generate`): Python 3.10–3.12 plus a
local virtualenv with `whisperx`. See
[`tools/transcribe-generate/`](./tools/transcribe-generate/) for
setup. Demo visitors never need this.

### Demo (browser side)

- Modern browser with Web Audio API and AudioWorklet support.
- HTTPS (or `localhost`) for microphone access.
- The browser uses
  [`@unimusic/chromaprint`](https://github.com/unimusic-app/unimusic-chromaprint)
  (Emscripten WASM build of chromaprint) for in-browser
  fingerprinting. Bundled via `demo/vendor/` by the deploy
  workflow; no install needed by the visitor.

## Tools

The CLI lives under [`tools/`](./tools/). Each tool has its own
folder with focused docs:

- [`tools/afs-generate/`](./tools/afs-generate/) — media file → AFS.
  The everyday tool.
- [`tools/afs-format/`](./tools/afs-format/) — lower-level:
  `fpcalc -raw` output → AFS. Used by `afs-generate` internally;
  handy on its own when you already have an fpcalc stream.
- [`tools/transcribe-generate/`](./tools/transcribe-generate/) —
  media → time-aligned SRT (via WhisperX) **and** AFS, in one step.
- [`tools/afs-minimize/`](./tools/afs-minimize/) — drop AFS hashes
  outside subtitle coverage windows. Useful for sparse-cue content
  and for distributing AFS files outside HTTP.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to run tests,
add content, and submit changes.

## License

Apache License 2.0.
