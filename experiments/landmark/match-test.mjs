// match-test.mjs
// Real-world(ish) matcher test: take a 5-second slice of the source
// audio, fingerprint it INDEPENDENTLY (re-decoding from the byte
// range, not slicing the index), look it up against the full
// file's landmark index. This is closer to what mic capture looks
// like than my earlier degenerate self-match.
//
// Optional second arg: add Gaussian-noise to the captured audio to
// see how the algorithm degrades.
//
// Usage:
//   node match-test.mjs <audio> [noise-db]

import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Codegen } = require("./vendor/lib");

const audioPath = process.argv[2];
const noiseDb = process.argv[3] ? Number(process.argv[3]) : null;
if (!audioPath) {
  console.error("usage: node match-test.mjs <audio> [noise-db]");
  process.exit(1);
}
const absAudio = path.resolve(__dirname, audioPath);

const durSec =
  Number(
    spawnSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      absAudio,
    ]).stdout.toString().trim(),
  );

const TICK_MS = (256 / 22050) * 1000;

// Fingerprint a chunk of audio. If `sliceArgs` is given, applies an
// ffmpeg slice (-ss / -t) before decoding to PCM, so we can extract
// a specific time window from the source. If `noiseDb` is set, adds
// pink noise at that level.
async function fingerprint(absAudio, sliceArgs = null, noiseDb = null) {
  const inArgs = ["-i", absAudio];
  if (sliceArgs) inArgs.push(...sliceArgs);
  // Build the audio filter chain: optionally add white-noise overlay.
  const filterArgs = noiseDb != null
    ? [
        "-filter_complex",
        `aevalsrc=random(0)|random(0):d=1000:s=22050[n];[0:a][n]amix=inputs=2:weights=1 ${Math.pow(10, noiseDb / 20)}[a]`,
        "-map", "[a]",
      ]
    : [];
  const decoderArgs = [
    ...inArgs,
    ...filterArgs,
    "-acodec", "pcm_s16le",
    "-ar", "22050",
    "-ac", "1",
    "-f", "wav",
    "-v", "fatal",
    "pipe:1",
  ];
  const decoder = spawn("ffmpeg", decoderArgs, {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const fp = new Codegen();
  decoder.stdout.pipe(fp);
  const tcodes = [];
  const hcodes = [];
  await new Promise((resolve, reject) => {
    fp.on("data", (d) => {
      tcodes.push(...d.tcodes);
      hcodes.push(...d.hcodes);
    });
    fp.on("end", resolve);
    fp.on("error", reject);
    decoder.on("error", reject);
  });
  return { tcodes, hcodes };
}

console.log(`source: ${audioPath} (${durSec.toFixed(1)} s)`);
if (noiseDb != null) console.log(`with overlay noise: ${noiseDb} dB`);
console.log();

// Fingerprint full file → inverted index.
console.log("fingerprinting full source...");
const full = await fingerprint(absAudio);
const idx = new Map();
for (let i = 0; i < full.hcodes.length; i++) {
  const h = full.hcodes[i];
  if (!idx.has(h)) idx.set(h, []);
  idx.get(h).push(full.tcodes[i]);
}
console.log(`  ${full.tcodes.length} landmarks, ${idx.size} unique hashes`);
console.log();

// Pick three test slices spread across the runtime. Each one is a
// 5-second window starting at the given second offset.
const tests = [
  { label: "20% in", startSec: durSec * 0.2 },
  { label: "50% in", startSec: durSec * 0.5 },
  { label: "80% in", startSec: durSec * 0.8 },
];

for (const t of tests) {
  console.log(`=== ${t.label} (slice starts at ${t.startSec.toFixed(1)} s) ===`);
  const sliceSec = Number(process.env.SLICE_SEC || 5);
  const slice = await fingerprint(
    absAudio,
    ["-ss", t.startSec.toString(), "-t", sliceSec.toString()],
    noiseDb,
  );
  console.log(`  captured ${slice.tcodes.length} landmarks from ${sliceSec} s slice`);
  // Look up each captured landmark in the index; histogram of offsets.
  const offsetHist = new Map();
  for (let i = 0; i < slice.hcodes.length; i++) {
    const candidates = idx.get(slice.hcodes[i]);
    if (!candidates) continue;
    for (const tStored of candidates) {
      // Stored is absolute tcode in the source; slice tcode starts
      // at 0 because we sliced before fingerprinting. So expected
      // offset is round(startSec / TICK_MS).
      const offset = tStored - slice.tcodes[i];
      offsetHist.set(offset, (offsetHist.get(offset) || 0) + 1);
    }
  }
  const peaks = [...offsetHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const expectedOffsetTicks = Math.round((t.startSec * 1000) / TICK_MS);
  const expectedOffsetMs = expectedOffsetTicks * TICK_MS;
  if (peaks.length === 0) {
    console.log(`  FAIL: no offsets matched anything in the index`);
  } else {
    const [winningOffset, winningVotes] = peaks[0];
    const winningOffsetMs = winningOffset * TICK_MS;
    const err = Math.abs(winningOffsetMs - expectedOffsetMs);
    console.log(
      `  expected offset ${expectedOffsetMs.toFixed(0)} ms`,
    );
    for (const [off, votes] of peaks) {
      const offMs = off * TICK_MS;
      const marker = off === winningOffset ? "★" : " ";
      console.log(`    ${marker} ${offMs.toFixed(0).padStart(8)} ms — ${votes.toString().padStart(3)} votes`);
    }
    const ratio = peaks[1] ? winningVotes / peaks[1][1] : Infinity;
    console.log(
      `  winner Δ ${err.toFixed(0)} ms from expected, ratio over 2nd place: ${ratio.toFixed(1)}×`,
    );
  }
  console.log();
}
