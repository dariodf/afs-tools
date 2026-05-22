# TODO — what's left to do

This file tracks the remaining work to take the AFS project from
"complete skeleton with mock fingerprinter" to "working demo at
dariodf.github.io/afs-tools". Almost everything is mechanical;
the only real unknown is the WASM chromaprint API.

## Quick context

- The spec repo (`afs/`) is **complete**. Just push it.
- The implementation repo (`afs-tools/`) is **complete except for two
  TODO comments in `demo/src/chromaprint.js`** that wire up the WASM
  fingerprinter, plus content files that need to be downloaded and
  trimmed.
- 38 unit tests + 1 pipeline test + 1 import-resolution test, all
  passing. CI runs them on every push.
- GitHub Pages auto-deploy is wired up; just enable it in repo settings.

---

## Phase 1 — push the repos (~10 minutes)

### 1.1 Push `afs/` (the spec repo)

```bash
cd path/to/downloaded/afs/
git init
git add .
git commit -m "Initial AFS v0.1 spec"
git remote add origin git@github.com:dariodf/afs.git
git push -u origin main
```

### 1.2 Push `afs-tools/` (the implementation repo)

```bash
cd path/to/downloaded/afs-tools/
git init
git add .
git commit -m "Initial AFS tools and demo"
git remote add origin git@github.com:dariodf/afs-tools.git
git push -u origin main
```

### 1.3 Enable GitHub Pages for afs-tools

In the repo settings on github.com:

- Settings → Pages
- Source: **GitHub Actions**

The deploy workflow runs automatically on every push to `main`. After
the first push, the demo will be live at
`https://dariodf.github.io/afs-tools/` (modulo content files still
missing — Phase 3 fixes that).

---

## Phase 2 — wire up WASM chromaprint (~30 minutes if API is straightforward)

### 2.1 Install the package

```bash
cd afs-tools
npm install chromaprint-wasm
```

### 2.2 Read the actual API

The package is a Rust port wrapped via wasm-bindgen. Check what it
actually exports:

```bash
cat node_modules/chromaprint-wasm/README.md
ls node_modules/chromaprint-wasm/
cat node_modules/chromaprint-wasm/*.d.ts  # if TypeScript defs exist
```

My sketch in `demo/src/chromaprint.js` assumes the package looks like:

```javascript
import cp from 'chromaprint-wasm';
await cp.default();              // initialize WASM
const hashes = cp.fingerprint(int16Samples);  // returns Uint32Array
```

The real API may differ. Adjust accordingly.

### 2.3 Replace the two TODO blocks

In `demo/src/chromaprint.js`:

- The TODO inside `loadChromaprint()` (around line 38) — replace the
  `throw` with actual WASM loading.
- The TODO inside `fingerprintAudio()` (around line 60) — replace
  the `throw` with the actual call to the loaded module.
- Also update the import map in `demo/index.html` if the chromaprint
  package needs to be added (it might just work without one — Rust+wasm-bindgen
  outputs are often self-contained ESM).
- Update the deploy workflow (`.github/workflows/deploy-pages.yml`)
  to copy chromaprint-wasm to `demo/vendor/` like smol-toml is.

### 2.4 Verify

The mock fingerprinter still needs to work as a fallback for tests,
so don't remove the import of `mockFingerprint` in `app.js`. But the
custom-files demo and the live capture should now use the real one.

Run the test suite:

```bash
node test/test-runner.js          # 38 unit tests, should still pass
node test/test-demo-pipeline.js   # smoke test
node test/test-imports.js         # import resolution check
```

If the API was different than expected, the smoke test won't change
(it uses mockFingerprint), but the demo in a browser will reveal
problems. Open the demo locally and try the custom-files flow with
any audio file.

---

## Phase 3 — content production (~90 minutes)

This produces the actual media files the demos load. Everything is
documented in `demo/content/README.md` but here's the linear sequence.

### 3.1 Download sources

```bash
cd demo/content
bash fetch-content.sh
```

This downloads:
- `tearsofsteel-full.mp4` (Tears of Steel, ~120 MB)
- `tearsofsteel.en.srt` (Wikimedia Commons SRT)
- `1812-overture-full.mp3` (Skidmore College Orchestra recording, ~22 MB)

