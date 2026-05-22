# Claude Code handoff — AFS project

This document is for Claude Code (or any AI coding assistant) picking
up the AFS project. The human (Dario, github: dariodf) designed this
on a flight, working with Claude in chat. Most of the code is
written. What remains is integration work that needs internet, real
media files, and a real browser.

Read this whole file before starting. The order of operations matters.

---

## Project overview

**AFS** (Audio Fingerprint Sync) is an open file format and reference
implementation. AFS files pair audio fingerprints with explicit time
cues so any device with a microphone can determine "where in this
known audio source am I right now" — enabling subtitles, haptics,
lighting cues, or other reactions to sync with playing audio without
network coordination.

Two repos:

- **`afs/`** — the spec repo. Spec, examples, license. ~6 files total.
- **`afs-tools/`** — the reference implementation: CLI generators
  (bash), browser demo (JS/HTML), tests, GitHub Actions deploy. ~30
  files of code plus docs.

The spec repo is **complete** and ready to push as-is. The tools repo
has all code and tests written but needs three things to be a fully
working live demo: WASM chromaprint wired in, content media files
produced, and a real-world phone-mic smoke test.

---

## What's done (don't redo this)

### afs/ repo (spec)

- `SPEC.md` — v0.1 format specification (TOML header + body, chromaprint-only)
- `README.md` — project overview, format explainer
- `examples/minimal.afs`, `examples/annotated.afs` — example files
- `LICENSE` (Apache 2.0), `CHANGELOG.md`, `.gitignore`

### afs-tools/ repo (implementation)

**CLI tools (bash, working):**
- `tools/afs-generate` — wraps ffmpeg + fpcalc to make AFS from any media file
- `tools/afs-format` — converts raw fpcalc output to AFS format
- `tools/srt-shift` — shifts SRT timestamps by N seconds

**Browser demo (`demo/`):**
- `index.html` — main UI with importmap for vendored deps
- `app.js` — demo dispatcher, ~650 lines, handles 4 demos
- `style.css` — full styling
- `src/afs-parser.js` — parses AFS files (uses smol-toml)
- `src/afs-writer.js` — serializes AFS files
- `src/afs-matcher.js` — Hamming-distance matcher with candidate tracking
- `src/srt-parser.js` — SRT parsing/shifting/serialization
- `src/audio-capture.js` — Web Audio capture from media element or mic
- `src/audio-worklet-processor.js` — AudioWorklet for sample capture
- `src/chromaprint.js` — WASM wrapper, **stub** (mockFingerprint used in dev)
- `src/subtitle-renderer.js` — raw/AFS toggle subtitle display
- `src/haptics-events.js` — fires callbacks at predefined positions
- `src/demo-session.js` — common pattern: load AFS, capture, match, dispatch
- `src/debug-panel.js` — `?debug=1` URL param activates an in-browser diagnostic panel
- `src/vendor/qr-code.js` — thin wrapper around qrcode-generator npm package

**Four demos wired in `app.js`:**
1. `desync-srt` — one video, two SRT tracks (correct + shifted +2s), per-track AFS toggle
2. `desync-video` — original + edited (3 cuts) side-by-side, shared SRT; mic mode shows single video
3. `haptics` — 1812 Overture finale with cannon visual + screen flash + vibrate
4. `custom` — upload your own files, generates AFS in-browser

**Tests (53 passing, run automatically in CI):**
- `test/test-runner.js` — 38 unit tests
- `test/test-matcher-robustness.js` — 13 tests for ambiguity, pause/resume, wrong-AFS, end-of-source, partial overlap, safety
- `test/test-demo-pipeline.js` — end-to-end smoke test (audio → AFS → match → subtitle → haptic)
- `test/test-imports.js` — walks the import graph, catches missing files

**Deployment:**
- `.github/workflows/deploy-pages.yml` — vendors npm deps, runs all four test suites, deploys `demo/` to GitHub Pages

