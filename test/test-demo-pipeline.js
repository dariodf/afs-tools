// test/test-demo-pipeline.js
// End-to-end smoke test of the demo's module pipeline:
//   Generate audio → fingerprint → write AFS → parse AFS → match a
//   slice → look up subtitle.
//
// This is NOT a real matching test (mockFingerprint isn't real
// chromaprint — see comments in chromaprint.js). It only verifies
// that the modules wire together correctly. The slice must align to
// block boundaries (multiples of 1365 samples) for mockFingerprint
// to give matching hashes.
//
// Run with: node test/test-demo-pipeline.js

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import { AFSMatcher } from "../demo/src/afs-matcher.js";
import { parseSRT } from "../demo/src/srt-parser.js";
import { writeAFS } from "../demo/src/afs-writer.js";
import { mockFingerprint, chromaprintCueMs } from "../demo/src/chromaprint.js";
import { SubtitleRenderer } from "../demo/src/subtitle-renderer.js";
import { HapticsEventManager } from "../demo/src/haptics-events.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

console.log("end-to-end demo pipeline smoke test:");

// Generate a fake 90-second audio buffer.
const seconds = 90;
const samples = new Float32Array(seconds * 11025);
for (let i = 0; i < samples.length; i++) {
  samples[i] =
    Math.sin((2 * Math.PI * 440 * i) / 11025) * 0.5 +
    (Math.random() - 0.5) * 0.1;
}

// Fingerprint and write as AFS.
const storedHashes = mockFingerprint(samples);
const afsText = writeAFS(storedHashes, {
  source: { title: "Smoke Test", duration_ms: seconds * 1000 },
  audio: { sample_rate_hz: 44100, channels: 2, language: "en" },
});
console.log(`  AFS produced: ${storedHashes.length} hashes, ${afsText.length} bytes`);

// Parse back.
const parsed = parseAFS(afsText);
const { hashes, times } = chromaprintArrays(parsed);
assert(hashes.length === storedHashes.length, "round-trip hash count");
assert(times[0] === 0, "first time cue is 0");

// Slice on a block boundary so mockFingerprint produces matching
// hashes. Real chromaprint wouldn't need this alignment.
const startBlock = 220;
const numBlocks = 40;
const sliceStart = startBlock * 1365;
const sliceLength = numBlocks * 1365;
const captured = samples.subarray(sliceStart, sliceStart + sliceLength);
const capturedHashes = mockFingerprint(captured);

const matcher = new AFSMatcher(hashes, times, {
  coldStartMinHashes: 24,
  confidenceThreshold: 95,
});
const result = matcher.step(capturedHashes, Date.now());
assert(result !== null, "matcher returns a result");
assert(result.storedIndex === startBlock, `matched index ${result.storedIndex} === ${startBlock}`);
assert(result.confidence === 100, "perfect confidence with mock fingerprinter");
console.log(`  matcher: index ${result.storedIndex}, time ${result.time_ms}ms, confidence ${result.confidence}%`);

// Verify subtitle rendering against the matched position.
const stubEl = {
  _text: "",
  get textContent() { return this._text; },
  set textContent(v) { this._text = v; },
};
const cues = parseSRT(`1
00:00:27,000 --> 00:00:32,000
Match around 30 seconds

2
00:00:35,000 --> 00:00:38,000
Later cue
`);
const renderer = new SubtitleRenderer(stubEl, cues);
renderer.setUseAfs(true);
renderer.setAfsTimeMs(result.time_ms);
const expectedTimeMs = chromaprintCueMs(startBlock);
console.log(`  rendered subtitle at ${expectedTimeMs}ms: "${stubEl.textContent}"`);
// The match is at block 220 ≈ 27.24s; first cue runs 27-32s.
assert(stubEl.textContent === "Match around 30 seconds", "rendered correct subtitle");

// Verify haptics fire on matched position.
const events = [{ time_ms: result.time_ms, type: "cannon" }];
let fired = 0;
const haptics = new HapticsEventManager(events, () => fired++);
haptics.step(result.time_ms, Date.now());
assert(fired === 1, "haptic event fired");
console.log(`  haptics fired: ${fired}`);

console.log("end-to-end demo pipeline OK.");
