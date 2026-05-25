# Demo

The browser side of AFS Tools. Pure static files (HTML + JS + CSS,
no build step beyond the one-shot vendor copy described in the
top-level [README](../README.md#run-the-demo-locally)).

## Pages

| File | Purpose |
|---|---|
| `index.html` | The main demo. Four tabs: **Subtitles**, **Karaoke**, **Haptics**, **Generate**. The first three are bundled demos; **Generate** is a link to `generate.html`. |
| `listen.html` | Standalone microphone listener. Loads AFS + SRT from URL parameters (`?afs=…&srt=…&title=…`) or from local file pickers when no params are given. Used as the companion page on a second device. |
| `listen-haptics.html` | Listen-mode variant for the Haptics demo. Black stage; vibrates and flashes a cannon clip on detected cannon hits. |
| `generate.html` | Browser-side AFS generator. Drag-drop a media file; fingerprints locally via the WASM chromaprint module and offers the `.afs` as a download. |

## Modules (`src/`)

All ESM, no bundler. Each file does one thing and has a short
header comment explaining what and why.

- `afs-parser.js` — read AFS v0.1 TOML+body files
- `afs-writer.js` — emit AFS v0.1 files
- `afs-matcher.js` — match captured chromaprint hashes against a
  source AFS; cold-start + locked-tracking modes; offset-locked
  rendering for smooth subtitle display between matcher ticks
- `afs-mapping.js` — derived→source time mapping for the
  pre-calculated subtitles demo
- `srt-parser.js` — minimal SRT parser + cue lookup
- `subtitle-renderer.js` — cue display widget; toggleable raw vs.
  AFS-corrected time source
- `chromaprint.js` — thin wrapper over the WASM chromaprint build;
  cumulative-correct cue-time math
- `audio-capture.js` — getUserMedia + MediaElementSource capture,
  AudioWorklet-based PCM pump
- `mic-waveform.js` — small visualizer for the listen page
- `demo-session.js` — composes capture + matcher + status events
- `haptics-events.js` — schedule-ahead event scheduler for the
  Haptics demo; pause / replay / silence handling
- `debug-panel.js` — `?debug=1` URL flag opens an internal-state
  panel useful for matcher diagnostics

## Content (`content/`)

Demo media (Tears of Steel, 1812 Overture finale, Silent Night, the
Fort Snelling cannon clip), the matching AFS + SRT pairs, and the
cannon-event JSON. See [`content/README.md`](./content/README.md)
for sources and production recipes.

## Vendor (`vendor/`)

npm dependencies copied at deploy time. Not checked into git; the
top-level [README](../README.md#run-the-demo-locally) explains how
to populate it locally.
