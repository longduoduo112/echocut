#!/usr/bin/env python3
"""画面识别 Bill 时间段 — 纯颜色统计版

Bill 的画面特征:白棒球帽(R logo) + 白T恤,跟其他嘉宾(灰T VANS / adidas白绿T / 主持人长发黑白条纹衫)差异显著。
策略:OpenCV Haar 找脸 → 脸上方颜色统计(找白帽) + 脸下方颜色统计(找白T) → 综合判分。

输出:JSON 数组 [{t: 秒, score: 0-1, label: bill|other|no_face, debug: ...}]
"""

import sys
import os
import json
import cv2
import numpy as np
import argparse


def detect_largest_face(frame_bgr, cascade):
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
    if len(faces) == 0:
        return None
    return max(faces, key=lambda f: f[2] * f[3])


def white_ratio(region_bgr, sat_max=120, val_min=140):
    """宽松白色:紫色舞台灯下白帽 S 可能升到 60-100,V 也可能掉到 140-180"""
    if region_bgr is None or region_bgr.size == 0:
        return 0.0
    hsv = cv2.cvtColor(region_bgr, cv2.COLOR_BGR2HSV)
    return float(((hsv[..., 1] < sat_max) & (hsv[..., 2] > val_min)).mean())


def gray_ratio(region_bgr):
    """灰色:低饱和度 + 中等亮度(VANS 灰T 嘉宾的特征)"""
    if region_bgr is None or region_bgr.size == 0:
        return 0.0
    hsv = cv2.cvtColor(region_bgr, cv2.COLOR_BGR2HSV)
    return float(((hsv[..., 1] < 50) & (hsv[..., 2] >= 80) & (hsv[..., 2] <= 160)).mean())


