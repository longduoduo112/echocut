# echocut

> **English** | [简体中文](README.zh-CN.md)

**Turn raw footage into brand-ready, platform-optimized video — with one command.**

`echocut` is a **local-first** video CLI. Point it at a video and it transcribes the
speech, burns in big readable subtitles, adds your brand band + cover, optionally cuts
fillers/silence, slices highlights, and writes a multi-platform publish kit — all on
your own machine. No cloud upload, no editor, no timeline.

```bash
echocut burn talk.mp4 --cut-fillers
# → talk_burn.mp4  (subtitles + title + brand band + cover + fade)  +  cover.jpg  +  subtitles.srt  +  publish.md
```

## ✨ Features

| | |
|---|---|
| 🎬 | **Subtitle burn-in** — word-level ASR (WhisperX cross-platform; Qwen3/MLX on Apple Silicon), large readable captions, your `@brand` capsule on every frame |
| 🖼️ | **Brand cover** as first frame + smooth fade-out + end CTA card |
| ✂️ | **Filler / silence cutting** at the video-track level (removes "um" and dead air — video, audio and subtitles stay in sync) |
| 🎯 | **Highlights** — slice a long video into shareable clips |
| 📐 | **Any aspect ratio** — vertical / landscape / square / 4:3 auto-fit; **`--obs`** mode for face-on-top + screen-below recordings |
| 📤 | **Publish kit** — titles + descriptions + hashtags for multiple platforms |
| 🌏 | **Multi-brand** — every brand is one JSON file |
| ⚡ | **Built for long videos** — chunked transcription with resume, cross-run transcript cache, hardware encode/decode on Apple Silicon |

## 🚀 Quickstart

### 1. Prerequisites

| Dependency | Why | Install |
|---|---|---|
| **Node.js 18+** | the CLI | <https://nodejs.org> |
| **Python 3.11+** | speech-to-text | <https://python.org> |
| **FFmpeg** | video/audio processing | `brew install ffmpeg` · `apt install ffmpeg` |
| **Ollama** | local LLM (titles, caption fixes) | <https://ollama.com> → `ollama pull qwen3.5:9b` |

> **Platform:** works cross-platform via **WhisperX** (CPU or CUDA). The fastest ASR
> (`qwen3`, `mlx`) is **Apple Silicon only** and falls back to WhisperX elsewhere.

### 2. Install

```bash
git clone https://github.com/<you>/echocut.git && cd echocut
npm install                                                  # Node deps + CLI
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python ASR
npm run fetch-fonts                                          # download default CJK font (Noto Sans SC, OFL)
cp .env.example .env                                         # optional keys (proxy, MiniMax, …)
npm link                                                     # register the `echocut` command
echocut doctor                                               # environment self-check
```

### 3. Make your first video

```bash
# Subtitles + title + brand band + cover + publish kit
echocut burn /path/to/video.mp4 --cut-fillers

# OBS screen recording (face on top, screen below) — face stays visible, compact title
echocut burn /path/to/obs.mov --obs --headline "Title" --subline "Subtitle"

# Long landscape tutorial — stays full-screen landscape, readable
echocut burn /path/to/tutorial.mp4 --no-title

# Slice a long video into highlight clips
echocut highlights /path/to/long.mp4 --segments 4
```

Output → `debug_outputs/video/<run_id>/`: the `*.mp4`, a `*_cover.jpg`, `*.srt`, and `publish.md`.

> Re-rendering the same video reuses the cached transcription instantly. `--fresh`
> forces a re-transcribe; `--reuse-captions <file>` skips transcription + LLM entirely.

## 🎨 Make it yours — brands

Every brand is one file: `configs/brands/<id>.json` — identity, colors, brand capsule,
CTA, BGM defaults and the LLM persona. Start from the template:

```bash
cp configs/brands/_template.json configs/brands/mybrand.json
#  edit name / colors / @handle / CTA …
echocut burn /path/to/video.mp4 --brand mybrand
```

See `configs/brands/example.json` for a filled-in example and `_README.md` for the field reference.

## 📐 Output layouts

echocut keeps **one frame size per file** and adapts the overlays to the source shape.
Your `@brand` capsule is drawn on **every** frame — it's your traceable mark.

