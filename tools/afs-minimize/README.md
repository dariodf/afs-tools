# afs-minimize

Shrinks an AFS by keeping only the hash lines whose time cue falls
within a subtitle-driven coverage window. During subtitle-less
stretches (music, silence, no-dialogue scenes) the matcher has
nothing to do anyway, and dropping those hashes is functionally
lossless.

```bash
# Output to stdout
./afs-minimize movie.afs movie.en.srt > movie.min.afs

# Or write directly to a file
./afs-minimize movie.afs movie.en.srt movie.min.afs

# Custom lead-in (default 10 s)
./afs-minimize --lead-ms 15000 movie.afs movie.en.srt > movie.min.afs

# Custom gap merge tolerance (default 20 s)
./afs-minimize --gap-ms 30000 movie.afs movie.en.srt > movie.min.afs
```

## How the windows are built

Each kept window starts `LEAD_MS` before the cue (default 10 s) so
the matcher has time to cold-start and lock before the first word
arrives, and ends at the cue's end. Adjacent windows within
`GAP_MS` of each other are merged into one, which avoids brief
coverage holes between rapid cues that would otherwise cause the
matcher to lose lock and flicker on reacquire.

The original AFS file is never modified. Reduction stats print to
stderr.

## How much you save depends on SRT density

For a typical dialogue-driven feature film (dialogue cues every
few seconds, default lead and gap), expect single-digit-percent
reductions: a 113-min thriller test gave **3 %** with an SDH
subtitle file (which covers sound effects + music + dialogue) and
**10 %** with a dialogue-only subtitle file. For *sparse* content
— karaoke songs (lyrics over long instrumental passages),
audiobook chapter breaks, lecture recordings with extended Q&A
pauses — the wins are far larger because the subtitle coverage is
itself low.

For HTTP-served AFS files, gzip's `Content-Encoding` already
absorbs most of the structural redundancy (a 2-h AFS file
compresses to ~43 % of its raw size). The minimizer's marginal
value on top of gzip is modest for dialogue-heavy content; it's
most useful for sparse-cue content or for distributing AFS files
outside HTTP.

## Caveat

This treats the SRT as authoritative about "when sync matters."
If the SRT is missing cues for parts of the source that the user
expects to be synced, the minimized AFS will have no coverage
there and the listen page will show LOST while the source plays.
