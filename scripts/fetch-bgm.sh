#!/bin/bash
# Download the full ECHOCUT BGM pack (74 royalty-free background-music tracks, ~385MB).
# A curated starter set (01–08) already ships in the repo; this fetches the rest.
# Tracks are referenced by brand configs via bgm.defaultName (filename without .mp3).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/assets/bgm"
mkdir -p "$DIR"
URL="${ECHOCUT_BGM_URL:-https://github.com/BillLucky/echocut/releases/download/bgm-pack-v1/echocut-bgm-pack.zip}"
echo "Downloading the full ECHOCUT BGM pack (74 tracks, ~385MB)"
echo "  from: $URL"
echo "  into: $DIR"
TMP="$(mktemp -t echocut-bgm-XXXX).zip"
trap 'rm -f "$TMP"' EXIT
curl -fSL "$URL" -o "$TMP"
unzip -o "$TMP" -d "$DIR" >/dev/null
echo "Done. $(ls "$DIR"/*.mp3 2>/dev/null | wc -l | tr -d ' ') tracks ready in $DIR"