**Vertical** `9:16` (1080×1920) — the default for talking-head clips:

```
┌────────────────────────────┐
│ [@yourhandle]   Headline    │  ← brand capsule (top-left) + title + subline
│                 Subline     │
├────────────────────────────┤
│                             │
│         video content        │
│                             │
│   ┌─────────────────────┐   │
│   │    BIG  SUBTITLE     │   │  ← large captions, emphasis words highlighted
│   └─────────────────────┘   │
└────────────────────────────┘
   echocut burn clip.mp4 --cut-fillers
```

**Landscape** `16:9` — full-screen screencasts / tutorials stay landscape (readable):

```
┌──────────────────────────────────────────┐
│ [@yourhandle]                              │  ← capsule only (use --no-title)
│                                            │
│              video content                 │
│                                            │
│   ┌────────────────────────────────────┐  │
│   │           BIG  SUBTITLE            │  │  ← captions on a bottom band
│   └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
   echocut burn tutorial.mp4 --no-title
   (cover is exported as a separate .jpg, not prepended)
```

**OBS** — `--obs` for "face on top, screen below" recordings: a compact top band keeps
the face visible, with a small title beside the capsule:

```
┌────────────────────────────┐
│ [@you]  Small title         │  ← compact band — face below stays visible
│  ┌──────────────────────┐   │
│  │      webcam / face    │   │
│  └──────────────────────┘   │
│                             │
│         screen share         │
│   ┌─────────────────────┐   │
│   │    BIG  SUBTITLE     │   │
│   └─────────────────────┘   │
└────────────────────────────┘
   echocut burn obs.mov --obs --headline "Title"
```

Any other shape (e.g. 4:3 live-stream) → `--auto-pad` fits it into the target container,
`--strip-top <px>` wipes a top watermark band.

## 🧰 Commands

`echocut` is a toolbox. Full reference + agent-friendly guide: **[docs/CLI.md](docs/CLI.md)**.
Every subcommand has live help — `echocut <command> --help` — with examples.

| Group | Commands |
|---|---|
| **Video core** | `burn` (transcribe→subtitles→title→brand→cover→publish kit) · `package` (already-edited video → cover+BGM+CTA) · `batch` (a whole folder) |
| **Long video** | `highlights` (auto-slice N clips) · `hls` (analyze + list segments) · `hmk` (render chosen segments) · `afc` (article from a segment) |
| **Multi-person** | `panel-clip` (panel → per-speaker clips) · `identity-card` (name/title overlay) |
| **Marketing** | `distribute` (per-platform packages) · `hook-gen` (5 opening hooks) · `cover` (standalone cover .jpg) · `publish` (upload → signed URL) |
| **Text** | `article` · `essay` · `translate` · `cross-lang` (zh→en/ja/es) · `weekly-retro` |
| **Media / AI** | `music` (BGM) · `minimax` (tts/image/video) · `vlog` / `ingest` |
| **Ops** | `doctor` (self-check) · `studio` (admin UI) · `brand` (list/show/validate) |

Most flags live on `burn` — see the [full flag table in docs/CLI.md](docs/CLI.md#5-burn--full-flag-reference)
for `--engine`, `--ratio`, `--cut-fillers`, `--golden-hook`, `--reuse-captions`, and more.

## 📚 More

- **CLI reference (agent-friendly):** [docs/CLI.md](docs/CLI.md)
- **Contributing & dev setup:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **AI coding tools (Claude Code / Cursor):** [CLAUDE.md](CLAUDE.md) · [AGENTS.md](AGENTS.md)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md) — **Security:** [SECURITY.md](SECURITY.md)
- **All commands:** `echocut --help` (every subcommand has `--help` with examples)
- **简体中文文档:** [README.zh-CN.md](README.zh-CN.md)

## 📄 License

[Apache-2.0](LICENSE). Bundled/declared third-party components keep their own licenses —
see [NOTICE](NOTICE). The default font (Noto Sans SC) is downloaded at setup under the
SIL Open Font License 1.1. The optional Remotion render path is licensed separately and
is **not** required by the default FFmpeg pipeline.
