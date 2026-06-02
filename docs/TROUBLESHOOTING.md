# Troubleshooting / 常见问题

Most setup problems fall into a handful of buckets. Run `echocut doctor` first —
it checks Node / FFmpeg / Python / Ollama / memory and tells you what's missing.

> 大部分问题都能被 `echocut doctor` 一眼定位。下面按"症状 → 原因 → 解决"组织。

---

## Install & first run / 安装与首次运行

### `command not found: echocut`
The CLI isn't linked. From the repo root:
```bash
npm install && npm link
```
`npm link` registers the global `echocut` command. If `npm link` needs sudo on your
system, prefer a Node version manager (nvm/fnm) so your user owns the global prefix.

### `ffmpeg: command not found` / FFmpeg not detected
echocut shells out to FFmpeg for everything. Install it and make sure it's on `PATH`:
```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian/Ubuntu
choco install ffmpeg         # Windows (or scoop install ffmpeg)
```
Verify with `ffmpeg -version` and `ffprobe -version` (echocut needs both).

### Fonts missing → captions render as boxes/tofu / 字幕变成方块
The default CJK font is downloaded at setup, not committed. Run:
```bash
npm run fetch-fonts          # downloads Noto Sans SC (SIL OFL)
```
If the download fails (network/GitHub rate limit), re-run it, or drop any `.ttf/.otf`
into `assets/fonts/` and point your brand's `visual.titleFont` / `subtitleFont` at it.
Without a usable font, FFmpeg `drawtext` produces empty boxes.

### Python / ASR install fails / 转写依赖装不上
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
Platform notes:
- **`mlx-whisper` only installs on Apple Silicon.** On Linux/Windows that wheel is
  expected to be skipped — echocut automatically uses **WhisperX** there (see
  [ASR-ENGINES.md](ASR-ENGINES.md)). A failed `mlx` wheel on non-Mac is not fatal.
- `funasr` pulls native audio deps (libsndfile etc.). On minimal Linux images install
  `ffmpeg libsndfile1` from the system package manager first.

---

## Ollama (titles, caption fixes) / 本地大模型

### `Ollama 未运行` / connection refused on `127.0.0.1:11434`
Start Ollama and pull the default model:
```bash
ollama serve                 # if not already running as a service
ollama pull qwen3.5:9b       # default model echocut expects
```
Running Ollama on another host? Set `OLLAMA_URL` in `.env`
(e.g. `OLLAMA_URL=http://192.168.1.10:11434/api/chat`).

### Want a different / smaller model
Pull it and pass `--model`, e.g. `echocut afc video.mp4 --model qwen3.5:7b`, or set the
model in `.env`. Smaller models are faster but title/caption quality drops.

---

## Running out of memory / 内存不足

`echocut` refuses to start a run below ~2GB available and warns under ~4GB for the
high-quality MLX engines. On macOS, **ignore `Activity Monitor`'s "free" number** — the
preflight reads real available memory via `vm_stat` (unified memory reclaims cache on
pressure). If you still hit OOM on a long video:
- use a lighter engine: `--engine whisperx` (or `funasr` for text-only),
- close other GPU/ML processes (only one MLX job should run at a time),
- bypass the preflight at your own risk with `ZDE_SKIP_PREFLIGHT=1`.

---

## Disk space / 磁盘清理

A burn needs roughly **3× the source video** in scratch space (filler-cut intermediates +
the rendered cut + post-process). If preflight reports low disk, clear caches:
```bash
rm -rf .echo-cache/transcribe/*   # chunked transcription scratch (safe)
rm -rf debug_outputs/video/*      # old rendered outputs you've already saved
```
The transcript cache under `.echo-cache/transcript/` is keyed by source-file fingerprint
and is safe to delete — it only costs you a re-transcribe next run.

---

## Cross-platform expectations / 跨平台说明

echocut is **local-first and cross-platform**, but the experience differs by hardware:

| | Apple Silicon (Mac) | Linux / Windows |
|---|---|---|
| ASR | `qwen3` / `mlx` (fastest, default) | **WhisperX** (CPU or CUDA) — auto-selected |
| Video encode | `h264_videotoolbox` (hardware) | `libx264` (software — slower, more CPU) |
| `mlx-whisper` wheel | installs | skipped (Mac-only) — expected |

So a long render on a CPU-only Linux box is correct but slower than on a Mac. With an
NVIDIA GPU, WhisperX uses CUDA for transcription automatically.

---

## Transcription behaviour / 转写行为

### "It re-transcribed even though nothing changed"
Pass nothing — the transcript cache should hit automatically on the same source file.
It misses if the file's size/mtime changed. Force a fresh pass with `--fresh`.

### "I just want to re-render with a different ratio/style, fast"
Skip transcription **and** the LLM pass entirely:
```bash
echocut burn video.mp4 --reuse-captions path/to/captions.json --ratio 9:16
```

### Strict engines never silently downgrade
`--engine qwen3` (default) and `--engine mlx_hq` retry only within that engine and
**never** fall back to a different one — mixing engines would drift subtitle timing. If
the engine genuinely fails, the run errors out so you can retry, by design. See
[ASR-ENGINES.md](ASR-ENGINES.md).

---

Still stuck? Open an issue with the failing command, `echocut doctor` output, and your
OS — <https://github.com/BillLucky/echocut/issues>.
