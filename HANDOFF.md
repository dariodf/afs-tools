# TODO — what's left to do

This file tracks the remaining work to take the AFS project from
"complete skeleton with mock fingerprinter" to "working demo at
dariodf.github.io/afs-tools".

## Status (2026-05-22)

Work completed in the licensing + WASM session:

- Spec repo (`afs/`) finalized. Switched license to CC0 1.0
  Universal. Time cues in the body switched from microseconds to
  milliseconds, with a non-normative Appendix A.1 specifying
  cumulative-correct rounding so different generators produce
  identical cue sequences. SHA-256 redefined as a hash of the
  source file bytes. Other small clarifications (whitespace
  tolerance in the body, minor-version-acceptance rule, inline
  comments disallowed, `[metadata.audio]` source-side wording).
  Stale `IMPLEMENTATION.md` removed.
- Tools repo (`afs-tools/`) finalized for licensing: LICENSE
  copyright filled in, NOTICE added covering chromaprint
  (LGPL-2.1), `@unimusic/chromaprint` (MIT), smol-toml (MIT),
  qrcode-generator (MIT). CC-BY-ND removed from accepted licenses
  in CONTRIBUTING.md.
- **WASM chromaprint wired up**, using `@unimusic/chromaprint`
  (Emscripten WASM build of AcoustID chromaprint, MIT-wrapped
  LGPL-2.1). `demo/src/chromaprint.js` now loads it via dynamic
  `import()` (Node-safe — tests still use mockFingerprint).
- Source-side µs→ms sync across parser, writer, matcher,
  demo-session, bash CLIs, and tests.
- afs-generate now hashes the original input file (per the
  updated spec) instead of the extracted PCM audio.
- Test suites: 4 of them, all green — `test-runner.js` (42),
  `test-matcher-robustness.js` (13), `test-demo-pipeline.js`,
  `test-imports.js` (23 files in the import graph after vendoring
  the new chromaprint module).
- Local repos created and committed at `~/dariodf/afs` and
  `~/dariodf/afs-tools`, **not yet pushed** (waiting on a
  browser-side smoke test of the live demo).
- Cannon-clip source switched from CC-BY-ND NCpedia to a Public
  Domain US Army Signal Corps WWI howitzer clip on Wikimedia
  Commons (see `demo/content/MEDIA-CHOICES.md`).

Remaining gates to a live, working demo:

1. Browser-side smoke test of the WASM integration (custom-files
   demo: upload audio → AFS generated → matcher locks on
   playback). See Phase 2.4 below.
2. Phase 3: content production — `fetch-content.sh` is now fully
   automated; manual work is the trim/SRT/JSON steps and cannon
   timings.
3. Phase 4: phone-mic smoke test.

## Quick context

- The spec repo (`afs/`) is **complete and committed locally**.
- The implementation repo (`afs-tools/`) is **complete except for**
  content production (Phase 3) and the live-browser verification
  step. The WASM integration that was the original blocker is wired.
- 4 test suites, ~56 tests + pipeline + import graph, all passing.
  CI runs them on every push.
- GitHub Pages auto-deploy is wired up; just enable it in repo
  settings after first push.

---

## Phase 1 — push the repos (DONE locally)

Both GitHub repos exist (private, `dariodf/afs` and
`dariodf/afs-tools`) and have a first commit on `main` locally.
They have **not** been pushed yet, by deliberate choice — push
only after a successful browser-side smoke test in Phase 2.4.

When ready to push:

```bash
git -C ~/dariodf/afs push -u origin main
git -C ~/dariodf/afs-tools push -u origin main
```

After pushing afs-tools, enable Pages in the repo settings:
Settings → Pages → Source: **GitHub Actions**. The deploy
workflow runs automatically on subsequent pushes to `main` and
publishes the demo at `https://dariodf.github.io/afs-tools/`.

---

## Phase 2 — wire up WASM chromaprint (DONE; browser verification still owed)

The originally-named `chromaprint-wasm` package (2018) turned out to
be unusable: it only exposes a base64-compressed fingerprint string,
not the raw uint32 hashes AFS needs, and its module-loading pattern
is bundler-dependent. Switched to **`@unimusic/chromaprint`** (2025),
an Emscripten WASM build of the AcoustID chromaprint library with
the full C API exposed.

