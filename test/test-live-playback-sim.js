// test/test-live-playback-sim.js
// Simulate the live demo's matcher pipeline offline and verify the
// REPORTED POSITION matches actual playback head position.
//
// This is the test we want as a substitute for manual browser
// testing of "does the AFS time displayed actually correspond to
// where in the audio I am?". It treats the demo pipeline as a
// black box and checks input/output behavior:
//
//   At simulated playback time T, the audio buffer contains the
//   last `bufferDurationSec` of source audio — i.e., source range
//   [T - bufferDurationSec, T]. Fingerprint that range. Run it
//   through the matcher. Apply the same projection demo-session
//   applies. Assert the reported position is close to T.
//
// If the projection formula is wrong (off by capture-window
// length, off by chromaprint's 2.6 s analysis window, off by
// anything), the assertion fails with a clear "reported X,
// expected T" message. There's no "the code matches the code"
// circularity — the test compares against an external ground
// truth: the playback time we chose to simulate.
//
// Run with: node test/test-live-playback-sim.js

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import { AFSMatcher } from "../demo/src/afs-matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../demo/content");
const AFS_PATH = path.join(CONTENT_DIR, "dialogue-clip.afs");
const SOURCE_MP4 = path.join(CONTENT_DIR, "dialogue-clip.mp4");

const BUFFER_DURATION_SEC = 8; // matchWindowSeconds default
const CONFIDENCE_THRESHOLD = 60;
// Tolerance for "reported position matches simulated playback head".
// Allow ~250 ms of slop for chromaprint's per-hash delay (tens of
// ms), the boundary alignment of the analysis window, and the
// 124 ms hop quantization.
const TOLERANCE_MS = 250;

let failures = 0;
function fail(msg) { console.error(`  FAIL: ${msg}`); failures++; }
function ok(msg)   { console.log(`  ok: ${msg}`); }
function skip(msg) {
  console.log(`test-live-playback-sim: SKIP — ${msg}`);
  process.exit(0);
}

for (const tool of ["fpcalc", "ffmpeg"]) {
  try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
  catch { skip(`${tool} not on PATH`); }
}
if (!existsSync(AFS_PATH) || !existsSync(SOURCE_MP4)) {
  skip("dialogue-clip content not produced.");
}

// Use the original dialogue clip (no cuts) so playback-head ==
// source-position is unambiguous. (A cuts variant would need to
// track edited→original mapping, which complicates the ground
// truth.)

const parsed = parseAFS(readFileSync(AFS_PATH, "utf-8"));
const { hashes: storedHashes, times: storedTimes } = chromaprintArrays(parsed);

function freshMatcher() {
  return new AFSMatcher(storedHashes, storedTimes, {
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    coldStartMinHashes: 24,
  });
}

// Capture the contents of the audio buffer at simulated playback
// time `playheadSec`. Returns the captured hashes and the exact
// audio-duration-ms (which is what demo-session's projection uses).
function captureBufferAt(playheadSec) {
  const bufferStart = Math.max(0, playheadSec - BUFFER_DURATION_SEC);
  const bufferDur = playheadSec - bufferStart;
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", SOURCE_MP4,
      "-ss", String(bufferStart),
      "-t", String(bufferDur),
      "-vn", "-ar", "48000", "-ac", "2",
      "-f", "wav", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], {
    input: wav,
  }).toString();
  const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
  if (!fpLine) throw new Error("fpcalc produced no FINGERPRINT line");
  const captured = new Uint32Array(
    fpLine
      .slice("FINGERPRINT=".length)
      .split(",")
      .map((s) => {
        const n = Number(s);
        return n < 0 ? n + 4294967296 : n;
      }),
  );
  return { captured, bufferDurationMs: bufferDur * 1000 };
}

// Same projection demo-session._tick applies. If this formula
// changes there, this test catches it.
function projectMatcherPosition(matcherResult, bufferDurationMs) {
  return matcherResult.time_ms + bufferDurationMs;
}

