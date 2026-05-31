# Contributing to echocut

> **English** below · [中文见下半部分](#贡献指南中文)

Thanks for your interest! echocut is a local-first video CLI built on Node.js + FFmpeg +
local ASR/LLM. Contributions of all sizes are welcome — bug fixes, new brands, docs,
new platform presets, performance.

## Dev setup

```bash
git clone https://github.com/<you>/echocut.git && cd echocut
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm run fetch-fonts
npm run check        # syntax check (must pass)
npm test             # check + unit tests (must pass)
```

You need **Node 18+**, **Python 3.11+**, **FFmpeg**, and (for LLM features) **Ollama**.
`echocut doctor` tells you what's missing.

## Project layout

```
bin/echocut.js        CLI entry (commander) → src/cli/commands/*
src/cli/commands/*        one file per subcommand (burn, highlights, cover, …)
src/video/*               render core: remotionRunner (FFmpeg subtitle burn), coverGenerator,
                          postProcess (cover/fade/CTA/BGM), fillerCutter, aspectRatioFitter
src/services/*            transcriber, processor (LLM), clipper, transcribeLong, brandLoader, …
src/lib/*                 small utilities (transcriptCache, stripEmoji, asrNameSanitizer, ffmpegProgress)
configs/brands/*.json     one file per brand (identity/visual/cta/bgm/llm)
configs/asr-tech-terms.json   global ASR term corrections (Claude Code, GitHub, …)
python/transcribe_*.py    ASR adapters (whisperx / mlx / qwen3 / funasr)
tests/*.test.js           node:test unit tests
```

The CLI is a thin wrapper that forwards to `scripts/run-video-cases.js` /
`scripts/clip-video.js` via `ZDE_*` environment variables.

## Before you open a PR

1. `npm run check` and `npm test` pass.
2. Add/extend unit tests for logic changes (`node --test tests/<x>.test.js`).
3. Keep changes focused; match the surrounding code style and comment density.
4. **Never commit secrets, personal data, or non-redistributable assets** (real brand
   data, API keys, copyrighted fonts/music). Configure secrets via `.env` (gitignored).
5. Write a clear commit message describing the technical reason.

## Tips

- ASR engine: default `qwen3` (Apple Silicon) / `whisperx` (cross-platform). Pick with `--engine`.
- The subtitle burn is FFmpeg (`h264_videotoolbox` on macOS, `libx264` fallback). Remotion is optional.
- Long videos: transcription is chunked + cached; re-renders are fast.

---

<a name="贡献指南中文"></a>

# 贡献指南(中文)

感谢关注!echocut 是基于 Node.js + FFmpeg + 本地 ASR/LLM 的本地优先视频 CLI。欢迎任何大小的
贡献 —— 修 bug、加品牌、补文档、加平台预设、做性能优化。

## 开发环境

```bash
git clone https://github.com/<you>/echocut.git && cd echocut
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm run fetch-fonts
npm run check        # 语法检查(必须过)
npm test             # check + 单元测试(必须过)
```

需要 **Node 18+**、**Python 3.11+**、**FFmpeg**,LLM 功能还需 **Ollama**。`echocut doctor` 会告诉你缺什么。

## 项目结构

```
bin/echocut.js        CLI 入口(commander)→ src/cli/commands/*
src/cli/commands/*        每个子命令一个文件(burn / highlights / cover …)
src/video/*              渲染核心:remotionRunner(FFmpeg 烧字幕)、coverGenerator、
                          postProcess(封面/淡出/CTA/BGM)、fillerCutter、aspectRatioFitter
src/services/*           transcriber、processor(LLM)、clipper、transcribeLong、brandLoader …
src/lib/*                小工具(transcriptCache、stripEmoji、asrNameSanitizer、ffmpegProgress)
configs/brands/*.json    每个品牌一份文件
python/transcribe_*.py   ASR 适配(whisperx / mlx / qwen3 / funasr)
tests/*.test.js          node:test 单元测试
```

CLI 是薄封装,通过 `ZDE_*` 环境变量转发到 `scripts/run-video-cases.js` / `scripts/clip-video.js`。

## 提 PR 前

1. `npm run check` 和 `npm test` 都过。
2. 逻辑改动配单测(`node --test tests/<x>.test.js`)。
3. 改动聚焦;匹配周围代码风格与注释密度。
4. **绝不提交密钥、个人数据、不可再分发资产**(真实品牌数据、API key、受版权字体/音乐)。密钥走 `.env`(已 gitignore)。
5. commit message 写清技术原因。
