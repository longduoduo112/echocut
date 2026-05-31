# CLAUDE.md

Guidance for AI coding agents (Claude Code, Cursor, etc.) working in this repository.
Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md). Users: see [README.md](README.md)
and [docs/CLI.md](docs/CLI.md).

## What this project is

**echocut** is a **local-first video CLI**: point it at a video and it transcribes the
speech, burns in large readable subtitles, adds a brand band + cover, optionally cuts
fillers/silence, slices highlights, and writes a multi-platform publish kit — all on the
user's own machine (FFmpeg + WhisperX/MLX + Ollama). No cloud upload, no editor, no timeline.

Two entry points:

- **CLI** (primary): `echocut burn/highlights/cover/publish/...` — see `docs/CLI.md`.
- **Telegram bot** (optional): `src/app.js` — a long-running front-end; not needed for the CLI.

## Common commands

```bash
npm run check         # syntax check — MUST pass after any code change
npm run test:unit     # node:test unit tests (tests/*.test.js)
npm test              # check + unit tests

echocut doctor                              # environment self-check
echocut burn <file> --cut-fillers --cut-silence
echocut burn <file> --brand <id>            # use a specific brand
echocut highlights <long.mp4> --segments 4
echocut --help
```

The CLI is a thin wrapper: subcommands forward to `scripts/run-video-cases.js` and
`scripts/clip-video.js`, passing settings through env vars (`ZDE_PRESET_CONFIG`,
`ZDE_CUT_FILLERS`, `ZDE_BRAND_CONFIG`, …) so presets/brands don't pollute the DB.

## Architecture

- **Brand system** (`configs/brands/` + `src/services/brandLoader.js`): each brand is one
  JSON file (identity / visual / cta / bgm / llm). Cached `loadBrand()` with two-pass
  placeholder interpolation. Threaded to child processes via env `ZDE_BRAND_CONFIG`.
- **CLI entry**: `bin/echocut.js` (commander) → `src/cli/commands/*.js` → forwards to the
  low-level scripts; every subcommand loads the brand then injects env for downstream.
- **Service entry** (optional bot): `index.js` (watchdog) → `src/app.js` (Telegram intake,
  task queue, end-to-end orchestration).
- **Admin plane**: `src/admin/server.js` + `src/admin/public/*` (observability, config).
- **Content engine**: `src/services/processor.js` (titles / captions correction via Ollama LLM).
- **Transcribe engine**: `src/services/transcriber.js` → `src/video/asrAdapters.js` →
  `python/transcribe_*.py`. Long audio: `src/services/transcribeLong.js` (chunk + resume).
- **Video engine**: `src/video/remotionRunner.js` (FFmpeg subtitle burn + brand band).
- **Post-processing**: `src/video/fillerCutter.js` (track-level filler cut),
  `src/video/coverGenerator.js` (brand cover), `src/video/postProcess.js` (cover as first
  frame + end fade).
- **Highlights**: `src/services/clipper.js` (LLM segmentation + 3-tier anchor fallback +
  FFmpeg clip + per-segment burn).
- **Data plane**: SQLite (`data/contents.db`) via `src/db/*Repo.js`.
- **Object storage** (`src/services/storage.js`): AWS SDK v3, S3/MinIO compatible;
  `uploadFile()` returns a presigned URL. Env `ZDE_S3_*`.
- **Caption rules**: `src/video/captionUtils.js` + `src/video/captionConfig.js` (single
  read entry). **Visual presets**: `src/video/presets/*.json`.

## The burn pipeline (7 visible stages)

```
[1] extract audio       ffprobe probe + ffmpeg pull audio (high-pass + loudnorm)
[2] transcribe          word-level ASR (default engine; strict mode, no silent downgrade)
[3] cut fillers/silence (optional) track-level filler + long-silence removal
[4] discover emphasis   LLM finds per-video keywords to highlight
[5] LLM captions/meta   typo correction + headline/subline
[6] burn subtitles      FFmpeg ASS captions + title + brand capsule (h264_videotoolbox → libx264)
[7] cover + CTA + BGM    cover first frame + end fade + CTA card + optional BGM
```

All ffmpeg calls go through `src/lib/ffmpegProgress.js::runFfmpegWithProgress`
(spawn + streaming `time=` parse, no event-loop blocking).

