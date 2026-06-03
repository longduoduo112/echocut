#!/usr/bin/env bash
#
# echocut — macOS (Apple Silicon) one-shot setup.
#
# Verified end-to-end on a fresh Mac mini (M4, 16GB, macOS 26 "Tahoe", arm64) whose
# only pre-existing tools were Apple's system git + system python3 + Xcode CLT.
#
# Idempotent: every step is guarded so re-runs are safe. Re-run it any time — it skips
# what's already installed.
#
# Usage:
#   bash scripts/setup-macos.sh
#   USE_CN_MIRROR=1 bash scripts/setup-macos.sh    # mainland China — use domestic mirrors
#
# ⚠️ Mainland China note: a system-wide VPN/proxy in TUN/global mode hijacks even the
#    domestic mirrors and throttles them to ~10-20 KB/s. Turn the system proxy OFF and
#    run with USE_CN_MIRROR=1; only the optional Ollama model pull wants a proxy.
#
set -euo pipefail

# ── pretty logging ──────────────────────────────────────────────────────────
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
step() { echo; echo "${BOLD}${CYAN}==> $*${RESET}"; }
ok()   { echo "${GREEN}  ✓ $*${RESET}"; }
warn() { echo "${YELLOW}  ⚠ $*${RESET}"; }
err()  { echo "${RED}  ✗ $*${RESET}" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "${BOLD}echocut macOS setup${RESET}  (${PROJECT_ROOT})"

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This script targets macOS. On Linux/Windows, install ffmpeg + node 18+ + python3.11 with your package manager and use WhisperX as the ASR engine."
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Not Apple Silicon (arm64). The MLX/qwen3 engines won't run; echocut will use WhisperX. Continuing anyway."
fi

# ── mainland-China mirror env (only when USE_CN_MIRROR=1) ─────────────────────
PIP_INDEX_ARGS=()
if [[ "${USE_CN_MIRROR:-0}" == "1" ]]; then
  step "Mainland-China mirrors enabled (USE_CN_MIRROR=1)"
  export HOMEBREW_API_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
  export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
  export HF_ENDPOINT="https://hf-mirror.com"
  PIP_INDEX_ARGS=(-i "https://pypi.tuna.tsinghua.edu.cn/simple")
  ok "Homebrew → TUNA bottles; pip → TUNA index; HF_ENDPOINT → hf-mirror.com; npm → npmmirror (set below)"
  warn "Make sure any system VPN/proxy in TUN/global mode is OFF — it throttles these mirrors."
fi

# ── 1. Xcode Command Line Tools ───────────────────────────────────────────────
# Needed to compile native node modules (e.g. better-sqlite3) from source.
step "[1/10] Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "already installed ($(xcode-select -p))"
else
  warn "not installed — launching the installer (a GUI dialog will appear)"
  xcode-select --install || true
  echo "    Finish the Xcode CLT install dialog, then re-run this script."
  exit 1
fi

# ── 2. Homebrew ───────────────────────────────────────────────────────────────
step "[2/10] Homebrew"
if have brew; then
  ok "already installed ($(brew --version | head -1))"
else
  # A previous bootstrap over a flaky/slow/proxied network can truncate the
  # formula API cache → you get minimal/wrong formulae (e.g. ffmpeg without libass).
  # Clear that cache before installing to be safe.
  rm -rf "${HOME}/Library/Caches/Homebrew/api" 2>/dev/null || true
  warn "installing Homebrew (needs sudo once)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Put brew on PATH for the rest of this script (Apple Silicon prefix).
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  have brew || { err "brew still not on PATH — open a new terminal and re-run"; exit 1; }
  ok "installed ($(brew --version | head -1))"
fi

# If a past flaky bootstrap left a truncated formula cache, clearing the api cache
# here is cheap and idempotent — it heals a slim/wrong ffmpeg formula on re-run.
rm -rf "${HOME}/Library/Caches/Homebrew/api" 2>/dev/null || true

# ── 3. FFmpeg (MUST be ffmpeg-full, NOT ffmpeg) ───────────────────────────────
# CRITICAL: brew's plain `ffmpeg` formula is slimmed and built WITHOUT libass →
# the subtitles/ass filter is missing → echocut's subtitle burn-in fails with
# "No option name near ...ass..." / "ffmpeg exited with code 234".
# ffmpeg-full bundles libass + fontconfig + freetype + fribidi + harfbuzz.
step "[3/10] FFmpeg (ffmpeg-full — bundles libass for subtitle burn-in)"
ffmpeg_has_libass() { ffmpeg -version 2>/dev/null | grep -q -- '--enable-libass'; }
if have ffmpeg && ffmpeg_has_libass; then
  ok "ffmpeg with libass already on PATH"
else
  if brew list --formula 2>/dev/null | grep -qx 'ffmpeg'; then
    warn "plain 'ffmpeg' is installed (no libass) — removing it first"
    brew uninstall --ignore-dependencies ffmpeg || true
  fi
  if ! brew list --formula 2>/dev/null | grep -qx 'ffmpeg-full'; then
    warn "installing ffmpeg-full (large — pulls libass/fontconfig/freetype/fribidi/harfbuzz)…"
    brew install ffmpeg-full
  fi
  # ffmpeg-full is keg-only; force-link so `ffmpeg` resolves to it.
  brew link --force --overwrite ffmpeg-full || true
fi

# Verify libass + the subtitle/ass filters — warn loudly if missing.
if ffmpeg_has_libass; then
  ok "ffmpeg built with --enable-libass"
else
  err "ffmpeg has NO libass — subtitle burn-in will fail (code 234). Check 'brew link --force ffmpeg-full'."
fi
if ffmpeg -filters 2>/dev/null | grep -qE ' (subtitles|ass) '; then
  ok "subtitles/ass filters available"
else
  err "subtitles/ass filter NOT found — you likely still have the slim ffmpeg on PATH."
fi

# ── 4. Node.js (MUST be node@22 LTS, NOT latest) ──────────────────────────────
# CRITICAL: brew's default `node` is bleeding-edge (e.g. v26). The native dep
# better-sqlite3@12 has no prebuilt binary for it and fails to compile from source
# (NODE_MODULE_CONTEXT_AWARE / "make failed"). Use the LTS node@22.
step "[4/10] Node.js (node@22 LTS — better-sqlite3 has prebuilt binaries for it)"
node_is_22() { have node && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == "22" ]]; }
if node_is_22; then
  ok "node $(node --version) already active"
