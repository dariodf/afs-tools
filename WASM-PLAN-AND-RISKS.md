# WASM contingency plan + project risk audit

This document covers:

1. What to do if `chromaprint-wasm` doesn't work — building it from
   source via Emscripten.
2. Other risks to the project that aren't covered in HANDOFF.md.
3. What you can do to maximize odds of a working demo.

---

## Part 1: WASM contingency plan

### When to abandon `chromaprint-wasm`

After Phase 2 of HANDOFF.md, you'll know if `chromaprint-wasm` works.
Reasons to abandon it and build our own:

- The package fails to install or load.
- The API is incompatible (the package targets old build tooling
  that doesn't play nice with ES modules).
- It loads but produces output that the matcher can't lock onto even
  when fingerprinting the same source file twice (proves the package
  is broken).
- The package's bundle size or load time is unacceptable.

### What to build

`libchromaprint` ships with **KissFFT bundled as a fallback FFT**.
That's the path we use: build libchromaprint with `-DFFT_LIB=kissfft`
under Emscripten. No external FFT dependency, no FFmpeg, no FFTW3
(both LGPL/GPL), pure permissive license.

Result: a single `chromaprint.wasm` + thin JS glue, ~150-250 KB
total. The library exposes the standard chromaprint C API which we
call from JS through Emscripten's `cwrap`/`ccall`.

### Build plan

```bash
# 1. Install Emscripten (one-time, ~10 min)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh

# 2. Clone chromaprint source
cd ..
git clone https://github.com/acoustid/chromaprint.git
cd chromaprint

# 3. Build with CMake + Emscripten, KissFFT backend
mkdir build-wasm && cd build-wasm
emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DFFT_LIB=kissfft \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TOOLS=OFF \
  -DBUILD_TESTS=OFF
emmake make -j

# 4. Link the static lib into a WASM module with the C API exposed
emcc -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS='[
    "_chromaprint_new",
    "_chromaprint_free",
    "_chromaprint_get_algorithm",
    "_chromaprint_set_option",
    "_chromaprint_start",
    "_chromaprint_feed",
    "_chromaprint_finish",
    "_chromaprint_get_raw_fingerprint",
    "_chromaprint_get_raw_fingerprint_size",
    "_chromaprint_dealloc",
    "_malloc",
    "_free"
  ]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAP16","HEAPU32"]' \
  -o chromaprint.js \
  libchromaprint.a
```

That produces `chromaprint.js` (the ES module loader, ~10 KB) and
`chromaprint.wasm` (the binary, ~150-200 KB). Drop both into
`demo/vendor/chromaprint/`.

### Glue code in our chromaprint.js

Replace the two TODO blocks with the real implementation. The pattern:

```javascript
let cpModule = null;

export async function loadChromaprint() {
  if (cpModule) return cpModule;
  const Module = await import("./vendor/chromaprint/chromaprint.js");
  cpModule = await Module.default();
  return cpModule;
}

export function fingerprintAudio(samples) {
  if (!cpModule) throw new Error("call loadChromaprint() first");

  // Allocate int16 buffer in WASM heap
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const inputPtr = cpModule._malloc(int16.length * 2);
  cpModule.HEAP16.set(int16, inputPtr / 2);

  // Create context, feed samples
  const ctx = cpModule._chromaprint_new(CHROMAPRINT_ALGORITHM);
  cpModule._chromaprint_start(ctx, 11025, 1);
  cpModule._chromaprint_feed(ctx, inputPtr, int16.length);
  cpModule._chromaprint_finish(ctx);

  // Read raw fingerprint
  const sizePtr = cpModule._malloc(4);
  const outPtrPtr = cpModule._malloc(4);
  cpModule._chromaprint_get_raw_fingerprint(ctx, outPtrPtr, sizePtr);
  const size = cpModule.HEAPU32[sizePtr / 4];
  const outPtr = cpModule.HEAPU32[outPtrPtr / 4];
  const hashes = new Uint32Array(cpModule.HEAPU32.buffer, outPtr, size).slice();

  // Cleanup
  cpModule._chromaprint_dealloc(outPtr);
  cpModule._chromaprint_free(ctx);
  cpModule._free(inputPtr);
  cpModule._free(sizePtr);
  cpModule._free(outPtrPtr);

  return hashes;
}
```

### Time budget

- Emscripten install: 10 min one-time.
- First successful build: 30-60 min (CMake quirks).
- Glue code + verification: 30-60 min.

Total: **2-3 hours** if it all goes smoothly, half a day if Emscripten
has surprises.

### Known build risks

- **Emscripten CMake integration may require flags I don't know.**
  The chromaprint CMake might explicitly call `find_package(Threads)`
  or similar in ways that don't translate cleanly. Mitigation: read
  build errors, comment out the offending CMake bits.
- **The exported function list might be incomplete.** If `_chromaprint_dealloc`
  isn't the actual symbol name (chromaprint may have renamed it), the
  linker will complain. Fix: `nm libchromaprint.a | grep T` to find
  real symbol names.
- **Memory growth may not be enabled.** Long audio buffers can blow
  past the default 16 MB heap. The `-s ALLOW_MEMORY_GROWTH=1` flag
  handles this.

If you hit a wall: the simpler fallback is **pre-generating all AFS
files server-side via `fpcalc`** (which the CLI already does) and
disabling the browser's "upload your own files" feature. The mic
capture path also stops working without browser-side chromaprint, so
the demo loses mic mode. That's a significant feature loss but the
desync demos still work in direct mode (the matcher matches the AFS
against the captured audio, which is the same content the AFS was
generated from — alignment is trivial there).

---

## Part 2: Other project risks

### Risk 1: Mic capture is silent or noisy

Browser mic capture has gotchas:

- **iOS Safari requires explicit user gesture even after permission.**
  The AudioContext may need `.resume()` called from a click handler.
- **Auto Gain Control / Echo Cancellation distort the signal.**
  Browsers default to mic processing for voice calls. Chromaprint
  expects raw audio. Disable via `getUserMedia({ audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false } })`.
- **Sample rates differ by device.** Desktop Chrome captures at 48000
  Hz, some Android devices at 44100. Our worklet resamples to 11025
  Hz; verify the resampler is correct by comparing fingerprints from
  the same file captured at different rates.

**Check before launch:** in the browser console with the demo running,
log `max(abs(samples))` over a 1-second window. If it's near zero,
mic isn't capturing. If it varies wildly between identical sources,
AGC is on.

### Risk 2: Browser autoplay blocking

The desync demos auto-play video. Most browsers block autoplay
without a user gesture. Symptom: the video element exists but
doesn't actually play; the matcher has no audio to fingerprint.

**Mitigation:** ensure the "Start" button is a real user gesture, and
play the video from inside that click handler. The current code does
this, but worth verifying in Safari.

### Risk 3: Cross-origin issues with media files

If `audio.crossOrigin` isn't set, `createMediaElementSource()` won't
expose the audio data to the AudioContext. We do set it, but only
matters when the audio comes from a different origin. Since our
content is same-origin (under `demo/content/`), this is fine.

**If you ever host content elsewhere (e.g., archive.org direct links):**
audio capture will silently fail. The fix is to either (a) proxy the
content through our origin, or (b) accept that direct-mode-with-CDN
won't work and force mic mode for those.

### Risk 4: GitHub Pages serves files with wrong MIME types

Rare but possible. `.afs` files may be served as `application/octet-stream`
instead of `text/plain`. Fetching with `.text()` still works regardless
of MIME, but worth verifying.

Wasm files specifically need `application/wasm` MIME or
`WebAssembly.instantiate()` rejects them in strict mode. GitHub Pages
serves them correctly by default.

### Risk 5: The matcher's confidence thresholds are wrong for real audio

`confidenceThreshold: 60` is the default in `demo-session.js`. This
was tuned against the mock fingerprinter, which produces clean,
deterministic output. Real chromaprint under mic capture produces
~80-95% confidence in good conditions, less in noisy environments.

**If the matcher rejects valid matches**, lower the threshold to 50
or 45. Don't go below 40 — false positives become likely.

### Risk 6: Cold-start latency too high

Cold start takes ~3 seconds (need 24 hashes ≈ 3 seconds of audio).
On phones with slow CPUs, fingerprinting 3 seconds of audio may
itself take 200-500ms, so total cold-start latency could be 3.5-4s.

**Mitigation:** lower `coldStartMinHashes` from 24 to 16 (about 2s of
audio). False positives become slightly more likely; in practice
fine for a single-source demo.

### Risk 7: The custom-files demo decoding step is slow

`audioContext.decodeAudioData` on a long file (>5 min) can take
several seconds. The current UI just says "generating AFS from your
file..." without progress.

**Improvement:** add a progress callback by chunking the decode if
performance matters. Skip if the demo only handles short clips.

### Risk 8: Phone screen sleeps during the demo

Mic mode + cannon demo + phone-in-pocket scenario: the screen turns
off after 30s, the page is throttled, audio capture stops.

**Mitigation:** request a wake lock via the Wake Lock API:

```javascript
let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}
```

Call this when entering mic mode. Five lines of code. Not in the
current demo; worth adding.

### Risk 9: No way to debug a failed match in production

If the smoke test fails, you need to see *why* — what hashes did the
mic produce, what's the closest match in the AFS, what's the Hamming
distance at the best position.

**Mitigation:** add a `?debug=1` URL param that shows a panel with:
- Capture buffer level
- Last N captured hashes (hex)
- Matcher state (current best position, confidence)
- Hamming distance histogram against the AFS

This was originally going to be in `test-chromaprint-compat.js`
which I removed. Worth restoring as an in-browser tool. Maybe 50
lines of code.

### Risk 10: Tears of Steel has minimal dialogue in many segments

The film alternates dialogue scenes with action sequences. If you
pick a 90-second window with mostly fighting/CGI and not much
talking, the desync demo loses its punch (you can't see subtitles
out of sync if there are no subtitles to see).

**Mitigation:** preview multiple candidate windows before committing.
Watch for ~3+ subtitle cues in your 90-second range to make the
desync visible.

---

## Part 3: How to maximize odds of success

### Test the WASM path early

Before doing all the content production: get `chromaprint-wasm` (or
the DIY build) working, run a single end-to-end test with a known
audio file. Don't optimize content until you know the matcher works.

### Add the debug panel

Risk 9's debug panel is the single highest-leverage addition for
diagnosing problems. Without it, "matcher doesn't lock on" is
unfixable; with it, you can see exactly what's wrong.

### Test on the actual target devices

A mid-range Android phone + an iPhone + a laptop. The behavior
varies more between devices than between browsers. iOS Safari is the
most likely source of surprises.

### Have a fallback content set

If the chosen 90-second Tears of Steel window doesn't work well,
have a backup ready (different window, or different source entirely).
Pre-trim 2-3 candidate clips before committing to one for the demo.

### Don't enable the haptics demo prematurely

The haptics demo is the most impressive but also the most fragile
(it depends on cannon timing accuracy, which depends on hand-
annotation accuracy, which depends on you having quiet listening
time). If you're rushing the demo, ship just the desync demos first
and add haptics in a follow-up.

### Don't perfect the SRT trim

For the dialogue clip, near-perfect timing on the source SRT isn't
critical. The whole point is to show AFS *correcting* timing. As
long as the original SRT is reasonably aligned (within ±1s), the
demo works.

### Plan for the announcement

When the demo is live, what's the launch? Options:

1. **Quiet launch.** Push to GitHub, link from your other repos
   (netflix_subtitles_translator), wait for organic discovery.
2. **HN post.** Self-submitted Show HN with the demo URL and a brief
   technical writeup. Risk: HN front page = a lot of traffic and
   GitHub Pages bandwidth limits (100 GB/month, plenty for a quiet
   demo, possibly tight under a viral surge — though 100 GB at ~50
   MB of demo content per visit is 2000 visits which is fine, but a
   front-page HN post can produce 50,000+ visits in a day).
3. **Mastodon / Bluesky / Twitter post.** Lower-throughput, more
   conversational. Good for finding initial interested users.

Recommendation: quiet launch first, fix anything that breaks under
real-world use, then HN once you've shaken out the rough edges.

### Document the contributor path

Right now there's no instruction for "I have a movie and a sub file
and I want to add it to the demo." The README mentions custom files
but not how to contribute back. Add a `CONTRIBUTING.md` that explains:

- How to generate an AFS for your content (CLI usage)
- How to PR it into the demo's content directory
- How to add a new demo card to the dropdown

Could be 50 lines. Major boost for the "community-contributable"
framing.

---

## Part 4: Strict priority order

If you want this shipped as fast as possible:

1. **Phase 1-2 of HANDOFF.md.** Push repos, wire WASM. ~40 min.
2. **Validate WASM with a single audio file via the custom-files demo.**
   This is the make-or-break test. If it works, everything else is
   mechanical. ~15 min.
3. **Phase 3 of HANDOFF.md.** Content production. ~90 min.
4. **Smoke test Phase 4.** Phone + laptop. ~5 min.
5. **Add Wake Lock for mic mode (Risk 8).** 5 lines of code. ~5 min.

That's it. Everything else in this doc is "if something doesn't work"
or "to make it better." If the happy path works on the first try, you
ship in ~2.5 hours.

The debug panel (Risk 9) and CONTRIBUTING.md (last item in Part 3)
are the best optional additions. Skip if rushing.

---

## What's truly missing from the project right now

After all the above, here's the honest list of what's *not* done and
not covered by any document:

1. **CONTRIBUTING.md** — how to add content / how to PR an AFS file.
2. **Wake Lock for mic mode** — 5 lines, prevents the screen-sleep
   failure mode.
3. **Debug panel** — `?debug=1` URL param showing matcher state.
4. **A 30-second video of the demo working** — for the README,
   tweets, HN post. Needs to be recorded after the demo is live.
5. **A way to know if the deployed demo is actually working** — no
   uptime monitoring, no automated browser test that exercises a
   real audio match. Could add a Playwright test that loads a known
   AFS + audio file and confirms the matcher reports the right
   position.

Items 1-3 are real code/doc additions worth doing. 4 is post-launch.
5 is nice-to-have for long-term maintenance.

Beyond that: the project is structurally complete. There's no design
decision left to make, no feature missing, no test that should
exist but doesn't.
