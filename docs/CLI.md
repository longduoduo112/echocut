# echocut — CLI Reference / 命令手册

> [English README](../README.md) · [简体中文 README](../README.zh-CN.md)

Complete, agent-friendly reference for the `echocut` CLI — detailed enough that an AI
coding agent can drive echocut end-to-end. Every subcommand also has live help:
`echocut <command> --help`.

---

## 1. Core concepts

**echocut is a local pipeline.** `echocut burn <video>` runs 7 visible stages:

| # | Stage | What happens |
|---|---|---|
| 1 | extract audio | ffprobe + ffmpeg pull the audio track (high-pass + loudnorm for cleaner ASR) |
| 2 | transcribe | word-level ASR (`--engine`); long audio is chunked + cached + resumable |
| 3 | cut fillers/silence | *(optional)* physically trims "um" / long pauses at the video-track level |
| 4 | discover emphasis | LLM finds per-video keywords to highlight in the captions |
| 5 | LLM captions/meta | typo correction + headline/subline (skipped if you pass `--headline/--subline`) |
| 6 | burn subtitles | FFmpeg draws ASS captions + title + brand capsule (`h264_videotoolbox`, libx264 fallback) |
| 7 | cover + CTA + BGM | cover first frame (portrait) + end fade + CTA card + optional background music |

**Output** lands in `debug_outputs/video/<run_id>/`:
`*.mp4` (final) · `*_cover.jpg` (standalone cover) · `*.srt` · `captions.json` · `publish.md` (titles + hashtags).

**ASR engines** (`--engine`): `qwen3` (default, best Chinese, Apple Silicon) · `whisperx`
(cross-platform CPU/CUDA) · `mlx` / `mlx_hq` (Apple Silicon) · `funasr` / `sensevoice`.
On non-Apple platforms use `--engine whisperx`.

**Aspect / layout:** echocut targets a `1080×1920` portrait container by default.
Landscape sources stay landscape (`--no-title` recommended for full-screen screencasts);
`--obs` is for "face on top + screen below" recordings; `--auto-pad` fits any ratio
(e.g. 4:3) into a target container.

**Brands:** every brand is one JSON file `configs/brands/<id>.json`. Pick with `--brand <id>`. See §3.

**Caching / speed:** transcription is cached per source video — re-renders are instant.
`--fresh` re-transcribes; `--reuse-captions <file>` skips transcription + LLM entirely.

---

## 2. Common workflows

```bash
# Talking-head vertical clip (golden path): cut fillers + silence
echocut burn input.mp4 --cut-fillers --cut-silence

# Full-screen landscape tutorial — stays landscape, readable, brand capsule kept
echocut burn tutorial.mp4 --no-title

# OBS screen recording (face top, screen bottom)
echocut burn obs.mov --obs --headline "Title" --subline "Subtitle"

# 4:3 / live-stream recording → 9:16, strip a top watermark band
echocut burn panel.mp4 --auto-pad --strip-top 80 --headline "..." --subline "..."

# Long video → highlight clips (V2: analyze, then produce)
echocut hls long.mp4              # 1) analyze, list candidate segments (cached)
echocut hmk long.mp4 --seg 1      # 2) produce one highlight clip
echocut afc long.mp4 --seg 1      # 3) long-form article from the same segment

# One recording → per-platform publish packages + opening hooks
echocut distribute long.mp4 --seg 1
echocut hook-gen long.mp4

# Just a branded cover image (edit the video elsewhere)
echocut cover --headline "Big headline" --subline "Subline" --brand mybrand

# Already-edited video → add brand cover + BGM + CTA only (no subtitles)
echocut package edited.mp4 --brand mybrand

# Re-render in a different ratio WITHOUT re-transcribing (fast)
echocut burn input.mp4 --reuse-captions debug_outputs/video/<run>/captions.json --ratio 16:9
```

---

## 3. Design your own brand

A brand is one file. Copy the template, edit, use:

```bash
cp configs/brands/_template.json configs/brands/mybrand.json
echocut brand --show mybrand     # inspect the resolved config
echocut burn video.mp4 --brand mybrand
```

Key fields (`configs/brands/<id>.json`):

| Field | Meaning | Tips |
|---|---|---|
| `identity.name / description` | injected into every LLM prompt | be specific — industry, voice, mental models; the more concrete, the more it sounds like you |
| `visual.brandTag` | the always-on capsule, e.g. `@yourhandle` | this is your brand asset — anyone who screenshots can trace the source; keep it short |
| `visual.tagBgColor / tagTextColor` | capsule colors (hex) | high contrast; default is yellow-on-dark |
| `cta.title / subtitle / hint` | end CTA card | a clear follow/subscribe ask |
| `bgm.defaultName` | default music (file in `assets/bgm/`) | leave empty for no BGM |

Conventions echocut applies automatically:
- **Brand capsule** drawn top-left on every frame (vertical & landscape) — your traceable mark.
- **Cover** = unified first frame for vertical output; for landscape it's a separate `.jpg`.
- **Big subtitles** with strong outline for readability; per-video **emphasis words** auto-highlighted.

See `configs/brands/_README.md` for the full field schema and `configs/brands/example.json` for a filled-in example.

A layout cheat-sheet (vertical 1080×1920):

