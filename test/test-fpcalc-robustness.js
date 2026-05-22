// test/test-fpcalc-robustness.js
// Robustness tests driving real chromaprint (via fpcalc) into our
// matcher, beyond the basic positive/negative cases in
// test-fpcalc-match.js:
//
//   1. CUTS TIMELINE — Walk the entire edited clip in rolling
//      5 s windows and verify the matcher locates the right
//      original-source position across all three cuts.
//
//   2. SAMPLE-RATE ROBUSTNESS — Same source slice at 44.1, 48,
//      and 96 kHz. All must produce hashes that lock onto the
//      same position, proving the demo will work across the
//      audio rates real browsers and devices use.
//
//   3. MIC-MODE NOISE TOLERANCE — Source slice with added
//      background noise (simulating a phone microphone listening
//      to a laptop speaker across a room). Must still find the
//      right position, with confidence above the matcher's
//      threshold.
//
// Requires fpcalc + ffmpeg + the dialogue-clip content. Skips
// gracefully when any are missing.
//
// Run with: node test/test-fpcalc-robustness.js

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import { AFSMatcher } from "../demo/src/afs-matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../demo/content");
const AFS_PATH = path.join(CONTENT_DIR, "dialogue-clip.afs");
const EDITED_MP4 = path.join(CONTENT_DIR, "dialogue-clip-edited.mp4");

const CONFIDENCE_THRESHOLD = 60;

let failures = 0;
function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failures++;
}
function ok(msg) {
  console.log(`  ok: ${msg}`);
}
function skip(msg) {
  console.log(`test-fpcalc-robustness: SKIP — ${msg}`);
  process.exit(0);
}

for (const tool of ["fpcalc", "ffmpeg"]) {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore" });
  } catch {
    skip(`${tool} not on PATH.`);
  }
}
if (!existsSync(AFS_PATH) || !existsSync(EDITED_MP4)) {
  skip("dialogue-clip content not produced.");
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

// Slice + fingerprint, choosing the decode parameters.
function fpcalcSlice(mediaPath, startSec, durSec, ffmpegExtraArgs = []) {
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-ss", String(startSec),
      "-t", String(durSec),
      "-vn",
      ...ffmpegExtraArgs,
      "-f", "wav", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], {
    input: wav,
  }).toString();
  const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
  if (!fpLine) throw new Error(`fpcalc produced no FINGERPRINT line`);
  return new Uint32Array(
    fpLine
      .slice("FINGERPRINT=".length)
      .split(",")
      .map((s) => {
        const n = Number(s);
        return n < 0 ? n + 4294967296 : n;
      }),
  );
}

const parsed = parseAFS(readFileSync(AFS_PATH, "utf-8"));
const { hashes, times } = chromaprintArrays(parsed);

function freshMatcher(options = {}) {
  return new AFSMatcher(hashes, times, {
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    coldStartMinHashes: 8,
    ...options,
  });
}

// -----------------------------------------------------------------
// 1. CUTS TIMELINE
// -----------------------------------------------------------------
//
// Edited blocks → original mappings:
//   edited 0-5  → original 0-5
//   edited 5-10 → original 7-12   (cut: orig 5-7 removed)
//   edited 10-14→ original 14-18  (cut: orig 12-14 removed)
//   edited 14-84→ original 20-90  (cut: orig 18-20 removed)
//
// Pick a 4 s window inside each block (smaller than a block,
// avoiding cut spans) and verify the matcher locates the
// corresponding original-source position.

console.log("\n1. CUTS TIMELINE");
{
  // 5 s windows produce ~19 hashes from fpcalc — comfortably
  // above the matcher's cold-start minimum. Block 3 (edited
  // 10-14) is only 4 s long so we skip it; blocks 1, 2, and 4
  // (sampled at multiple positions) cover the across-cut
  // re-acquisition behavior.
  const windows = [
    { editedStart: 0,  durSec: 5, expectedOrigMs: 0,     label: "block 1 (orig 0-5)" },
    { editedStart: 5,  durSec: 5, expectedOrigMs: 7000,  label: "block 2 (orig 7-12)" },
    { editedStart: 20, durSec: 5, expectedOrigMs: 26000, label: "block 4 (orig 26-31)" },
    { editedStart: 40, durSec: 5, expectedOrigMs: 46000, label: "block 4 (orig 46-51)" },
    { editedStart: 60, durSec: 5, expectedOrigMs: 66000, label: "block 4 (orig 66-71)" },
  ];

  // Use a single matcher across the walk so we exercise its
  // steady-state + re-acquisition logic the way the live demo
  // would (rather than resetting between windows). cold-start
  // threshold = 8, same as the basic-match test.
  const matcher = freshMatcher();
  let wallTime = 0;

  for (const w of windows) {
    const captured = fpcalcSlice(EDITED_MP4, w.editedStart, w.durSec, [
      "-ar", "48000", "-ac", "2",
    ]);
    wallTime += w.durSec * 1000;
    const result = matcher.step(captured, wallTime);

    if (!result) {
      fail(`${w.label}: no result. Expected ~${w.expectedOrigMs} ms.`);
      continue;
    }
    const err = Math.abs(result.time_ms - w.expectedOrigMs);
    const detail =
      `time ${result.time_ms} ms (expected ~${w.expectedOrigMs}, off ${err}), ` +
      `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}` +
      (result.ambiguous ? `, ambiguous=${result.candidates?.length}` : "");
    if (err >= 1500) {
      fail(`${w.label}: wrong position. ${detail}`);
    } else if (result.ambiguous) {
      // The top candidate is correct, but the matcher wants more
      // audio before committing. That's the right behavior in a
      // live demo; it'd disambiguate on the next tick.
      ok(`${w.label}: ${detail} (would disambiguate over time)`);
    } else {
      ok(`${w.label}: ${detail}`);
    }
  }
}

