import os
import json
import sys
import warnings
import torch
os.environ.setdefault("PYANNOTE_AUDIO_BACKEND", "soundfile")
import whisperx
from transcribe_common import read_initial_prompt, extract_words_and_text

warnings.filterwarnings("ignore", message="torchcodec is not installed correctly*")
warnings.filterwarnings("ignore", category=UserWarning)

def get_total_memory_gb():
    meminfo_path = "/proc/meminfo"
    try:
        if os.path.exists(meminfo_path):
            with open(meminfo_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        parts = line.split()
                        if len(parts) >= 2:
                            kb = int(parts[1])
                            return kb / (1024 * 1024)
    except Exception:
        pass
    return None

def parse_whisperx_models(default_model):
    explicit = str(os.getenv("WHISPERX_MODEL", "")).strip()
    if explicit:
        return [x.strip() for x in explicit.split(",") if x.strip()]
    fallback_raw = str(os.getenv("WHISPERX_MODEL_FALLBACKS", "")).strip()
    fallback_models = [x.strip() for x in fallback_raw.split(",") if x.strip()]
    candidates = [default_model, *fallback_models]
    uniq = []
    for name in candidates:
        if name and name not in uniq:
            uniq.append(name)
    return uniq

def run_transcription(audio_path):
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    # WhisperX uses CTranslate2 which does NOT support MPS — skip to CPU on macOS
    if torch.cuda.is_available():
        device = "cuda"
        compute_type = "float16"
    else:
        device = "cpu"
        compute_type = "int8"

    total_memory_gb = get_total_memory_gb()
    forced_low_memory = str(os.getenv("WHISPERX_LOW_MEMORY", "")).strip().lower() in ("1", "true", "yes", "on")
    auto_low_memory = device == "cpu" and total_memory_gb is not None and total_memory_gb < 3
    low_memory_mode = forced_low_memory or auto_low_memory

    if device == "cuda":
        batch_size = int(os.getenv("WHISPERX_BATCH_SIZE", "16"))
    else:
        batch_size = int(os.getenv("WHISPERX_BATCH_SIZE", "1" if low_memory_mode else "4"))

    nltk_data_dir = os.getenv("NLTK_DATA", os.path.join(os.path.dirname(__file__), ".nltk_data"))
    os.environ["NLTK_DATA"] = nltk_data_dir
    os.makedirs(nltk_data_dir, exist_ok=True)

    default_model = "small" if low_memory_mode else "medium"
    model_candidates = parse_whisperx_models(default_model)
    disable_align = str(os.getenv("WHISPERX_DISABLE_ALIGN", "1" if low_memory_mode else "0")).strip().lower() in ("1", "true", "yes", "on")
    print(
        f"[transcribe] device={device} compute_type={compute_type} model={','.join(model_candidates)} low_memory={low_memory_mode} mem_gb={total_memory_gb}",
        file=sys.stderr
    )
    model = None
    used_model = ""
    last_model_error = None
    initial_prompt = read_initial_prompt()
    asr_options = {"initial_prompt": initial_prompt} if initial_prompt else {}
    for model_name in model_candidates:
        try:
            model = whisperx.load_model(model_name, device, compute_type=compute_type, asr_options=asr_options)
            used_model = model_name
            break
        except Exception as model_error:
            last_model_error = model_error
            if device == "cpu":
                continue
            try:
                print(f"[transcribe] fallback_cpu={model_error}", file=sys.stderr)
                model = whisperx.load_model(model_name, "cpu", compute_type="int8", asr_options=asr_options)
                device = "cpu"
                compute_type = "int8"
                used_model = model_name
                break
            except Exception as cpu_model_error:
                last_model_error = cpu_model_error
                continue
    if model is None:
        raise last_model_error if last_model_error else RuntimeError("whisperx load_model failed")
    language = os.getenv("ASR_LANGUAGE", "zh").strip() or None
    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=batch_size, language=language)
    words = []
    align_device = device if device == "cuda" else "cpu"

    if not disable_align:
        try:
            model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=align_device)
            aligned = whisperx.align(result["segments"], model_a, metadata, audio, align_device, return_char_alignments=False)
            for segment in aligned["segments"]:
                for word_info in segment.get("words", []):
                    if "start" in word_info:
                        words.append({
                            "word": word_info["word"],
                            "start": word_info["start"],
                            "end": word_info["end"]
                        })
        except Exception as align_error:
            if align_device != "cpu":
                try:
                    print(f"[transcribe] align_retry_cpu={align_error}", file=sys.stderr)
                    model_a, metadata = whisperx.load_align_model(language_code=result["language"], device="cpu")
                    aligned = whisperx.align(result["segments"], model_a, metadata, audio, "cpu", return_char_alignments=False)
                    for segment in aligned["segments"]:
                        for word_info in segment.get("words", []):
                            if "start" in word_info:
                                words.append({
                                    "word": word_info["word"],
                                    "start": word_info["start"],
                                    "end": word_info["end"]
                                })
                except Exception as cpu_align_error:
                    print(f"[transcribe] align_fallback={cpu_align_error}", file=sys.stderr)
    base_words, full_text = extract_words_and_text(result.get("segments", []))
    if not words:
        words = base_words
    return {
        "audio_path": os.path.abspath(audio_path),
        "language": result.get("language"),
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
        print("Usage: python transcribe.py <path_to_audio> [output_json_path]", file=sys.stderr)
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