```
┌───────────────────────────┐
│ [@yourhandle]  Headline    │  ← brand capsule (top-left) + title
│                Subline     │
├───────────────────────────┤
│                            │
│        video content       │
│                            │
│                            │
│   ┌────────────────────┐   │
│   │   BIG SUBTITLE      │   │  ← large captions, emphasis words highlighted
│   └────────────────────┘   │
└───────────────────────────┘
```

---

## 4. Commands

Run `echocut <command> --help` for the full, authoritative flag list of any command.

| Group | Command | Purpose |
|---|---|---|
| **Video core** | `burn <file>` | transcribe + burn subtitles + title + brand band + cover + publish kit |
| | `package <file>` | already-edited video → add brand cover + BGM + CTA (no subtitles) |
| | `batch <dir>` | run `burn` / `highlights` over every video in a folder |
| **Long video** | `highlights <file>` | LLM picks N highlight segments, each fully rendered |
| | `highlights-ls` / `hls <file>` | analyze a long video, list candidate segments (cached) |
| | `highlights-make` / `hmk <file>` | render specific/filtered segments from the `hls` cache |
| | `article-from-clip` / `afc <file>` | long-form article from a highlight segment |
| **Multi-person** | `panel-clip <file>` | panel/round-table → per-speaker clips (transcribe → segment → reframe → burn) |
| | `identity-card <file>` | persistent name + title overlay (for panel/speaker videos) |
| **Marketing** | `distribute [file]` | one cut → per-platform publish packages (6 platforms) |
| | `hook-gen [file]` | 5 opening-hook candidates (counter-intuitive / provocative / numeric / story / identity) |
| | `cover` | standalone branded cover `.jpg` (no video processing) |
| | `publish [file]` | upload the result to S3/MinIO, return a signed URL |
| **Content (text)** | `article` | article + social copy from video/audio/text |
| | `essay <source>` | long-form essay from transcript/folder/.txt |
| | `translate <md-or-dir>` | localize Chinese → English (blog style) |
| | `cross-lang [file]` | Chinese → target-language bundle (hooks + thread + article); en/ja/es |
| | `weekly-retro` | weekly review template → LLM analysis + next-week topics |
| **Media / AI** | `music` | generate BGM (MiniMax) — single / batch / local library |
| | `minimax <sub>` | MiniMax suite: tts / image / video / quota |
| | `vlog` / `vlog-plan` | AI plans + renders N vlog cuts from a theme + idea |
| | `ingest <dir>` | tag raw clips with a local vision model → `metadata.json` for vlog |
| **Ops** | `doctor` | environment self-check (Node / FFmpeg / Python / Ollama / memory) |
| | `studio` | start the local admin UI (http://localhost:3399) |
| | `brand` | list / show / validate brand configs |

> Some commands need extra setup: LLM features need **Ollama**; `music`/`minimax` need a
> `MINIMAX_API_KEY`; `publish` needs S3/MinIO env vars; `sync`/`tasks` talk to an optional
> server. The CLI degrades gracefully and `echocut doctor` reports what's available.

---

## 5. `burn` — full flag reference

`echocut burn <file> [options]`:

| Flag | Default | Meaning |
|---|---|---|
| `--headline <text>` | LLM auto | top title (skips the LLM title step) |
| `--subline <text>` | LLM auto | top subtitle |
| `--engine <name>` | `qwen3` | ASR engine: `qwen3` / `whisperx` / `mlx` / `mlx_hq` / `funasr` / `sensevoice` |
| `--ratio <r>` | `auto` | `9:16` / `16:9` / `1:1` / `auto` |
| `--preset <name>` | `douyin` | visual preset: `douyin` (big captions) / `none` |
| `--preview <sec>` | — | render only the first N seconds (fast iteration) |
| `--cut-fillers` | off | physically remove fillers ("um"…) — video/audio/subtitles stay in sync |
| `--cut-silence` | off | remove long pauses (`--silence-threshold <sec>`, default 2.5) |
| `--no-fillers` | — | keep fillers in captions (default removes them) |
| `--no-title` | — | hide title/subline overlay (recommended for screencasts); brand capsule kept |
| `--obs` | off | OBS layout (face top + screen bottom): compact top band so the face stays visible |
| `--brand <id>` | `example` | brand config to use (`configs/brands/<id>.json`) |
| `--bgm <name>` / `--bgm-volume <v>` / `--no-bgm` | brand default | background music control |
| `--denoise` / `--denoise-mix <0-1>` | off / 0.85 | RNNoise voice denoise (noisy environments) |
| `--golden-hook` / `--golden-start <sec>` / `--golden-duration <sec>` | off / auto / 3.0 | copy the punchiest line to the front (retention booster) |
| `--auto-pad` / `--strip-top <px>` | off / 0 | fit any ratio into the target container; strip a top watermark band |
| `--no-subtitle` | — | skip ASR + caption burn (keep title + brand + cover + BGM + CTA + publish kit) |
| `--reuse-captions <file>` | — | reuse a `captions.json` — skip transcription + LLM (fast re-render) |
| `--fresh` | — | force re-transcribe, bypass the transcript cache |

All other commands follow the same pattern — `echocut <command> --help` lists their flags and usage examples.
