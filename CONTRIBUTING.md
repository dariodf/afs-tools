# Contributing

AFS is an open file format and the project is happy to accept
contributions of new AFS files, bug fixes, feature improvements, or
documentation. This doc covers the most common contribution paths.

## Contributing an AFS file for your own content

If you have a video or audio file you want to add to the demo (or
just produce an AFS file for personal use), there are two paths.

### Browser path (easiest)

Visit the live demo at <https://dariodf.github.io/afs-tools/>, pick
"Use your own files...", upload your media, and download the
generated `.afs` file. Done.

You can use the resulting file with any AFS-aware player.

### CLI path (for batch processing or contribution)

Install the CLI tool's dependencies:

```bash
# macOS
brew install ffmpeg chromaprint

# Ubuntu/Debian
sudo apt install ffmpeg libchromaprint-tools

# Windows: install via Chocolatey or use WSL
```

Clone the repo:

```bash
git clone https://github.com/dariodf/afs-tools.git
cd afs-tools/tools
```

Generate an AFS file:

```bash
./afs-generate path/to/your-movie.mp4 \
  --title "Your Movie Title" \
  --year 2020 \
  --language en
```

Output goes to `your-movie.afs` next to the source.

See `tools/README.md` for full CLI documentation.

## Adding new demo content

If you'd like to PR a new content piece into the demo (e.g., another
CC-licensed film clip with subtitles):

1. Verify the content is licensed compatibly with this project
   (CC-BY, CC-BY-SA, or public domain). MP4/MP3 + SRT pairs are
   ideal. CC-BY-ND is not accepted: the demo pipeline trims clips
   and re-encodes audio, both of which are derivative operations
   that the ND clause prohibits.
2. Trim the media to a focused 90-second window (see
   `demo/content/README.md` for ffmpeg recipes).
3. Generate the AFS file with the CLI.
4. Add a new demo to `demo/app.js` (follow the pattern of the
   existing demos in the `demos` object).
5. Add your content to `demo/content/` and update the
   `demo/content/README.md` table.
6. Update the footer credits in `demo/index.html`.
7. Open a PR.

The smaller the content payload, the better — please keep new
demo clips under 30 MB if possible.

## Adding consumer-data formats

AFS itself only carries fingerprints. The actual reactions
(subtitles, haptic events, lighting cues, etc.) come from companion
files in formats specific to each use case. For example:

- Subtitles: SRT, WebVTT
- Haptic events: JSON (see `demo/content/overture-finale-cannons.json`)
- Lighting cues: invent your own JSON schema

If you build something interesting on top of AFS — a new consumer
format, a player for a specific use case, a server-side integration
— please link it from the project's README under "Built with AFS."

## Reporting bugs

Open an issue on GitHub with:

- What you did (the URL or input file)
- What you expected
- What happened
- Browser + OS + device if relevant
- A screenshot or console log if available

For matcher issues specifically: use the debug panel by adding
`?debug=1` to the demo URL. It shows the matcher's internal state
(buffer level, fingerprints, confidence) and the screenshot of that
is very helpful for debugging.

## Code contributions

The codebase is small and well-tested. Run tests before submitting:

```bash
npm install
node test/test-runner.js
node test/test-demo-pipeline.js
node test/test-imports.js
```

The deploy workflow runs all three on every push.

Style preferences:

- Match the existing style. The code is intentionally plain JS with
  no transpilation step.
- Add tests for new functionality.
- Keep modules small and focused.
- Comments explain *why*, not *what*. Avoid trivial comments.

## License

By contributing you agree that your contributions are licensed under
Apache 2.0, matching the rest of the project. Content derived from
CC-BY-SA sources may be relicensed CC-BY-SA 4.0 with attribution. The
AFS specification itself is dedicated to the public domain under
CC0 1.0; see the [afs](https://github.com/dariodf/afs) repository.
