# AFS Roadmap

Open items beyond v0.1. Not commitments — a place to note what's
considered and what the rough shape of each item is.

## Migrate from chromaprint to Shazam-style landmark fingerprinting

Chromaprint carries v0.1 well but has structural limits we hit in
real-room microphone use. Its 12-dimensional chroma hashes fold
additive noise (HVAC, room reverb, ambient speech) into the chroma
bins instead of being invisible to them; in clean rooms the
confidence ceiling is around 80 %. Cold-start needs ~2.6 s of audio
before the first hash, which puts first-match latency at roughly
3.5 s. And the per-tick matcher cost is O(N) in the source AFS
length — fine for clips, mostly fine for movies as
[measured](./README.md#status), but architecturally not what
landmark hashing offers.

A landmark fingerprinter (Wang 2003, the Shazam algorithm) addresses
all three: spectral-peak hashes are tolerant to additive noise, the
first hash comes ~500 ms into capture, and the matcher becomes an
inverted-index lookup that's effectively independent of source
length. The patent has expired (2024-2025) and an MPL-2.0-licensed
TypeScript implementation
([adblockradio/stream-audio-fingerprint](https://github.com/adblockradio/stream-audio-fingerprint))
exists as a vendoring candidate.

The path: AFS v0.2 changes `[fingerprint].algorithm` to
`shazam-landmark`, body lines store packed `(freq1, freq2, dt)`
hashes instead of chromaprint integers, and the matcher swaps
`sumHamming` for an inverted-index lookup plus a time-offset
histogram. The matcher's state machine (lost / tracking / jump
consistency) is algorithm-agnostic and transfers as-is. AFS v0.1
files would not be matchable by v0.2 matchers; either regenerate
or ship a one-way converter.

The biggest derisking step is to try the vendored TS implementation
on `overture-finale.mp3` first. If the landmarks look sensible
after an afternoon of glue code, the rest is straightforward.

### What the afternoon-of-glue-code experiment showed

Code lives at [`experiments/landmark/`](./experiments/landmark/)
on this branch. Run it via `node match-test.mjs`. Findings on the
demo's actual three content pieces:

| Content | Min capture for reliable lock | Notes |
|---|---|---|
| Dialogue (Tears of Steel) | **~3 s, infinity-margin lock** | Speech transients + formants are uniquely distinctive; no competing offsets |
| Vocal music (Silent Night) | ~10 s, 5-7× margin | Sustained tones give weaker landmarks |
| Orchestral (1812 finale) | ~10 s, 1.6-13× margin | Repeating motifs create collateral matches at short captures (off by 30 s in one 5-s test) |

Noise robustness at -24 dB (typical room ambient): holds. At -12 dB
overlay noise: collapses — the lib produced 374-432 spurious
landmarks from a 5-second window (should be ~25 real), drowning
the signal entirely.

The "Shazam is universally magic" picture overstates it. The
algorithm is **content-dependent**:

- **Movies / dialogue**: landmark beats chromaprint on every axis
  (3 s lock vs 3.5 s, no false positives, larger but gzippable
  stream).
- **Karaoke / vocal music**: landmark needs longer captures
  (10 s) but is robust once locked.
- **Orchestral / instrumental**: weakest case for landmark —
  repeating themes confuse the matcher with short captures.

The v0.2 case for landmark is real but should be sold as
"better-for-dialogue, neutral-for-music," not "universal upgrade."
A real migration would:

1. Tune the lib's peak-detection threshold (cuts noise landmarks)
2. Adapt the listen-page state machine to handle different
   lock-on latencies per content type (~3 s for movies, ~10 s
   for music)
3. A/B both algorithms on the actual demos with real phone-mic
   capture, not synthetic noise

For v0.1 release, chromaprint remains the right pick — its
weaknesses are visible but bounded, and landmark's wins are
content-conditional in a way that complicates the spec story.

## Animated-QR file transfer between generate.html and listen.html

v0.1 ships the generate / listen handoff via local file transfer
(AirDrop, Drive, email) with file pickers on the listen page. An
animated-QR transfer — generate.html zips AFS + SRT, base64-encodes,
chunks, and cycles QR frames on a timer; listen.html opens the
camera, runs `jsQR` per frame, accumulates chunks, reassembles,
unzips — would close the loop entirely inside the browser with no
out-of-band step.

Two implementation styles. **Sequential chunks** are simpler: the
scanner needs to catch one full animation cycle in order; good
enough for content under ~50 KB total zipped. **Fountain-coded
(LT)** lets the scanner miss arbitrary frames and still reconstruct
from any sufficient subset, at the cost of a ~150 LOC decoder.

Practical size ceiling: a 2 953-byte QR holds ~2 KB after error
correction. At 4 fps, karaoke / short clips (≤ 10 KB) scan in 1-2 s;
sparse-SRT feature films (≤ 200 KB) take ~25 s; a full feature with
SDH SRT (~600 KB) takes over a minute and is past the patience
cliff. A size warning on the generate page sets honest expectations.

Two real risks: `getUserMedia` for the camera has the same
secure-context requirement as the microphone (phone over LAN IP
over plain HTTP won't work), and phone decode rate varies a lot by
hardware and lighting. The recommended path when picked up: ship
the simple-sequential version first, add fountain coding only if
dropped-frame failure becomes a real complaint.
