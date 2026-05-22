// test/test-afs-mapping-edges.js
// Edge-case tests for computeTimeMapping (Mode 1's offline path).
// test-precalc-mapping.js covers the happy path with real demo
// content; this file covers degenerate inputs and lookup-region
// behavior. Pure Node — no audio tools or external content needed.
//
// Cases:
//   1. Empty derived AFS: mapping should be empty, lookup -> null
//   2. Identical source and derived: one block, offset 0, exact lookup
//   3. No overlap (totally different hashes): no anchors, no blocks
//   4. Derived is a strict slice of source: one block, constant offset
//   5. Lookup before first block / between blocks / after last block:
//      extrapolates from nearest neighbour, gap-midpoint split
//
// Run with: node test/test-afs-mapping-edges.js

import { parseAFS } from "../demo/src/afs-parser.js";
import { writeAFS } from "../demo/src/afs-writer.js";
import { computeTimeMapping } from "../demo/src/afs-mapping.js";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// Deterministic synthetic hash sequence: each hash is i scaled and
// scrambled enough to look chromaprint-ish. Real chromaprint hashes
// have high entropy across adjacent positions, which is what makes
// the matcher able to distinguish positions.
function synthHashes(n, seed = 1) {
  const out = new Uint32Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    // xorshift32
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    out[i] = x;
  }
  return out;
}

function afsFrom(hashes) {
  return parseAFS(writeAFS(hashes));
}

// 1. Empty derived AFS.
{
  const src = afsFrom(synthHashes(200, 1));
  const drv = afsFrom(new Uint32Array(0));
  const m = computeTimeMapping(src, drv);
  check(
    "empty derived: anchors and blocks are empty",
    m.anchors.length === 0 && m.blocks.length === 0,
    `anchors=${m.anchors.length} blocks=${m.blocks.length}`,
  );
  check(
    "empty derived: lookup returns null for any input",
    m.lookup(0) === null && m.lookup(5000) === null,
  );
}

// 2. Identical source and derived: every aligned window matches
// trivially. Mapping should be a single block with offset ~0.
{
  const hashes = synthHashes(300, 42);
  const src = afsFrom(hashes);
  const drv = afsFrom(hashes);
  const m = computeTimeMapping(src, drv);
  check(
    "identical inputs: at least one block",
    m.blocks.length >= 1,
    `${m.blocks.length} blocks, ${m.anchors.length} anchors`,
  );
  if (m.blocks.length >= 1) {
    check(
      "identical inputs: block offset is ~0",
      Math.abs(m.blocks[0].offset) < 50,
      `offset=${m.blocks[0].offset.toFixed(1)} ms`,
    );
    // Probe inside the block: derived t should map to source t (±0).
    const probe = m.blocks[0].derivedStart + 500;
    const got = m.lookup(probe);
    check(
      "identical inputs: lookup inside block is near-identity",
      got !== null && Math.abs(got - probe) < 50,
      `lookup(${probe}) = ${got}`,
    );
  }
}

// 3. No overlap: derived hashes drawn from a different seed.
// Matcher should find no confident matches.
{
  const src = afsFrom(synthHashes(400, 11));
  const drv = afsFrom(synthHashes(400, 99));
  const m = computeTimeMapping(src, drv);
  check(
    "no overlap: no stable blocks (random hashes don't correlate)",
    m.blocks.length === 0,
    `blocks=${m.blocks.length} anchors=${m.anchors.length}`,
  );
  check(
    "no overlap: lookup returns null everywhere",
    m.lookup(1000) === null && m.lookup(10000) === null,
  );
}

// 4. Derived is a contiguous slice of source. Build a mapping that
// should show as a single block with a constant non-zero offset.
{
  const fullSource = synthHashes(400, 7);
  const sliceStart = 50;
  const sliceLen = 200;
  const slice = fullSource.slice(sliceStart, sliceStart + sliceLen);
  const src = afsFrom(fullSource);
  const drv = afsFrom(slice);
  const m = computeTimeMapping(src, drv);
  check(
    "slice mapping: exactly one block",
    m.blocks.length === 1,
    `${m.blocks.length} blocks`,
  );
  if (m.blocks.length === 1) {
    // The chromaprint cue interval is ~123.99 ms per hash. The slice
    // started at source index 50, so the expected offset is roughly
    // 50 * 124 ms = 6200 ms.
    const expectedOffset = sliceStart * 4096000 / 33075;
    const offsetErr = Math.abs(m.blocks[0].offset - expectedOffset);
    check(
      "slice mapping: offset matches slice start position",
      offsetErr < 200,
      `offset=${m.blocks[0].offset.toFixed(0)} ms (expected ~${expectedOffset.toFixed(0)} ms)`,
    );
  }
}

// 5. Two-block mapping: derived is built by concatenating two
// slices of source from different positions (simulating a cut).
// Lookup behavior at the seam between blocks should respect the
// gap-midpoint split.
{
  const fullSource = synthHashes(600, 99);
  const part1 = fullSource.slice(0, 100);    // source 0..100
  const part2 = fullSource.slice(300, 400);  // source 300..400 (skip 100..300)
  const concat = new Uint32Array(part1.length + part2.length);
  concat.set(part1, 0);
  concat.set(part2, part1.length);
  const src = afsFrom(fullSource);
  const drv = afsFrom(concat);
  const m = computeTimeMapping(src, drv);
  check(
    "synthetic-cut mapping: produces two blocks",
    m.blocks.length === 2,
    `${m.blocks.length} blocks`,
  );
  if (m.blocks.length === 2) {
    // Lookup inside block 1 should give offset 0; inside block 2 should
    // give offset = (300-100)*hop = 200*124 ms ≈ 24788 ms.
    const interiorB1 = m.blocks[0].derivedStart + 500;
    const insideB1 = m.lookup(interiorB1);
    check(
      "two-block lookup: interior of block 1 returns near-identity",
      insideB1 !== null && Math.abs(insideB1 - interiorB1) < 200,
      `lookup(${interiorB1}) = ${insideB1}`,
    );
    const interiorB2 = m.blocks[1].derivedStart + 500;
    const insideB2 = m.lookup(interiorB2);
    const expectedB2 = interiorB2 + m.blocks[1].offset;
    check(
      "two-block lookup: interior of block 2 uses block 2's offset",
      insideB2 !== null && Math.abs(insideB2 - expectedB2) < 200,
      `lookup(${interiorB2}) = ${insideB2} (expected ~${expectedB2.toFixed(0)})`,
    );

    // Gap-midpoint rule: between block 1 end and block 2 start, the
    // earlier half uses block 1's offset, the later half uses block 2's.
    const gapStart = m.blocks[0].derivedEnd;
    const gapEnd = m.blocks[1].derivedStart;
    if (gapEnd > gapStart) {
      const justAfter = gapStart + 1;
      const justBefore = gapEnd - 1;
      const lookupAfter = m.lookup(justAfter);
      const lookupBefore = m.lookup(justBefore);
      check(
        "two-block lookup: just after block 1 end uses block 1's offset",
        lookupAfter !== null &&
          Math.abs(lookupAfter - (justAfter + m.blocks[0].offset)) < 200,
        `lookup(${justAfter}) = ${lookupAfter}`,
      );
      check(
        "two-block lookup: just before block 2 start uses block 2's offset",
        lookupBefore !== null &&
          Math.abs(lookupBefore - (justBefore + m.blocks[1].offset)) < 200,
        `lookup(${justBefore}) = ${lookupBefore}`,
      );
    }
  }
}

console.log("");
console.log(`test-afs-mapping-edges: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
