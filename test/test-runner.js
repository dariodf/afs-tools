// test/test-runner.js
// Simple test runner that runs tests in Node.js. No frameworks; just
// plain assertions and console output.
//
// Run with: node test/test-runner.js

import { parseAFS, chromaprintArrays } from "../demo/src/afs-parser.js";
import {
  hamming32,
  coldStartMatch,
  localMatch,
  AFSMatcher,
} from "../demo/src/afs-matcher.js";
import {
  parseSRT,
  findActiveCue,
  serializeSRT,
  shiftCues,
} from "../demo/src/srt-parser.js";
import { writeAFS } from "../demo/src/afs-writer.js";
import {
  mockFingerprint,
  chromaprintCueMs,
  estimateMatchLatencyMs,
} from "../demo/src/chromaprint.js";
import { SubtitleRenderer } from "../demo/src/subtitle-renderer.js";
import { HapticsEventManager } from "../demo/src/haptics-events.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    if (e.stack) {
      console.log(`  ${e.stack.split("\n").slice(1, 4).join("\n  ")}`);
    }
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "assertEqual"}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || "assertDeepEqual"}: expected ${e}, got ${a}`);
  }
}

function assertThrows(fn, pattern) {
  let threw = false;
  let error = null;
  try {
    fn();
  } catch (e) {
    threw = true;
    error = e;
  }
  if (!threw) {
    throw new Error("expected function to throw");
  }
  if (pattern && !pattern.test(error.message)) {
    throw new Error(
      `expected error to match ${pattern}, got "${error.message}"`,
    );
  }
}

// -----------------------------------------------------------------------
// AFS parser tests
// -----------------------------------------------------------------------

test("parseAFS: minimal file", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

---
0 12345
124 67890
`;
  const result = parseAFS(text);
  assertEqual(result.version, "0.1");
  assertEqual(result.algorithm, "chromaprint");
  assertEqual(result.fingerprints.length, 2);
  assertEqual(result.fingerprints[0].time_ms, 0);
  assertEqual(result.fingerprints[0].payload, "12345");
  assertEqual(result.fingerprints[1].time_ms, 124);
});

test("parseAFS: with metadata", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

[metadata]
generator = "test"

[metadata.audio]
language = "en"

[metadata.source]
title = "Test"
year = 2026

---
0 1
124 2
`;
  const result = parseAFS(text);
  assertEqual(result.metadata.generator, "test");
  assertEqual(result.metadata.audio.language, "en");
  assertEqual(result.metadata.source.title, "Test");
  assertEqual(result.metadata.source.year, 2026);
});

test("parseAFS: comments in body", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

---
# leading comment
0 1
# middle comment
124 2

248 3
`;
  const result = parseAFS(text);
  assertEqual(result.fingerprints.length, 3);
  assertEqual(result.fingerprints[2].time_ms, 248);
});

test("parseAFS: tab and multi-space separators", () => {
  // Spec §4.1: one or more whitespace characters (space or tab).
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

---
0\t12345
124   67890
248\t  11111
`;
  const result = parseAFS(text);
  assertEqual(result.fingerprints.length, 3);
  assertEqual(result.fingerprints[0].payload, "12345");
  assertEqual(result.fingerprints[1].payload, "67890");
  assertEqual(result.fingerprints[2].payload, "11111");
});

test("parseAFS: rejects missing delimiter", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"
`;
  assertThrows(() => parseAFS(text), /delimiter/);
});

test("parseAFS: rejects unknown algorithm", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "wang-shazam"

---
`;
  assertThrows(() => parseAFS(text), /unsupported algorithm/);
});

test("parseAFS: rejects unsupported major version", () => {
  const text = `[afs]
version = "2.0"

[fingerprint]
algorithm = "chromaprint"

---
`;
  assertThrows(() => parseAFS(text), /unsupported AFS major version/);
});

test("parseAFS: accepts forward-compat minor version with known algorithm", () => {
  // Spec §7: a parser supporting major N accepts files declaring N.x
  // for any minor x; algorithm is validated separately.
  const text = `[afs]
version = "0.99"

[fingerprint]
algorithm = "chromaprint"

---
0 1
`;
  const result = parseAFS(text);
  assertEqual(result.fingerprints.length, 1);
});

test("parseAFS: rejects out-of-order time cues", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

---
124 1
0 2
`;
  assertThrows(() => parseAFS(text), /out of order/);
});

