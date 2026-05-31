import json
import os
import sys
import mlx_whisper
from transcribe_common import read_initial_prompt, extract_words_and_text


def parse_model_candidates(profile):
    explicit = str(os.getenv("MLX_WHISPER_MODEL", "")).strip()
    if explicit:
        return [x.strip() for x in explicit.split(",") if x.strip()]
    if profile == "fast":
        return [
            "mlx-community/whisper-large-v3-turbo",
            "mlx-community/whisper-large-v3"
        ]
    return [
        "mlx-community/whisper-large-v3",
        "mlx-community/whisper-large-v3-turbo"
    ]


def run_transcription(audio_path, model_candidates):
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    initial_prompt = read_initial_prompt()
    language = os.getenv("ASR_LANGUAGE", "zh").strip() or None
    result = None
    used_model = ""
    last_error = None
    for model_name in model_candidates:
        try:
            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=model_name,
                language=language,
                word_timestamps=True,
                initial_prompt=initial_prompt,
                # Prevent hallucination cascades: don't feed previous chunk's output
                # back as conditioning — each audio chunk decoded independently.
                condition_on_previous_text=False,
                # Filter out highly-repetitive (likely hallucinated) segments.
                compression_ratio_threshold=2.4,
                # Skip near-silent segments that trigger phantom transcription.
                no_speech_threshold=0.6
            )
            used_model = model_name
            break
        except Exception as e:
            last_error = e
    if result is None:
        raise RuntimeError(str(last_error or "mlx transcribe failed"))

    words, full_text = extract_words_and_text(result.get("segments", []))

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
        print("Usage: python transcribe_mlx.py <path_to_audio> [output_json_path]", file=sys.stderr)
        sys.exit(1)
    try:
        profile = os.getenv("ASR_PROFILE", "").strip().lower()
        models = parse_model_candidates(profile)
        payload = run_transcription(sys.argv[1], models)
        if len(sys.argv) >= 3:
            output_path = sys.argv[2]
            write_output_file(output_path, payload)
            print(output_path)
        else:
            print(json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