### 3.2 Manual download — cannon video

NCpedia doesn't have a programmatic download URL. Open
<https://ncpedia.org/media/video/firing-18th-century> in a browser,
right-click the video, "Save video as", save to
`demo/content/cannon-shot-source.mp4`.

License: CC-BY-ND 4.0 (no modifications allowed beyond clipping for
length — fine for our use).

### 3.3 Trim Tears of Steel to a 90-second dialogue-rich window

The full film is 12 minutes. Pick a window with continuous dialogue.
Watching minute 3-5 usually gives a good window. Adjust `-ss` and
`-to` based on what's actually dialogue-heavy in this recording.

```bash
# Pick the window first by previewing
ffplay -ss 180 -t 90 tearsofsteel-full.mp4

# Once you've found a good 90-second window:
ffmpeg -i tearsofsteel-full.mp4 -ss 180 -to 270 -c copy dialogue-clip.mp4
```

Adjust the start/end seconds to whatever window has clear dialogue.

### 3.4 Trim SRT to the same window

The Wikimedia Commons SRT covers the whole film. Trim it to the
window you used in 3.3, and shift timestamps so the SRT starts at 0.

Easiest: open `tearsofsteel.en.srt` in a text editor, copy out the
cues that fall within your window, paste into a new
`dialogue-clip.en.srt`, then shift them down by your offset (180s in
the example above):

```bash
../../tools/srt-shift -180 dialogue-clip-raw.en.srt > dialogue-clip.en.srt
```

(`srt-shift` accepts negative values to shift earlier; it drops
cues that would end up with negative timestamps.)

### 3.5 Generate the shifted SRT

```bash
../../tools/srt-shift 2 dialogue-clip.en.srt > dialogue-clip.en.shifted.srt
```

### 3.6 Generate the edited video (3 cuts in first 20s)

```bash
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
```

### 3.7 Trim 1812 Overture to the finale (~90 seconds)

The full overture is ~16 minutes. The cannon finale is in the last
~2 minutes. Preview to find where it starts:

```bash
ffplay -ss 850 1812-overture-full.mp3   # adjust until you hear cannons
```

Once you've identified the finale start (typically around 14:00 in
the Skidmore recording):

```bash
ffmpeg -i 1812-overture-full.mp3 -ss FINALE_START -to FINALE_END \
  -c copy overture-finale.mp3
```

### 3.8 Trim the cannon clip to ~1 second

```bash
ffmpeg -i cannon-shot-source.mp4 -ss 5 -t 1 -c copy cannon-shot.mp4
```

(Adjust `-ss` to find the actual firing moment in the source clip.)

### 3.9 Hand-annotate cannon timings

This is the one task that needs human ears.

Play `overture-finale.mp3` and note the time (in milliseconds) of
each cannon hit. Edit `demo/content/overture-finale-cannons.json`
and replace the placeholder times with real ones.

Format:

```json
{
  "events": [
    { "time_ms": 18000, "type": "cannon", "label": "Cannon 1" },
    ...
  ]
}
```

There are typically 8-16 cannons in the finale depending on the
performance. ~15 minutes of work with headphones and a clock.

### 3.10 Generate AFS files

```bash
cd demo/content
../../tools/afs-generate --title "Tears of Steel (excerpt)" --year 2012 \
  --language en dialogue-clip.mp4

../../tools/afs-generate --title "Tears of Steel (edited)" --year 2012 \
  --language en dialogue-clip-edited.mp4

../../tools/afs-generate --title "1812 Overture (finale)" \
  --language en overture-finale.mp3
```

