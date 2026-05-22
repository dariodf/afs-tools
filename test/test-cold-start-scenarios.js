// test/test-cold-start-scenarios.js
// Cold-start the matcher at several different playhead positions in
// the edited clip and verify the first confident result lands in a
// reasonable place. test-full-playback-walk.js implicitly tests
// cold-start at edited 8 s (the first tick once its buffer fills);
// this test exercises cold-start at multiple chosen positions
// including ones that are easy (deep inside a clean block) and
// hard (right after a cut, between cuts).
//
// What "reasonable" means depends on the scenario:
//   - Clean buffer (no cut in the last 8 s): matcher must report a
//     confident position within 500 ms of truth.
//   - Cut-spanning buffer (a cut within the buffer): matcher's
//     first result may be 2-3 s off because the buffer literally
//     contains audio from multiple source blocks. We require ONLY
//     that it returns a non-null result and that the result is
//     within ~3 s of *some* plausible source position.
//
// Run with: node test/test-cold-start-scenarios.js

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

const BUFFER_SEC = 8;
const CUTS_AT_EDITED_SEC = [5, 10, 14];
function editedSecToSourceSec(editedSec) {
  if (editedSec < 5) return editedSec;
  if (editedSec < 10) return editedSec + 2;
  if (editedSec < 14) return editedSec + 4;
  return editedSec + 6;
}

function fail(msg) { console.error(`  FAIL ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`  ok  ${msg}`); }
function skip(msg) {
  console.log(`test-cold-start-scenarios: SKIP — ${msg}`);
  process.exit(0);
}

for (const tool of ["fpcalc", "ffmpeg"]) {
  try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
  catch { skip(`${tool} not on PATH`); }
}
if (!existsSync(AFS_PATH) || !existsSync(EDITED_MP4)) {
  skip("dialogue-clip content not produced.");
}

function captureAt(playheadSec) {
  const bufStart = Math.max(0, playheadSec - BUFFER_SEC);
  const bufDur = playheadSec - bufStart;
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", EDITED_MP4,
      "-ss", String(bufStart),
      "-t", String(bufDur),
      "-vn", "-ar", "48000", "-ac", "2",
      "-f", "wav", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], {
    input: wav,
  }).toString();
  const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
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

// Buffer is clean if no cut in [playhead - BUFFER_SEC, playhead].
function isClean(playheadSec) {
  return !CUTS_AT_EDITED_SEC.some(
    (c) => c > playheadSec - BUFFER_SEC && c <= playheadSec,
  );
}

const SCENARIOS = [
  { playhead: 8,  description: "right after cuts cluster (buffer spans all 3 cuts)" },
  { playhead: 12, description: "between cuts (buffer spans 2 cuts)" },
  { playhead: 18, description: "buffer spans cut at 14" },
  { playhead: 25, description: "deep in block 4 (clean)" },
  { playhead: 50, description: "midway through block 4 (clean)" },
  { playhead: 70, description: "near end of clip (clean)" },
];

console.log("cold-start at several playhead positions in the edited clip:\n");

for (const sc of SCENARIOS) {
  const captured = captureAt(sc.playhead);
  // Fresh matcher per scenario — cold-start path only.
  const matcher = new AFSMatcher(hashes, times, {
    confidenceThreshold: 60,
    coldStartMinHashes: 24,
  });
  const result = matcher.step(captured, 0);
  const clean = isClean(sc.playhead);
  const projectedMs = result ? result.time_ms + BUFFER_SEC * 1000 : null;
  const truthMs = editedSecToSourceSec(sc.playhead) * 1000;
  const errMs = projectedMs == null ? null : Math.abs(projectedMs - truthMs);

  const detail =
    `playhead ${sc.playhead}s [${clean ? "clean" : "spans cut"}] ` +
    (result
      ? `→ source ${projectedMs.toFixed(0)} ms (truth ${truthMs}, err ${errMs.toFixed(0)} ms), ` +
        `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}, ambiguous=${result.ambiguous || false}`
      : "→ NO RESULT") +
    `  // ${sc.description}`;

  if (result == null) {
    fail(detail);
    continue;
  }

  if (clean) {
    // Strong contract on clean cold-starts: confident match within 500 ms.
    if (errMs > 500) fail(detail);
    else if (result.ambiguous) fail(detail + "  (ambiguous on clean buffer)");
    else ok(detail);
  } else {
    // Loose contract on cut-spanning cold-starts: just verify it
    // returned a non-null result in the right neighbourhood of the
    // source (within ~3 s of either the dominant pre-cut block or
    // the truth). This is the "graceful degradation" check.
    if (errMs > 3500) fail(detail + "  (>3.5 s from truth)");
    else ok(detail);
  }
}

console.log("");
if (process.exitCode) {
  console.error("test-cold-start-scenarios: failures above");
  process.exit(1);
}
console.log("test-cold-start-scenarios: OK");
