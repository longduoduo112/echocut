const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { transcribeAudio } = require('../services/transcriber');
const { getConfigValue, DEFAULT_CONFIGS } = require('../db/configRepo');
const { loadBrand } = require('../services/brandLoader');
const { getAvailableMemoryGB } = require('../lib/preflight');

// 超过此时长(秒)的音频在 auto 模式下自动降级到更省内存的引擎。
// 阈值跟着可用内存动态走 — 48GB Mac 没必要 10 分钟就开始降级。
// 显式指定 LONG_AUDIO_THRESHOLD_SEC env 一律覆盖。
function getLongAudioThresholdSec() {
    const explicit = Number(process.env.LONG_AUDIO_THRESHOLD_SEC);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    let avail = 0;
    try { avail = getAvailableMemoryGB(); } catch (_) {}
    if (avail >= 16) return 1800; // 大内存机器:auto 模式下 30min 内仍走 MLX
    if (avail >= 8) return 900;   // 中内存:15min
    return 600;                    // 保守:10min(原值)
}

function probeAudioDuration(filePath) {
    const result = spawnSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', filePath
    ], { encoding: 'utf8', timeout: 15000 });
    const dur = parseFloat(String(result.stdout || '').trim());
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

function resolvePythonBin() {
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
    const localVenvPython = path.join(process.cwd(), '.venv', 'bin', 'python');
    if (fs.existsSync(localVenvPython)) return localVenvPython;
    return 'python3';
}

function resolveEngineModel(envKey, configKey, fallback) {
    const envValue = String(process.env[envKey] || '').trim();
    if (envValue) return envValue;
    try {
        const configFallback = DEFAULT_CONFIGS[configKey] || fallback;
        const cfgValue = String(getConfigValue(configKey, configFallback) || '').trim();
        return cfgValue || fallback;
    } catch (_) {
        return fallback;
    }
}

function buildAsrDomainPrompt() {
    // 话题提示:CLI --headline/--subline 通过 env 注入,把已知主题告诉 Whisper
    // 远距离/噪音场景对专词识别帮助巨大(如 HK Summit 演讲 → "亚洲国际博览中心" 不再识别成"波兰")
    const headline = String(process.env.ZDE_ASR_HINT_HEADLINE || '').trim();
    const subline = String(process.env.ZDE_ASR_HINT_SUBLINE || '').trim();
    const hintBits = [headline, subline].filter(Boolean);
    const topicHint = hintBits.length ? ` 本段话题涉及:${hintBits.join('；')}。` : '';

    // 优先从当前 brand 读专词表(完整替换,不合并,避免多品牌互相污染)
    try {
        const brand = loadBrand();
        const brandKw = Array.isArray(brand?.asrDomainKeywords) ? brand.asrDomainKeywords : [];
        if (brandKw.length > 0) {
            const clean = brandKw.map((k) => String(k).trim()).filter(Boolean).join('、');
            return `以下是一段关于商业、技术、历史或人文的中文录音。可能涉及的专有名词：${clean}。${topicHint}`;
        }
    } catch (_) { /* fallthrough 到 DB */ }
    // Fallback: 读 DB 配置(兼容旧的 Telegram Bot 场景)
    try {
        const keywords = String(getConfigValue('asr_domain_keywords', '') || '').trim();
        if (!keywords && !topicHint) return '';
        const cleanKeywords = keywords
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
            .join('、');
        const kwPart = cleanKeywords ? `可能涉及的专有名词：${cleanKeywords}。` : '';
        return `以下是一段关于商业、技术、历史或人文的中文录音。${kwPart}${topicHint}`.trim();
    } catch (_) {
        return topicHint.trim();
    }
}

