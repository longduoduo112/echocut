# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CI** — GitHub Actions runs `check` + unit tests on Node 18/20 for every push/PR; README badges.
- **Docs** — `docs/TROUBLESHOOTING.md` (FAQ), `docs/ASR-ENGINES.md` (engine selection), `ROADMAP.md`.
- **Brand config** — documented `asrNameCorrections` (homophone name correction for panel/multi-speaker) in the brand template and field reference.

### Changed
- Documented `hook-gen --rounds` (A/B rounds) and `afc --deep-review` in `docs/CLI.md`.
- README now notes the cross-platform video-encoder trade-off (hardware on Mac, `libx264` elsewhere).

### Fixed
- **Security** — removed SaaS-only `sync` / `tasks` commands that still carried hardcoded server/admin defaults; they were never useful to the local-first CLI.
- Fixed dangling in-code doc references (`ASR-FINAL-REPORT.md`, `OPERATIONS.md`) to point at real docs.

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