**Documentation:**
- `README.md` — project overview, run locally, deploy
- `CONTRIBUTING.md` — contribution paths for users and developers
- `HANDOFF.md` — the human-facing version of what needs to happen
- `WASM-PLAN-AND-RISKS.md` — Emscripten build instructions if chromaprint-wasm doesn't work, plus risk audit
- `HISTOGRAM-VOTE-MATCHING.md` — design note for an alternative matcher algorithm (not currently needed)

---

## What's NOT done (your job)

### 1. WASM chromaprint integration

**File to change:** `demo/src/chromaprint.js`

Two `throw new Error("...TODO...")` blocks need to be replaced:
- `loadChromaprint()` — load the WASM module
- `fingerprintAudio(samples)` — call the module to fingerprint Int16 samples at 11025 Hz mono, return Uint32Array of hashes

**Preferred path:** use the npm package `chromaprint-wasm`:
```bash
cd afs-tools
npm install chromaprint-wasm
```
Then read `node_modules/chromaprint-wasm/README.md` and any `.d.ts`
files to figure out the actual API. Update `chromaprint.js` to call it.
Also update `.github/workflows/deploy-pages.yml` to vendor it like
smol-toml is vendored (and the import map in `demo/index.html`).

**Important:** the package was last published in 2018, so it might
not work cleanly. If it doesn't:

**Fallback path:** build chromaprint from source with Emscripten. See
`WASM-PLAN-AND-RISKS.md` for the full build commands and glue code
template. Estimate: 2-3 hours if smooth, half a day if Emscripten has
surprises.

**Verification:** the demo's "custom files" tab lets a user upload an
audio file and generates an AFS in-browser. Once WASM is wired:
1. Open the demo locally
2. Use "Use your own files..." mode
3. Upload any audio file
4. Confirm the AFS download is non-empty and parseable

Also confirm `mockFingerprint` is still used as a test fallback —
don't delete it. Several tests depend on it.

### 2. Content production

**Directory:** `demo/content/`

**Read first:** `demo/content/README.md` — has exact ffmpeg commands and source URLs for every file.

**Sequence:**

```bash
cd demo/content
bash fetch-content.sh    # downloads Tears of Steel, 1812 Overture, etc.
```

Then follow `demo/content/README.md` to trim clips, generate the
edited version with 3 cuts, hand-annotate cannon timings, and run
`../../tools/afs-generate` against each clip.

**Cannon timings (`overture-finale-cannons.json`):** the current file
has placeholder timings. After trimming `overture-finale.mp3`, you'll
need to listen and identify cannon hits. If you have transcription
ability or audio analysis tools, use them. Otherwise leave a note for
Dario to fill in by ear — it's a 15-minute task with headphones.

**Cannon video:** NCpedia (CC-BY-ND) — must be manually downloaded
from a webpage that has no direct download URL. Tell Dario this is
his one manual step if you hit it.

### 3. Phone-mic smoke test

Only Dario can do this. He plays the demo on a laptop, holds a phone
running the demo in mic mode near the speakers, and confirms the
matcher locks on. Document the outcome and any threshold tuning
needed.

If the matcher is flaky in real audio conditions, the most likely
fixes are in `demo/src/demo-session.js`:
- Lower `confidenceThreshold` from 60 to 50 or 45
- Lower `coldStartMinHashes` from 24 to 16

See `WASM-PLAN-AND-RISKS.md` Part 2 for the full troubleshooting list.

---

## Order of operations

Do these in this order. Each step is small and verifiable.

### Step 0: Verify everything as-is

Before changing anything, prove the current code works:

```bash
cd afs-tools
npm install
mkdir -p demo/vendor/smol-toml demo/vendor/qrcode-generator
cp node_modules/smol-toml/dist/*.js demo/vendor/smol-toml/
cp node_modules/qrcode-generator/dist/qrcode.mjs demo/vendor/qrcode-generator/index.mjs

node test/test-runner.js               # 38 passed
node test/test-matcher-robustness.js   # 13 passed
node test/test-demo-pipeline.js        # OK
node test/test-imports.js              # 22 files checked
```