def analyze_frame(frame_bgr, cascade):
    face = detect_largest_face(frame_bgr, cascade)
    if face is None:
        return {"label": "no_face", "score": 0.0, "debug": {}}
    x, y, w, h = [int(v) for v in face]
    H, W = frame_bgr.shape[:2]
    # 帽子区域 = 头顶 + 额头(跨过脸上边界):y 从 [face_y - 0.4*h] 到 [face_y + 0.15*h]
    # 棒球帽压在额头,所以包含脸内 15% 高度是关键
    cap_y0 = max(0, y - int(h * 0.40))
    cap_y1 = min(H, y + int(h * 0.15))
    cap_x0 = max(0, x - w // 6)
    cap_x1 = min(W, x + w + w // 6)
    cap = frame_bgr[cap_y0:cap_y1, cap_x0:cap_x1]
    # T 恤区域:脸下方 0.5-1.8 倍脸高(避开脸下方的脖子)
    shirt_y0 = min(H, y + h + int(h * 0.3))
    shirt_y1 = min(H, shirt_y0 + int(h * 1.5))
    shirt_x0 = max(0, x - w // 3)
    shirt_x1 = min(W, x + w + w // 3)
    shirt = frame_bgr[shirt_y0:shirt_y1, shirt_x0:shirt_x1]
    cap_w = white_ratio(cap)
    shirt_w = white_ratio(shirt)
    shirt_g = gray_ratio(shirt)
    # Bill 综合分:帽子白(权重高)+ T恤白
    bill_score = 0.55 * cap_w + 0.45 * shirt_w
    debug = {
        "face_xywh": [x, y, w, h],
        "cap_xyxy": [cap_x0, cap_y0, cap_x1, cap_y1],
        "shirt_xyxy": [shirt_x0, shirt_y0, shirt_x1, shirt_y1],
        "cap_white": round(cap_w, 3),
        "shirt_white": round(shirt_w, 3),
        "shirt_gray": round(shirt_g, 3),
        "bill_score": round(bill_score, 3),
    }
    # 放宽阈值: bill_score>=0.22 即认为是 Bill(测试后再细调)
    if bill_score >= 0.22 and (cap_w >= 0.15 or shirt_w >= 0.15):
        return {"label": "bill", "score": bill_score, "debug": debug}
    return {"label": "other", "score": bill_score, "debug": debug}


def sample_frames(video_path, every_seconds, output_path, max_frames=None):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 17.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps
    step_frames = max(1, int(round(every_seconds * fps)))
    print(f"video: fps={fps:.2f} total_frames={total_frames} duration={duration:.1f}s "
          f"step={step_frames}frames ({every_seconds}s)", file=sys.stderr)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if cascade.empty():
        raise RuntimeError("haarcascade load failed")
    results = []
    frame_idx = 0
    seen = 0
    while True:
        if max_frames and seen >= max_frames:
            break
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            break
        t = frame_idx / fps
        out = analyze_frame(frame, cascade)
        out["t"] = round(t, 2)
        results.append(out)
        seen += 1
        if seen % 50 == 0:
            print(f"  {seen} frames analyzed t={t:.1f}s last_label={out['label']} "
                  f"score={out['score']:.2f}", file=sys.stderr)
        frame_idx += step_frames
    cap.release()
    # 写文件
    tmp = output_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "video": video_path,
            "fps": fps,
            "duration": duration,
            "every_seconds": every_seconds,
            "samples": results,
        }, f, ensure_ascii=False)
    os.replace(tmp, output_path)
    # 简单汇总
    bill_count = sum(1 for r in results if r["label"] == "bill")
    other_count = sum(1 for r in results if r["label"] == "other")
    no_face_count = sum(1 for r in results if r["label"] == "no_face")
    print(f"\n=== summary ===\n  total samples: {len(results)}\n"
          f"  bill: {bill_count} ({100*bill_count/max(1,len(results)):.1f}%)\n"
          f"  other: {other_count}\n"
          f"  no_face: {no_face_count}\n"
          f"  output: {output_path}", file=sys.stderr)
    return results


def sanity_check(image_paths, expected_labels):
    """用已知图片快速验证判别器"""
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    print("\n=== sanity check ===", file=sys.stderr)
    correct = 0
    for path, expected in zip(image_paths, expected_labels):
        if not os.path.exists(path):
            print(f"  SKIP {path} (missing)", file=sys.stderr)
            continue
        frame = cv2.imread(path)
        if frame is None:
            print(f"  ERR cannot read {path}", file=sys.stderr)
            continue
        out = analyze_frame(frame, cascade)
        ok = "✓" if out["label"] == expected else "✗"
        if out["label"] == expected:
            correct += 1
        print(f"  {ok} {os.path.basename(path)} expected={expected} got={out['label']} "
              f"score={out['score']:.2f} debug={out['debug']}", file=sys.stderr)
    return correct


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video")
    ap.add_argument("--out", default="/tmp/panel-work/face_samples.json")
    ap.add_argument("--every", type=float, default=5.0, help="采样间隔秒")
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--sanity", action="store_true", help="只跑 sanity check")
    args = ap.parse_args()

    if args.sanity:
        sanity_check(
            image_paths=[
                "/path/to/reference-face.png",
                "/tmp/panel-frames/frame_1200s.jpg",  # 已确认是 Bill(白帽白T)
                "/tmp/panel-frames/frame_600s.jpg",   # VANS灰T嘉宾
                "/tmp/panel-frames/frame_60s.jpg",    # 主持人(长发条纹衫)
                "/tmp/panel-frames/frame_1800s.jpg",  # adidas白绿T嘉宾
                "/tmp/panel-frames/frame_2400s.jpg",  # 玫瑰花灰T嘉宾
            ],
            expected_labels=["bill", "bill", "other", "other", "other", "other"],
        )
        return

    if not args.video:
        print("--video required (or use --sanity)", file=sys.stderr)
        sys.exit(2)
    sample_frames(args.video, args.every, args.out, args.max_frames)


if __name__ == "__main__":
    main()
