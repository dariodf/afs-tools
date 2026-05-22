// test/test-cli-conformance.js
// End-to-end conformance test for the `afs-generate` CLI tool.
// Runs the actual shell tool against a real media file, then
// verifies the output is:
//   - parseable by our parseAFS()
//   - structurally consistent (right algorithm, monotonic times,
//     plausible cue spacing, plausible hash count for the duration)
//   - usable by AFSMatcher: feeding the same audio captures back
//     through the matcher must lock on at time 0 with high
//     confidence
//
// This catches CLI argument regressions (e.g., if afs-generate
// stops passing --sha256 or starts using a different fpcalc flag)
// without us noticing in the unit tests.
//
// Run with: node test/test-cli-conformance.js

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import { AFSMatcher } from "../demo/src/afs-matcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "..");
const TOOL_PATH = path.join(REPO_DIR, "tools", "afs-generate");
const INPUT_MEDIA = path.resolve(REPO_DIR, "demo/content/dialogue-clip.mp4");

const CHROMAPRINT_HOP_MS = 4096000 / 33075; // ~123.99 ms

function skip(msg) {
  console.log(`test-cli-conformance: SKIP — ${msg}`);
  process.exit(0);
}
function fail(msg) { console.error(`  FAIL ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`  ok  ${msg}`); }

for (const tool of ["fpcalc", "ffmpeg", "bash"]) {
  try { execFileSync(tool, ["-version"], { stdio: "ignore" }); }
  catch {
    // Bash's -version isn't universal; fall back to --version.
    try { execFileSync(tool, ["--version"], { stdio: "ignore" }); }
    catch { skip(`${tool} not on PATH`); }
  }
}
if (!existsSync(TOOL_PATH)) skip("afs-generate not at tools/afs-generate");
if (!existsSync(INPUT_MEDIA)) skip(`input media missing: ${INPUT_MEDIA}`);

const workDir = mkdtempSync(path.join(tmpdir(), "afs-cli-test-"));
const outputPath = path.join(workDir, "out.afs");

try {
  console.log(`running: afs-generate --title "Test" --year 2026 ${path.basename(INPUT_MEDIA)} → out.afs\n`);
  execFileSync(
    "bash",
    [TOOL_PATH, "--title", "Test", "--year", "2026", "--no-sha256", "-q", INPUT_MEDIA, outputPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  if (!existsSync(outputPath)) {
    fail("afs-generate produced no output file");
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }

  const text = readFileSync(outputPath, "utf-8");

  // 1. parseAFS succeeds.
  let parsed;
  try {
    parsed = parseAFS(text);
    ok("parseAFS() accepts the CLI output");
  } catch (e) {
    fail(`parseAFS() rejects CLI output: ${e.message}`);
    process.exit(1);
  }

  // 2. Right algorithm.
  ok(`algorithm = ${parsed.algorithm}`);
  if (parsed.algorithm !== "chromaprint") {
    fail(`expected algorithm=chromaprint, got ${parsed.algorithm}`);
  }

  // 3. Metadata flags propagated.
  if (parsed.metadata?.source?.title !== "Test") {
    fail(`--title not propagated: got ${JSON.stringify(parsed.metadata?.source?.title)}`);
  } else ok(`metadata.source.title = "${parsed.metadata.source.title}"`);
  if (parsed.metadata?.source?.year !== 2026) {
    fail(`--year not propagated: got ${parsed.metadata?.source?.year}`);
  } else ok(`metadata.source.year = ${parsed.metadata.source.year}`);

  // 4. Body structurally consistent.
  const { hashes, times } = chromaprintArrays(parsed);
  ok(`${hashes.length} hashes in body`);
  if (hashes.length < 50) {
    fail(`suspiciously few hashes (${hashes.length}) for a 14-second clip`);
  }

  // Times monotonically increasing.
  let monotonic = true;
  for (let i = 1; i < times.length; i++) {
    if (times[i] <= times[i - 1]) { monotonic = false; break; }
  }
  if (!monotonic) fail("body times are not strictly monotonic");
  else ok("body times are strictly monotonic");

  // Cue spacing close to chromaprint's hop interval (~124 ms).
  if (times.length >= 2) {
    const lastInterval = times[times.length - 1] - times[times.length - 2];
    if (Math.abs(lastInterval - CHROMAPRINT_HOP_MS) > 1) {
      fail(`last cue spacing ${lastInterval.toFixed(2)} ms differs from chromaprint hop ${CHROMAPRINT_HOP_MS.toFixed(2)} ms`);
    } else ok(`cue spacing matches chromaprint hop (${lastInterval.toFixed(2)} ms)`);
  }

  // 5. Matcher round-trip: re-fingerprint the same input and verify
  //    a confident lock-on at time 0.
  const wav = execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-i", INPUT_MEDIA,
      "-ss", "0", "-t", "5",
      "-vn", "-ar", "48000", "-ac", "2",
      "-f", "wav", "-",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const fpOut = execFileSync("fpcalc", ["-raw", "-length", "0", "-"], { input: wav }).toString();
  const fpLine = fpOut.split("\n").find((l) => l.startsWith("FINGERPRINT="));
  const captured = new Uint32Array(
    fpLine
      .slice("FINGERPRINT=".length)
      .split(",")
      .map((s) => { const n = Number(s); return n < 0 ? n + 4294967296 : n; }),
  );

  const matcher = new AFSMatcher(hashes, times, {
    confidenceThreshold: 60,
    coldStartMinHashes: 8,
  });
  const result = matcher.step(captured, 0);
  if (!result) fail("matcher returned null on round-trip");
  else if (result.ambiguous) fail("matcher reports ambiguous on perfect round-trip");
  else if (result.time_ms > 500) {
    fail(`matcher locked at ${result.time_ms} ms, expected ~0 ms`);
  } else {
    ok(`round-trip match at ${result.time_ms.toFixed(0)} ms, confidence ${result.confidence.toFixed(1)}%`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (process.exitCode) {
  console.error("test-cli-conformance: failed");
  process.exit(1);
}
console.log("test-cli-conformance: OK");
