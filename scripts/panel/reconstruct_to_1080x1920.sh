#!/bin/bash
# 把 4:3 960×720 重构图到 9:16 1080×1920(中央放视频,上下黑边)
# 4:3 scale 到 1080 宽 → 高 810,上下各 555 黑边补到 1920
# burn vertical preset 字幕预期落在底部黑边,标题落在顶部黑边
set -euo pipefail

WORK=/tmp/panel-work
SEG_DIR=$WORK/segments
RECON_DIR=$WORK/segments_1080x1920
mkdir -p $RECON_DIR

reconstruct() {
  local seg=$1
  local input=$SEG_DIR/${seg}.mp4
  local output=$RECON_DIR/${seg}.mp4
  echo "[reconstruct] $seg → 1080×1920"
  ffmpeg -y -i "$input" \
    -vf "scale=1080:-2:flags=lanczos,pad=1080:1920:0:(1920-ih)/2:black" \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
    -c:a copy \
    -movflags +faststart \
    "$output" 2>&1 | tail -2
}

for s in seg-01-self-intro seg-02-opc-leverage seg-03-go-global; do
  reconstruct $s
done

echo ""
echo "=== 拼合 1080×1920 合集 ==="
CONCAT_LIST=$WORK/concat_list_1080x1920.txt
> $CONCAT_LIST
for s in seg-01-self-intro seg-02-opc-leverage seg-03-go-global; do
  echo "file '$RECON_DIR/$s.mp4'" >> $CONCAT_LIST
done
ffmpeg -y -f concat -safe 0 -i $CONCAT_LIST -c copy \
  $WORK/bill_compilation_1080x1920.mp4 2>&1 | tail -2

echo ""
echo "=== 验证产物分辨率 ==="
for f in $RECON_DIR/seg-*.mp4 $WORK/bill_compilation_1080x1920.mp4; do
  W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$f")
  H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f")
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  SZ=$(ls -lah "$f" | awk '{print $5}')
  printf "  %-50s %sx%s  %.1fs  %s\n" "$(basename $f)" "$W" "$H" "$D" "$SZ"
done
