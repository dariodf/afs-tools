// test/test-three-modes.js
// Run the SAME source point through all three mode-equivalent
// code paths and print a comparative readout. Used as a
// human-readable "everything works" smoke test in CI; the deep
// per-mode tests live in test-precalc-mapping.js,
// test-live-playback-sim.js, and test-fpcalc-robustness.js.
//
//   Mode 1 — Pre-calculated:
//     Look up edited-time in a derived→source mapping built once
//     from both AFS files. No audio capture, no matcher running.
//
//   Mode 2 — Listen · audio output:
//     Fingerprint the edited clip's clean audio (what Web Audio's
//     MediaElementSource would capture) and locate it in the
//     source AFS via the matcher.
//
//   Mode 3 — Listen · microphone:
//     Fingerprint the same audio with light "mic-channel"
//     degradation applied (a low-pass roll-off + dynamic-range
//     compression + background noise) and locate it via the
//     matcher with relaxed tolerance.
//
// Requires fpcalc + ffmpeg + the dialogue-clip content. Skips
// gracefully when missing.
//
// Run with: node test/test-three-modes.js

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import { AFSMatcher } from "../demo/src/afs-matcher.js";
import { computeTimeMapping } from "../demo/src/afs-mapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../demo/content");
const SOURCE_AFS = path.join(CONTENT_DIR, "dialogue-clip.afs");
const DERIVED_AFS = path.join(CONTENT_DIR, "dialogue-clip-edited.afs");
const EDITED_MP4 = path.join(CONTENT_DIR, "dialogue-clip-edited.mp4");

// Probe point: edited time 25 s sits inside block 4 (the long
// final block, no nearby cuts) and maps to source 31 s.
const PROBE_EDITED_MS = 25000;
const PROBE_SLICE_LEN_SEC = 5;
const EXPECTED_SOURCE_MS = 31000;

const PRECALC_TOLERANCE_MS = 200;
const LISTEN_OUTPUT_TOLERANCE_MS = 250;
const LISTEN_MIC_TOLERANCE_MS = 600;

let failures = 0;
function fail(msg) { console.error(`  FAIL: ${msg}`); failures++; }
function ok(msg)   { console.log(`  ok: ${msg}`); }

function skip(msg) {
  console.log(`test-three-modes: SKIP — ${msg}`);
  process.exit(0);
}

for (const tool of ["fpcalc", "ffmpeg"]) {
  try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
  catch { skip(`${tool} not on PATH`); }
}
for (const f of [SOURCE_AFS, DERIVED_AFS, EDITED_MP4]) {
  if (!existsSync(f)) skip(`missing content file: ${path.basename(f)}`);
}

const sourceAfs = parseAFS(readFileSync(SOURCE_AFS, "utf-8"));
const derivedAfs = parseAFS(readFileSync(DERIVED_AFS, "utf-8"));
const { hashes: srcHashes, times: srcTimes } = chromaprintArrays(sourceAfs);

function freshMatcher() {
  return new AFSMatcher(srcHashes, srcTimes, {
    confidenceThreshold: 60,
    coldStartMinHashes: 8,
  });
}

// Fingerprint a 5 s slice of the edited audio, optionally applying
// a "microphone channel" filter: low-pass roll-off above 4 kHz
// (smartphone mic frequency response), a moderate compressor (AGC
// approximation), and additive white noise (room background).
function fpcalcSlice(editedSec, len, { mic = false } = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-i", EDITED_MP4,
  ];
  if (mic) {
    // Mix the source-derived audio with a noise source to simulate
    // the acoustic + sensor chain. The chained filters approximate
    // mic frequency response (lowpass), AGC (acompressor), then
    // add background noise.
    const filter =
      `[0:a]atrim=${editedSec}:${editedSec + len},asetpts=PTS-STARTPTS,` +
      `lowpass=f=4000,acompressor=ratio=4:threshold=-15dB[clean];` +
      `anoisesrc=amplitude=0.06:color=white:duration=${len}:sample_rate=48000[noise];` +
      `[clean][noise]amix=inputs=2:duration=shortest:weights=4 1[mix]`;
    args.push(
      "-filter_complex", filter,
      "-map", "[mix]",
    );
  } else {
    args.push(
      "-ss", String(editedSec),
      "-t", String(len),
    );
  }
  args.push(
    "-vn", "-ar", "48000", "-ac", "2", "-f", "wav", "-",
  );
  const wav = execFileSync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
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

function evaluate(label, gotMs, toleranceMs, detail = "") {
  if (gotMs == null) {
    fail(`${label}: no result`);
    return;
  }
  const err = Math.abs(gotMs - EXPECTED_SOURCE_MS);
  const line =
    `${label}: edited ${PROBE_EDITED_MS} ms → source ${gotMs.toFixed(0)} ms ` +
    `(expected ~${EXPECTED_SOURCE_MS}, off ${err.toFixed(0)} ms)` +
    (detail ? `, ${detail}` : "");
  if (err <= toleranceMs) ok(line);
  else fail(`${line} — tolerance ${toleranceMs} ms`);
}

console.log(`probe: edited ${PROBE_EDITED_MS} ms · expected source ${EXPECTED_SOURCE_MS} ms`);
console.log("");

// -----------------------------------------------------------------
// Mode 1 — Pre-calculated
// -----------------------------------------------------------------
{
  const mapping = computeTimeMapping(sourceAfs, derivedAfs);
  const got = mapping.lookup(PROBE_EDITED_MS);
  evaluate(
    "MODE 1 — pre-calc",
    got,
    PRECALC_TOLERANCE_MS,
    `${mapping.blocks.length} blocks, ${mapping.anchors.length} anchors`,
  );
}

// -----------------------------------------------------------------
// Mode 2 — Listen · audio output
// -----------------------------------------------------------------
{
  const sliceStart = (PROBE_EDITED_MS - PROBE_SLICE_LEN_SEC * 1000) / 1000;
  const captured = fpcalcSlice(sliceStart, PROBE_SLICE_LEN_SEC);
  const result = freshMatcher().step(captured, 0);
  const got = result ? result.time_ms + PROBE_SLICE_LEN_SEC * 1000 : null;
  evaluate(
    "MODE 2 — listen · audio output",
    got,
    LISTEN_OUTPUT_TOLERANCE_MS,
    result
      ? `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}, ambiguous=${result.ambiguous || false}`
      : "matcher returned null",
  );
}

// -----------------------------------------------------------------
// Mode 3 — Listen · microphone (simulated)
// -----------------------------------------------------------------
{
  const sliceStart = (PROBE_EDITED_MS - PROBE_SLICE_LEN_SEC * 1000) / 1000;
  const captured = fpcalcSlice(sliceStart, PROBE_SLICE_LEN_SEC, { mic: true });
  const result = freshMatcher().step(captured, 0);
  const got = result ? result.time_ms + PROBE_SLICE_LEN_SEC * 1000 : null;
  evaluate(
    "MODE 3 — listen · microphone (sim)",
    got,
    LISTEN_MIC_TOLERANCE_MS,
    result
      ? `confidence ${result.confidence.toFixed(1)}%, mode=${result.mode}, ambiguous=${result.ambiguous || false}`
      : "matcher returned null",
  );
}

console.log("");
if (failures > 0) {
  console.error(`test-three-modes: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-three-modes: OK");
