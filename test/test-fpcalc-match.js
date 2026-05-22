// test/test-fpcalc-match.js
// Integration test: real chromaprint (via fpcalc) feeds the matcher.
// Two cases run against the dialogue-clip ORIGINAL AFS:
//
//   1. POSITIVE: 5 s slice of the edited clip's audio (entirely
//      inside a single edited block, no cut span). The matcher
//      should lock onto the corresponding position in the original
//      with high confidence and low error.
//
//   2. NEGATIVE: 5 s slice of the 1812 Overture audio (unrelated
//      content). The matcher should reject — return null, OR mark
//      the result as ambiguous, OR return a low-confidence match
//      below the threshold. It must NOT return a confident match,
//      because that would mean a false positive on totally
//      unrelated audio.
//
// Requires `fpcalc` and `ffmpeg` on PATH and the dialogue-clip +
// overture content produced (run demo/content/fetch-content.sh and
// the trim recipes in demo/content/README.md).
//
// Run with: node test/test-fpcalc-match.js

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
const OVERTURE_MP3 = path.join(CONTENT_DIR, "overture-finale.mp3");

const CONFIDENCE_THRESHOLD = 60;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
function skip(msg) {
  console.log(`test-fpcalc-match: SKIP — ${msg}`);
  process.exit(0);
}

// Pre-flight: required external tools and content files.
for (const tool of ["fpcalc", "ffmpeg"]) {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore" });
  } catch {
    skip(`${tool} not on PATH. Install libchromaprint-tools / ffmpeg.`);
  }
}
if (!existsSync(AFS_PATH) || !existsSync(EDITED_MP4) || !existsSync(OVERTURE_MP3)) {
  skip(
    "content not produced. Run demo/content/fetch-content.sh + the trim recipes in demo/content/README.md.",
  );
}

// Slice and fingerprint a window of audio from a media file at the
// given offset, returning the captured hashes as a Uint32Array.
//
// When `nativeRate` is true the slice is extracted as 48 kHz
// stereo and fpcalc resamples it internally — this mirrors the
// browser's Option B pipeline where we feed chromaprint native-
// rate audio and let it do the resampling. When false (default)
// we pre-resample to 11 025 mono via ffmpeg before fpcalc, which
// is what the old broken worklet path was doing.
function fingerprintSlice(mediaPath, startSec, durSec, { nativeRate = false } = {}) {
  const decodeArgs = nativeRate
    ? ["-ar", "48000", "-ac", "2"]
    : ["-ar", "11025", "-ac", "1"];
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-ss", String(startSec),
      "-t", String(durSec),
      "-vn",
      ...decodeArgs,
      "-f", "wav", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], {
    input: wav,
  }).toString();
  const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
  if (!fpLine) fail(`fpcalc produced no FINGERPRINT line for ${mediaPath}`);
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

// Load the original clip's AFS once; both cases match against it.
const parsed = parseAFS(readFileSync(AFS_PATH, "utf-8"));
const { hashes, times } = chromaprintArrays(parsed);

function freshMatcher() {
  return new AFSMatcher(hashes, times, {
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    coldStartMinHashes: 8, // slices are short
  });
}

// Slice geometry: the edited clip's blocks map back to the original
// as [0-5 → 0-5, 5-10 → 7-12, 10-14 → 14-18, 14-end → 20-end]. Edited
// 20-25 s is inside the final block, no cut span, mapping to original
// 26-31 s.
const SLICE_START = 20;
const SLICE_LEN = 5;
const EXPECTED_MS = 26000;

function assertConfidentMatch(label, result) {
  if (!result) {
    fail(
      `${label}: matcher returned no result. Expected a confident match near ${EXPECTED_MS} ms.`,
    );
  }
  const err = Math.abs(result.time_ms - EXPECTED_MS);
  console.log(
    `${label}: matched ${result.time_ms} ms (expected ~${EXPECTED_MS}, off ${err} ms), ` +
      `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}, ambiguous=${result.ambiguous || false}`,
  );
  if (err >= 1000) {
    fail(`${label}: position off by ${err} ms (>1 s). Matcher/AFS broken.`);
  }
  if (result.ambiguous) {
    fail(
      `${label}: matcher reported ambiguous with ${result.candidates?.length} ` +
        `candidates. Should lock on confidently for a clean slice.`,
    );
  }
}

// -----------------------------------------------------------------
// Case 1 — POSITIVE (pre-resampled)
// -----------------------------------------------------------------
//
// Mirrors the OLD browser path: audio is pre-resampled to 11 025 Hz
// mono before being handed to chromaprint. Sanity baseline.
{
  const captured = fingerprintSlice(EDITED_MP4, SLICE_START, SLICE_LEN);
  const result = freshMatcher().step(captured, 0);
  assertConfidentMatch("positive (pre-resampled 11025)", result);
}

