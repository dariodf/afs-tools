// test/test-full-playback-walk.js
// Walk the entire edited-clip playback through the matcher tick
// by tick — the way the live demo actually runs across a whole
// session — and verify:
//
//   1. Steady-state TRACKING within each block: reported source
//      position is within tolerance of truth (computed from the
//      known edited→source mapping for this clip's cuts).
//
//   2. RECOVERY across each cut: after a cut, the matcher takes
//      some ticks to re-acquire the new source position. Within
//      a bounded recovery window, tracking resumes.
//
//   3. Aggregate tracking ratio over the full walk is high (the
//      vast majority of ticks land in the correct block).
//
// The matcher's state is preserved across calls — this is the
// same matcher instance the live demo would run for a 60-90 s
// playback session. Local search + cold-start re-acquisition
// behaviors are exercised end-to-end.
//
// Requires fpcalc + ffmpeg + the dialogue-clip content. Slower
// than other tests (~75 ffmpeg+fpcalc subprocess pairs); skips
// gracefully when tools/content aren't present.
//
// Run with: node test/test-full-playback-walk.js

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

// Playback geometry. Stride 1 s gives us 75 sample points over a
// 75 s walk — comparable to the demo's perceived behavior, fast
// enough for CI (~10-15 s wall-clock).
const STRIDE_SEC = 1;
const BUFFER_SEC = 8;
const START_SEC = BUFFER_SEC; // first tick once the buffer is full
const END_SEC = 75;

// Tolerance bands.
const TRACKING_TOLERANCE_MS = 600; // "I'm on the right source position"
const LOST_TOLERANCE_MS = 2500;    // beyond this is "lost," not "recovering"

// A tick is "stable" when no cut sits within the last STABLE_LOOKBACK_SEC
// seconds of edited time. The matcher's single-window alignment cannot
// give a unique source position while its buffer literally contains
// audio from multiple source blocks — that's a fundamental property of
// chromaprint matching, not a bug. We require tracking only in stable
// ticks; transient ticks are reported but not asserted.
//
// 5 s is empirically the smallest contiguous in-buffer block size at
// which alignment locks on this clip (see test output: tracking
// resumes at edited 19 s, exactly 5 s after the last cut at 14 s).
const STABLE_LOOKBACK_SEC = 5;
// Aggregate floor across the whole walk (catches catastrophic
// regressions even if no individual stable tick fails).
const MIN_TRACKING_RATIO = 0.75;

// Edited clip construction (see demo/content/MEDIA-CHOICES.md):
//   edited 0-5  → source 0-5
//   edited 5-10 → source 7-12   (cut at edited 5; removed source 5-7)
//   edited 10-14→ source 14-18  (cut at edited 10; removed source 12-14)
//   edited 14-end→source 20-end (cut at edited 14; removed source 18-20)
const CUTS_AT_EDITED_SEC = [5, 10, 14];
function editedSecToSourceSec(editedSec) {
  if (editedSec < 5) return editedSec;
  if (editedSec < 10) return editedSec + 2;
  if (editedSec < 14) return editedSec + 4;
  return editedSec + 6;
}

function fail(msg) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; }
function skip(msg) {
  console.log(`test-full-playback-walk: SKIP — ${msg}`);
  process.exit(0);
}

for (const tool of ["fpcalc", "ffmpeg"]) {
  try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
  catch { skip(`${tool} not on PATH`); }
}
if (!existsSync(AFS_PATH) || !existsSync(EDITED_MP4)) {
  skip("dialogue-clip content not produced.");
}

