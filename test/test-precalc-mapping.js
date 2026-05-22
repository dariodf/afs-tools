// test/test-precalc-mapping.js
// Verify the pre-computed time mapping (mode 1: local player, no
// listening) produces correct source positions for known derived
// times across all blocks of the edited clip.
//
// This is the "real local player" mode: instead of running the
// matcher tick-by-tick during playback, compute a static mapping
// from derived-clip time to source-clip time once, then look up
// at every frame. Faster, more accurate, doesn't need the audio
// graph running.
//
// Ground truth comes from how the edited clip was constructed
// (see demo/content/README.md):
//
//   edited 0-5  s → source 0-5
//   edited 5-10 s → source 7-12   (cut: removed source 5-7)
//   edited 10-14 s → source 14-18 (cut: removed source 12-14)
//   edited 14-end → source 20-end (cut: removed source 18-20)
//
// At interior points of each block the mapping is a pure offset.
// Across a cut the mapping jumps.
//
// Doesn't require fpcalc — the AFS files committed to demo/content/
// are enough. (ffmpeg / fpcalc are not used here.)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseAFS } from "../demo/src/afs-parser.js";
import { computeTimeMapping } from "../demo/src/afs-mapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_AFS = path.resolve(__dirname, "../demo/content/dialogue-clip.afs");
const EDITED_AFS = path.resolve(
  __dirname,
  "../demo/content/dialogue-clip-edited.afs",
);

let failures = 0;
function fail(msg) { console.error(`  FAIL: ${msg}`); failures++; }
function ok(msg)   { console.log(`  ok: ${msg}`); }

if (!existsSync(SOURCE_AFS) || !existsSync(EDITED_AFS)) {
  console.log(
    "test-precalc-mapping: SKIP — dialogue-clip AFS files not present. " +
      "Run demo/content/fetch-content.sh + the trim recipes in README.md.",
  );
  process.exit(0);
}

const source = parseAFS(readFileSync(SOURCE_AFS, "utf-8"));
const edited = parseAFS(readFileSync(EDITED_AFS, "utf-8"));

const mapping = computeTimeMapping(source, edited);

console.log(`built mapping from ${mapping.anchors.length} anchors`);

// Tolerance: anchors are sampled at sub-second stride and inside
// each block the mapping is identity-plus-offset, so interior
// errors should be tens of ms. Within ~1 s after a cut the
// matcher's local-search recovery is still settling and errors
// up to ~1.5 s are expected.
const INTERIOR_TOLERANCE_MS = 200;
const POST_CUT_TOLERANCE_MS = 1500;

// IMPORTANT: precalc mapping has unavoidable blind spots in a
// window of ~2.6 s immediately BEFORE each cut. This is a property
// of chromaprint, not of our algorithm: a hash whose timestamp is
// `t` was computed using audio in [t, t + 2.6 s]. Within 2.6 s of
// a cut, those hashes incorporate audio from *both* sides of the
// cut and become inherently ambiguous — the matcher picks
// whichever forward source position scores best, which is usually
// somewhere past the cut. For practical use (subtitle display,
// haptics scheduling) this manifests as a sub-3-s transition
// where the displayed source-time leads the true source-time
// briefly. Visually it just looks like an early cue change.
//
// The test reflects this. We DO test:
//   - well-interior points (≥ 2.6 s before a cut, ≥ 1 s after)
//   - "just after a cut" — recovery should be quick once new
//     audio comes in
// We do NOT test the 2.6 s window immediately before a cut. A
// future algorithm change that closes this gap is welcome but not
// a contract.

const cases = [
  // Block 1 — source 0-5 (cut at edited 5).
  { editedMs:  1000, expectedSourceMs:  1000, kind: "interior", label: "block 1 mid" },
  // Block 2 — source 7-12 (cut at edited 10, +2 s offset).
  { editedMs:  6500, expectedSourceMs:  8500, kind: "interior", label: "block 2 mid (≥1 s past cut)" },
  // Block 3 — source 14-18 (cut at edited 14, +4 s offset). Block
  // is only 4 s long; the interior point is also the only safe
  // probe.
  { editedMs: 11500, expectedSourceMs: 15500, kind: "interior", label: "block 3 mid" },
  // Block 4 — source 20-end, +6 s offset. Several samples to
  // confirm the mapping holds across the full block.
  { editedMs: 16000, expectedSourceMs: 22000, kind: "post-cut", label: "block 4 just after cut" },
  { editedMs: 25000, expectedSourceMs: 31000, kind: "interior", label: "block 4 mid" },
  { editedMs: 50000, expectedSourceMs: 56000, kind: "interior", label: "block 4 late" },
  { editedMs: 75000, expectedSourceMs: 81000, kind: "interior", label: "block 4 very late" },
];

console.log("");
for (const c of cases) {
  const got = mapping.lookup(c.editedMs);
  if (got == null) {
    fail(`${c.label} (edited ${c.editedMs} ms): lookup returned null`);
    continue;
  }
  const err = Math.abs(got - c.expectedSourceMs);
  const tolerance =
    c.kind === "interior" ? INTERIOR_TOLERANCE_MS : POST_CUT_TOLERANCE_MS;
  const detail =
    `edited ${c.editedMs} ms → source ${got.toFixed(0)} ms ` +
    `(expected ~${c.expectedSourceMs}, off ${err.toFixed(0)} ms)`;
  if (err < tolerance) {
    ok(`${c.label}: ${detail}`);
  } else {
    fail(`${c.label}: ${detail} — exceeded ${tolerance} ms tolerance`);
  }
}

console.log("");
if (failures > 0) {
  console.error(`test-precalc-mapping: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-precalc-mapping: OK");
