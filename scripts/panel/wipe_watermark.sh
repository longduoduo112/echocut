#!/bin/bash
# v3 优化:在 v2 burn 输出上用 drawbox 黑色覆盖顶部"2754人看过"直播水印
# v2 输出 1080×1920,水印在 Y ≈ 540-640 这一条(顶部黑边和 Bill 视频之间)
# 用 drawbox 用黑色 fill 这条,水印消失,看起来就是干净的标题区 → 视频
set -euo pipefail

INPUT=${1:?需要输入视频}
OUTPUT=${2:?需要输出视频}

if [ ! -f "$INPUT" ]; then echo "✗ 输入不存在 $INPUT"; exit 1; fi

# 水印位置经实测:
# - 原 960×720 中顶部黑条约 60 px(Y 0-60),写"NNNN人看过"
# - reconstruct 后 1080×1920,scale 1080/960=1.125,黑条变 ~67 px
# - 黑条在 1920 居中后位于 Y = (1920-810)/2 = 555 起,高 67 → Y 555-622
# - 留 10 px 边缘保险,drawbox Y=550 h=80
ffmpeg -y -i "$INPUT" \
  -vf "drawbox=x=0:y=540:w=1080:h=90:color=black@1.0:t=fill" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
  -c:a copy \
  -movflags +faststart \
  "$OUTPUT" 2>&1 | tail -2

echo "✓ 水印盖掉: $OUTPUT"
ffprobe -v error -show_entries stream=width,height -show_entries format=duration -of default=nw=1 "$OUTPUT"
