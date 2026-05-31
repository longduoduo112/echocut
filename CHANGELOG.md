# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-31

First public release.

### Added
- **`burn`** — one-command pipeline: word-level ASR → subtitle burn-in → title + brand
  capsule → cover → optional filler/silence cutting → multi-platform publish kit.
- **Highlights** — `highlights` (auto-slice N clips), `hls` (analyze + list candidate
  segments, cached), `hmk` (render chosen segments), `afc` (article from a segment).
- **Layout modes** — vertical `9:16`, landscape `16:9` (stays landscape for screencasts),
  square, `--auto-pad` for any ratio, and `--obs` for "face top + screen bottom" recordings.
- **Brand system** — every brand is one JSON file (`configs/brands/<id>.json`); ships with
  `_default` / `_template` / `example` only.
- **ASR engines** — `whisperx` (cross-platform CPU/CUDA), `qwen3` / `mlx` / `mlx_hq`
  (Apple Silicon), `funasr` / `sensevoice`; long audio is chunked, cached and resumable.
- **Marketing** — `distribute` (per-platform packages), `hook-gen` (opening hooks),
  `cover` (standalone cover), `publish` (upload → signed URL).
- **Optional Telegram bot** front-end and a local admin UI (`studio`).
- Bilingual docs (English + 简体中文), `docs/CLI.md` agent-friendly reference, `CLAUDE.md` /
  `AGENTS.md` for AI coding tools.

### Notes
- Apache-2.0. Default CJK font Noto Sans SC (SIL OFL 1.1, downloaded at setup).
- Remotion render path is an `optionalDependency` (separate license); the default pipeline
  is pure FFmpeg.

[0.1.0]: https://github.com/BillLucky/echocut/releases/tag/v0.1.0