## Layout philosophy

Default target container is `1080×1920` portrait, but overlays adapt to the source shape:

- **Vertical / portrait**: title on top, big captions on the bottom band.
- **Landscape (16:9)**: stays landscape for readability (full-screen screencasts);
  cover is exported as a separate `.jpg`, not prepended. `--no-title` recommended.
- **OBS** (`--obs`, "face top + screen bottom"): compact top band so the face stays
  visible; small title beside the brand capsule.
- The **brand capsule** is drawn on every frame (vertical & landscape) — the traceable mark.

## ASR engines (`--engine`)

| Engine | Platform | Notes |
|---|---|---|
| `qwen3` | Apple Silicon | **default on macOS** — best Chinese, word-level timestamps, MLX-native, chunked for long audio |
| `whisperx` | cross-platform (CPU/CUDA) | **use this on non-Apple** |
| `mlx` / `mlx_hq` | Apple Silicon | faster preview / higher accuracy |
| `funasr` / `sensevoice` | cross-platform | fast, fallback for long videos |

## Key design constraints (read before changing related code)

- **Single caption-config entry**: all caption params via `src/video/captionConfig.js`.
- **Preset env layer**: `src/db/configRepo.js::getConfigValue` reads `ZDE_PRESET_CONFIG`
  JSON first, so preset switches don't write the DB.
- **FFmpeg exact clip**: `clipper.js` uses precise seek + re-encode (NOT `-c copy`) to avoid
  keyframe-alignment subtitle drift.
- **Encoder fallback chain**: Darwin tries `h264_videotoolbox`, falls back to `libx264`;
  always append `-pix_fmt yuv420p`.
- **ffmpeg process lifecycle**: every ffmpeg call must go through `runFfmpegWithProgress`;
  the error path force-kills + `removeAllListeners` to avoid orphan processes.
- **Transcribe strict mode**: `qwen3` / `mlx_hq` never silently downgrade — a failure
  retries only on the same engine, then errors, rather than swapping to another engine
  (timestamp-precision consistency; silent fallback once caused subtitle drift).
- **Caption-correction length guard**: `processor.js::acceptCaptionFix` rejects LLM
  corrections that change length too much (prevents reflow that desyncs timestamps).
- **3-tier anchor fallback**: LLM segmentation is unstable → clipper falls back
  indexOf → fuzzy substring → even time split to guarantee output.
- **Brand override policy**: a brand only overrides *content* (capsule text/colors, CTA,
  BGM defaults, LLM prompts), **not** *layout rules* (caption ratios/sizes, filler lexicon).
  Hold this line in review.
- **Brand placeholder two-pass interpolation**: pass 1 replaces identity fields
  (`{{name}}` …), pass 2 expands `{{personaBase}}`; unknown placeholders are kept, not cleared.
- **Transcription is cached** per source fingerprint (`src/lib/transcriptCache.js`,
  size+mtime+first-1MB sha) — re-renders are instant. `--fresh` bypasses; preview mode
  doesn't cache. `--reuse-captions <file>` skips transcription + LLM entirely.
- **macOS memory check** must use `src/lib/preflight.js::getAvailableMemoryGB`
  (vm_stat on darwin), NOT `os.freemem()` (returns only fully-free pages under unified memory).
- **Atomic DB write**: sql.js `db.save()` writes to a tmp file then renames — never write
  the target path directly (a half-write on kill corrupts the whole DB).
- **Empty-title guard**: no-speech / no-metadata paths set `headline=''` + `hideTitle=true`
  and the cover generator escapes empty headlines — never substitute a placeholder title.

## Environment

- Node.js 18+ (CommonJS, not ESM)
- Python 3.11+ in `.venv` (whisperx / mlx-whisper / funasr); `npm run setup:python`
- Ollama (default model `qwen3.5:9b`) for LLM features
- FFmpeg
- Default CJK font: Noto Sans SC (OFL), downloaded via `npm run fetch-fonts`
- Remotion render path is optional (`optionalDependencies`); the default pipeline is FFmpeg

## Output directories

- `debug_outputs/video/<run_id>/` — final mp4 + cover.jpg + srt + captions.json + publish.md
- `debug_outputs/audio/<run_id>/` — transcription artifacts
- `.echo-cache/` — transcript / highlights caches (gitignored)
