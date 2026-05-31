#!/usr/bin/env python3
"""transcribe_qwen3.py — Qwen3-ASR(原生 MLX)适配脚本

接口与 transcribe_mlx.py 完全一致(供 transcriber.js 统一调度):
  argv[1] = 音频路径
  argv[2] = 输出 JSON 路径(可选;无则打印到 stdout)
  输出 payload: { words:[{word,start,end}], full_text, used_model }

为什么选 Qwen3-ASR 进 burn 管道:基准实测中文 CER 远低于 whisper-large-v3
(场景A 1.2% vs 6.5% / 场景B 2.6% vs 10.2%),且原生带词级时间戳(字幕烧录必需),
mlx-qwen3-asr CLI 自带 20min 分块,长视频不 OOM。

env:
  QWEN3_ASR_MODEL  覆盖模型(默认 Qwen/Qwen3-ASR-1.7B,可降 Qwen/Qwen3-ASR-0.6B)
"""
import sys
import os
import json
import glob
import signal
import tempfile
import subprocess


def _run_cli(cmd):
    """以独立进程组跑 mlx_qwen3_asr,确保父进程被 SIGTERM/SIGINT(Node execFile 超时)
    杀掉时,底层 CLI 子进程一起被杀,不留孤儿继续抢 GPU/MLX。

    背景:此前用 subprocess.run() 时,Node 超时只 SIGTERM 这个 python 父进程,
    mlx_qwen3_asr 子进程会被 init 收养继续跑,长视频场景下多个孤儿叠加抢资源。
    """
    # start_new_session=True → 子进程成为新进程组组长,可整组 kill
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )

    def _forward(signum, _frame):
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        # 退出码沿用被信号打断的语义
        sys.exit(128 + signum)

    prev_term = signal.signal(signal.SIGTERM, _forward)
    prev_int = signal.signal(signal.SIGINT, _forward)
    try:
        stdout, stderr = proc.communicate()
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
    return proc.returncode, stdout, stderr


def run(audio_path):
    model = os.getenv("QWEN3_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B").strip()
    tmpd = tempfile.mkdtemp(prefix="qwen3asr_")
    cmd = [
        sys.executable, "-m", "mlx_qwen3_asr", audio_path,
        "--model", model, "--language", "zh",
        "--output-dir", tmpd, "--output-format", "json",
        "--timestamps", "--no-progress", "--quiet",
    ]
    returncode, stdout, stderr = _run_cli(cmd)
    if returncode != 0:
        raise RuntimeError(
            f"mlx_qwen3_asr 退出码 {returncode}: "
            f"{(stderr or stdout or '')[-400:]}"
        )
    jfs = sorted(glob.glob(os.path.join(tmpd, "*.json")),
                 key=lambda p: os.path.getmtime(p))
    if not jfs:
        raise RuntimeError("mlx_qwen3_asr 未产出 JSON")
    d = json.load(open(jfs[-1], encoding="utf-8"))

    segs = d.get("segments") or []
    words = []
    for s in segs:
        if "start" in s and "end" in s and str(s.get("text", "")).strip():
            words.append({
                "word": str(s.get("text", "")).strip(),
                "start": float(s["start"]),
                "end": float(s["end"]),
            })
    full_text = (d.get("text") or "".join(s.get("text", "") for s in segs)).strip()
    if not full_text:
        full_text = "".join(w["word"] for w in words).strip()
    return {"words": words, "full_text": full_text, "used_model": model}


def write_output_file(output_path, payload):
    abs_out = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(abs_out), exist_ok=True)
    tmp = f"{abs_out}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, abs_out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python transcribe_qwen3.py <audio> [output_json]", file=sys.stderr)
        sys.exit(1)
    try:
        payload = run(sys.argv[1])
        if len(sys.argv) >= 3:
            write_output_file(sys.argv[2], payload)
            print(sys.argv[2])
        else:
            print(json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
