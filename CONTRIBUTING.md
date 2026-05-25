# Contributing

AFS is an open file format. The project welcomes contributions of
new AFS files, bug fixes, feature improvements, or documentation.

## Run the tests

```bash
node test/test-runner.js          # core: parser, matcher, SRT, scheduler
node test/test-cli-smoke.js       # CLI: help, error paths, smoke-end-to-end
node test/test-imports.js         # the demo's import graph resolves
node test/test-cli-conformance.js # afs-generate end-to-end via real fpcalc
```

The deploy workflow runs all of these (plus a longer matcher
robustness suite) on every push; if any fail, the deploy is
blocked.

For matcher issues specifically: open the demo with `?debug=1` in
the URL. The debug panel shows the matcher's internal state
(buffer level, fingerprints, confidence), which is very helpful
for triage.

## Add code

The codebase is intentionally plain JS — no transpilation, no
framework — and small. A few conventions to match the existing
style:

- Match the surrounding code. Module shape, function naming, and
  comment density should look the same whether you opened a fresh
  file or an existing one.
- Add tests for new functionality. Most logic that runs in the
  browser also runs cleanly in Node, so tests usually go in
  `test/test-runner.js` (unit) or one of the dedicated scenario
  files (`test/test-*.js`).
- Keep modules small and focused. The demo's `src/` files each do
  one thing.
- Comments explain *why*, not *what*. The well-named identifier
  already tells you the *what*. The comment exists for the hidden
  constraint or the surprising decision.

## Add a new demo content piece

If you'd like to PR a new content piece into the demo (a CC-licensed
film clip with subtitles, a public-domain song, etc.):

1. Verify the content is licensed compatibly: CC-BY, CC-BY-SA, or
   public domain. CC-BY-ND is not accepted — the demo pipeline
   trims clips and re-encodes audio, both derivative operations
   the ND clause prohibits.
2. Trim the media to a focused window (see
   [`demo/content/README.md`](./demo/content/README.md) for ffmpeg
   recipes).
3. Generate the AFS file:
   `./tools/afs-generate/afs-generate path/to/clip.mp4`
4. Wire a new demo handler in `demo/app.js` (follow the pattern of
   `startKaraokeDemo` or `startHapticsDemo`).
5. Put the trimmed media + SRT + AFS under `demo/content/` and
   update [`demo/content/README.md`](./demo/content/README.md).
6. Update the footer credits in `demo/index.html`.
7. Open a PR.

Please keep new demo clips small. Under 30 MB is a good target.

## Add a new consumer-data format

AFS itself only carries fingerprints. The actual reactions
(subtitles, haptic events, lighting cues, etc.) come from companion
files in formats specific to each use case:

- Subtitles: SRT, WebVTT
- Haptic events: JSON (see `demo/content/overture-finale-cannons.json`)
- Lighting cues: invent your own JSON schema

If you build something interesting on top of AFS — a new consumer
format, a player for a specific use case, a server-side
integration — link it from the project's README under
"Built with AFS."

## Report a bug

Open an issue on GitHub with:

- What you did (the URL or input file)
- What you expected
- What happened
- Browser + OS + device if relevant
- A screenshot or console log if available

For matcher issues, attach a screenshot of the `?debug=1` panel
from the moment things went wrong.

## License

By contributing you agree that your contributions are licensed
under Apache 2.0, matching the rest of the project. Content
derived from CC-BY-SA sources may be relicensed CC-BY-SA 4.0 with
attribution. The AFS specification itself is dedicated to the
public domain under CC0 1.0; see the
[afs](https://github.com/dariodf/afs) repository.