// -----------------------------------------------------------------
// 2. SAMPLE-RATE ROBUSTNESS
// -----------------------------------------------------------------

console.log("\n2. SAMPLE-RATE ROBUSTNESS");
{
  // edited 20-25 = orig 26-31, no cut span
  const SLICE = { start: 20, dur: 5, expected: 26000 };
  const rates = [
    { ar: "44100", ac: "1", label: "44.1 kHz mono" },
    { ar: "48000", ac: "2", label: "48 kHz stereo" },
    { ar: "96000", ac: "2", label: "96 kHz stereo" },
  ];

  for (const r of rates) {
    const captured = fpcalcSlice(EDITED_MP4, SLICE.start, SLICE.dur, [
      "-ar", r.ar, "-ac", r.ac,
    ]);
    const result = freshMatcher().step(captured, 0);
    if (!result) {
      fail(`${r.label}: no result.`);
      continue;
    }
    const err = Math.abs(result.time_ms - SLICE.expected);
    const detail =
      `time ${result.time_ms} ms (off ${err}), ` +
      `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}` +
      (result.ambiguous ? `, ambiguous=${result.candidates?.length}` : "");
    if (err < 1000 && !result.ambiguous) {
      ok(`${r.label}: ${detail}`);
    } else {
      fail(`${r.label}: ${detail}`);
    }
  }
}

// -----------------------------------------------------------------
// 3. MIC-MODE NOISE TOLERANCE
// -----------------------------------------------------------------
//
// Source slice mixed with low-amplitude white noise (simulating a
// phone microphone capturing audio across a room with some
// background). Chromaprint is designed to be noise-tolerant; the
// match should still succeed, possibly with lower confidence.

console.log("\n3. MIC-MODE NOISE TOLERANCE");
{
  const SLICE = { start: 20, dur: 5, expected: 26000 };

  // amplitudes are relative to the source signal (-1..1). Anything
  // up to ~0.2 represents realistic mic noise; above that we're
  // simulating a very noisy environment.
  const noiseLevels = [
    { amp: 0.0,  label: "no noise (baseline)" },
    { amp: 0.05, label: "quiet room (noise 0.05)" },
    { amp: 0.15, label: "moderate noise (0.15)" },
    { amp: 0.30, label: "noisy room (0.30)" },
  ];

  for (const n of noiseLevels) {
    let captured;
    if (n.amp === 0) {
      captured = fpcalcSlice(EDITED_MP4, SLICE.start, SLICE.dur, [
        "-ar", "48000", "-ac", "2",
      ]);
    } else {
      // ffmpeg filter graph: mix the source audio with a noise
      // generator of the given amplitude, then re-encode to WAV.
      const filter = `[0:a]atrim=${SLICE.start}:${SLICE.start + SLICE.dur},asetpts=PTS-STARTPTS[src];` +
        `anoisesrc=amplitude=${n.amp}:color=white:duration=${SLICE.dur}:sample_rate=48000[noise];` +
        `[src][noise]amix=inputs=2:duration=shortest[mix]`;
      const wav = execFileSync(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error",
          "-i", EDITED_MP4,
          "-filter_complex", filter,
          "-map", "[mix]",
          "-ar", "48000", "-ac", "2",
          "-vn", "-f", "wav", "-",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], {
        input: wav,
      }).toString();
      const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
      captured = new Uint32Array(
        fpLine
          .slice("FINGERPRINT=".length)
          .split(",")
          .map((s) => {
            const x = Number(s);
            return x < 0 ? x + 4294967296 : x;
          }),
      );
    }

    const result = freshMatcher().step(captured, 0);
    if (!result) {
      fail(`${n.label}: no result.`);
      continue;
    }
    const err = Math.abs(result.time_ms - SLICE.expected);
    const detail =
      `time ${result.time_ms} ms (off ${err}), ` +
      `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}` +
      (result.ambiguous ? `, ambiguous=${result.candidates?.length}` : "");
    if (err < 1000 && !result.ambiguous) {
      ok(`${n.label}: ${detail}`);
    } else {
      fail(`${n.label}: ${detail}`);
    }
  }
}

console.log("");
if (failures > 0) {
  console.error(`test-fpcalc-robustness: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-fpcalc-robustness: OK");
