#!/usr/bin/env python3
"""run_mimo_asr.py — MiMo-V2.5-ASR (MLX) 单文件转写,输出 JSON 到 stdout

修复要点(2026-05-18):
  1. mlx-audio fork 的 model.generate 默认 max_tokens=256 → 长音频文本被截断在
     ~415 汉字。改为按音频时长动态放大 max_tokens。
  2. fork 不做长音频分块,整段编码进单 prompt,超长会爆 LLM 上下文。改为
     按 CHUNK_SEC 切窗逐块转写再拼接,生产可处理 1 小时录音/视频。

注意:MiMo STTOutput 只给整段 segment(无词级时间戳),适合纯文本转写;
      视频字幕烧录(需 word timestamp)仍走 qwen3/whisper。

用法: run_mimo_asr.py <audio> [model_dir] [tok_dir] [lang] [chunk_sec]
输出: {"text","engine":"mimo","model","elapsed_ms","chunks","audio_sec"}
"""
import sys
import json
import time

CHUNK_SEC_DEFAULT = 240          # 单块上限(秒),稳在 MiMo 上下文内
TOKENS_PER_SEC = 16              # 动态 max_tokens = chunk_sec * 此值(中文口播 ~6 字/s,留足余量)
MAX_TOKENS_CAP = 8192


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: run_mimo_asr.py <wav> [model_dir] [tok_dir] [lang] [chunk_sec]"}))
        sys.exit(2)
    wav = sys.argv[1]
    model_dir = sys.argv[2] if len(sys.argv) > 2 else "./models/MiMo-V2.5-ASR-MLX-8bit"
    tok_dir = sys.argv[3] if len(sys.argv) > 3 else "./models/MiMo-Audio-Tokenizer"
    lang = sys.argv[4] if len(sys.argv) > 4 else "zh"
    chunk_sec = int(sys.argv[5]) if len(sys.argv) > 5 else CHUNK_SEC_DEFAULT

    t0 = time.time()
    from mlx_audio.stt import load
    from mlx_audio.stt.utils import load_audio
    import mlx_audio.stt.models.mimo_v2_asr.asr as asr_mod

    sr = getattr(asr_mod, "AUDIO_SAMPLE_RATE", 24000)

    # 兼容不同 fork 版本的 load 签名
    model = None
    for kwargs in ({"tokenizer_path": tok_dir}, {"audio_tokenizer_path": tok_dir}, {}):
        try:
            model = load(model_dir, **kwargs)
            break
        except TypeError:
            continue
    if model is None:
        model = load(model_dir)

    audio = load_audio(wav, sr=sr)
    n = int(audio.shape[0])
    audio_sec = n / float(sr)
    win = int(chunk_sec * sr)

    parts = []
    nchunks = 0
    pos = 0
    while pos < n:
        seg = audio[pos:pos + win]
        seg_sec = int(seg.shape[0]) / float(sr)
        max_tokens = max(256, min(MAX_TOKENS_CAP, int(seg_sec * TOKENS_PER_SEC)))
        result = None
        for kwargs in ({"language": lang, "max_tokens": max_tokens},
                       {"lang": lang, "max_tokens": max_tokens},
                       {"max_tokens": max_tokens},
                       {"language": lang}):
            try:
                result = model.generate(seg, **kwargs)
                break
            except TypeError:
                continue
        if result is None:
            result = model.generate(seg)
        txt = getattr(result, "text", None)
        if txt is None and isinstance(result, dict):
            txt = result.get("text")
        parts.append((txt or "").strip())
        nchunks += 1
        pos += win

    full = "".join(parts).strip()
    print(json.dumps({
        "text": full,
        "engine": "mimo",
        "model": model_dir,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "chunks": nchunks,
        "audio_sec": round(audio_sec, 1),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
