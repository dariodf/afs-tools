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