// Capture the last `BUFFER_SEC` seconds of audio ending at playhead
// `tSec` (in edited time). Returns the captured chromaprint hashes.
function captureAt(tSec) {
  const bufStart = Math.max(0, tSec - BUFFER_SEC);
  const bufDur = tSec - bufStart;
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
  if (!fpLine) throw new Error("fpcalc produced no FINGERPRINT line");
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

// Walk the timeline. For each tick: capture buffer, step matcher,
// project to "where the source is now" (start of matched window +
// captured-window duration), classify the result against truth.
const ticks = []; // [{tSec, truthMs, gotMs, errMs, classification, mode}]
let wallTime = 0;

console.log(
  `walk: edited ${START_SEC}-${END_SEC} s, stride ${STRIDE_SEC} s, buffer ${BUFFER_SEC} s`,
);
console.log("");

for (let t = START_SEC; t <= END_SEC; t += STRIDE_SEC) {
  const captured = captureAt(t);
  wallTime += STRIDE_SEC * 1000;
  const result = matcher.step(captured, wallTime);

  const truthMs = editedSecToSourceSec(t) * 1000;
  const gotMs = result ? result.time_ms + BUFFER_SEC * 1000 : null;
  const errMs = gotMs == null ? null : Math.abs(gotMs - truthMs);

  let classification;
  if (gotMs == null) classification = "no-result";
  else if (errMs < TRACKING_TOLERANCE_MS) classification = "tracking";
  else if (errMs < LOST_TOLERANCE_MS) classification = "recovering";
  else classification = "lost";

  ticks.push({
    tSec: t,
    truthMs,
    gotMs,
    errMs,
    classification,
    mode: result?.mode ?? null,
    ambiguous: !!result?.ambiguous,
  });
}

// Mark each tick stable or transient. Transient = there was a cut
// within the last STABLE_LOOKBACK_SEC; the matcher cannot be expected
// to give a uniquely-correct answer because its buffer is spanning
// multiple source blocks.
function isStable(editedSec) {
  return !CUTS_AT_EDITED_SEC.some(
    (c) => c > editedSec - STABLE_LOOKBACK_SEC && c <= editedSec,
  );
}
for (const t of ticks) t.stable = isStable(t.tSec);

// Report each tick in a compact, scannable table.
const fmt = (n) => (n == null ? "—".padStart(7) : String(Math.round(n)).padStart(7));
console.log("  edited   truth     got     err  mode   ambig  zone        state");
console.log("  ───────────────────────────────────────────────────────────────────────");
for (const t of ticks) {
  const isCut = CUTS_AT_EDITED_SEC.some((c) => Math.abs(t.tSec - c) < 0.5);
  const cutMarker = isCut ? "  ← cut" : "";
  console.log(
    `  ${String(t.tSec.toFixed(0)).padStart(3)} s  ` +
      `${fmt(t.truthMs)}  ${fmt(t.gotMs)}  ${fmt(t.errMs)}  ` +
      `${(t.mode ?? "—").padEnd(5)}  ` +
      `${t.ambiguous ? "yes  " : "no   "}  ` +
      `${t.stable ? "stable    " : "transient "}  ` +
      `${t.classification}${cutMarker}`,
  );
}
console.log("");

const total = ticks.length;
const stableTicks = ticks.filter((t) => t.stable);
const transientTicks = ticks.filter((t) => !t.stable);
const tracking = ticks.filter((t) => t.classification === "tracking").length;
const stableTracking = stableTicks.filter((t) => t.classification === "tracking").length;
const stableNotTracking = stableTicks.filter((t) => t.classification !== "tracking");
const trackingRatio = tracking / total;

console.log(
  `summary: ${tracking}/${total} tracking (${(trackingRatio * 100).toFixed(1)}%), ` +
    `${stableTicks.length} stable / ${transientTicks.length} transient, ` +
    `stable tracking ${stableTracking}/${stableTicks.length}`,
);

// Assertions.
let assertionFailures = 0;
// 1. Every stable tick must be tracking. This is the strong invariant:
//    once the buffer is contiguous, the matcher must report the right
//    source position.
if (stableNotTracking.length > 0) {
  fail(
    `${stableNotTracking.length} stable tick(s) not tracking:` +
      stableNotTracking
        .map(
          (t) =>
            `\n      edited ${t.tSec}s: truth ${t.truthMs} got ${t.gotMs} (err ${t.errMs}) — ${t.classification}`,
        )
        .join(""),
  );
  assertionFailures += 1;
}
// 2. Aggregate floor across the whole walk. Transients are allowed
//    to be off, but if we drop below this threshold something is
//    catastrophically broken.
if (trackingRatio < MIN_TRACKING_RATIO) {
  fail(
    `tracking ratio ${(trackingRatio * 100).toFixed(1)}% below minimum ` +
      `${(MIN_TRACKING_RATIO * 100).toFixed(0)}%`,
  );
  assertionFailures += 1;
}
// 3. The matcher should self-flag MOST transient ticks where it's
//    reporting a wrong position. The edge-check (head+tail Hamming
//    distance against the projected source positions) is the signal
//    used here. It's not perfect — a buffer that happens to span
//    similar audio at both edges can slip through — but it should
//    catch the vast majority of cut-spanning ticks. Allow up to one
//    miss per cuts cluster as a tolerable limitation.
const transientNotTracking = transientTicks.filter(
  (t) => t.classification !== "tracking",
);
const unflagged = transientNotTracking.filter((t) => !t.ambiguous);
const maxUnflagged = Math.max(1, Math.floor(transientNotTracking.length * 0.15));
if (unflagged.length > maxUnflagged) {
  fail(
    `${unflagged.length} transient tick(s) reported a wrong position ` +
      `with ambiguous=false (max allowed ${maxUnflagged} = 15 % of ${transientNotTracking.length} ` +
      `non-tracking transient ticks):` +
      unflagged
        .map(
          (t) =>
            `\n      edited ${t.tSec}s: got ${t.gotMs} (err ${t.errMs}) — ${t.classification}`,
        )
        .join(""),
  );
  assertionFailures += 1;
}

console.log("");
if (assertionFailures > 0) {
  console.error(`test-full-playback-walk: ${assertionFailures} assertion(s) failed`);
  process.exit(1);
}
console.log("test-full-playback-walk: OK");
