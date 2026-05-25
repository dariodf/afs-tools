# afs-format

Lower-level CLI for turning the integer hash output of
`fpcalc -raw` into a complete AFS v0.1 file. Used internally by
[`afs-generate`](../afs-generate/README.md); useful directly if
you already have an fpcalc output stream or want to script
something custom.

```bash
fpcalc -raw -length 0 audio.wav \
  | ./afs-format --title "My Audio" \
  > audio.afs
```

## Options

```
--title TEXT             Source title
--year INT               Source year
--imdb-id TEXT           IMDb identifier
--language CODE          Audio language (ISO 639-1 or 639-3)
--sha256 HEX             Pre-computed SHA-256 of source file
--duration-ms INT        Source duration in ms (otherwise computed)
--generator-name TEXT    Override the "generator" metadata string
```

## Dependencies

- `bash` 4+
- `awk` (universally available)
