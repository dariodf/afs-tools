// test/test-seek-recovery.js
// Verify the matcher recovers after a "seek" — i.e. when the
// audio in the buffer suddenly comes from a different source
// position than the matcher's local search expects.
//
// In the live demo, scrubbing or seeking the video element doesn't
// flush the matcher's state; the matcher's expected-position math
// will be wrong for whatever audio shows up next. The matcher's
// local-search branch should fail quickly (low scores) and fall
// through to cold-start, which re-acquires from the new audio.
//
// This test exercises that recovery by:
//   1. Walking the matcher through edited 8 → 30 s of continuous
//      playback (matcher locks on, has a recent lastMatch around
//      source 36 s).
//   2. Switching captured audio to playback starting at edited 60 s
//      (simulating an instant seek with a fully-replaced buffer).
//   3. Stepping the matcher repeatedly with this new audio and
//      counting how many ticks until it reports a confident result
//      within tolerance of the new truth.
//
// Run with: node test/test-seek-recovery.js

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
const STRIDE_SEC = 1;
const TRACKING_TOLERANCE_MS = 600;
// After a seek, recovery should happen within this many ticks.
// Justification: the matcher needs ~5 s of contiguous in-buffer
// audio at the new position to lock (see test-full-playback-walk
// behavior around cuts). With STRIDE_SEC=1, 6 ticks = 6 s. Add a
// small headroom for the local-search-fails phase.
const MAX_SEEK_RECOVERY_TICKS = 8;

function editedSecToSourceSec(editedSec) {
  if (editedSec < 5) return editedSec;
  if (editedSec < 10) return editedSec + 2;
  if (editedSec < 14) return editedSec + 4;
  return editedSec + 6;
}

function fail(msg) { console.error(`  FAIL ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`  ok  ${msg}`); }
function skip(msg) {
  console.log(`test-seek-recovery: SKIP — ${msg}`);
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
const matcher = new AFSMatcher(hashes, times, {
  confidenceThreshold: 60,
  coldStartMinHashes: 24,
});

let wallTime = 0;

// Phase 1: walk normally edited 8 → 30 s. After this, the matcher
// should be solidly locked on block 4 (source ~22..36 s).
console.log("phase 1 — pre-seek walk:");
for (let t = 8; t <= 30; t += STRIDE_SEC) {
  const captured = captureAt(t);
  wallTime += STRIDE_SEC * 1000;
  const r = matcher.step(captured, wallTime);
  if (t === 30) {
    const projected = r ? r.time_ms + BUFFER_SEC * 1000 : null;
    console.log(
      `  walked to edited ${t}s: matcher reports ${projected?.toFixed(0)} ms` +
        ` (truth ${editedSecToSourceSec(t) * 1000}, mode=${r?.mode})`,
    );
  }
}

// Phase 2: instant seek to edited 60 s. The next capture is taken
// at edited 60 s rather than continuing from 31 s. The matcher's
// lastMatch is stale (says source ~36 s) but the new audio is from
// source ~66 s.
const SEEK_TARGET = 60;
const TRUTH_AFTER_SEEK_MS = editedSecToSourceSec(SEEK_TARGET) * 1000;
console.log(
  `\nphase 2 — instant seek edited 30→${SEEK_TARGET}s (new truth ${TRUTH_AFTER_SEEK_MS} ms):`,
);

let ticksToRecover = null;
const RECOVERY_BUDGET = MAX_SEEK_RECOVERY_TICKS + 4;
for (let i = 0; i < RECOVERY_BUDGET; i++) {
  // Each post-seek tick: capture the buffer at SEEK_TARGET + i seconds
  // (i.e., playback continues normally from the seeked position).
  const playhead = SEEK_TARGET + i;
  const captured = captureAt(playhead);
  wallTime += STRIDE_SEC * 1000;
  const r = matcher.step(captured, wallTime);
  const projected = r ? r.time_ms + BUFFER_SEC * 1000 : null;
  const truthMs = editedSecToSourceSec(playhead) * 1000;
  const errMs = projected == null ? null : Math.abs(projected - truthMs);
  const status = projected == null
    ? "no-result"
    : errMs < TRACKING_TOLERANCE_MS
      ? "TRACKING"
      : "recovering";

  console.log(
    `  +${i} tick: playhead ${playhead}s → got ${projected?.toFixed(0) ?? "—"} ms` +
      ` (truth ${truthMs}, err ${errMs?.toFixed(0) ?? "—"} ms), ` +
      `mode=${r?.mode ?? "—"}, ambiguous=${r?.ambiguous || false}, ${status}`,
  );

  if (status === "TRACKING" && ticksToRecover == null) {
    ticksToRecover = i;
  }
}

console.log("");
if (ticksToRecover == null) {
  fail(`matcher never recovered within ${RECOVERY_BUDGET} ticks after seek`);
} else if (ticksToRecover > MAX_SEEK_RECOVERY_TICKS) {
  fail(
    `recovery took ${ticksToRecover} ticks (max ${MAX_SEEK_RECOVERY_TICKS})`,
  );
} else {
  ok(`matcher recovered ${ticksToRecover} tick(s) after seek`);
}

if (process.exitCode) {
  console.error("test-seek-recovery: failed");
  process.exit(1);
}
console.log("test-seek-recovery: OK");