test("chromaprintArrays: produces uint32 hashes and times", () => {
  const text = `[afs]
version = "0.1"

[fingerprint]
algorithm = "chromaprint"

---
0 2349871234
124 2349872891
`;
  const parsed = parseAFS(text);
  const { hashes, times } = chromaprintArrays(parsed);
  assertEqual(hashes.length, 2);
  assertEqual(times.length, 2);
  assertEqual(hashes[0], 2349871234);
  assertEqual(hashes[1], 2349872891);
  assertEqual(times[0], 0);
  assertEqual(times[1], 124);
});

// -----------------------------------------------------------------------
// Chromaprint cue function
// -----------------------------------------------------------------------

test("estimateMatchLatencyMs: direct mode uses baseLatency + tick + hop", () => {
  // baseLatency 15 ms * 1000 = 15
  // matchIntervalMs / 2 = 125
  // hop / 2 ≈ 62
  // mic extra: 0
  // Total ≈ 202
  const result = estimateMatchLatencyMs(
    { baseLatency: 0.015 },
    { matchIntervalMs: 250, isMic: false },
  );
  assertEqual(result, 202);
});

test("estimateMatchLatencyMs: mic mode adds capture overhead", () => {
  // baseLatency 10 + tick 125 + hop 62 + mic 30 = 227
  const result = estimateMatchLatencyMs(
    { baseLatency: 0.010 },
    { matchIntervalMs: 250, isMic: true },
  );
  assertEqual(result, 227);
});

test("estimateMatchLatencyMs: falls back when baseLatency missing", () => {
  // Fallback baseLatency = 10
  const result = estimateMatchLatencyMs(null, { matchIntervalMs: 250 });
  assertEqual(result, 197);
});

test("estimateMatchLatencyMs: tighter tick lowers the estimate", () => {
  // matchIntervalMs / 2 = 62 instead of 125
  const result = estimateMatchLatencyMs(
    { baseLatency: 0.010 },
    { matchIntervalMs: 124, isMic: false },
  );
  // 10 + 62 + 62 + 0 = 134
  assertEqual(result, 134);
});

test("chromaprintCueMs: bounded drift over long sequences", () => {
  // The exact step is 4096000 / 33075 ≈ 123.83 ms. Naive stepwise
  // addition (124 ms per step) drifts ~0.17 ms per hop. The cumulative
  // formula must stay within < 1 ms of the true sample-position time.
  for (const i of [0, 1, 10, 100, 1000, 10000, 100000]) {
    const cue = chromaprintCueMs(i);
    const truth = (i * 4096000) / 33075;
    const error = Math.abs(cue - truth);
    if (error >= 0.5) {
      throw new Error(`cue ${i}: error ${error} ms exceeds 0.5 ms bound`);
    }
  }
  // First few cues match the known sequence (124, 124, 124, 124, 124, 124, 124, 123, ...).
  assertEqual(chromaprintCueMs(0), 0);
  assertEqual(chromaprintCueMs(1), 124);
  assertEqual(chromaprintCueMs(7), 867);
});

// -----------------------------------------------------------------------
// Matcher tests
// -----------------------------------------------------------------------

test("hamming32: identical = 0", () => {
  assertEqual(hamming32(0xdeadbeef, 0xdeadbeef), 0);
});

test("hamming32: all bits different = 32", () => {
  assertEqual(hamming32(0x00000000, 0xffffffff), 32);
});

test("hamming32: single bit difference = 1", () => {
  assertEqual(hamming32(0, 1), 1);
  assertEqual(hamming32(0, 0x80000000), 1);
});

