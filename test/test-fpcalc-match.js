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
function fingerprintSlice(mediaPath, startSec, durSec) {
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", mediaPath,
      "-ss", String(startSec),
      "-t", String(durSec),
      "-vn", "-ar", "11025", "-ac", "1",
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

// -----------------------------------------------------------------
// Case 1 — POSITIVE
// -----------------------------------------------------------------
//
// Slice geometry: the edited clip's blocks map back to the original
// as [0-5 → 0-5, 5-10 → 7-12, 10-14 → 14-18, 14-end → 20-end]. Edited
// 20-25 s is inside the final block, no cut span, mapping to original
// 26-31 s.
{
  const captured = fingerprintSlice(EDITED_MP4, 20, 5);
  const result = freshMatcher().step(captured, 0);
  if (!result) {
    fail(
      `POSITIVE: matcher returned no result for edited 20-25s slice. ` +
        `Expected a confident match near 26000 ms.`,
    );
  }
  const expectedMs = 26000;
  const err = Math.abs(result.time_ms - expectedMs);
  console.log(
    `positive: matched ${result.time_ms} ms (expected ~${expectedMs}, off ${err} ms), ` +
      `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}, ambiguous=${result.ambiguous || false}`,
  );
  if (err >= 1000) {
    fail(`POSITIVE: position off by ${err} ms (>1 s). Matcher/AFS broken.`);
  }
  if (result.ambiguous) {
    fail(
      `POSITIVE: matcher reported ambiguous with ${result.candidates?.length} ` +
        `candidates. Should lock on confidently for a clean slice.`,
    );
  }
}

// -----------------------------------------------------------------
// Case 2 — NEGATIVE
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
