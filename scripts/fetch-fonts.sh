#!/bin/bash
# Download the default CJK font: Noto Sans SC (SIL OFL 1.1, freely redistributable).
# ECHOCUT burns subtitles/titles with FFmpeg drawtext, which needs a real font file.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/assets/fonts"
mkdir -p "$DIR"
BASE="https://github.com/google/fonts/raw/main/ofl/notosanssc"
echo "Downloading Noto Sans SC (OFL 1.1) -> $DIR ..."
curl -fSL "$BASE/NotoSansSC%5Bwght%5D.ttf" -o "$DIR/NotoSansSC-Regular.otf"
cp "$DIR/NotoSansSC-Regular.otf" "$DIR/NotoSansSC-Bold.otf"   # variable font; same file used for bold weight
curl -fsSL "$BASE/OFL.txt" -o "$DIR/OFL.txt" || echo "(OFL.txt download skipped; see https://openfontlicense.org)"
echo "Done. Fonts ready in $DIR"
