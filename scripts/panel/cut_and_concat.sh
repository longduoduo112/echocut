#!/bin/bash
# 切 Bill 3 段 + 拼合 + 独立片段
# 用精确 seek + 重编码(不用 -c copy 避免关键帧对齐导致字幕漂移)
set -euo pipefail

SRC="${1:-/path/to/panel.mp4}"
WORK=/tmp/panel-work
OUT_DIR=$WORK/segments
mkdir -p $OUT_DIR

# 段时间戳(来自 bill_segments.json)
# seg-01-self-intro    01:58.22  08:45.02   406.8s
# seg-02-opc-leverage  18:03.80  22:02.19   238.4s
# seg-03-go-global     36:33.63  41:40.01   306.4s

cut_seg() {
  local id=$1
  local start=$2
  local end=$3
  local title=$4
  local duration=$(echo "$end - $start" | bc -l)
  echo "[cut] $id  ${start}s-${end}s  (${duration}s)  $title"
  # -ss 在 -i 前 = 输入 seek(快但不精确)
  # -ss 在 -i 后 + -accurate_seek = 输出 seek(慢但精确)
  # 用两段 seek:输入 seek 到 start-2s 粗定位,输出 seek 精确切到 start
  local pre_ss=$(echo "$start - 2" | bc -l)
  [ $(echo "$pre_ss < 0" | bc -l) -eq 1 ] && pre_ss=0
  local out_offset=$(echo "$start - $pre_ss" | bc -l)
  ffmpeg -y \
    -ss $pre_ss \
    -i "$SRC" \
    -ss $out_offset \
    -t $duration \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    -af "highpass=f=80,dynaudnorm=p=0.95:m=10,loudnorm=I=-16:TP=-1.5:LRA=11" \
    "$OUT_DIR/${id}.mp4" 2>&1 | tail -3
}

cut_seg "seg-01-self-intro"   118.22  525.02  "自我介绍 + 团队"
cut_seg "seg-02-opc-leverage" 1083.80 1322.19 "OPC 红利 = 杠杆"
cut_seg "seg-03-go-global"    2193.63 2500.01 "出海 / OPC 选市场"

echo ""
echo "=== 拼合成合集 ==="
CONCAT_LIST=$WORK/concat_list.txt
> $CONCAT_LIST
for s in seg-01-self-intro seg-02-opc-leverage seg-03-go-global; do
  echo "file '$OUT_DIR/$s.mp4'" >> $CONCAT_LIST
done
ffmpeg -y \
  -f concat -safe 0 -i $CONCAT_LIST \
  -c copy \
  $WORK/bill_compilation_raw.mp4 2>&1 | tail -3

echo ""
echo "=== 产物 ==="
ls -lah $OUT_DIR/ $WORK/bill_compilation_raw.mp4
echo ""
echo "=== 时长验证 ==="
for f in $OUT_DIR/seg-*.mp4 $WORK/bill_compilation_raw.mp4; do
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  printf "  %s  %ss\n" "$(basename $f)" "$dur"
done
