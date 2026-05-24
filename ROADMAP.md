# AFS Roadmap

Open work items beyond the v0.1 demo. Not commitments — a place to capture
decisions and what would be needed if we pursue them.

---

## Migrate from Chromaprint to Shazam-style landmark fingerprinting

**Status:** considered, not committed. Decision deferred to a future session.

### Why consider it

Chromaprint has carried the v0.1 demo well, but it has structural limits we've
hit in mic-mode testing:

- **Noise robustness is mediocre.** Chromaprint hashes are 12-dim chroma
  averages — additive noise (HVAC, room reverb, ambient talk) folds into the
  chroma bins instead of being invisible to them. We see ~80-82 % confidence
  ceiling on real mic capture even in quiet rooms. Shazam routinely matches
  in noisy bars; the reason is algorithmic, not better hardware.
- **2.6 s minimum-to-first-hash floor.** Chromaprint stacks sixteen 371 ms
  windows for its first hash. Confident matches need ≥ 8 of those hashes,
  putting our practical first-match-latency at ~3.5 s. Landmark hashing
  produces its first hash ~500 ms in and can converge in 1-2 s.
- **O(N) matcher cost per tick.** `sumHamming` linearly scans every offset
  in the source AFS. Fine for a 71 s clip; expensive for a 2 h movie
  (the long-form use case [[project-movies-long-form]]). Landmark matching
  uses inverted-index hash lookups + a time-offset histogram — O(L) in
  captured landmarks, essentially independent of source length.

### Why we'd replace, not ship both

A single algorithm keeps the spec honest and the demo focused. Two
algorithms invite confusion: which AFS file is which, which matcher to run,
which to recommend. If Shazam-landmark dominates chromaprint on every axis
we care about (noise robustness, latency, scalability), it should *be* AFS
v0.2 — not a parallel option.

### What needs to change

**Spec (afs/):**

- [ ] AFS v0.2: change `[fingerprint] algorithm` value to `shazam-landmark`
      (no co-existence with chromaprint in the same file).
- [ ] Body format: each line is `time_ms hash` (same shape as today,
      but hash represents a landmark-pair instead of a chroma hash —
      32-bit packed `(freq1, freq2, dt)`).
- [ ] Header: add `[fingerprint.landmark]` block for algorithm parameters
      (peak-detection threshold, target zone width, etc.) so the AFS is
      self-describing for re-derivable matching.
- [ ] Migration note: chromaprint-format AFS files from v0.1 are not
      compatible with v0.2 matchers. Either regenerate or ship a one-way
      converter.

**Reference implementation (afs-tools/):**

- [ ] Vendor an existing landmark implementation. Best candidate is
      [`adblockradio/stream-audio-fingerprint`](https://github.com/adblockradio/stream-audio-fingerprint)
      (TypeScript, MPL-2.0, archived but stable). Approach:
  - Copy `lib/index.ts` (or its compiled JS) into `demo/vendor/landmark/`.
  - Add MPL-2.0 attribution to NOTICE alongside the existing
      chromaprint/Fort-Snelling entries. MPL-2.0 is file-level copyleft:
      modifications to the vendored file must stay MPL, but our wrapper
      code keeps Apache 2.0.
  - Strip the Node `stream.Transform` interface; expose a synchronous
      `fingerprintAudio(samples, sampleRate) → Array<{time_ms, hash}>`
      to match the chromaprint wrapper's shape.
- [ ] If the vendoring path doesn't work cleanly, write fresh from
      Wang's 2003 paper (~500 LOC of DSP: FFT → spectral peaks →
      pairwise hashing). The paper is 10 pages, well-explained, and the
      patent expired around 2022.

**Matcher (`afs-matcher.js`):**

- [ ] Replace `sumHamming`-over-offsets with the landmark consensus
      algorithm:
  1. For each captured landmark, look up its hash in an inverted index
      built from the source AFS (`Map<hash, Array<storedIndex>>`).
  2. For each (capturedIndex, storedIndex) pair, compute
      `offset = storedIndex - capturedIndex`.
  3. Histogram the offsets. The bin with the most votes is the source
      position; the vote count is the confidence proxy.
  4. Confident match: histogram peak ≥ N votes AND ≥ 2× the next-highest
      bin (rough Shazam-paper rule for "confident enough to commit").
- [ ] Keep the matcher's existing state machine (lost / tracking / jump
      consistency) — those are consumer concerns, independent of the
      underlying fingerprint algorithm.

**Tools (`tools/`):**

- [ ] Update `afs-generate` to produce landmark-format AFS by default.
- [ ] Keep `cannon-mix` as-is — it operates on the audio, not the
      fingerprints; only `afs-generate` changes consumers.
- [ ] `tools/afs-format` needs the new header schema.

**Tests:**

- [ ] Most of the existing test scaffolding (live-playback walk,
      cold-start scenarios, robustness with sample rates and noise) is
      algorithm-agnostic — re-uses the same fpcalc/ffmpeg harnesses but
      with the new fingerprinter. They should mostly transfer.
- [ ] New tests specific to landmark matching: inverted-index lookup
      correctness, time-offset histogram consensus, target-zone tuning.
- [ ] Drop chromaprint-specific tests (`test-cli-conformance.js` for
      `fpcalc`, the cumulative-rounding drift test in `test-runner.js`).

**Demo:**

- [ ] Regenerate `demo/content/*.afs` files with the new format.
- [ ] No UI changes expected; the matcher's external contract
      (`onPosition`, `onStatus`) is unchanged.
- [ ] Smaller files? Larger files? Landmark hashing typically produces
      5-20× more hashes per second than chromaprint. AFS files grow.
      Worth measuring.

### Open questions

- Where does Chromaprint stay relevant? The "find duplicate MP3s in a
  library" use case is genuinely Chromaprint's home turf — file-vs-file
  matching where the input is clean audio bytes. If AFS is "sync via
  audio fingerprinting," and Chromaprint is "identify a file from its
  audio fingerprint," those might be different problems with different
  algorithms. Worth thinking about whether AFS-the-spec really should be
  algorithm-pluggable for that reason, even if AFS-the-demo only ships one.
- How does landmark-matching handle the *first* second of captured audio,
  before enough hashes have accumulated? Chromaprint's 2.6 s wait is at
  least a known floor. Landmark's behavior with N=1 or N=2 hashes is
  worth pre-validating before commitment.

### Estimated effort

Best case (vendoring works, spec is straightforward): **2-3 days of focused
work** for a working v0.2 demo. Worst case (rewriting the algorithm + new
matcher infrastructure from scratch): **a week**.

The biggest derisking step is **try the vendored TS implementation first**.
If it produces sensible landmarks on `overture-finale.mp3` after one
afternoon of glue code, the rest is straightforward. If it doesn't,
reassess.

### Branch / worktree approach when picked up

```bash
cd ~/dariodf/afs-tools
git worktree add ../afs-tools-landmark -b shazam-landmark
# Now ~/dariodf/afs-tools is on main (chromaprint) and
# ~/dariodf/afs-tools-landmark is on shazam-landmark, both backed by
# the same git history. Two `python3 -m http.server` instances on
# different ports lets you A/B the demos side-by-side.
```

When the experiment proves out, the branch becomes the next AFS
release; not a separate project.