The integration in `demo/src/chromaprint.js` calls the WASM C API
directly (`_chromaprint_new` / `_start` / `_feed` / `_finish` /
`_get_raw_fingerprint`) and reads uint32 hashes out of HEAP32. The
@unimusic high-level wrapper's raw-output path has a bug (reads the
data pointer before the call populates it); we skip that wrapper.

`loadChromaprint()` uses a dynamic `import()` so the Emscripten glue
(which asserts `ENVIRONMENT_IS_WEB` at module-load time) is only
fetched at runtime in a browser. Node-side tests never call
`loadChromaprint()` — they use `mockFingerprint` — so the import
never fires under Node and tests stay green.

What's bundled:

- `demo/vendor/@unimusic/chromaprint/chromaprint.js` (Emscripten
  glue, ~43 KB)
- `demo/vendor/@unimusic/chromaprint/chromaprint.wasm` (~107 KB)
- `demo/vendor/@unimusic/chromaprint/LICENSE.md`
- Import map entry in `demo/index.html`
- Workflow vendors all three files in the Pages deploy step

### 2.4 Browser-side smoke test (still owed)

Tests use the mock fingerprinter; they can't exercise the real WASM
path. Run locally:

```bash
cd ~/dariodf/afs-tools
# Re-vendor if you've blown away demo/vendor/:
mkdir -p demo/vendor/smol-toml demo/vendor/qrcode-generator demo/vendor/@unimusic/chromaprint
cp node_modules/smol-toml/dist/*.js demo/vendor/smol-toml/
cp node_modules/smol-toml/LICENSE demo/vendor/smol-toml/LICENSE
cp node_modules/qrcode-generator/dist/qrcode.mjs demo/vendor/qrcode-generator/index.mjs
cp node_modules/@unimusic/chromaprint/dist/chromaprint.{js,wasm} demo/vendor/@unimusic/chromaprint/
cp node_modules/@unimusic/chromaprint/LICENSE.md demo/vendor/@unimusic/chromaprint/

cd demo && python3 -m http.server 8000
```

Open <http://localhost:8000>, pick the "Use your own files..." demo,
upload any short audio file, and confirm:

1. An AFS file downloads with a non-empty body.
2. Parsing it back round-trips through `parseAFS()` without errors.
3. Playing the audio back in direct mode makes the matcher lock on.

Once that works, the WASM path is verified and the project is ready
to push and deploy.

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

### 3.2 Cannon video (now automated)

`fetch-content.sh` pulls a Public Domain US Army Signal Corps WWI
howitzer clip from Wikimedia Commons
(`9.2inchhowitzerfiringWWI.ogv`). No manual download step.

License: Public Domain (PD-USGov, 17 USC §105 + CC Public Domain
Mark 1.0). See `demo/content/MEDIA-CHOICES.md` for the reasoning
behind this choice over the original CC-BY-ND NCpedia clip and the
CC-BY-SA HD alternatives.

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
# Source is .ogv; convert to .mp4 while trimming so it plays in
# browsers without extra codec hassle. Adjust -ss to land on the
# actual firing instant in the 17-second source.
ffmpeg -i cannon-shot-source.ogv -ss 5 -t 1 \
  -c:v libx264 -preset slow -crf 23 -an cannon-shot.mp4
```

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

| Phase | Status | Time | Blocked on |
|-------|--------|------|-----------|
| 1. Repos created and committed locally | DONE | — | first push gated on Phase 2.4 |
| 2. WASM wiring (`@unimusic/chromaprint`) | DONE | — | browser smoke test (2.4) still owed |
| 2.4 Browser-side smoke test | TODO | ~10 min | local server + a browser |
| 3. Content production | TODO | ~90 min | downloads, ffmpeg, you listening to cannons |
| 4. Phone-mic smoke test | TODO | ~5 min | a phone and a laptop |
| **Total remaining** | | **~2 hours** | |

vs. the 4-6 weekend estimate from the original implementation spec.
The estimate was for someone starting from scratch. What you have
now is mostly done — this is execution.

Phase 3.9 (cannon annotations) is the only task that genuinely needs
a human listener. Everything else can be automated or scripted.

If Phase 4 surfaces real-world matcher problems, add a few hours of
threshold tuning per the troubleshooting section above; still
nowhere near a weekend.