If any of these fail, **stop and report back** before making changes.
The repo should arrive in a known-good state.

### Step 1: Push the repos

If Dario hasn't already pushed them:

```bash
cd path/to/afs/
git init && git add . && git commit -m "Initial AFS v0.1 spec"
# Push to github.com/dariodf/afs

cd path/to/afs-tools/
git init && git add . && git commit -m "Initial AFS tools and demo"
# Push to github.com/dariodf/afs-tools
```

Then in repo settings on github.com: Settings → Pages → Source =
"GitHub Actions". The deploy workflow will run on the next push.

### Step 2: Wire WASM chromaprint

See "What's NOT done" item 1. This is the riskiest step. Do it before
content production so you don't waste time on content if the matcher
turns out to need a different approach.

After wiring, run all four test suites again. They should still pass
(mockFingerprint is the fallback for tests; real chromaprint only
affects the live demo).

Open the demo locally:
```bash
cd demo && python3 -m http.server 8000
```
Try the "custom files" demo. Upload any audio. Confirm an AFS file
downloads. Confirm playing the audio back makes the matcher lock on.

### Step 3: Content production

See "What's NOT done" item 2. Mechanical work. Follow
`demo/content/README.md` step by step. The main media files
(`*.mp4`, `*.mp3`) are in `.gitignore` — decide whether to commit
them (Option A in HANDOFF.md, simplest) or use a GitHub Release
(Option B).

### Step 4: Deploy + smoke test

Push to main. The deploy workflow runs tests and uploads `demo/` to
Pages. Demo is live at `https://dariodf.github.io/afs-tools/`.

Tell Dario to do the phone-mic smoke test (Step 4 of HANDOFF.md).

---

## Things to watch for

### The matcher has subtle state

`AFSMatcher` in `demo/src/afs-matcher.js` tracks pending candidates
across `step()` calls. The candidate-tracking logic in
`_evaluateCandidates` does index arithmetic that's the kind of place
off-by-one errors hide. If something breaks at runtime, look there
first. The robustness test suite covers the known cases but real
audio could surface something subtle.

### mockFingerprint has known limitations

Documented at the bottom of `demo/src/chromaprint.js`. It requires
block-aligned slices (every 1365 samples) and is NOT noise-tolerant
like real chromaprint. Some tests rely on its determinism. **Don't**
delete it after wiring real WASM — keep it as a test fallback.

### The smol-toml vendor structure

`smol-toml`'s `index.js` re-exports from sibling files (`parse.js`,
`stringify.js`, etc.). The vendor step must copy *all* of
`dist/*.js`, not just `index.js`. The deploy workflow gets this
right; if you change anything about vendoring, make sure
`test/test-imports.js` still passes (it walks the actual import graph).

### Import map in index.html

`demo/index.html` has an import map that translates `smol-toml` and
`qrcode-generator` to vendored paths. If you add a new npm dep:
1. Add it to `package.json`
2. Add a vendor step to the deploy workflow
3. Add it to the import map in `index.html`
4. Run `test/test-imports.js` to verify

### Don't break tests, ever

Five test suites have to pass on every push:
- `test/test-runner.js`
- `test/test-matcher-robustness.js`
- `test/test-demo-pipeline.js`
- `test/test-imports.js`

The deploy workflow runs all of them before publishing. If you can't
make a change without breaking a test, the test is documenting
intended behavior — change the test deliberately, with a comment
explaining why.

### Don't run `web_search` or `web_fetch` for project context

Everything you need is in this repo. Search the web only for
language/library questions you can't answer from training data
(e.g., "how does chromaprint-wasm's API actually look").

---

## Files I'd read in this order

If you have time before starting, read in this order:

1. `afs-tools/README.md` — high-level project overview
2. `afs-tools/HANDOFF.md` — the original handoff (human-facing, more detail)
3. `afs/SPEC.md` — the file format
4. `afs-tools/demo/src/afs-matcher.js` — the core algorithm
5. `afs-tools/demo/src/chromaprint.js` — where the WASM work happens
6. `afs-tools/demo/content/README.md` — content production recipes
7. `afs-tools/WASM-PLAN-AND-RISKS.md` — fallback plan + risks
8. `afs-tools/test/test-matcher-robustness.js` — the matcher's behavioral contract