// -----------------------------------------------------------------
// Case 2 — POSITIVE (native rate, simulates the new browser path)
// -----------------------------------------------------------------
//
// Mirrors the NEW browser path (Option B): the captured audio is
// at the AudioContext's native rate (48 kHz, stereo) and we let
// chromaprint resample internally. fpcalc and @unimusic/chromaprint
// both wrap libchromaprint, so if fpcalc-at-native-rate hashes
// match the stored AFS, the browser's @unimusic/chromaprint
// hashes should match too.
{
  const captured = fingerprintSlice(EDITED_MP4, SLICE_START, SLICE_LEN, {
    nativeRate: true,
  });
  const result = freshMatcher().step(captured, 0);
  assertConfidentMatch("positive (native 48k stereo)", result);
}

// -----------------------------------------------------------------
// Case 3 — WINDOW-END PROJECTION
// -----------------------------------------------------------------
//
// The matcher reports `time_ms` as the source position of the
// START of the captured window — where the OLDEST sample in our
// audio buffer sits in the source. For "where is the source NOW",
// every consumer of onPosition (subtitle display, status bar,
// haptics scheduling) needs the source position of the NEWEST
// sample, which is exactly bufferDurationMs ahead:
//
//   positionMs = result.time_ms + (samples.length / sampleRate) * 1000
//
// This is more accurate than projecting by hash count *
// hop_ms — the latter only reaches the start of chromaprint's
// last analysis window, but chromaprint's 2.6-s window depth
// means the actual end-of-audio sits ~2.6 s beyond there.
//
// A previous bug had demo-session.js passing matcher.time_ms
// straight through to onPosition; subtitles lagged playback by
// the entire match-window length (~5-8 s). The fix lives in
// demo-session._tick; this test pins the expected positioning
// semantics down so a refactor can't silently break it.
{
  const SLICE_START_EDITED = 20;
  const SLICE_LEN = 5;
  // Edited 20 maps to original 26; edited 25 (the END of the
  // slice — i.e., position of the newest sample) maps to original 31.
  const EXPECTED_START_MS = 26000;
  const EXPECTED_END_MS = 31000;
  // Tolerance accounts for the small offset that chromaprint
  // assigns to each hash (its "delay" — typically tens of ms).
  const TOLERANCE_MS = 100;

  const captured = fingerprintSlice(EDITED_MP4, SLICE_START_EDITED, SLICE_LEN, {
    nativeRate: true,
  });
  const result = freshMatcher().step(captured, 0);
  if (!result) fail("WINDOW-END: no result");

  // Same projection demo-session._tick uses.
  const projectedEndMs = result.time_ms + SLICE_LEN * 1000;
  const startErr = Math.abs(result.time_ms - EXPECTED_START_MS);
  const endErr = Math.abs(projectedEndMs - EXPECTED_END_MS);

  console.log(
    `window-end: matcher.time_ms = ${result.time_ms.toFixed(0)} ms ` +
      `(start, expected ~${EXPECTED_START_MS}, off ${startErr.toFixed(0)}); ` +
      `projected END = ${projectedEndMs.toFixed(0)} ms ` +
      `(expected ~${EXPECTED_END_MS}, off ${endErr.toFixed(0)})`,
  );

  if (startErr >= TOLERANCE_MS) {
    fail(
      `WINDOW-END: matcher.time_ms diverged from slice START by ${startErr.toFixed(0)} ms. ` +
        `If the matcher's reported semantic changed from "start of captured window," ` +
        `update demo-session.js's projection formula and this test together.`,
    );
  }
  if (endErr >= TOLERANCE_MS) {
    fail(
      `WINDOW-END: projected END diverged from slice END by ${endErr.toFixed(0)} ms. ` +
        `The "+ captureDurationMs" projection in demo-session.js is the ` +
        `mechanism that turns matcher position into "where the source is now". ` +
        `Without it, consumers (subtitles, status bar, haptics) lag by ~${SLICE_LEN} seconds.`,
    );
  }
}

// -----------------------------------------------------------------
// Case 4 — NEGATIVE
// -----------------------------------------------------------------
//
// 5 s slice of the 1812 Overture audio. Unrelated to the dialogue
// clip; the matcher must NOT report a confident, unambiguous match.
{
  const captured = fingerprintSlice(OVERTURE_MP3, 10, 5);
  const matcher = freshMatcher();
  const result = matcher.step(captured, 0);
  if (result === null) {
    console.log(
      `negative: matcher returned null (no candidates met threshold) — OK`,
    );
  } else if (result.ambiguous) {
    console.log(
      `negative: matcher reported ambiguous with ${result.candidates?.length} ` +
        `candidates — OK (no confident lock-on)`,
    );
  } else if (result.confidence < CONFIDENCE_THRESHOLD) {
    console.log(
      `negative: matcher returned a sub-threshold match ` +
        `(confidence ${result.confidence.toFixed(1)}%) — OK`,
    );
  } else {
    fail(
      `NEGATIVE: matcher confidently locked on unrelated audio. ` +
        `Got ${result.time_ms} ms at confidence ${result.confidence.toFixed(1)}% ` +
        `(mode=${result.mode}). This is a false positive — the matcher is ` +
        `too lenient or the matcher / hashes are broken.`,
    );
  }
}

console.log("test-fpcalc-match: OK");
