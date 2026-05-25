// compare.mjs
// Run both the chromaprint v0.1 fingerprinter and the Shazam-style
// landmark fingerprinter against the same demo audio and report
// what each produces. Goal: derisk the v0.2 landmark migration —
// does the landmark algorithm produce sensible hashes? How dense?
// What's the rough cost? Does a self-match work?
//
// Usage: node compare.mjs <path-to-audio>

import { spawnSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Codegen } = require("./vendor/lib");

const audioPath = process.argv[2] || "../../demo/content/overture-finale.mp3";
const absAudio = path.resolve(__dirname, audioPath);
const audioBytes = statSync(absAudio).size;

const durSec =
  Number(
    spawnSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      absAudio,
    ]).stdout.toString().trim(),
  );

console.log(`source: ${audioPath}`);
console.log(`         ${(audioBytes / 1024).toFixed(0)} KB, ${durSec.toFixed(1)} s\n`);

// ---------- chromaprint baseline ----------
console.log("=== chromaprint v0.1 ===");
const cpStart = performance.now();
const cpOut = spawnSync("fpcalc", ["-raw", "-length", "0", absAudio]).stdout
  .toString();
const cpMs = performance.now() - cpStart;
const cpHashes = (cpOut.match(/^FINGERPRINT=(.*)$/m)?.[1] || "")
  .split(",")
  .filter(Boolean);
console.log(`  hashes: ${cpHashes.length.toLocaleString()}`);
console.log(`  density: ${(cpHashes.length / durSec).toFixed(2)} hashes/sec`);
console.log(`  bytes per hash: 4 (uint32)`);
console.log(`  wall time: ${cpMs.toFixed(0)} ms`);
console.log(`  raw stream size: ${(cpHashes.length * 4 / 1024).toFixed(1)} KB`);
console.log();

// ---------- landmark fingerprinter ----------
console.log("=== shazam-style landmarks (adblockradio) ===");
const lmStart = performance.now();
const tcodes = [];
const hcodes = [];
await new Promise((resolve, reject) => {
  const decoder = spawn(
    "ffmpeg",
    [
      "-i", "pipe:0",
      "-acodec", "pcm_s16le",
      "-ar", "22050",
      "-ac", "1",
      "-f", "wav",
      "-v", "fatal",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const fp = new Codegen();
  decoder.stdout.pipe(fp);
  // Stream the source mp3 in.
  const reader = spawn("cat", [absAudio]);
  reader.stdout.pipe(decoder.stdin);
  fp.on("data", (d) => {
    tcodes.push(...d.tcodes);
    hcodes.push(...d.hcodes);
  });
  fp.on("end", resolve);
  fp.on("error", reject);
  decoder.on("error", reject);
});
const lmMs = performance.now() - lmStart;

// tcodes are FFT step indices. The lib uses NFFT=512 with 50%
// overlap, so STEP=256 samples. At 22050 Hz that's 256/22050 ≈
// 11.61 ms per tick. (The lib's README example uses NFFT/SAMPLE_RATE
// which is a different — and wrong — figure; the source code is
// the source of truth.)
const TICK_MS = (256 / 22050) * 1000;
const lastMs = (tcodes[tcodes.length - 1] || 0) * TICK_MS;

console.log(`  landmarks: ${tcodes.length.toLocaleString()}`);
console.log(`  density: ${(tcodes.length / durSec).toFixed(2)} landmarks/sec`);
console.log(`  bytes per hash: 4 (uint32 hcode + uint32 tcode)`);
console.log(`  wall time: ${lmMs.toFixed(0)} ms`);
console.log(`  span: 0 to ${(lastMs / 1000).toFixed(1)} s`);
console.log(`  raw stream size: ${(tcodes.length * 8 / 1024).toFixed(1)} KB`);
console.log();

// ---------- self-match: take a 5 s window of landmarks from the middle
// of the source and see if an inverted-index lookup against the full
// stream finds the right time offset. This is the matcher's actual
// hot path in Shazam-style; the algorithm is histogram-of-offsets.
console.log("=== self-match test (5 s window from middle) ===");
const middleMs = (durSec * 1000) / 2;
const middleTick = middleMs / TICK_MS;
const windowTicks = 5000 / TICK_MS;
const sliceIdx = tcodes
  .map((t, i) => [t, i])
  .filter(([t]) => t >= middleTick && t < middleTick + windowTicks);
console.log(`  slice has ${sliceIdx.length} landmarks (expected ~${(sliceIdx.length / 5).toFixed(0)}/sec)`);

// Build inverted index from the full file: hash → list of tcodes.
const idx = new Map();
for (let i = 0; i < hcodes.length; i++) {
  const h = hcodes[i];
  if (!idx.has(h)) idx.set(h, []);
  idx.get(h).push(tcodes[i]);
}
console.log(`  inverted index: ${idx.size.toLocaleString()} unique hashes (of ${hcodes.length.toLocaleString()} total)`);

// Histogram of (storedTick - capturedTick) offsets.
const offsetHist = new Map();
for (const [tCaptured, iCaptured] of sliceIdx) {
  const hCaptured = hcodes[iCaptured];
  const candidates = idx.get(hCaptured);
  if (!candidates) continue;
  for (const tStored of candidates) {
    const offset = tStored - tCaptured;
    offsetHist.set(offset, (offsetHist.get(offset) || 0) + 1);
  }
}

// Top 3 peaks
const peaks = [...offsetHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(`  histogram has ${offsetHist.size.toLocaleString()} distinct offsets`);
for (const [offset, count] of peaks) {
  const offsetMs = offset * TICK_MS;
  console.log(`    offset ${offsetMs.toFixed(0)} ms — ${count} votes`);
}
const winningOffsetTicks = peaks[0]?.[0] ?? 0;
const winningOffsetMs = winningOffsetTicks * TICK_MS;
const expectedOffsetMs = 0; // self-match: 0 offset because we took from the same file
console.log(`  result: matched at offset ${winningOffsetMs.toFixed(0)} ms (expected ${expectedOffsetMs} ms)`);
console.log(
  `  ratio peak/second: ${peaks[0] && peaks[1]
    ? (peaks[0][1] / peaks[1][1]).toFixed(1)
    : "?"
  }× (Shazam paper recommends >= 2× for confident lock)`,
);
