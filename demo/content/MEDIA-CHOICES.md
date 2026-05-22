# Media choices — what and why

This file documents *why* the demo uses the specific content it does.
The `demo/content/README.md` covers *what* the files are and *how* to
produce them. This file is the missing reasoning.

If a future contributor wants to swap content (different film,
different music, different speech), this document gives them the
criteria the current choices were trying to meet.

---

## Demo 1 & 2: Tears of Steel (Blender Foundation, 2012)

**File:** `dialogue-clip.mp4` and `dialogue-clip-edited.mp4`

### Why this film

Considered options:

| Film | License | Issues |
|------|---------|--------|
| **Tears of Steel** | CC-BY 3.0 | English dialogue, decent SRT available, 720p reasonable size |
| Big Buck Bunny | CC-BY 3.0 | Almost no dialogue (it's a wordless animation) — wouldn't make the desync demos visible |
| Sintel | CC-BY 3.0 | Has dialogue but very sparse; only a few lines per minute |
| Elephant's Dream | CC-BY 2.5 | Cryptic dialogue, sparse, surreal — hard for viewers to evaluate subtitle correctness |
| Cosmos Laundromat | CC-BY-SA | Short (12 min), too little dialogue density |
| Spring | CC-BY 4.0 | Wordless |
| Caminandes | CC-BY 4.0 | Wordless cartoons |
| Hollywood films | All rights reserved | Legally hopeless |
| YouTube CC-licensed content | Varies | Hard to find with permissive SRT, and YouTube ToS complicates redistribution |

Tears of Steel won by elimination: it's the only Blender film with
substantial English dialogue and an existing CC-licensed SRT track
on Wikimedia Commons. Per-minute dialogue density is high enough
that any 90-second window has 5-10 subtitle cues, which is exactly
what the desync demos need.

### Why a 90-second clip

- **Long enough** for the matcher to cold-start (needs ~3s of audio),
  reach steady state, and demonstrate AFS-corrected behavior across
  multiple subtitle cues.
- **Short enough** to keep page weight reasonable on GitHub Pages
  (~20 MB at 720p) and to not bore the viewer.
- **Long enough** for the cuts in the edited version to add up to a
  visible offset, but short enough that the demo can be experienced
  in one sitting.

### Why three cuts at 5, 7-12, and 14-18 seconds for the edited version

The edited demo (Demo 2) removes three 2-4 second segments from the
first 20 seconds:
- Cut 1: removes 5s-7s (2 seconds)
- Cut 2: removes 12s-14s (2 seconds)
- Cut 3: removes 18s-20s (2 seconds)

Total removed: 6 seconds across three cuts.

Rationale:
- **Three cuts, not one**: a single cut produces a constant offset
  which is indistinguishable from the desync-SRT demo. Multiple cuts
  produce non-uniform desync — each cut adds 2s of offset, but the
  subtitles before each cut are still correctly timed. This is the
  specific behavior AFS handles that simpler offset-correction tools
  (like `ffsubsync`) don't.
- **Cuts in the first 20 seconds, not spread across the whole clip**:
  if the demo is 90 seconds long and cuts happen at second 60, the
  viewer has to wait a long time to see the desync. Front-loading the
  cuts makes the effect visible quickly.
- **2-second cuts, not longer**: short enough that the missing
  content doesn't disorient the viewer ("wait, where did that scene
  go?") but long enough that the resulting subtitle desync is
  obviously visible. Two seconds per cut means each cut shifts
  subtitles by 2 seconds — a lifetime in subtitle timing.

If you swap to a different film, preserve this structure: three cuts
of similar length in the first ~25% of the clip.

### Why the shifted SRT is +2 seconds

The Demo 1 "shifted" SRT (`dialogue-clip.en.shifted.srt`) is the
original shifted forward by exactly 2 seconds. This represents the
single most common subtitle-desync complaint: the user downloaded
the wrong release of the subtitles and they're consistently a few
seconds off.

Why 2 seconds and not 5 or 10:
- **Big enough to be obviously wrong**: at 2 seconds, dialogue and
  subtitles are clearly misaligned but still recognizably related.
- **Small enough that AFS-corrected subtitles snap visibly into place**:
  at 10s, the demo viewer might not realize the AFS-corrected and raw
  modes are showing the *same* subtitles, just timed differently. At
  2s, the snap into sync is immediately apparent.

---

## Demo 3: 1812 Overture finale (Tchaikovsky)

**File:** `overture-finale.mp3` (Skidmore College Orchestra recording)

### Why this piece of music

The haptics demo needs an audio source with:
1. **Clear, discrete events** to sync against. Continuous music
   doesn't produce a haptics-worthy moment.
2. **Well-known events** so viewers immediately understand what's
   being synced.
3. **Permissive license** for the recording.

The 1812 Overture finale famously includes cannon fire — discrete,
loud, identifiable percussive events that everyone recognizes. The
piece itself is centuries out of copyright; we just need a
permissively-licensed *recording*.

Considered alternatives:

| Music | Why not |
|-------|---------|
| **1812 Overture (Skidmore)** | Picked — cannon events, PD recording |
| Stockhausen Helicopter Quartet | Hard to find recordings, weird vibe for a demo |
| Star Wars theme | Copyrighted |
| Anvil Chorus (Il Trovatore) | Anvils are less iconic than cannons |
| Hammer & sickle / industrial sounds | No emotional payoff, less recognizable |
| Drum solos | Too dense — events not visually separable |

### Why the Skidmore College Orchestra recording specifically

Available at archive.org `1812Overture_201603`, originally hosted at
musopen.org which catalogs public-domain orchestral recordings.

- **Public Domain** (musopen.org's policy is to host only PD/CC0
  recordings of out-of-copyright works).
- **Good audio quality** — well-recorded modern performance.
- **Includes real cannons** (or at least good recordings of them) in
  the finale — some recordings of the 1812 substitute synthesized
  cannon sounds or skip them entirely, which would defeat the demo's
  purpose.

### Why the finale (last ~90 seconds), not the whole piece

The full overture is ~16 minutes. The cannons only appear in the
final ~2 minutes. Including the rest would mean:
- 14 minutes of audio that has no demo-relevant events
- Much larger page weight
- The viewer has to wait 14 minutes to see anything happen

Trimming to the finale gives an 8-cannon demo in a manageable
duration.

---

## Cannon video

**File:** `cannon-shot.mp4` (trimmed and re-encoded from
`Fort_snelling_cannon_20120612_lq.ogv` on Wikimedia Commons)

### Why this specific clip

Source: https://commons.wikimedia.org/wiki/File:Fort_snelling_cannon_20120612_lq.ogv

- **Real video + real audio in one file.** Earlier choices were
  silent video clips (we'd had to synthesize or pair separate
  cannon SFX); this one has the actual cannon report recorded with
  the visual. The 1812 demo's emotional payoff is the sound + visual
  arriving together with the music, and a clip that contains both
  removes a class of synchronization bugs.
- **Era-appropriate weapon.** Fort Snelling fires a muzzle-loading
  reproduction cannon for its daily ceremony — the same style of
  smoothbore black-powder field piece Tchaikovsky would have known
  in 1880, and what historically-informed performances of the 1812
  finale use. The earlier WWI howitzer alternative was visually
  "old artillery" but acoustically very different (modern breech-
  loaded, recoil-compensated).
- **Trimmable to a tight 2-second clip.** The source is 28 s of
  ceremony; we extract a 2.4-s window centered on the firing
  moment at ~24.7 s and re-encode as MP4 (H.264 + AAC) at 480p for
  broad browser support.

### License

- **CC BY 3.0 Unported** — attribution required, no share-alike, no
  derivative restriction. Attribution is satisfied by a one-line
  entry in the project NOTICE file; the CC BY grant on this single
  file does NOT relicense the rest of the project.
- Author: G. Edward Johnson (Wikimedia user EnLorax).
- Full attribution text used in NOTICE: *"Firing the cannon at Fort
  Snelling" by G. Edward Johnson, CC BY 3.0, via Wikimedia Commons.*

### Considered alternatives

| Source | License | Why not |
|--------|---------|---------|
| **Fort Snelling cannon** (Wikimedia) | CC BY 3.0 | Picked — real audio, era-appropriate |
| 9.2inchhowitzerfiringWWI.ogv (Wikimedia) | PD-USGov | Previously picked; dropped because the audio track is essentially silent-film hiss (max −44 dB) — no real cannon report |
| qubodup "Cannon Shot" (Freesound) | CC0 | Audio-only — would have needed to pair with a separate video |
| Cape Town Noon Gun (Wikimedia) | CC-BY-SA 3.0 | Share-alike forces our trimmed clip to ship as CC-BY-SA — more attribution complexity, possibly relicensing concerns |
| NCpedia "Firing an 18th-century cannon" | CC-BY-ND 4.0 | Trimming is a derivative; ND prohibits |
| Stock footage sites | Commercial | Not free for redistribution |

---

## Cannon timings (overture-finale-cannons.json)

The file currently contains placeholder timings — 8 evenly-ish
spaced events between 18 and 70 seconds. These do NOT match the
actual cannon hits in the source.

### Why placeholder, not real

We didn't have the actual trimmed audio file when designing the
demo (it gets produced on the ground via `fetch-content.sh` +
`ffmpeg`). The timings depend on:
- Where you start the clip (which determines the offset)
- The specific performance (different recordings have different
  finale durations)

So the JSON exists as scaffolding: same structure, same number of
events, but real time values need to be filled in by listening to
the actual clip after it's trimmed.

### Why 8 cannons

Typical performances of the 1812 finale have 6-16 cannon hits
depending on the conductor's interpretation. Eight is a reasonable
middle: enough to feel like cannons are firing throughout the
finale, not so many that the viewer loses count.

If the chosen recording has more or fewer, just add/remove events
in the JSON file. The matcher and the haptics module don't care
about the exact count.

---

## What was considered and dropped

### Audio-only demo (Churchill speech) — DROPPED

Originally planned as Demo 4: a 30-60 second excerpt of "We Shall
Fight on the Beaches" (PD, 1940 BBC recording) with synchronized
subtitles.

Why dropped:
- **No clean SRT source.** The Internet Archive page for the speech
  has the audio but no subtitle file. We'd have to hand-write timings
  for the famous passage.
- **The haptics demo already proves AFS works on audio-only content.**
  An audio-only Churchill demo would be redundant with the haptics
  demo (both have no video) and weaker than it (because Churchill
  doesn't have discrete event timing to react to).
- **The user-upload demo covers the audio-only case** for anyone who
  wants to try it with their own podcast or speech.

If you want to add audio-only content later, look for podcasts that
ship VTT/SRT files alongside their MP3s (some Public Radio Exchange
content does this; some NPR shows too).

### YouTube content — DROPPED

Considered: pulling a clip from a YouTube CC-licensed creator.

Why dropped:
- **Legal gray area.** YouTube ToS prohibits programmatic downloads
  even of CC-licensed content. The CC license is between the creator
  and the viewer; YouTube's ToS is between you and YouTube.
- **Less stable than archive.org or Wikimedia.** YouTube videos can
  be removed without warning.

### Anything from streaming services — NEVER CONSIDERED

The original framing of AFS (during early design) was around fixing
Netflix subtitle desync. That use case is legally fraught (CSS-Auth
violations, ToS issues). The project was deliberately reframed
around home and user-driven content: things people legally own and
play themselves, not commercial streams.

The CONTRIBUTING.md and HANDOFF docs reinforce this — AFS files for
copyrighted streamed content aren't the project's territory.

---

## If you want to add a new demo

The criteria a new demo's content should satisfy:

1. **Permissively licensed** (public domain / CC0, CC-BY, or
   CC-BY-SA). CC-BY-ND is not accepted: trimming or re-encoding a
   clip for the demo is a derivative under most readings of the ND
   clause. Verify and document the source.
2. **Demonstrates something the existing demos don't.** "Another
   subtitle demo" isn't a new demo. "A demo of AFS triggering
   lighting in a home automation system" is.
3. **Self-explanatory in 30 seconds.** A viewer should understand
   what's being synced and what AFS is doing without reading
   long-form text.
4. **Page-weight reasonable.** Aim for under 30 MB of new media.

Then add:
- The new media files to `demo/content/` (and `.gitignore` if large)
- The source URLs and ffmpeg recipes to `demo/content/README.md`
- The reasoning to *this* file
- A new entry to the `demos` object in `demo/app.js`
- A new option in the dropdown in `demo/index.html`
- Updated attributions in the footer

The fingerprint generation works on any audio source automatically.
The matcher, subtitle renderer, and haptics modules are reusable.
What's new is just the demo-specific UI for whatever consumer
reaction you're demonstrating.