test("hamming32: known case", () => {
  // 0b10110101 vs 0b10010111 differs in 2 bits
  assertEqual(hamming32(0b10110101, 0b10010111), 2);
});

test("coldStartMatch: finds exact match at offset", () => {
  const stored = new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const captured = new Uint32Array([4, 5, 6]);
  const result = coldStartMatch(stored, captured);
  assertEqual(result.bestIndex, 3);
  assertEqual(result.bestScore, 0);
  assertEqual(result.confidence, 100);
});

test("coldStartMatch: finds best fuzzy match", () => {
  const stored = new Uint32Array([1, 2, 3, 4, 5]);
  const captured = new Uint32Array([3, 4, 5]); // matches at index 2 exactly
  const result = coldStartMatch(stored, captured);
  assertEqual(result.bestIndex, 2);
  assertEqual(result.bestScore, 0);
});

test("coldStartMatch: returns null when captured longer than stored", () => {
  const stored = new Uint32Array([1, 2]);
  const captured = new Uint32Array([1, 2, 3, 4]);
  const result = coldStartMatch(stored, captured);
  assertEqual(result, null);
});

test("localMatch: finds in window", () => {
  const stored = new Uint32Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const captured = new Uint32Array([50, 60]);
  const result = localMatch(stored, captured, 4, 2);
  assertEqual(result.bestIndex, 4);
  assertEqual(result.bestScore, 0);
});

test("localMatch: doesn't find outside window", () => {
  const stored = new Uint32Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const captured = new Uint32Array([10, 20]);
  // Expected index 5, window radius 1 → search [4, 5, 6]. Match is at 0.
  const result = localMatch(stored, captured, 5, 1);
  // Best within window won't be 0 (out of window), so score > 0.
  if (result.bestIndex === 0) {
    throw new Error("localMatch should not have found the out-of-window match");
  }
});

test("AFSMatcher: cold start path", () => {
  const stored = new Uint32Array(100);
  for (let i = 0; i < 100; i++) stored[i] = (i * 0xabcdef) >>> 0;
  const times = new Float64Array(100);
  for (let i = 0; i < 100; i++) times[i] = chromaprintCueMs(i);
  const matcher = new AFSMatcher(stored, times, { coldStartMinHashes: 5 });
  const captured = stored.slice(40, 60); // 20 hashes starting at index 40
  const result = matcher.step(captured, performance.now());
  assertEqual(result.storedIndex, 40);
  assertEqual(result.mode, "cold");
  assertEqual(result.confidence, 100);
});

test("AFSMatcher: rejects below confidence threshold", () => {
  const stored = new Uint32Array(100);
  for (let i = 0; i < 100; i++) stored[i] = (i * 0xabcdef) >>> 0;
  const times = new Float64Array(100);
  for (let i = 0; i < 100; i++) times[i] = chromaprintCueMs(i);
  // Random captured = pure noise, should not match confidently.
  const captured = new Uint32Array(30);
  for (let i = 0; i < 30; i++) captured[i] = Math.random() * 0xffffffff;
  const matcher = new AFSMatcher(stored, times, {
    confidenceThreshold: 95,
    coldStartMinHashes: 5,
  });
  const result = matcher.step(captured, performance.now());
  assertEqual(result, null);
});

test("AFSMatcher: returns null below coldStartMinHashes", () => {
  const stored = new Uint32Array(100);
  const times = new Float64Array(100);
  const matcher = new AFSMatcher(stored, times, { coldStartMinHashes: 10 });
  const result = matcher.step(new Uint32Array(5), performance.now());
  assertEqual(result, null);
});

// -----------------------------------------------------------------------
// SRT parser tests
// -----------------------------------------------------------------------

test("parseSRT: basic cues", () => {
  const text = `1
00:00:01,234 --> 00:00:03,456
Hello world

2
00:00:04,000 --> 00:00:05,500
Second cue
multi-line
`;
  const cues = parseSRT(text);
  assertEqual(cues.length, 2);
  assertEqual(cues[0].start_ms, 1234);
  assertEqual(cues[0].end_ms, 3456);
  assertEqual(cues[0].text, "Hello world");
  assertEqual(cues[1].text, "Second cue\nmulti-line");
});

