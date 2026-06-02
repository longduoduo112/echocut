# ASR engines / 转写引擎选型

echocut burns **word-level** subtitles, so the transcription engine must return reliable
word timestamps — otherwise captions drift out of sync with the audio. This is the main
reason not every "accurate" model is usable here.

> echocut 烧的是**词级**字幕,引擎必须给出可靠的词级时间戳,否则字幕会和声音漂移。

## The engines

| Engine | Accuracy (zh) | Speed | Platform | Word timestamps | When to use |
|---|---|---|---|---|---|
| `qwen3` | highest | fast | Apple Silicon | ✅ | **Default** for `burn` / `highlights`. Qwen3-ASR, native MLX. |
| `whisperx` | good | medium | **any** (CPU/CUDA) | ✅ | **Default off Apple Silicon.** The cross-platform path. |
| `mlx` | good | medium | Apple Silicon | ✅ | Faster preview on Mac. |
| `mlx_hq` | high (zh weaker) | slow | Apple Silicon | ✅ | Large-v3 on Mac; kept as a fallback. |
| `funasr` | medium | fast | any | ⚠️ limited | Text-only extraction / long-video fallback (not ideal for burned subs). |

Pick with `--engine <name>`. With no flag, echocut auto-selects: **`qwen3` on Apple
Silicon, `whisperx` elsewhere.**

## Why qwen3 is the default (on Apple Silicon)

On Chinese talking-head benchmarks, Qwen3-ASR's character error rate is dramatically
lower than `whisper-large-v3` (single-digit-percent vs ~2–4× higher), while still
producing the native word-level timestamps that subtitle burning needs. It runs natively
on MLX with built-in chunking, so long videos don't OOM.

## Cross-platform

There is **no MLX on Linux/Windows** — those engines are Apple-Silicon only. On other
platforms echocut falls back to **WhisperX**, which runs on CPU or, if you have an NVIDIA
GPU, on CUDA automatically. WhisperX also gives word timestamps, so subtitle burning
works the same; it's just slower than MLX on comparable hardware.

## Strict mode: no silent downgrade

`qwen3` and `mlx_hq` run in **strict mode** — on failure they retry only within the same
engine and **never** silently fall back to a different one. Mixing engines mid-pipeline
would change timestamp precision and desync the subtitles. If the chosen engine truly
can't run, the pipeline errors out so you can retry — by design. (A past silent fallback
to a weaker engine shipped drifted captions before anyone noticed; strict mode prevents
that.)

## Text-only transcription

If you only need the text (an article, notes) and not burned subtitles, you don't need
word timestamps — a plain-text-optimized model or `funasr` is fine. For subtitle burning,
stick with the word-timestamp engines above.
