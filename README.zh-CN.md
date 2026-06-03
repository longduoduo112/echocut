> [English](README.md) | **简体中文**

# echocut

[![CI](https://github.com/BillLucky/echocut/actions/workflows/ci.yml/badge.svg)](https://github.com/BillLucky/echocut/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![欢迎 PR](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **一条命令,把原始素材变成带品牌、适配各平台的成片。**

`echocut` 是一个**本地优先**的视频 CLI。给它一个视频,它就自动转写语音、烧录大字幕、
加品牌带 + 封面、(可选)切口水词/静默、切精华片段、生成多平台宣发文案 —— 全程在你自己
机器上跑,不上传云端、不用剪辑软件、不用拖时间轴。

```bash
echocut burn talk.mp4 --cut-fillers
# → talk_burn.mp4(字幕+标题+品牌带+封面+淡出)+ cover.jpg + subtitles.srt + publish.md
```

## ✨ 能力

| | |
|---|---|
| 🎬 | **烧字幕** — 词级 ASR(WhisperX 跨平台;Apple Silicon 上用 Qwen3/MLX),大字幕 + 你的 `@品牌` 胶囊常驻每帧 |
| 🖼️ | **品牌封面**作为第一帧 + 末尾淡出 + 结尾 CTA 卡 |
| ✂️ | **口水词/静默切除**(视频轨道级,真删"嗯/啊"和空档,音画字三轨同步) |
| 🎯 | **精华切片** — 长视频切成可分享的短片段 |
| 📐 | **任意画幅** — 竖屏/横屏/方屏/4:3 自动适配;**`--obs`** 模式适配"顶部人脸+底部屏幕"录屏 |
| 📤 | **宣发包** — 多平台标题+简介+话题标签 |
| 🌏 | **多品牌** — 每个品牌一份 JSON |
| ⚡ | **为长视频而生** — 分块转写可断点续跑、转写跨运行缓存、Apple Silicon 硬件编解码 |

## 🚀 快速上手

### 1. 环境依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| **Node.js 18+** | CLI | <https://nodejs.org> |
| **Python 3.11+** | 语音转文字 | <https://python.org> |
| **FFmpeg** | 视频/音频处理 | `brew install ffmpeg` · `apt install ffmpeg` |
| **Ollama** | 本地 LLM(标题、字幕纠错) | <https://ollama.com> → `ollama pull qwen3.5:9b` |

> **平台**:通过 **WhisperX** 跨平台(CPU 或 CUDA)。最快的 `qwen3`/`mlx` 仅 Apple Silicon,其他平台自动回退 WhisperX。视频编码在 Mac 走硬件加速、其他平台走软件 `libx264`(结果一致,只是更慢)——详见 [常见问题](docs/TROUBLESHOOTING.md#cross-platform-expectations--跨平台说明)。

### 2. 安装

#### 快速上手 —— macOS(Apple Silicon)

在 Mac(M1/M2/M3/M4)上,一条幂等脚本装好一切 —— Homebrew、FFmpeg、Node、Python ASR
套件、字体和 CLI:

```bash
git clone https://github.com/<you>/echocut.git && cd echocut
bash scripts/setup-macos.sh                  # 幂等,可重复跑
USE_CN_MIRROR=1 bash scripts/setup-macos.sh  # 国内网络,走国内镜像
```

脚本帮你绕开的两个坑(手动安装务必照做):FFmpeg 必须装 **`ffmpeg-full`**,不是精简版
`ffmpeg`(精简版没 libass,烧字幕会挂);Node 必须用 LTS **`node@22`**,不是最新版
(最新 Node 让 better-sqlite3 没有预编译二进制、源码编译失败)。完整细节、镜像与排错见
**[docs/INSTALL-MACOS.md](docs/INSTALL-MACOS.md)**。

#### 手动安装(任意平台)

```bash
git clone https://github.com/<you>/echocut.git && cd echocut
npm install                                                  # Node 依赖 + CLI
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python ASR
npm run fetch-fonts                                          # 下载默认中文字体(Noto Sans SC,OFL)
cp .env.example .env                                         # 可选密钥(代理、MiniMax 等)
npm link                                                     # 注册 echocut 命令
echocut doctor                                               # 环境自检
```

### 3. 出第一条片

```bash
echocut burn /path/to/video.mp4 --cut-fillers                # 字幕+标题+品牌带+封面+宣发包
echocut burn /path/to/obs.mov --obs --headline "标题" --subline "副标题"   # OBS 人脸+屏幕录屏
echocut burn /path/to/tutorial.mp4 --no-title                # 横屏教程,保持满屏可读
echocut highlights /path/to/long.mp4 --segments 4            # 长视频切精华
```

产物 → `debug_outputs/video/<run_id>/`:`*.mp4` + `*_cover.jpg` + `*.srt` + `publish.md`。

> 同一视频重跑会秒命中转写缓存。`--fresh` 强制重转写;`--reuse-captions <file>` 跳过转写+LLM。

## 🎨 定制你的品牌

每个品牌一份文件 `configs/brands/<id>.json`(身份/颜色/胶囊/CTA/BGM/LLM 人设)。从模板起步:

```bash
cp configs/brands/_template.json configs/brands/mybrand.json
#  改 名字 / 颜色 / @昵称 / CTA …
echocut burn /path/to/video.mp4 --brand mybrand
```

填好的示例见 `configs/brands/example.json`,字段说明见 `_README.md`。

## 📐 输出布局

echocut **一个文件全程同一画幅**,按源视频形状自适应叠加层。你的 `@品牌` 胶囊会画在**每一帧**——这是可溯源的品牌印记。

**竖屏** `9:16`(1080×1920)——口播类默认:

```
┌────────────────────────────┐
│ [@你的昵称]      标题        │  ← 品牌胶囊(左上)+ 标题 + 副标题
│                 副标题       │
├────────────────────────────┤
│                             │
│           画面内容           │
│                             │
│   ┌─────────────────────┐   │
│   │      大 字 幕        │   │  ← 大字幕,爆点词高亮
│   └─────────────────────┘   │
└────────────────────────────┘
   echocut burn clip.mp4 --cut-fillers
```

**横屏** `16:9`——全屏录屏/教程保持横屏(满屏可读):

```
┌──────────────────────────────────────────┐
│ [@你的昵称]                                │  ← 只留胶囊(配 --no-title)
│                                            │
│                画面内容                    │
│                                            │
│   ┌────────────────────────────────────┐  │
│   │            大  字  幕              │  │  ← 字幕落在底部黑边
│   └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
   echocut burn tutorial.mp4 --no-title
   (封面单独导出为 .jpg,不拼到第一帧)
```

**OBS** ——`--obs` 用于「上脸下屏」录制:压缩顶部条让人脸不被挡,标题缩小贴在胶囊右侧:

```
┌────────────────────────────┐
│ [@你]  小标题               │  ← 紧凑顶条,下方人脸不被遮
│  ┌──────────────────────┐   │
│  │      摄像头 / 人脸     │   │
│  └──────────────────────┘   │
│                             │
│           屏幕共享           │
│   ┌─────────────────────┐   │
│   │      大 字 幕        │   │
│   └─────────────────────┘   │
└────────────────────────────┘
   echocut burn obs.mov --obs --headline "标题"
```

其他画幅(如 4:3 直播录屏)→ `--auto-pad` 套进目标容器,`--strip-top <px>` 抹掉顶部水印条。

## 🧰 命令一览

`echocut` 是一套工具箱。完整参考 + agent 友好指南见 **[docs/CLI.md](docs/CLI.md)**。
每个子命令都有实时帮助——`echocut <命令> --help`,带示例。

| 分组 | 命令 |
|---|---|
| **视频核心** | `burn`(转写→字幕→标题→品牌带→封面→宣发包)· `package`(已剪好的视频 → 封面+BGM+CTA)· `batch`(整个文件夹) |
| **长视频** | `highlights`(自动切 N 段)· `hls`(分析+列候选段)· `hmk`(产出指定段)· `afc`(从某段出长文) |
| **多人** | `panel-clip`(圆桌 → 按讲者切)· `identity-card`(姓名/头衔条) |
| **营销** | `distribute`(分平台宣发包)· `hook-gen`(5 个开场钩子)· `cover`(独立封面 .jpg)· `publish`(上传 → 签名链接) |
| **文本** | `article` · `essay` · `translate` · `cross-lang`(中→英/日/西)· `weekly-retro` |
| **媒体 / AI** | `music`(BGM)· `minimax`(tts/图/视频)· `vlog` / `ingest` |
| **运维** | `doctor`(自检)· `studio`(管理后台)· `brand`(列出/查看/校验) |

大部分参数在 `burn` 上——`--engine`、`--ratio`、`--cut-fillers`、`--golden-hook`、`--reuse-captions`
等完整 flag 表见 [docs/CLI.md](docs/CLI.md#5-burn--full-flag-reference)。

## 📚 更多

- **命令手册(对 agent 友好)**:[docs/CLI.md](docs/CLI.md)
- **常见问题 / FAQ**:[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- **转写引擎选型**:[docs/ASR-ENGINES.md](docs/ASR-ENGINES.md)
- **贡献与开发**:[CONTRIBUTING.md](CONTRIBUTING.md) · **路线图**:[ROADMAP.md](ROADMAP.md)
- **AI 编程工具(Claude Code / Cursor)**:[CLAUDE.md](CLAUDE.md) · [AGENTS.md](AGENTS.md)
- **更新日志**:[CHANGELOG.md](CHANGELOG.md) — **安全**:[SECURITY.md](SECURITY.md)
- **全部命令**:`echocut --help`(每个子命令都有 `--help` 和示例)

## 📄 许可

[Apache-2.0](LICENSE)。第三方组件保留各自许可,见 [NOTICE](NOTICE)。默认字体 Noto Sans SC
在安装时下载(SIL OFL 1.1)。可选的 Remotion 渲染链路单独授权,**默认 FFmpeg 流水线不需要它**。