async function transcribeByEngine(audioFile, engine = 'auto') {
    const normalizedEngine = String(engine || '').trim().toLowerCase() || 'auto';
    // MiMo 没有词级时间戳(STTOutput 只给整段 segment),不能驱动字幕烧录的音画对齐。
    // 此前未集成时会静默 fallback 到 auto→whisper(最差引擎),用户以为在测 MiMo
    // 实际拿到 whisper-turbo 的错别字。改为明确报错指路,绝不静默降级到错引擎。
    if (normalizedEngine === 'mimo' || normalizedEngine === 'mimo-4bit' || normalizedEngine.startsWith('mimo')) {
        throw new Error(
            `引擎 "${normalizedEngine}" 不能用于视频字幕:MiMo 无词级时间戳,字幕会与声音对不上。\n`
            + `  · 视频字幕(burn/highlights):用 --engine qwen3(默认,中文最准 + 词级时间戳)\n`
            + `  · 纯文本转写(录音/文章):用 --engine funasr(无需词级时间戳的场景)\n`
            + `  详见 docs/ASR-ENGINES.md 选型结论`
        );
    }
    const profileMap = {
        whisperx: {
            transcribeEngine: 'whisperx',
            env: {}
        },
        whisperx_hq: {
            transcribeEngine: 'whisperx',
            env: {
                WHISPERX_MODEL: process.env.WHISPERX_HQ_MODEL || 'large-v3'
            }
        },
        mlx: {
            transcribeEngine: 'mlx',
            env: {
                MLX_WHISPER_MODEL: process.env.MLX_WHISPER_FAST_MODEL || process.env.MLX_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo'
            }
        },
        mlx_hq: {
            transcribeEngine: 'mlx',
            env: {
                // 逗号分隔，Python 脚本支持按序尝试：优先 large-v3，不可用则 fallback turbo
                MLX_WHISPER_MODEL: process.env.MLX_WHISPER_HQ_MODEL || 'mlx-community/whisper-large-v3,mlx-community/whisper-large-v3-turbo'
            }
        },
        // qwen3: Qwen3-ASR(原生 MLX)。2026-05 基准实测中文 CER 远低于 whisper-large-v3
        // (场景A 1.2% vs 6.5% / 场景B 2.6% vs 10.2%),原生带词级时间戳(字幕烧录必需)。
        // 详见 docs/ASR-ENGINES.md。严格不降级(理由同 mlx_hq:时间戳精度一致性)。
        qwen3: {
            transcribeEngine: 'qwen3',
            env: {
                QWEN3_ASR_MODEL: process.env.QWEN3_ASR_MODEL || 'Qwen/Qwen3-ASR-1.7B'
            }
        },
        funasr: {
            transcribeEngine: 'funasr',
            env: {
                FUNASR_MODEL: resolveEngineModel('FUNASR_MODEL', 'funasr_model', 'paraformer-zh')
            }
        },
        sensevoice: {
            transcribeEngine: 'funasr',
            env: {
                FUNASR_MODEL: resolveEngineModel('FUNASR_SENSEVOICE_MODEL', 'funasr_sensevoice_model', 'iic/SenseVoiceSmall')
            }
        },
        auto: {
            transcribeEngine: process.platform === 'darwin' ? 'mlx' : 'whisperx',
            env: process.platform === 'darwin'
                ? { MLX_WHISPER_MODEL: process.env.MLX_WHISPER_HQ_MODEL || 'mlx-community/whisper-large-v3,mlx-community/whisper-large-v3-turbo' }
                : {}
        }
    };
    let profile = profileMap[normalizedEngine] || profileMap.auto;

    // 长音频自动降级: MLX 全量加载内存, 超长视频容易 OOM
    // 只在 engine=auto 时降级。用户显式指定 mlx/mlx_hq 时严格遵守,
    // 因为 funasr 字幕时间戳精度差、会导致字幕与人声完全对不上。
    const isAutoEngine = normalizedEngine === 'auto';
    const longAudioThresholdSec = getLongAudioThresholdSec();
    if (profile.transcribeEngine === 'mlx' && isAutoEngine) {
        const durationSec = probeAudioDuration(audioFile);
        if (durationSec > longAudioThresholdSec) {
            console.warn(`[asr] audio=${Math.round(durationSec)}s > threshold=${longAudioThresholdSec}s, auto 模式降级 mlx→funasr 以防 OOM(显式指定 --engine mlx_hq 可绕过)`);
            profile = profileMap.funasr;
        }
    } else if (profile.transcribeEngine === 'mlx') {
        const durationSec = probeAudioDuration(audioFile);
        if (durationSec > longAudioThresholdSec) {
            console.warn(`[asr] audio=${Math.round(durationSec)}s > ${longAudioThresholdSec}s,engine=${normalizedEngine} 显式指定,不降级(内存吃紧,预计会慢)`);
        }
    }

    // 合并 DB 配置的专词提示到环境变量（Python 侧通过 ASR_DOMAIN_PROMPT 读取）
    const domainPrompt = buildAsrDomainPrompt();
    const envOverrides = domainPrompt
        ? { ...profile.env, ASR_DOMAIN_PROMPT: domainPrompt }
        : profile.env;

    return transcribeAudio(audioFile, {
        pythonBin: resolvePythonBin(),
        transcribeScriptPath: 'python/transcribe.py',
        transcribeMlxScriptPath: 'python/transcribe_mlx.py',
        transcribeFunasrScriptPath: 'python/transcribe_funasr.py',
        transcribeQwen3ScriptPath: 'python/transcribe_qwen3.py',
        transcribeEngine: profile.transcribeEngine,
        transcribeEnvOverrides: envOverrides,
        requestedEngine: normalizedEngine
    });
}

module.exports = { transcribeByEngine, resolvePythonBin, getLongAudioThresholdSec };