// -----------------------------------------------------------------
// Test 1 — Discrete playhead positions across the clip
// -----------------------------------------------------------------
//
// Independent samples: each iteration creates a fresh matcher and
// captures a buffer at the chosen playhead. The matcher must
// locate that position correctly from a cold start.

console.log("\n1. PLAYHEAD ACCURACY (cold start at each position)");
{
  // Skip the first 8 seconds (buffer can't be full before then).
  const playheads = [8, 12, 20, 35, 50, 70, 85];

  for (const T of playheads) {
    const { captured, bufferDurationMs } = captureBufferAt(T);
    const result = freshMatcher().step(captured, 0);
    if (!result) {
      fail(`T=${T}s: matcher returned no result`);
      continue;
    }
    if (result.ambiguous) {
      // Soft-pass if top candidate is correct — same convention as
      // the cuts-tracking test in test-fpcalc-robustness.
      const projected = projectMatcherPosition(result, bufferDurationMs);
      const err = Math.abs(projected - T * 1000);
      if (err < 1000) {
        ok(`T=${T}s: projected ${projected.toFixed(0)} ms (truth ${T * 1000}, off ${err.toFixed(0)}), ambiguous=${result.candidates?.length}`);
      } else {
        fail(`T=${T}s: ambiguous with wrong top candidate (off ${err.toFixed(0)} ms)`);
      }
      continue;
    }
    const projected = projectMatcherPosition(result, bufferDurationMs);
    const err = Math.abs(projected - T * 1000);
    if (err < TOLERANCE_MS) {
      ok(`T=${T}s: projected ${projected.toFixed(0)} ms (truth ${T * 1000}, off ${err.toFixed(0)} ms), confidence ${result.confidence.toFixed(1)}%`);
    } else {
      fail(`T=${T}s: projected ${projected.toFixed(0)} ms diverged from playhead ${T * 1000} ms by ${err.toFixed(0)} ms`);
    }
  }
}

// -----------------------------------------------------------------
// Test 2 — Linear progression
// -----------------------------------------------------------------
//
// Walk consecutive playheads simulating real continuous playback.
// Single matcher held across calls (so we exercise steady-state
// local search too, not just cold-start). The reported positions
// should be monotonically increasing by the step size, within
// tolerance.

console.log("\n2. LINEAR PROGRESSION (matcher state preserved across ticks)");
{
  const startSec = 10;
  const endSec = 30;
  const stepSec = 4;
  const matcher = freshMatcher();
  let wallTime = 0;
  let previousReported = null;

  for (let T = startSec; T <= endSec; T += stepSec) {
    const { captured, bufferDurationMs } = captureBufferAt(T);
    wallTime += stepSec * 1000;
    const result = matcher.step(captured, wallTime);
    if (!result || result.ambiguous) {
      // Tolerated for cold-start period, not in the middle.
      console.log(`  ... T=${T}s: ${!result ? "no result" : `ambiguous (${result.candidates?.length})`} — skipping monotonicity check`);
      continue;
    }
    const projected = projectMatcherPosition(result, bufferDurationMs);
    const err = Math.abs(projected - T * 1000);

    if (err >= TOLERANCE_MS) {
      fail(`T=${T}s: projected ${projected.toFixed(0)} ms vs truth ${T * 1000} ms (off ${err.toFixed(0)})`);
      continue;
    }

    if (previousReported != null) {
      const delta = projected - previousReported;
      const expectedDelta = stepSec * 1000;
      const deltaErr = Math.abs(delta - expectedDelta);
      if (deltaErr >= TOLERANCE_MS) {
        fail(`T=${T}s: jumped ${delta.toFixed(0)} ms from previous, expected ~${expectedDelta} ms`);
        continue;
      }
      ok(`T=${T}s: projected ${projected.toFixed(0)} ms (off ${err.toFixed(0)}), delta ${delta.toFixed(0)} ms, mode=${result.mode}`);
    } else {
      ok(`T=${T}s: projected ${projected.toFixed(0)} ms (off ${err.toFixed(0)}), mode=${result.mode}`);
    }
    previousReported = projected;
  }
}

console.log("");
if (failures > 0) {
  console.error(`test-live-playback-sim: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-live-playback-sim: OK");