This produces `dialogue-clip.afs`, `dialogue-clip-edited.afs`, and
`overture-finale.afs`. Commit these (they're small text files).

The large media files (`*.mp4`, `*.mp3`) are in `.gitignore` and
**should not be committed**. They're served from GitHub Pages as
static assets — push them via the deploy workflow's `demo/` upload,
or alternatively host them on GitHub Releases and update the demo
URLs to point at the release. See "media hosting" below.

### 3.11 Media hosting decision

**Option A** (simplest): commit the media files. Total ~50 MB,
well within GitHub's 100 MB/file and 1 GB/repo limits. The deploy
workflow uploads them as Pages artifacts. Trade-off: clones become
larger.

**Option B** (cleaner): upload media files to a GitHub Release, fetch
them at deploy time via a `curl` step in the workflow, never commit
them to git. Trade-off: more workflow complexity.

Recommendation: **Option A** at this scale. Revisit if the demo
grows to multiple hours of media.

If you choose Option A: remove `demo/content/*.mp4` and `*.mp3` from
`.gitignore`, then `git add` the files.

---

## Phase 4 — the smoke test (~5 minutes)

This is the only thing only you can do: the phone-and-speakers test.

1. Open the deployed demo on a laptop: `https://dariodf.github.io/afs-tools/`
2. Pick the haptics demo, mode: direct. Play the overture.
3. Confirm the cannons fire visually at the right moments (proves
   AFS works in same-device mode).
4. On a phone, open the same URL.
5. Switch the phone to mic mode (or scan the QR code from the laptop).
6. Hold the phone near the laptop's speakers, play the overture on
   the laptop.
7. Confirm the phone fires cannons in sync.

If yes: ship it, tweet it, you're done.

If the matcher locks on only sometimes, or with bad confidence:
notes below.

---

## Troubleshooting if Phase 4 doesn't work

### Matcher never locks on

Possible causes, in order of likelihood:

- **WASM chromaprint output format mismatch.** Maybe it returns
  signed ints instead of unsigned, or has a different byte order than
  expected. Compare `fpcalc -raw -length 0 file.mp3` output to
  what the WASM produces on the same file via the browser console.
- **Resampling drift.** The audio-capture module resamples to 11025
  Hz; if the source is at 48000 Hz or 44100 Hz, small interpolation
  errors might accumulate. Check by feeding the audio-capture output
  back through the fingerprinter offline.
- **Mic gain too low.** Some browsers/devices have aggressive auto
  gain control. The audio worklet samples raw PCM; if they're all
  near zero, fingerprints are noise. Add a log of `max(abs(samples))`
  to verify.

### Matcher locks on with low confidence (~40-60%)

This is normal under noisy conditions. Adjust the matcher's
`confidenceThreshold` (currently 60) down to 50 or 45 in
`demo/src/demo-session.js`. Real chromaprint tolerates a lot of
noise; the threshold can be relaxed.

### Cold start takes more than 5 seconds

Check that `coldStartMinHashes` (currently 24) isn't too high.
24 hashes is ~3 seconds of audio. Lowering to 16 (~2 seconds) makes
cold start faster but increases false positives.

### iOS Safari has issues

Known limitations:
- No `navigator.vibrate` support (the haptics visual still works).
- Fullscreen API has quirks; the auto-fullscreen on demo start may
  silently fail. The demo still works, just without fullscreen.
- AudioContext may need to be resumed after a user gesture even when
  one already happened. If audio capture appears silent, add a tap
  handler that calls `audioContext.resume()`.

---

## Phase 5 — polish and announce (optional, post-launch)

- Add a "Star us on GitHub" link.
- Tweet the demo with a 30-second video of the haptics demo working.
- Submit to Hacker News with title "AFS: sync subtitles to audio via
  fingerprinting, no network needed".
- Open an issue in the BBC R&D repo or contact the IBM patent
  authors as a courtesy, since you're publicizing the same idea
  (per the prior-art notes in the spec repo). Optional but
  professional.

---

## Summary: how long this actually takes

| Phase | Time | Blocked on |
|-------|------|-----------|
| 1. Push repos | 10 min | nothing |
| 2. WASM wiring | 30 min | npm + reading the chromaprint-wasm API |
| 3. Content production | 90 min | downloads, ffmpeg, you listening to cannons |
| 4. Smoke test | 5 min | a phone and a laptop |
| **Total** | **~2.5 hours** | |

vs. the 4-6 weekend estimate from the implementation spec. The
estimate was for someone starting from scratch. What you have now is
done — this is execution.

Phase 3.9 (cannon annotations) is the only task that genuinely needs
a human listener. Everything else can be automated or scripted.

If Phase 4 surfaces real WASM problems, add a few hours; still
nowhere near a weekend.