test("parseSRT: handles CRLF line endings", () => {
  const text =
    "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n";
  const cues = parseSRT(text);
  assertEqual(cues.length, 2);
  assertEqual(cues[0].text, "Hello");
});

test("findActiveCue: finds cue containing time", () => {
  const cues = parseSRT(`1
00:00:01,000 --> 00:00:03,000
A

2
00:00:05,000 --> 00:00:07,000
B
`);
  assertEqual(findActiveCue(cues, 2000).text, "A");
  assertEqual(findActiveCue(cues, 6000).text, "B");
  assertEqual(findActiveCue(cues, 4000), null); // gap
  assertEqual(findActiveCue(cues, 500), null); // before first
});

test("shiftCues: shifts every cue by delta", () => {
  const cues = parseSRT(`1
00:00:01,000 --> 00:00:03,000
A

2
00:00:05,000 --> 00:00:07,000
B
`);
  const shifted = shiftCues(cues, 2000);
  assertEqual(shifted[0].start_ms, 3000);
  assertEqual(shifted[0].end_ms, 5000);
  assertEqual(shifted[1].start_ms, 7000);
});

test("shiftCues: drops cues with negative start time", () => {
  const cues = parseSRT(`1
00:00:01,000 --> 00:00:03,000
A

2
00:00:05,000 --> 00:00:07,000
B
`);
  const shifted = shiftCues(cues, -2000);
  assertEqual(shifted.length, 1); // First cue would start at -1000, dropped
  assertEqual(shifted[0].start_ms, 3000);
});

test("serializeSRT: round-trips", () => {
  const original = `1
00:00:01,234 --> 00:00:03,456
Hello`;
  const cues = parseSRT(original);
  const serialized = serializeSRT(cues);
  // Reparse and compare cue data.
  const reparsed = parseSRT(serialized);
  assertEqual(reparsed[0].start_ms, cues[0].start_ms);
  assertEqual(reparsed[0].end_ms, cues[0].end_ms);
  assertEqual(reparsed[0].text, cues[0].text);
});

// -----------------------------------------------------------------------
// Writer tests
// -----------------------------------------------------------------------

test("writeAFS: minimal output round-trips through parser", () => {
  const hashes = new Uint32Array([12345, 67890, 11111]);
  const text = writeAFS(hashes);
  const parsed = parseAFS(text);
  assertEqual(parsed.version, "0.1");
  assertEqual(parsed.fingerprints.length, 3);
  assertEqual(parsed.fingerprints[0].time_ms, 0);
  assertEqual(parsed.fingerprints[1].time_ms, 124);
  assertEqual(parsed.fingerprints[0].payload, "12345");
});

test("writeAFS: includes metadata", () => {
  const hashes = new Uint32Array([1, 2]);
  const text = writeAFS(hashes, {
    audio: { sample_rate_hz: 48000, channels: 2, language: "en" },
    source: { title: "Test", year: 2026, duration_ms: 200000 },
  });
  const parsed = parseAFS(text);
  assertEqual(parsed.metadata.audio.sample_rate_hz, 48000);
  assertEqual(parsed.metadata.audio.language, "en");
  assertEqual(parsed.metadata.source.title, "Test");
  assertEqual(parsed.metadata.source.year, 2026);
});

test("writeAFS: hashStartIndex offsets body cues", () => {
  const hashes = new Uint32Array([1, 2]);
  const text = writeAFS(hashes, {}, { hashStartIndex: 1000 });
  const parsed = parseAFS(text);
  assertEqual(parsed.fingerprints[0].time_ms, chromaprintCueMs(1000));
  assertEqual(parsed.fingerprints[1].time_ms, chromaprintCueMs(1001));
});

