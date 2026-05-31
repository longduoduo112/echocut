import os

DOMAIN_PROMPT = (
    "以下是一段关于商业、技术、历史或人文的中文录音。"
    "可能涉及的专有名词："
    "曾国藩、王阳明、三省吾身、知行合一、阳明心学、正心诚意、成人达己、"
    "毛选、矛盾论、实践论、道德经、资治通鉴、纳瓦尔宝典、反脆弱、系统之美、大败局、"
    "echocut科技、Example Studio、旷视、金山云、example、"
    "地理套利、供应链、跨境电商、SaaS、LTD、B2B、"
    "DeepSeek、Qwen、Gemini、Claude、GPT、Ollama、Remotion、Stripe、"
    "API、CLI、RAG、LLM、大模型、具身智能、多模态、"
    "主权个人、数字游民、反脆弱、增强回路、代偿机制、系统动力学、降维打击、"
    "清迈、曼谷、巴厘岛、耒阳、东莞、深圳、北京。"
)


def read_initial_prompt():
    return os.getenv("ASR_DOMAIN_PROMPT", DOMAIN_PROMPT)


def extract_words_and_text(segments):
    words = []
    for segment in segments:
        for word_info in segment.get("words", []):
            if "start" in word_info and "end" in word_info:
                words.append({
                    "word": str(word_info.get("word", "")).strip(),
                    "start": float(word_info["start"]),
                    "end": float(word_info["end"])
                })
    full_text = " ".join(
        (seg.get("text") or "").strip()
        for seg in segments
        if (seg.get("text") or "").strip()
    ).strip()
    if not full_text:
        full_text = " ".join(item.get("word", "") for item in words if item.get("word")).strip()
    return words, full_text

