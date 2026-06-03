# Install on macOS (Apple Silicon)

> **English** | [简体中文](#简体中文) (scroll down)

A from-scratch install guide for **macOS on Apple Silicon** (M1/M2/M3/M4), verified
end-to-end on a fresh **Mac mini (M4, 16GB, macOS 26 "Tahoe", arm64)** whose only
pre-existing tools were Apple's system `git`, system `python3`, and Xcode Command Line
Tools — no Homebrew / Node / FFmpeg / Ollama.

If you just want it working, jump to **[Quickstart (one command)](#quickstart-one-command)**.

---

## What you get

A working `echocut` CLI that takes a video and outputs a brand-ready, subtitle-burned
MP4 plus a cover image, an `.srt`, and a multi-platform publish kit — all locally.

```bash
echocut burn /path/to/video.mp4 --cut-fillers
# → debug_outputs/video/<timestamp>/.../<name>_burn.mp4  (+ cover.jpg + .srt + publish.md)
```

## Prerequisites

You only need these *before* you start; the steps below install everything else:

| Already on a fresh Mac | What we add |
|---|---|
| Apple system `git` | Homebrew, FFmpeg (**`ffmpeg-full`**), Node (**`node@22`**), Ollama (optional) |
| system `python3` (3.9) | a `python@3.11` venv with the ASR stack |
| Xcode Command Line Tools (or we trigger the installer) | Node deps, fonts, the `echocut` CLI |

---

## ⚠️ Two critical gotchas (read these first)

These are the two things that silently bite people on current Homebrew. The setup
script handles both automatically — but if you install by hand, get them right.

### 1. FFmpeg must be `ffmpeg-full`, **NOT** `ffmpeg`

On current Homebrew the plain `ffmpeg` formula is **slimmed and built without libass**,
so the `subtitles` / `ass` filter is missing. echocut burns word-level subtitles through
that filter, so a plain `ffmpeg` fails the burn-in step.

- **Symptom:** subtitle burn-in dies with `No option name near ... .ass ...` or
  `ffmpeg exited with code 234`.
- **Fix:** install the full build, which bundles libass + fontconfig + freetype +
  fribidi + harfbuzz, and force-link it (it's keg-only):
  ```bash
  brew install ffmpeg-full
  brew link --force --overwrite ffmpeg-full
  ```
- **Verify** (both must print a line):
  ```bash
  ffmpeg -version  | grep enable-libass
  ffmpeg -filters  | grep -E ' (subtitles|ass) '
  ```
- If you already installed the slim one, remove it first:
  ```bash
  brew uninstall --ignore-dependencies ffmpeg
  ```

### 2. Node must be the LTS `node@22`, **NOT** the latest `node`

brew's default `node` is bleeding-edge (e.g. v26). The native dependency
`better-sqlite3@12` has **no prebuilt binary** for it and fails to compile from source.

- **Symptom:** `npm install` fails compiling better-sqlite3 —
  `NODE_MODULE_CONTEXT_AWARE_*` / `make failed`.
- **Fix:** use the LTS:
  ```bash
  brew install node@22
  brew link --force node@22
  ```

---

## Quickstart (one command)

From the repo root:

```bash
bash scripts/setup-macos.sh
```

Mainland China (use domestic mirrors — see [the section below](#slow-network--mainland-china)):

```bash
USE_CN_MIRROR=1 bash scripts/setup-macos.sh
```

The script is **idempotent** (safe to re-run) and automates all 10 steps below:
Xcode CLT → Homebrew → `ffmpeg-full` (force-linked, libass verified) → `node@22` →
Ollama (optional) → `npm install --omit=optional` → `python@3.11` venv + ASR stack →
fonts + `.env` + `npm link` → ASR notes → `echocut doctor`.

---

## Step by step (the verified manual path)

If you'd rather run it yourself, this is exactly what worked.

```bash
# 1. Xcode Command Line Tools (compiles native modules like better-sqlite3)
xcode-select --install        # finish the GUI dialog if it appears

# 2. Homebrew (official installer; needs sudo once)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
#   ⚠️ If a previous bootstrap ran over a flaky/slow/proxied network, its formula API
#      cache can be truncated → you get a minimal/wrong formula (e.g. ffmpeg without
#      libass). Cure: rm -rf ~/Library/Caches/Homebrew/api  then retry.

# 3. FFmpeg — the FULL build (see gotcha #1)
brew install ffmpeg-full
brew link --force --overwrite ffmpeg-full
ffmpeg -version | grep enable-libass            # must print a line
ffmpeg -filters | grep -E ' (subtitles|ass) '   # must print a line

# 4. Node — the LTS (see gotcha #2)
brew install node@22
brew link --force node@22

# 5. Ollama — OPTIONAL (local LLM for auto titles / caption fixes)
brew install ollama
#   `echocut burn` works without it; titles fall back to the brand config.

# 6. Clone + Node deps (omit the heavy Remotion render path — default pipeline is pure FFmpeg)
git clone https://github.com/<you>/echocut.git && cd echocut
npm install --omit=optional

# 7. Python venv + ASR  (system python3 3.9 is too old → use brew python@3.11)
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt        # whisperx, torch, mlx-whisper, funasr
.venv/bin/pip install mlx-qwen3-asr              # default best-quality engine on Apple Silicon
.venv/bin/pip install torch torchaudio           # funasr needs torch at runtime (not auto-pulled)

# 8. Fonts + env + link the CLI
npm run fetch-fonts
cp .env.example .env
npm link
#   `npm link` registers `echocut`. The global bin may live under ~/.npm-global/bin —
#   make sure it's on PATH:  export PATH="$(npm prefix -g)/bin:$PATH"
```

---

## ASR engines

| Engine | Role | Model source | First-run download |
|---|---|---|---|
| **`qwen3`** (default) | Qwen3-ASR-1.7B — best Chinese accuracy + word-level timestamps | Hugging Face | ~3.4 GB |
| `funasr` | lightweight fallback (`--engine funasr`) | ModelScope (China-native) | small |

- The **default is `qwen3`**. Its ~3.4 GB model downloads from Hugging Face on the first
  `echocut burn`. In mainland China set `HF_ENDPOINT=https://hf-mirror.com` (uncomment it
  in `.env`) — measured ~33 MB/s on good broadband.
- **`funasr`** is the lightweight fallback. Its model comes from **ModelScope**, which is
  fast inside China and needs no mirror/proxy. Force it with `echocut burn ... --engine funasr`.
- Both engines **shell out to `ffmpeg`**, so the `ffmpeg-full` from gotcha #1 must stay on
  PATH.
- Full selection guide: [docs/ASR-ENGINES.md](ASR-ENGINES.md).

## LLM (Ollama) is optional

Ollama only powers **auto titles** and **caption fixes**. `echocut burn` runs fine
without it — titles fall back to your brand config. If you want it:

```bash
ollama pull qwen3.5:9b
```

This pulls from an overseas registry and can be **very slow in mainland China**, so treat
it as optional, not a hard requirement.

---

## Slow network / mainland China

> All numbers below are **measured** on this build.

A system-wide VPN/proxy in **TUN/global mode hijacks even the domestic mirrors** and
throttles them to ~10–20 KB/s. For a mainland setup: **turn the system proxy OFF** and use
the domestic mirrors below. Only the optional overseas bits (the Ollama model) want a proxy.

The one-command path applies all of these for you:

```bash
USE_CN_MIRROR=1 bash scripts/setup-macos.sh
```

Or set them by hand:

| Tool | Mirror | Notes |
|---|---|---|
| Homebrew | `export HOMEBREW_API_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api`<br>`export HOMEBREW_BOTTLE_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles` | export **before** installing/using brew (~8 MB/s) |
| pip | `pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ...` | or aliyun (~5–8 MB/s) |
| npm | `npm config set registry https://registry.npmmirror.com` | |
| Hugging Face | `export HF_ENDPOINT=https://hf-mirror.com` | for qwen3's ~3.4 GB model |
| ModelScope | (none needed) | China-native, fast (~10 MB/s) — funasr models |

---

## Verify + first run

```bash
echocut doctor                                   # checks Node / FFmpeg / Python / Ollama / memory
echocut burn /path/to/video.mp4 --cut-fillers    # your first vertical talking-head run
```

Output lands in `debug_outputs/video/<timestamp>/.../<name>_burn.mp4` — a 720×1280
vertical video with burned subtitles + brand capsule, alongside a `cover.jpg`, an `.srt`,
and `publish.md`. Phone footage shot in portrait that stores its rotation in the Display
Matrix is auto-normalized.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Subtitle burn fails — `ffmpeg exited with code 234` / `No option name near ...ass...` | You have the **slim `ffmpeg`** (no libass) | Install `ffmpeg-full` (gotcha #1) |
| `npm install` fails building **better-sqlite3** (`make failed`) | You're on the **latest `node`**, not LTS | Use **`node@22`** (gotcha #2) |
| ASR errors that it **can't find `ffmpeg`** | `ffmpeg-full` not on PATH | `brew link --force ffmpeg-full`; check `which ffmpeg` |
| **funasr** transcription dies with a **SOCKS proxy** error | A stale `*_PROXY` line in your `.env` hijacks the ModelScope download | Comment out `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` in `.env` (they're commented by default) |
| Hugging Face / qwen3 model download is **very slow** | No mirror in China | `export HF_ENDPOINT=https://hf-mirror.com` (or uncomment it in `.env`) |
| `command not found: echocut` | CLI not linked / npm global bin not on PATH | `npm link`; then `export PATH="$(npm prefix -g)/bin:$PATH"` |

More: **[docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

---
---

# 简体中文

> [English](#install-on-macos-apple-silicon) | **简体中文**

**macOS（Apple Silicon，M1/M2/M3/M4）** 从零安装指南。已在一台全新的
**Mac mini（M4，16GB，macOS 26 "Tahoe"，arm64）** 上完整跑通——这台机器原本只有 Apple
自带的 `git`、自带的 `python3` 和 Xcode 命令行工具,没有 Homebrew / Node / FFmpeg / Ollama。

只想跑起来的话,直接看 **[一条命令安装](#一条命令安装)**。

## 安装完得到什么

一个能用的 `echocut` CLI:喂一个视频,输出带品牌、烧好字幕的成片,外加封面图、`.srt`
字幕和多平台宣发包 —— 全程本地。

```bash
echocut burn /path/to/video.mp4 --cut-fillers
# → debug_outputs/video/<timestamp>/.../<name>_burn.mp4(+ cover.jpg + .srt + publish.md)
```

## 前置条件

开始前只需这些,其余步骤会装好:

| 全新 Mac 上已有 | 我们要装 |
|---|---|
| Apple 自带 `git` | Homebrew、FFmpeg(**`ffmpeg-full`**)、Node(**`node@22`**)、Ollama(可选) |
| 自带 `python3`(3.9) | `python@3.11` venv + ASR 套件 |
| Xcode 命令行工具(或脚本触发安装) | Node 依赖、字体、`echocut` CLI |

## ⚠️ 两个致命坑(先读这两条)

当前版本 Homebrew 上会悄悄坑人的两件事。安装脚本已自动处理;手动安装务必照做。

### 1. FFmpeg 必须装 `ffmpeg-full`,**不是** `ffmpeg`

当前 Homebrew 的普通 `ffmpeg` 公式是**精简版、没编 libass**,缺 `subtitles`/`ass` 滤镜。
echocut 用这个滤镜烧词级字幕,普通 `ffmpeg` 会在烧字幕这步直接挂。

- **症状**:烧字幕报 `No option name near ... .ass ...` 或 `ffmpeg exited with code 234`。
- **解决**:装完整版(自带 libass + fontconfig + freetype + fribidi + harfbuzz),
  并强制 link(它是 keg-only):
  ```bash
  brew install ffmpeg-full
  brew link --force --overwrite ffmpeg-full
  ```
- **验证**(两条都要打印出内容):
  ```bash
  ffmpeg -version  | grep enable-libass
  ffmpeg -filters  | grep -E ' (subtitles|ass) '
  ```
- 已经装了精简版的,先卸掉:`brew uninstall --ignore-dependencies ffmpeg`

### 2. Node 必须用 LTS `node@22`,**不是**最新的 `node`

brew 默认的 `node` 是最新版(如 v26)。原生依赖 `better-sqlite3@12` **没有对应的预编译
二进制**,会回退到源码编译并失败。

- **症状**:`npm install` 在编 better-sqlite3 时报错 —— `NODE_MODULE_CONTEXT_AWARE_*` /
  `make failed`。
- **解决**:用 LTS:
  ```bash
  brew install node@22
  brew link --force node@22
  ```

## 一条命令安装

仓库根目录下:

```bash
bash scripts/setup-macos.sh
```

国内网络(走国内镜像,见 [慢网络 / 国内](#慢网络--国内)):

```bash
USE_CN_MIRROR=1 bash scripts/setup-macos.sh
```

脚本**幂等**(可重复跑),自动完成 10 步:Xcode CLT → Homebrew → `ffmpeg-full`(强制
link + 校验 libass)→ `node@22` → Ollama(可选)→ `npm install --omit=optional` →
`python@3.11` venv + ASR 套件 → 字体 + `.env` + `npm link` → ASR 说明 → `echocut doctor`。

## 手动逐步(实测可用路径)

```bash
# 1. Xcode 命令行工具(编译 better-sqlite3 等原生模块)
xcode-select --install        # 弹出 GUI 时点完成

# 2. Homebrew(官方安装器;需要一次 sudo)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
#   ⚠️ 若之前在弱网/慢/代理环境下装过 Homebrew,它的 formula API 缓存可能被截断,
#      导致取到精简/错误公式(如没 libass 的 ffmpeg)。解法:
#      rm -rf ~/Library/Caches/Homebrew/api  然后重试。

# 3. FFmpeg —— 完整版(见坑 1)
brew install ffmpeg-full
brew link --force --overwrite ffmpeg-full
ffmpeg -version | grep enable-libass
ffmpeg -filters | grep -E ' (subtitles|ass) '

# 4. Node —— LTS(见坑 2)
brew install node@22
brew link --force node@22

# 5. Ollama —— 可选(本地 LLM:自动标题 / 字幕纠错)
brew install ollama
#   不装也能跑 `echocut burn`,标题会回退到品牌配置。

# 6. clone + Node 依赖(省掉笨重的 Remotion 渲染路径,默认流水线是纯 FFmpeg)
git clone https://github.com/<you>/echocut.git && cd echocut
npm install --omit=optional

# 7. Python venv + ASR(系统 python3 3.9 太老 → 用 brew python@3.11)
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt        # whisperx, torch, mlx-whisper, funasr
.venv/bin/pip install mlx-qwen3-asr              # Apple Silicon 上默认的最高质量引擎
.venv/bin/pip install torch torchaudio           # funasr 运行时需要 torch(不会自动装)

# 8. 字体 + 环境变量 + link CLI
npm run fetch-fonts
cp .env.example .env
npm link
#   `npm link` 注册 `echocut`。全局 bin 可能在 ~/.npm-global/bin,确保它在 PATH 里:
#   export PATH="$(npm prefix -g)/bin:$PATH"
```

## ASR 引擎

| 引擎 | 角色 | 模型来源 | 首次下载 |
|---|---|---|---|
| **`qwen3`**(默认) | Qwen3-ASR-1.7B —— 中文最准 + 词级时间戳 | Hugging Face | ~3.4 GB |
| `funasr` | 轻量兜底(`--engine funasr`) | ModelScope(国内原生) | 小 |

- **默认 `qwen3`**,首次 `echocut burn` 时从 Hugging Face 下 ~3.4 GB 模型。国内设
  `HF_ENDPOINT=https://hf-mirror.com`(在 `.env` 里取消注释)—— 好的宽带实测约 33 MB/s。
- **`funasr`** 是轻量兜底,模型来自 **ModelScope**,国内快、无需镜像/代理。强制用:
  `echocut burn ... --engine funasr`。
- 两个引擎都会**调用 `ffmpeg`**,所以坑 1 里的 `ffmpeg-full` 必须在 PATH 上。
- 完整选型:[docs/ASR-ENGINES.md](ASR-ENGINES.md)。

## LLM(Ollama)是可选的

Ollama 只负责**自动标题**和**字幕纠错**。不装也能跑 `echocut burn`,标题会回退到品牌
配置。要用就:

```bash
ollama pull qwen3.5:9b
```

这是从海外仓库拉取,**国内可能非常慢**,因此把它当可选项,不是硬性要求。

## 慢网络 / 国内

> 下面的数字都是这次安装**实测**值。

系统级 VPN/代理在 **TUN/全局模式下会劫持连国内镜像**,把速度压到 ~10–20 KB/s。国内安装请
**关掉系统代理**,改用下面的国内镜像;只有可选的海外部分(Ollama 模型)才需要代理。

一条命令路径会自动应用全部镜像:

```bash
USE_CN_MIRROR=1 bash scripts/setup-macos.sh
```

或手动设置:

| 工具 | 镜像 | 备注 |
|---|---|---|
| Homebrew | `export HOMEBREW_API_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api`<br>`export HOMEBREW_BOTTLE_DOMAIN=https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles` | 在用 brew **之前** export(~8 MB/s) |
| pip | `pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ...` | 或阿里云(~5–8 MB/s) |
| npm | `npm config set registry https://registry.npmmirror.com` | |
| Hugging Face | `export HF_ENDPOINT=https://hf-mirror.com` | qwen3 的 ~3.4 GB 模型 |
| ModelScope | (无需) | 国内原生,快(~10 MB/s)—— funasr 模型 |

## 验证 + 首跑

```bash
echocut doctor                                   # 检查 Node / FFmpeg / Python / Ollama / 内存
echocut burn /path/to/video.mp4 --cut-fillers    # 第一条竖屏口播
```

产物在 `debug_outputs/video/<timestamp>/.../<name>_burn.mp4` —— 720×1280 竖屏、烧好字幕 +
品牌胶囊,同目录还有 `cover.jpg`、`.srt`、`publish.md`。手机竖拍、把旋转信息存在 Display
Matrix 里的素材会被自动归正。

## 常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| 烧字幕失败 —— `ffmpeg exited with code 234` / `No option name near ...ass...` | 装的是**精简 `ffmpeg`**(没 libass) | 改装 `ffmpeg-full`(坑 1) |
| `npm install` 编 **better-sqlite3** 失败(`make failed`) | 用了**最新 `node`**,不是 LTS | 改用 **`node@22`**(坑 2) |
| ASR 报**找不到 `ffmpeg`** | `ffmpeg-full` 不在 PATH | `brew link --force ffmpeg-full`;查 `which ffmpeg` |
| **funasr** 转写报 **SOCKS 代理**错误 | `.env` 里残留的 `*_PROXY` 劫持了 ModelScope 下载 | 注释掉 `.env` 里的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`(默认已注释) |
| Hugging Face / qwen3 模型下载**极慢** | 国内没设镜像 | `export HF_ENDPOINT=https://hf-mirror.com`(或在 `.env` 取消注释) |
| `command not found: echocut` | 没 link / npm 全局 bin 不在 PATH | `npm link`;再 `export PATH="$(npm prefix -g)/bin:$PATH"` |

更多:**[docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)**。
