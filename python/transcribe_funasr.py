import json
import os
import sys
import re
import subprocess
from funasr import AutoModel
from transcribe_common import read_initial_prompt

try:
    from funasr.utils.postprocess_utils import rich_transcription_postprocess
except Exception:
    rich_transcription_postprocess = None


def parse_model_candidates():
    explicit = str(os.getenv("FUNASR_MODEL", "")).strip()
    if explicit:
        return [x.strip() for x in explicit.split(",") if x.strip()]
    return ["paraformer-zh"]


def parse_device():
    raw = str(os.getenv("FUNASR_DEVICE", "")).strip().lower()
    if raw:
        return raw
    if sys.platform == "darwin":
        return "mps"
    return "cpu"


def clean_text(text):
    source = str(text or "")
    normalized = source.replace("< |", "<|").replace("| >", "|>").replace(" | ", "|")
    if rich_transcription_postprocess:
        try:
            normalized = rich_transcription_postprocess(normalized)
        except Exception:
            pass
    normalized = re.sub(r"<\|[^|>]+\|>", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def probe_audio_duration_sec(audio_path):
    ffprobe = os.getenv("FFPROBE_BIN", "ffprobe")
    try:
        out = subprocess.check_output([
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audio_path
        ], stderr=subprocess.STDOUT, text=True, timeout=12)
        value = float(str(out or "").strip())
        if value > 0:
            return value
    except Exception:
        pass
    return 0.0


def normalize_ts_value(raw):
    try:
        value = float(raw)
    except Exception:
        return None
    if value > 1000:
        return value / 1000.0
    return value


def parse_timestamp_pair(raw):
    if isinstance(raw, dict):
        start = normalize_ts_value(raw.get("start", raw.get("begin", raw.get("start_time", raw.get("start_ms")))))
        end = normalize_ts_value(raw.get("end", raw.get("finish", raw.get("end_time", raw.get("end_ms")))))
        if start is None or end is None:
            return None
        return start, max(start + 0.02, end)
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        if isinstance(raw[0], (list, tuple, dict)):
            first = parse_timestamp_pair(raw[0])
            last = parse_timestamp_pair(raw[-1])
            if first and last:
                return first[0], max(first[0] + 0.02, last[1])
        start = normalize_ts_value(raw[0])
        end = normalize_ts_value(raw[1])
        if start is None or end is None:
            return None
        return start, max(start + 0.02, end)
    return None


def split_sentences(text):
    source = str(text or "").strip()
    if not source:
        return []
    parts = re.split(r"(?<=[。！？!?；;])\s*", source)
    rows = [x.strip() for x in parts if x and x.strip()]
    if rows:
        return rows
    return [source]


def build_synthetic_words(full_text, audio_duration_sec):
    sentences = split_sentences(full_text)
    if not sentences:
        return []
    total_duration = max(1.5, float(audio_duration_sec or 0.0))
    lengths = [max(1, len(re.sub(r"\s+", "", sentence))) for sentence in sentences]
    total_len = max(1, sum(lengths))
    words = []
    cursor = 0.0
    for idx, sentence in enumerate(sentences):
        start = cursor
        ratio = lengths[idx] / total_len
        seg_duration = max(0.45, total_duration * ratio)
        end = min(total_duration, start + seg_duration)
        if end <= start:
            end = start + 0.45
        words.append({
            "word": sentence,
            "start": round(start, 3),
            "end": round(end, 3)
        })
        cursor = end
    if words:
        words[-1]["end"] = round(max(words[-1]["end"], total_duration), 3)
    return words


def build_words_from_result(result, full_text):
    words = []
    raw_timestamp = result.get("timestamp", [])
    raw_sentence_info = result.get("sentence_info", [])
    if isinstance(raw_sentence_info, list) and raw_sentence_info:
        for sent in raw_sentence_info:
            if not isinstance(sent, dict):
                continue
            sentence_text = clean_text(sent.get("text", ""))
            if not sentence_text:
                continue
            pair = parse_timestamp_pair(sent)
            if not pair:
                pair = parse_timestamp_pair(sent.get("timestamp"))
            if not pair:
                continue
            words.append({
                "word": sentence_text,
                "start": round(pair[0], 3),
                "end": round(pair[1], 3)
            })
    if words:
        return words
    if isinstance(raw_timestamp, list) and raw_timestamp:
        normalized_text = full_text.replace(" ", "")
        chars = list(normalized_text)
        for idx, ts in enumerate(raw_timestamp):
            if idx >= len(chars):
                break
            pair = parse_timestamp_pair(ts)
            if not pair:
                continue
            words.append({
                "word": chars[idx],
                "start": round(pair[0], 3),
                "end": round(pair[1], 3)
            })
    return words


def run_transcription(audio_path):
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    model_candidates = parse_model_candidates()
    device = parse_device()
    hotword = read_initial_prompt()
    hotword_text = ""
    if hotword:
        terms = re.split(r'[,，、;；\s]+', hotword)
        hotword_text = " ".join(t.strip() for t in terms if len(t.strip()) >= 2)

    result = None
    used_model = ""
    last_error = None

    for model_name in model_candidates:
        try:
            print(f"[transcribe_funasr] loading model={model_name}", file=sys.stderr)
            model = AutoModel(
                model=model_name,
                vad_model="fsmn-vad",
                punc_model="ct-punc",
                spk_model=None,
                device=device,
            )
            kwargs = {
                "input": audio_path,
                "batch_size_s": 300,
            }
            if hotword_text:
                kwargs["hotword"] = hotword_text
            res = model.generate(**kwargs)
            if res and len(res) > 0:
                result = res[0]
                used_model = model_name
                break
        except Exception as e:
            last_error = e
            print(f"[transcribe_funasr] model={model_name} error={e}", file=sys.stderr)

    if result is None:
        raise RuntimeError(str(last_error or "funasr transcribe failed"))

    full_text = clean_text(result.get("text", ""))
    words = build_words_from_result(result, full_text)
    if not words and full_text:
        duration_sec = probe_audio_duration_sec(audio_path)
        words = build_synthetic_words(full_text, duration_sec)

    print(
        f"[transcribe_funasr] model={used_model} device={device} words={len(words)} text_len={len(full_text)}",
        file=sys.stderr
    )

    return {
        "audio_path": os.path.abspath(audio_path),
        "language": "zh",
        "used_model": used_model,
        "words": words,
        "full_text": full_text
    }


def write_output_file(output_path, payload):
    abs_output = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(abs_output), exist_ok=True)
    temp_path = f"{abs_output}.tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(temp_path, abs_output)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python transcribe_funasr.py <path_to_audio> [output_json_path]", file=sys.stderr)
        sys.exit(1)
    try:
        payload = run_transcription(sys.argv[1])
        if len(sys.argv) >= 3:
            output_path = sys.argv[2]
            write_output_file(output_path, payload)
            print(output_path)
        else:
            print(json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