else
  if ! brew list --formula 2>/dev/null | grep -qx 'node@22'; then
    warn "installing node@22…"
    brew install node@22
  fi
  brew link --force node@22 || true
  if node_is_22; then
    ok "node $(node --version) linked"
  else
    warn "node@22 installed but the active node is '$(have node && node --version || echo none)' — open a new shell or fix PATH order"
  fi
fi

# ── 5. Ollama (OPTIONAL — local LLM for auto titles / caption fixes) ──────────
step "[5/10] Ollama (optional LLM)"
if have ollama; then
  ok "already installed ($(ollama --version 2>/dev/null | head -1))"
else
  warn "installing ollama (optional)…"
  brew install ollama || warn "ollama install failed — it's optional, continuing"
fi

# ── 6. Node dependencies ──────────────────────────────────────────────────────
# --omit=optional skips the heavy Remotion render path; the default pipeline is
# pure FFmpeg and echocut lazy-requires Remotion only if you opt into it.
step "[6/10] Node dependencies (npm install --omit=optional)"
if [[ "${USE_CN_MIRROR:-0}" == "1" ]]; then
  npm config set registry https://registry.npmmirror.com
  ok "npm registry → npmmirror.com"
fi
npm install --omit=optional
ok "node_modules ready"

# ── 7. Python venv + ASR ──────────────────────────────────────────────────────
# System python3 (3.9) is too old — use brew python@3.11.
step "[7/10] Python venv (python@3.11) + ASR engines"
if ! have python3.11; then
  warn "installing python@3.11…"
  brew install python@3.11
  brew link --force python@3.11 || true
fi
if [[ -x .venv/bin/python ]]; then
  ok ".venv already exists"
else
  python3.11 -m venv .venv
  ok "created .venv (python3.11)"
fi
.venv/bin/pip install --upgrade pip "${PIP_INDEX_ARGS[@]}"
# requirements.txt: whisperx, torch, mlx-whisper, funasr
.venv/bin/pip install "${PIP_INDEX_ARGS[@]}" -r requirements.txt
# Default, best-quality engine on Apple Silicon (word-level timestamps).
.venv/bin/pip install "${PIP_INDEX_ARGS[@]}" mlx-qwen3-asr
# funasr needs torch at runtime; it is NOT pulled in automatically.
.venv/bin/pip install "${PIP_INDEX_ARGS[@]}" torch torchaudio
ok "Python ASR stack installed (whisperx / mlx-whisper / funasr / mlx-qwen3-asr / torch)"

# ── 8. Fonts + .env + link the CLI ────────────────────────────────────────────
step "[8/10] Fonts + .env + npm link"
npm run fetch-fonts
ok "default CJK font ready (Noto Sans SC, OFL 1.1)"
if [[ -f .env ]]; then
  ok ".env already exists (left untouched)"
else
  cp .env.example .env
  ok "created .env from .env.example"
fi
npm link
ok "echocut command registered (global bin may live under ~/.npm-global/bin — keep it on PATH)"
if ! have echocut; then
  warn "'echocut' not on PATH yet — add your npm global bin to PATH, e.g.:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\"   # then open a new terminal"
fi

# ── 9. ASR model notes ────────────────────────────────────────────────────────
step "[9/10] ASR engines (Apple Silicon)"
echo "    Default engine: qwen3 (Qwen3-ASR-1.7B) — best Chinese accuracy + word-level timestamps."
echo "    The ~3.4GB model downloads from Hugging Face on first transcribe."
if [[ "${USE_CN_MIRROR:-0}" == "1" ]]; then
  ok "HF_ENDPOINT=${HF_ENDPOINT} set for this run — to make it permanent, uncomment HF_ENDPOINT in .env"
else
  echo "    In mainland China set HF_ENDPOINT=https://hf-mirror.com (uncomment it in .env)."
fi
echo "    Lightweight fallback: --engine funasr (model from ModelScope, fast in China, no proxy needed)."
echo "    Both engines shell out to ffmpeg, so ffmpeg-full must stay on PATH."
echo
echo "    Optional LLM model (auto titles / caption fixes), NOT required for burn:"
echo "      ollama pull qwen3.5:9b"
warn "    This pulls from an overseas registry and can be very slow in mainland China — skip it if you don't need auto titles (they fall back to the brand config)."

# ── 10. Self-check ────────────────────────────────────────────────────────────
step "[10/10] echocut doctor"
if have echocut; then
  echocut doctor || true
else
  ./bin/echocut.js doctor || true
fi

echo
echo "${BOLD}${GREEN}Setup complete.${RESET}"
echo "First run:  echocut burn /path/to/video.mp4 --cut-fillers"
echo "Output →    debug_outputs/video/<timestamp>/.../<name>_burn.mp4"