test("writeAFS: cumulative rounding bounds drift", () => {
  // Long sequence: the difference between the final cue and the
  // ideal continuous time should remain < 1 ms.
  const n = 50000;
  const hashes = new Uint32Array(n);
  for (let i = 0; i < n; i++) hashes[i] = i;
  const text = writeAFS(hashes);
  const parsed = parseAFS(text);
  const lastCue = parsed.fingerprints[n - 1].time_ms;
  const truth = ((n - 1) * 4096000) / 33075;
  const error = Math.abs(lastCue - truth);
  if (error >= 1) {
    throw new Error(
      `last cue ${lastCue} drifts ${error} ms from truth ${truth}`,
    );
  }
});

// -----------------------------------------------------------------------
// End-to-end test using mock fingerprinter
// -----------------------------------------------------------------------

test("end-to-end: write, parse, and match", () => {
  // Generate a synthetic audio buffer (sine wave plus noise) and
  // "fingerprint" it with the mock fingerprinter. Then write to AFS,
  // re-parse, and verify the matcher finds a slice in the right place.
  const seconds = 8;
  const sampleRate = 11025;
  const samples = new Float32Array(seconds * sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5
      + (Math.random() - 0.5) * 0.1;
  }
  const storedHashes = mockFingerprint(samples);
  const afsText = writeAFS(storedHashes);
  const parsed = parseAFS(afsText);
  const { hashes, times } = chromaprintArrays(parsed);

  // Slice a known section of the source samples, fingerprint it
  // independently, and the matcher should find it.
  // Note: mockFingerprint operates in 1365-sample blocks, so we slice
  // on a block boundary.
  const startBlock = 5;
  const numBlocks = 20;
  const sliceStart = startBlock * 1365;
  const sliceEnd = (startBlock + numBlocks) * 1365;
  const slice = samples.subarray(sliceStart, sliceEnd);
  const sliceHashes = mockFingerprint(slice);
  const matcher = new AFSMatcher(hashes, times, {
    coldStartMinHashes: 5,
    confidenceThreshold: 95,
  });
  const result = matcher.step(sliceHashes, performance.now());
  // Mock fingerprinter is fully deterministic, so we expect an exact match.
  assertEqual(result.storedIndex, startBlock);
  assertEqual(result.confidence, 100);
});

// -----------------------------------------------------------------------
// SubtitleRenderer tests (using a stub element)
// -----------------------------------------------------------------------

function stubElement() {
  return {
    _text: "",
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = v;
    },
  };
}

test("SubtitleRenderer: raw mode uses raw time", () => {
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  r.setRawTimeMs(2000);
  assertEqual(el.textContent, "Hello");
  r.setRawTimeMs(6000);
  assertEqual(el.textContent, "World");
  r.setRawTimeMs(4000);
  assertEqual(el.textContent, "");
});

test("SubtitleRenderer: AFS mode uses AFS time", () => {
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  r.setUseAfs(true);
  r.setRawTimeMs(0); // ignored in AFS mode
  r.setAfsTimeMs(2000);
  assertEqual(el.textContent, "Hello");
  r.setAfsTimeMs(6000);
  assertEqual(el.textContent, "World");
});

test("SubtitleRenderer: toggle between modes", () => {
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  // Raw time at 6s (World), AFS time at 2s (Hello).
  r.setRawTimeMs(6000);
  r.setAfsTimeMs(2000);
  assertEqual(el.textContent, "World"); // raw mode default
  r.setUseAfs(true);
  assertEqual(el.textContent, "Hello"); // switched to AFS
  r.setUseAfs(false);
  assertEqual(el.textContent, "World"); // back to raw
});

test("SubtitleRenderer: empty cues array shows nothing at any time", () => {
  const el = stubElement();
  const r = new SubtitleRenderer(el, []);
  r.setRawTimeMs(0);
  assertEqual(el.textContent, "");
  r.setRawTimeMs(50000);
  assertEqual(el.textContent, "");
  r.setUseAfs(true);
  r.setAfsTimeMs(50000);
  assertEqual(el.textContent, "");
});

