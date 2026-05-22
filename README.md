# AFS Tools

Reference implementation and demo for [AFS — Audio Fingerprint Sync](https://github.com/dariodf/afs).

## What's here

```
afs-tools/
├── tools/                # CLI generator scripts (bash)
│   ├── afs-generate      # Media file → .afs (uses ffmpeg + fpcalc + afs-format)
│   ├── afs-format        # fpcalc output → AFS v0.1 format
│   └── srt-shift         # Shift all SRT timestamps by N seconds
├── demo/                 # Browser-based AFS player and demos
│   ├── index.html
│   ├── app.js            # UI orchestration
│   ├── style.css
│   └── src/              # Reusable modules (parser, matcher, capture, etc.)
└── test/                 # Test runner and tests
```

## Quick start

### Generate an AFS file

```bash
# Requires ffmpeg and fpcalc (from chromaprint) on PATH.
./tools/afs-generate movie.mp4
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

30 tests cover the AFS parser, matcher, SRT parser, and writer.

## Status

v0.0.1. The AFS parser, matcher, SRT parser, and writer modules are
implemented and tested. CLI tools (`afs-format`, `afs-generate`,
`srt-shift`) are implemented. The WASM chromaprint module that the
browser uses for live audio fingerprinting is currently a stub; live
matching demos use a mock fingerprinter for development. The full
implementation status is tracked in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Dependencies

CLI tools:
- bash 4+
- ffmpeg (any recent version)
- fpcalc (from [chromaprint](https://github.com/acoustid/chromaprint), 1.5.0+)
- sha256sum (Linux) or shasum -a 256 (macOS)

Demo:
- Modern browser with Web Audio API and AudioWorklet support
- HTTPS or localhost for microphone access

## License

Apache License 2.0.
