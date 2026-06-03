# BGM (background music)

ECHOCUT mixes a soft background track under the voice during the final
cover + fade-out step. A brand picks its default track via `bgm.defaultName`
in `configs/brands/<id>.json` (the filename here, without the `.mp3`), and
the `burn` CLI can override per-run with `--bgm <name>` / `--bgm-volume <0-1>`
or disable it with `--no-bgm`.

## What ships here

A **curated starter set of 8 tracks** (`01-…` through `08-…`) is committed to
the repo so the default pipeline works out of the box — calm piano, guzheng,
lo-fi, strings, jazz, ambient, new-age and bossa.

## Get the full pack (74 tracks)

```bash
npm run fetch-bgm        # downloads the full pack (~385MB) into this folder
```

This pulls genre packs (`creator-*`, `dj-*`, `solo-*`, …) covering many moods
and instruments. Point a brand's `bgm.defaultName` at any of them, or pass
`--bgm <name>`.

## License

These tracks are provided royalty-free for use with ECHOCUT. Bring your own
music by dropping `*.mp3` files into this folder — any filename works as a
`--bgm` argument.