test("SubtitleRenderer: time before first cue is empty", () => {
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  r.setRawTimeMs(500); // 0.5s — before first cue starts at 1s
  assertEqual(el.textContent, "");
});

test("SubtitleRenderer: time after last cue is empty", () => {
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  r.setRawTimeMs(10000); // 10s — far after the single cue ends at 3s
  assertEqual(el.textContent, "");
});

test("SubtitleRenderer: useAfs=true falls back to raw when AFS time is null", () => {
  // This is the fallback path added during the live demo work:
  // when the user toggles AFS mode on BEFORE the matcher has
  // reported any position, the renderer should keep displaying
  // the raw-time-driven cue rather than freezing on whatever was
  // active at toggle time.
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n`,
  );
  const el = stubElement();
  const r = new SubtitleRenderer(el, cues);
  r.setUseAfs(true); // afsTimeMs still null
  r.setRawTimeMs(2000);
  assertEqual(el.textContent, "Hello"); // raw fallback active
  r.setRawTimeMs(6000);
  assertEqual(el.textContent, "World"); // raw still drives display
  r.setAfsTimeMs(2000); // AFS finally reports a position
  assertEqual(el.textContent, "Hello"); // now AFS takes over
  r.setRawTimeMs(6000); // raw updates while AFS is active — ignored
  assertEqual(el.textContent, "Hello");
});

test("SubtitleRenderer: text changes minimize DOM writes", () => {
  // The renderer should only assign to textContent when the cue
  // text actually changes. Frequent setRawTimeMs calls within the
  // same cue should not trigger re-assignments.
  const cues = parseSRT(
    `1\n00:00:01,000 --> 00:00:03,000\nHello\n`,
  );
  let writes = 0;
  const el = {
    _t: "",
    set textContent(v) { writes++; this._t = v; },
    get textContent() { return this._t; },
  };
  const r = new SubtitleRenderer(el, cues);
  r.setRawTimeMs(1500); // → "Hello" (1 write)
  r.setRawTimeMs(1600); // still "Hello" — no write
  r.setRawTimeMs(1700);
  r.setRawTimeMs(1800);
  assertEqual(writes, 1);
  r.setRawTimeMs(4000); // → "" (2nd write)
  assertEqual(writes, 2);
});

// -----------------------------------------------------------------------
// HapticsEventManager tests (schedule-ahead architecture)
// -----------------------------------------------------------------------
//
// The manager schedules fires via an injected scheduler. Tests pass a
// fake scheduler that records what would have been scheduled and lets
// the test invoke callbacks deterministically — no real wall-clock
// waits.

function makeFakeScheduler() {
  const records = [];
  return {
    records,
    schedule: (cb, ms) => {
      const rec = { cb, ms, cancelled: false };
      records.push(rec);
      return rec;
    },
    cancel: (rec) => {
      rec.cancelled = true;
    },
    // Helper: invoke a recorded callback (simulates the timeout firing)
    fire: (i) => {
      const rec = records[i];
      if (rec && !rec.cancelled) rec.cb();
    },
  };
}

function makeHaptics(events, options = {}) {
  const fired = [];
  const fakeSched = makeFakeScheduler();
  const h = new HapticsEventManager(events, (e) => fired.push(e.time_ms), {
    predictionOffsetMs: 100,
    schedule: fakeSched.schedule,
    cancel: fakeSched.cancel,
    ...options,
  });
  return { h, fired, sched: fakeSched };
}

test("HapticsEventManager: schedules upcoming events with offset", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events);
  // Position 0 at wall time 0; event 1000 ms ahead in source.
  // Expected wall delay: (1000 - 0) / 1.0 - 100 (offset) = 900 ms.
  h.step(0, 0);
  assertEqual(sched.records.length, 1);
  assertEqual(sched.records[0].ms, 900);
});

test("HapticsEventManager: fires when scheduled timeout invokes", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events);
  h.step(0, 0);
  sched.fire(0);
  assertEqual(fired.length, 1);
  assertEqual(fired[0], 1000);
});

test("HapticsEventManager: refire after offset-clamped target uses delay 0", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events);
  // Position is 950 — only 50 ms away. With offset 100, naive delay
  // = -50, clamped to 0 so the schedule fires immediately.
  h.step(950, 0);
  assertEqual(sched.records.length, 1);
  assertEqual(sched.records[0].ms, 0);
});

test("HapticsEventManager: marks past events missed (no schedule)", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events);
  // Position 1300 — already 300 ms past the event, beyond the
  // offset compensation window (100 ms). Should NOT schedule.
  h.step(1300, 0);
  assertEqual(sched.records.length, 0);
});

test("HapticsEventManager: doesn't schedule beyond horizon", () => {
  const events = [{ time_ms: 30000, type: "cannon" }];
  const { h, sched } = makeHaptics(events, { scheduleHorizonMs: 5000 });
  // Event 30 s ahead, horizon 5 s. Don't schedule yet.
  h.step(0, 0);
  assertEqual(sched.records.length, 0);
  // Once we're close enough, it schedules.
  h.step(26000, 0);
  assertEqual(sched.records.length, 1);
});

test("HapticsEventManager: re-step doesn't reschedule on small drift", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events, { rescheduleThresholdMs: 30 });
  h.step(0, 0); // schedules at 900 ms
  // Position barely changed; projected target drift = 10 ms (< 30 threshold)
  h.step(10, 10);
  assertEqual(sched.records.length, 1, "no extra schedule");
  assertEqual(sched.records[0].cancelled, false);
});

test("HapticsEventManager: re-step reschedules on large drift", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events, { rescheduleThresholdMs: 30 });
  h.step(0, 0); // schedules at 900 ms
  // Position jumped by 100 ms in source while wall time only moved
  // 10 ms — implies the matcher just re-acquired at a different
  // position. Target wall-clock drifts by ~90 ms, exceeds threshold.
  h.step(100, 10);
  assertEqual(sched.records.length, 2, "rescheduled");
  assertEqual(sched.records[0].cancelled, true);
  assertEqual(sched.records[1].cancelled, false);
});

test("HapticsEventManager: setOffset reschedules pending fires", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, sched } = makeHaptics(events);
  h.step(0, 0); // schedules at 900 ms (offset 100)
  h.setOffset(200);
  // New schedule should be at 800 ms (offset doubled).
  assertEqual(sched.records.length, 2);
  assertEqual(sched.records[0].cancelled, true);
  assertEqual(sched.records[1].ms, 800);
});

test("HapticsEventManager: reset clears pending and fired state", () => {
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events);
  h.step(0, 0);
  h.reset();
  assertEqual(sched.records[0].cancelled, true);
  // After reset, the manager treats events as never-scheduled again.
  h.step(0, 0);
  assertEqual(sched.records.length, 2);
  // Firing it produces one fire (state is clean).
  sched.fire(1);
  assertEqual(fired.length, 1);
});

test("HapticsEventManager: doesn't re-schedule an event after it fires", () => {
  // Once a scheduled timeout fires, the event is marked as fired
  // and subsequent step() calls must not schedule it again — even
  // if the position is still within range.
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events);
  h.step(0, 0);
  sched.fire(0);
  assertEqual(fired.length, 1);
  // A later step before/around the same event time must not add a
  // new schedule for it.
  h.step(500, 500);
  assertEqual(sched.records.length, 1, "no new schedule after fire");
  // Even a step right at the event time stays a no-op.
  h.step(1000, 1000);
  assertEqual(sched.records.length, 1);
  assertEqual(fired.length, 1);
});

test("HapticsEventManager: pending fire is NOT cancelled when position passes event time", () => {
  // Regression test for the "precalc misses cannons" bug:
  // a fire was scheduled on tick N when the event was still in the
  // future; on tick N+1 the reported position has moved past the
  // event time (e.g. 60 fps rAF can overshoot a setTimeout boundary
  // by ~16 ms). The old logic CANCELLED the still-pending fire and
  // marked the event missed, so the fire never ran. The correct
  // behavior: trust the pending schedule and let the setTimeout
  // callback drain naturally.
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events, { predictionOffsetMs: 0 });
  // Schedule the fire on the first tick.
  h.step(900, 0); // event 100 ms ahead, wallDelay 100 ms
  assertEqual(sched.records.length, 1);
  assertEqual(sched.records[0].cancelled, false);

  // Next rAF tick: position has moved past the event time (overshot
  // by 50 ms). The setTimeout for the fire hasn't been serviced yet.
  h.step(1050, 150);

  // The original schedule must still be alive.
  assertEqual(sched.records.length, 1, "no second schedule was created");
  assertEqual(
    sched.records[0].cancelled,
    false,
    "pending fire was NOT cancelled despite position overshoot",
  );

  // When the event loop services the setTimeout, the fire happens.
  sched.fire(0);
  assertEqual(fired.length, 1);
  assertEqual(fired[0], 1000);
});

test("HapticsEventManager: an unscheduled past event is marked missed (no fire)", () => {
  // Counter-test for the case above: if the manager first sees the
  // event when its position is already past, there's no pending
  // setTimeout to honor. Mark it as fired so the per-tick loop
  // stops considering it, and don't fire anything.
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events, { predictionOffsetMs: 100 });
  // Position 1300 — past the event by 200 ms, beyond the 100 ms
  // offset compensation. No prior tick scheduled this.
  h.step(1300, 1300);
  assertEqual(sched.records.length, 0, "nothing scheduled");
  // A later tick must not retroactively schedule it either.
  h.step(1400, 1400);
  assertEqual(sched.records.length, 0);
  assertEqual(fired.length, 0);
});

test("HapticsEventManager: auto-replay on large backward position jump", () => {
  // When the source restarts (audio replayed, mic recaptures from
  // the beginning, etc.), the matcher's reported position drops
  // back to ~0. The manager detects a drop > 5 s and clears its
  // `fired` set so the events fire again on the second pass.
  // The subtitles demo gets this implicitly because it's
  // stateless; haptics needs the explicit reset.
  const events = [
    { time_ms: 10000, type: "cannon", label: "Cannon 1" },
    { time_ms: 20000, type: "cannon", label: "Cannon 2" },
  ];
  const { h, fired, sched } = makeHaptics(events, { predictionOffsetMs: 0 });

  // First playthrough: fire both events.
  h.step(9900, 0);
  h.step(19900, 10000);
  assertEqual(sched.records.length, 2, "both events scheduled");
  sched.fire(0);
  sched.fire(1);
  assertEqual(fired.length, 2, "both events fired");

  // Audio ends, source restarts at 0 — backward jump of ~20 s,
  // well past the 5 s threshold. Auto-reset triggers.
  h.step(0, 30000);

  // Re-walk through the events; they must fire again this time.
  h.step(9900, 30100);
  h.step(19900, 40100);
  // Two new schedules (records[2] and records[3]).
  assertEqual(sched.records.length, 4, "events re-scheduled on replay");
  assertEqual(sched.records[2].cancelled, false);
  assertEqual(sched.records[3].cancelled, false);
  sched.fire(2);
  sched.fire(3);
  assertEqual(fired.length, 4, "both events fired again");
});

test("HapticsEventManager: small backward drift does NOT trigger auto-replay", () => {
  // Real-world matcher position estimates jitter a few hundred ms
  // backward and forward as it re-locks. Only large drops (here
  // > 5 s) should be interpreted as a restart.
  const events = [{ time_ms: 1000, type: "cannon" }];
  const { h, fired, sched } = makeHaptics(events, { predictionOffsetMs: 0 });
  h.step(900, 0);
  sched.fire(0);
  assertEqual(fired.length, 1);

  // Matcher reports 800 ms (200 ms back) — well under the 5 s threshold.
  h.step(800, 100);
  // No new schedule for the event that already fired.
  assertEqual(sched.records.length, 1, "no auto-reset on small jitter");
  assertEqual(fired.length, 1, "no re-fire");
});


// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
