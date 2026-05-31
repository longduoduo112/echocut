# scripts/panel/ — 多人 panel / 圆桌对话视频处理工具

为 2026-05-24 凌晨剪 Bill 在"非凡大赏"《OPC 红利》圆桌 panel 视频开发的一套工具。
比 `echocut burn` 单口播流水线复杂一层,主要解决:**多人对话视频里如何精确定位"目标讲话人"的发言段并裁剪/合成**。

## 工具清单

### `face_detect_speaker.py` — 画面识别说话人

OpenCV Haar 找脸 + 服饰颜色统计判别。专为本期 Bill 调过(白棒球帽 R logo + 白 T 恤,紫色舞台灯环境)。

```bash
# sanity check(在已知图片上验证判别器)
.venv/bin/python scripts/panel/face_detect_speaker.py --sanity

# 全程采样(5s 粒度)
.venv/bin/python scripts/panel/face_detect_speaker.py \
  --video /path/to/video.mp4 \
  --every 5 \
  --out /tmp/face_samples.json
```

**当前局限**:
- 阈值硬编码为 Bill 特征(白帽+白 T),换其他人需调 `analyze_frame` 函数
- 主持人长发条纹衫 false positive 率约 15%(背景紫光偏白)
- 未来:用 reference image embedding 替代纯颜色策略(face_recognition / mediapipe)

### `reconstruct_to_1080x1920.sh` — 4:3 源重构图到 9:16 容器

burn 流水线不会自己重构图。如果源是 4:3(如本期 panel 直播 960×720),需要先 scale+pad 到 1080×1920,再喂 burn,标题才能落在顶部黑边,字幕才能落在底部黑边。

```bash
# 假设 /tmp/panel-work/segments/seg-*.mp4 是切好的 4:3 段
bash scripts/panel/reconstruct_to_1080x1920.sh
```

**filter**: `scale=1080:-2:flags=lanczos,pad=1080:1920:0:(1920-ih)/2:black`

### `wipe_watermark.sh` — 覆盖直播平台水印

直播录屏画面顶部常有"NNNN人看过 / 弹幕"等水印。重构图后这些水印仍在画面里。用 ffmpeg drawbox 黑色覆盖。

```bash
bash scripts/panel/wipe_watermark.sh input.mp4 output.mp4
```

**位置**: drawbox x=0 y=540 w=1080 h=90 color=black(适配 1080×1920 中央 810 高视频源,水印在 Y 540-630)

### `cut_and_concat.sh` — 精确切片 + 拼接

模板脚本,改时间戳即可。用精确 seek + 重编码(libx264 CRF 18 + AAC 192k + dynaudnorm + loudnorm)。
不用 `-c copy` 避免关键帧对齐导致字幕漂移。

## 完整 panel 视频流水线(参考 .echo-output/panel-2026-05-24/WORKLOG.md)

```
1. qwen3 ASR 全量转写 50min panel
   → transcript.json(词级时间戳)

2. 关键词扫描时间轴
   → 找主持人喊嘉宾名字的所有位置
   → name_events.json

3. 识别目标人发言段
   → 主持人喊"XX"+ 下一段嘉宾发言 = XX 的发言段
   → bill_segments.json

4. 精确切片 + 拼接(cut_and_concat.sh)
   → segments/*.mp4 + compilation_raw.mp4

5. 重构图 4:3 → 1080×1920(reconstruct_to_1080x1920.sh)
   → segments_1080x1920/*.mp4 + compilation_1080x1920.mp4

6. burn 流水线(每个文件)
   → debug_outputs/video/<ts>/qwen3_<name>/<name>_burn.mp4

7. 去水印 v3(wipe_watermark.sh)
   → final/0X-*.mp4

8. 拷贝衍生物(cover.jpg / publish.md / captions.srt)+ 修正字幕
   → final/0X-* 全套
```

## 未来 v0.12+ 迭代方向(参考根 WORKLOG)

- 把这些固化进 `echocut panel <video> --speaker bill` 一个命令
- 画面识别用 face embedding 替代颜色策略,支持任意 reference
- burn 流水线 auto-detect 4:3 时自动重构图(目前需要前置脚本)
- ASR brand.asrDomainKeywords 注入嘉宾真名(避免 "李彪 / We点AI / 拥抱秩序" 这类同音字误识)
- 双层布局(上视频+下海报)支持
