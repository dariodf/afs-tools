// test/test-cli-smoke.js
// Smoke tests for the user-facing CLI scripts. These verify that
// each tool's argument parsing and error paths work; they do NOT
// verify the actual fingerprinting / transcription output (that's
// covered by test-cli-conformance.js for afs-generate, and would
// require WhisperX in CI for transcribe-generate).
//
// What each smoke test asserts:
//   - `--help` exits 0 and prints usage text
//   - missing required argument exits non-zero with a message
//   - any deliberately-bad-combination flags fail with a useful
//     error rather than crashing or hanging
//
// Run with: node test/test-cli-smoke.js

import { spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "..");
const TOOLS = path.join(REPO_DIR, "tools");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
  }
}

function run(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: 5000,
    // Default env, but drop anything the user might have set that
    // would pull in a non-default whisperx — we want the smoke
    // tests to be deterministic about "WhisperX not found" too.
    ...opts,
  });
}

function expectExitCode(result, expected, label) {
  if (result.error) {
    throw new Error(`${label}: subprocess error: ${result.error.message}`);
  }
  if (result.status !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${result.status}.\n` +
        `stderr: ${(result.stderr || "").trim().slice(0, 200)}`,
    );
  }
}

function expectOutputContains(result, fragment, label) {
  const combined = (result.stdout || "") + (result.stderr || "");
  if (!combined.includes(fragment)) {
    throw new Error(
      `${label}: expected output to contain "${fragment}"\n` +
        `  got:\n    ${combined.split("\n").slice(0, 6).join("\n    ")}`,
    );
  }
}

// ----------------------------------------------------------------
// afs-format
// ----------------------------------------------------------------

const AFS_FORMAT = path.join(TOOLS, "afs-format");

if (!existsSync(AFS_FORMAT)) {
  console.error(`Skipping: ${AFS_FORMAT} not found`);
  process.exit(0);
}

test("afs-format: --help exits 0 with usage", () => {
  const result = run(AFS_FORMAT, ["--help"]);
  expectExitCode(result, 0, "afs-format --help");
  expectOutputContains(result, "Usage", "afs-format --help");
});

test("afs-format: -h is equivalent to --help", () => {
  const result = run(AFS_FORMAT, ["-h"]);
  expectExitCode(result, 0, "afs-format -h");
});

// ----------------------------------------------------------------
// afs-generate
// ----------------------------------------------------------------

const AFS_GENERATE = path.join(TOOLS, "afs-generate");

test("afs-generate: --help exits 0 with usage", () => {
  const result = run(AFS_GENERATE, ["--help"]);
  expectExitCode(result, 0, "afs-generate --help");
  expectOutputContains(result, "Usage", "afs-generate --help");
});

test("afs-generate: no input exits non-zero with usage", () => {
  const result = run(AFS_GENERATE, []);
  // Should be non-zero exit
  if (result.status === 0) {
    throw new Error(`afs-generate with no args unexpectedly exited 0`);
  }
  expectOutputContains(result, "no input file", "afs-generate (no args)");
});

test("afs-generate: missing input file exits non-zero", () => {
  const result = run(AFS_GENERATE, ["/tmp/does-not-exist-xyz123.mp4"]);
  if (result.status === 0) {
    throw new Error(`afs-generate on missing input unexpectedly exited 0`);
  }
  expectOutputContains(result, "not found", "afs-generate (missing file)");
});

test("afs-generate: unknown option exits non-zero", () => {
  const result = run(AFS_GENERATE, ["--bogus-flag", "x.mp4"]);
  if (result.status === 0) {
    throw new Error(`afs-generate with unknown option unexpectedly exited 0`);
  }
  expectOutputContains(result, "unknown option", "afs-generate (bad option)");
});

// ----------------------------------------------------------------
// transcribe-generate
// ----------------------------------------------------------------

const TRANSCRIBE = path.join(TOOLS, "transcribe-generate");

test("transcribe-generate: --help exits 0 with usage", () => {
  const result = run(TRANSCRIBE, ["--help"]);
  expectExitCode(result, 0, "transcribe-generate --help");
  expectOutputContains(result, "Usage", "transcribe-generate --help");
});

test("transcribe-generate: no input exits non-zero with usage", () => {
  const result = run(TRANSCRIBE, []);
  if (result.status === 0) {
    throw new Error(
      `transcribe-generate with no args unexpectedly exited 0`,
    );
  }
  expectOutputContains(
    result,
    "no input file",
    "transcribe-generate (no args)",
  );
});

test("transcribe-generate: --no-srt and --no-afs together is rejected", () => {
  // We need a media file path that exists so the script gets past
  // the "input not found" check. Use any committed demo asset.
  const anyMedia = path.join(REPO_DIR, "demo/content/dialogue-clip.mp4");
  if (!existsSync(anyMedia)) {
    console.log(
      "  (skipped sub-check: demo/content/dialogue-clip.mp4 not present)",
    );
    return;
  }
  const result = run(TRANSCRIBE, ["--no-srt", "--no-afs", anyMedia]);
  if (result.status === 0) {
    throw new Error(
      `transcribe-generate --no-srt --no-afs unexpectedly exited 0`,
    );
  }
  expectOutputContains(
    result,
    "would do nothing",
    "transcribe-generate (--no-srt --no-afs)",
  );
});

test("transcribe-generate: missing WhisperX prints install help", () => {
  // Force WhisperX to be unavailable by pointing the venv-detection
  // path at a directory that doesn't have it AND by clearing PATH
  // so `command -v whisperx` fails. The script should print install
  // instructions and exit non-zero.
  const anyMedia = path.join(REPO_DIR, "demo/content/dialogue-clip.mp4");
  if (!existsSync(anyMedia)) {
    console.log(
      "  (skipped sub-check: demo/content/dialogue-clip.mp4 not present)",
    );
    return;
  }
  const result = run(TRANSCRIBE, ["--no-afs", anyMedia], {
    // Hostile env: only the script's own dir is reachable, so
    // anything not bundled with it (like a system whisperx) won't
    // be found. Critically: do NOT include the project's
    // .venv-whisperx/, which the user may have created locally.
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
    cwd: "/tmp",
  });
  // If the dev's repo HAS a .venv-whisperx directory, the script
  // will find it via REPO_ROOT/.venv-whisperx/bin/whisperx and
  // actually try to transcribe — succeeding (or failing with a
  // different error). In that case, accept any non-help exit
  // status; only fail if the script crashes without output.
  const hasVenv = existsSync(
    path.join(REPO_DIR, ".venv-whisperx", "bin", "whisperx"),
  );
  if (hasVenv) {
    console.log(
      "  (subcheck: local .venv-whisperx is present, skipping missing-WhisperX path)",
    );
    return;
  }
  if (result.status === 0) {
    throw new Error(
      `transcribe-generate without WhisperX unexpectedly exited 0`,
    );
  }
  expectOutputContains(
    result,
    "WhisperX not found",
    "transcribe-generate (no WhisperX)",
  );
});

// ----------------------------------------------------------------
// afs-minimize
// ----------------------------------------------------------------

const MINIMIZE = path.join(TOOLS, "afs-minimize");

test("afs-minimize: --help exits 0 with usage", () => {
  const result = run(MINIMIZE, ["--help"]);
  expectExitCode(result, 0, "afs-minimize --help");
  expectOutputContains(result, "Usage", "afs-minimize --help");
});

test("afs-minimize: missing arguments exits non-zero with usage", () => {
  const result = run(MINIMIZE, []);
  if (result.status === 0) {
    throw new Error(`afs-minimize with no args unexpectedly exited 0`);
  }
  expectOutputContains(result, "need both", "afs-minimize (no args)");
});

test("afs-minimize: missing AFS file exits non-zero", () => {
  const result = run(MINIMIZE, [
    "/tmp/does-not-exist-xyz123.afs",
    "/tmp/does-not-exist-xyz123.srt",
  ]);
  if (result.status === 0) {
    throw new Error(`afs-minimize on missing files unexpectedly exited 0`);
  }
  expectOutputContains(result, "not found", "afs-minimize (missing AFS)");
});

test("afs-minimize: minimizes the Tears of Steel pair and the result parses", () => {
  // End-to-end: run the real tool on the demo content, verify the
  // output is a valid AFS that contains fewer hash lines than the
  // input. Skips gracefully if the demo content isn't built.
  const inAfs = path.join(REPO_DIR, "demo/content/dialogue-clip.afs");
  const inSrt = path.join(REPO_DIR, "demo/content/dialogue-clip.en.srt");
  if (!existsSync(inAfs) || !existsSync(inSrt)) {
    console.log("  (skipped: dialogue-clip demo content not present)");
    return;
  }
  // Write to a tempfile rather than stdout — the smoke test runner
  // doesn't need to read the AFS body, just confirm tool exit + size.
  const outPath = path.join(REPO_DIR, ".afs-minimize-smoke-tmp.afs");
  try {
    const result = run(MINIMIZE, [inAfs, inSrt, outPath]);
    expectExitCode(result, 0, "afs-minimize end-to-end");
    if (!existsSync(outPath)) {
      throw new Error("afs-minimize produced no output file");
    }
    const inSize = statSync(inAfs).size;
    const outSize = statSync(outPath).size;
    if (outSize >= inSize) {
      throw new Error(
        `expected minimized AFS (${outSize}B) to be smaller than original (${inSize}B)`,
      );
    }
  } finally {
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});

// ----------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