`HISTOGRAM-VOTE-MATCHING.md` is a design note for a future
alternative matcher. Don't implement it unless the current matcher
actually fails in real-world testing.

---

## Quick architectural map

```
afs/                          # SPEC REPO
├── SPEC.md                   # v0.1 format
├── README.md
├── examples/
│   ├── minimal.afs
│   └── annotated.afs
└── LICENSE                   # Apache 2.0

afs-tools/                    # IMPLEMENTATION REPO
├── tools/                    # bash CLIs (working)
│   ├── afs-generate          # media → AFS via ffmpeg+fpcalc
│   ├── afs-format            # raw fpcalc → AFS
│   └── srt-shift             # shift SRT timestamps
├── demo/                     # browser demo (deployed via Pages)
│   ├── index.html
│   ├── app.js                # 4 demos wired
│   ├── style.css
│   ├── src/                  # JS modules
│   │   ├── afs-parser.js
│   │   ├── afs-matcher.js    # CORE — has candidate tracking
│   │   ├── afs-writer.js
│   │   ├── srt-parser.js
│   │   ├── audio-capture.js
│   │   ├── audio-worklet-processor.js
│   │   ├── chromaprint.js    # ⚠️ HAS 2 TODOs FOR WASM
│   │   ├── subtitle-renderer.js
│   │   ├── haptics-events.js
│   │   ├── demo-session.js
│   │   ├── debug-panel.js    # ?debug=1
│   │   └── vendor/
│   │       └── qr-code.js
│   └── content/              # needs media files (Step 3)
│       ├── README.md
│       ├── fetch-content.sh
│       └── overture-finale-cannons.json  # placeholder timings
├── test/                     # 4 test suites, all passing
│   ├── test-runner.js
│   ├── test-matcher-robustness.js
│   ├── test-demo-pipeline.js
│   └── test-imports.js
├── .github/workflows/
│   └── deploy-pages.yml      # auto-deploy on push to main
├── README.md
├── HANDOFF.md                # human-facing version
├── CONTRIBUTING.md
├── WASM-PLAN-AND-RISKS.md
├── HISTOGRAM-VOTE-MATCHING.md  # future-matcher design note
└── HANDOFF-FOR-CLAUDE-CODE.md  # this file
```

---

## Success criteria

You're done when:

1. Both repos pushed to github.com/dariodf
2. `afs-tools` GitHub Pages deployed and accessible at `https://dariodf.github.io/afs-tools/`
3. All 4 demos load without console errors
4. The "custom files" demo can generate an AFS from a user-uploaded file
5. The 4 test suites still pass (CI green)
6. Dario reports that the phone-mic smoke test works (this is on him, not you)

Stretch: open a PR with a 30-second demo video for the README,
recorded after a successful smoke test.

---

## If you get stuck

- WASM doesn't work → fall back to the Emscripten build in
  `WASM-PLAN-AND-RISKS.md`. If that also fails, the demo still works
  in direct mode (without mic capture), so ship that and document
  the limitation.
- A test fails after a change you made → the test is the spec. Read
  the test comment, understand the intended behavior, and either fix
  the code to match the test or change the test deliberately with a
  comment.
- Real-world matcher behavior is bad → check
  `WASM-PLAN-AND-RISKS.md` Part 2 for tuning notes. If still bad,
  read `HISTOGRAM-VOTE-MATCHING.md` for the alternative algorithm.
- Content files are too big to commit → switch to GitHub Release
  hosting (Option B in HANDOFF.md).
- Something Dario should know about → write a clear status note for
  him, including the symptom, what you tried, and what's next.

Don't make architectural decisions on Dario's behalf. The spec is
frozen at v0.1. If something seems to require a spec change, write
it up and leave it for Dario to decide.

Good luck.
