'use strict';

/**
 * 视频素材理解 (Ingest)
 *
 * 流程:
 *   1. ffprobe 探测 clip (duration/width/height/orientation)
 *   2. ffmpeg 管道抽 N 帧(不落盘,直出 base64)
 *   3. minicpm vision 逐帧分析 → JSON {scene, subject, tags, ...}
 *   4. LLM 聚合多帧 → clip 整体 metadata
 *   5. 缓存(mtime + size 指纹)
 *
 * 对齐 daily-bot 里 openbmb/minicpm-o2.6 调用风格:
 *   ollama.chat({ model, messages: [{role, content, images: [base64]}] })
 *   但本项目用 axios 直调 /api/chat 保持一致
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_VISION_MODEL = process.env.ZDE_VISION_MODEL || 'openbmb/minicpm-o2.6:latest';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';

// ────────────────────────────── 1. 探测视频 ──────────────────────────────

function probeClip(videoPath) {
    try {
        const r = spawnSync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate,duration',
            '-show_entries', 'format=duration,size,bit_rate',
            '-of', 'json', videoPath
        ], { encoding: 'utf8', timeout: 10000 });
        if (r.status !== 0) return null;
        const info = JSON.parse(r.stdout || '{}');
        const s = (info.streams || [])[0] || {};
        const f = info.format || {};
        const width = Number(s.width) || 0;
        const height = Number(s.height) || 0;
        const duration = Number(f.duration) || Number(s.duration) || 0;
        const orientation = width > height ? 'landscape'
            : width < height ? 'portrait'
            : 'square';
        return {
            width, height, duration,
            orientation,
            size: Number(f.size) || 0,
            bitrate: Number(f.bit_rate) || 0
        };
    } catch (_) { return null; }
}

// ────────────────────────────── 2. 抽帧时机 ──────────────────────────────

/**
 * 根据时长决定抽几帧 + 在哪些时间点抽。
 * 策略:短 clip 密一点,长 clip 最多 10 帧避免爆 vision。
 */
function computeFrameTimestamps(duration, opts = {}) {
    const minFrames = opts.minFrames || 2;
    const maxFrames = opts.maxFrames || 10;
    // 默认每 30 秒 1 帧(短 clip 密一点)
    let count;
    if (duration <= 10) count = 2;
    else if (duration <= 30) count = 3;
    else if (duration <= 90) count = Math.max(3, Math.ceil(duration / 30));
    else count = Math.min(maxFrames, Math.ceil(duration / 60));
    count = Math.max(minFrames, Math.min(maxFrames, count));

    // 均匀分布,避开头 0.5s 和尾 0.5s(黑帧/抖动)
    const safeDur = Math.max(1, duration - 1.0);
    const timestamps = [];
    for (let i = 0; i < count; i += 1) {
        const t = 0.5 + (safeDur * i / Math.max(1, count - 1));
        timestamps.push(Number(t.toFixed(2)));
    }
    return timestamps;
}

// ────────────────────────────── 3. 抽帧(管道,不落盘)──────────────────────────────

/**
 * 用 ffmpeg pipe 抽一帧,不落盘,返回 base64 jpg。
 * scale 到 640 宽足够 vision 模型识别,不需要全分辨率。
 */
function extractFrameBase64(videoPath, timestamp, opts = {}) {
    const targetWidth = opts.width || 640;
    return new Promise((resolve, reject) => {
        const args = [
            '-ss', String(timestamp),
            '-i', videoPath,
            '-frames:v', '1',
            '-vf', `scale='min(${targetWidth},iw)':-2`,
            '-q:v', '3',
            '-f', 'image2',
            '-vcodec', 'mjpeg',
            '-'
        ];
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        const errChunks = [];
        proc.stdout.on('data', (c) => chunks.push(c));
        proc.stderr.on('data', (c) => errChunks.push(c));
        proc.on('close', (code) => {
            if (code !== 0 || !chunks.length) {
                return reject(new Error(`ffmpeg extract frame failed at ${timestamp}s: ${Buffer.concat(errChunks).toString().slice(-200)}`));
            }
            const buf = Buffer.concat(chunks);
            resolve(buf.toString('base64'));
        });
        proc.on('error', reject);
    });
}

// ────────────────────────────── 4. minicpm vision ──────────────────────────────

const FRAME_PROMPT = [
    '你是专业视频素材分析师。看这一帧(从一个视频里抽出来的),描述你看到的:',
    '- 地点/场景(如:海边栈桥 / 会议中心大厅 / 香港中环街道 / 酒店房间 / 演讲舞台 / 咖啡厅)',
    '- 主体(人物 / 风景 / 物品 / 文字海报)',
    '- 动作(静止 / 走动 / 演讲 / 聊天 / 拍摄)',
    '- 氛围(沉静 / 激动 / 忙碌 / 孤独 / 专注 / 热闹)',
    '- 主色调',
    '- 可见文字(招牌/PPT/路牌,有就抄个大概)',
    '',
    '输出 JSON(严格,不加 markdown fence):',
    '{',
    '  "scene": "地点/场景一句话",',
    '  "subject": "主体一句话",',
    '  "action": "正在发生什么",',
    '  "mood": "氛围",',
    '  "tags": ["5-8 个 2-4 字标签"],',
    '  "has_visible_text": true/false,',
    '  "visible_text": "若有,摘几个字;没有则空串",',
    '  "dominant_color": "主色调一词"',
    '}'
].join('\n');

async function analyzeFrame({ base64, model = DEFAULT_VISION_MODEL, ollamaUrl = DEFAULT_OLLAMA_URL, timeoutMs = 60000 }) {
    const resp = await axios.post(ollamaUrl, {
        model,
        messages: [{
            role: 'user',
            content: FRAME_PROMPT,
            images: [base64]
        }],
        stream: false,
        think: false
    }, { timeout: timeoutMs, proxy: false });
    const raw = String(resp?.data?.message?.content || '');
    return { raw, parsed: parseFrameJson(raw) };
}

function parseFrameJson(raw) {
    if (!raw) return null;
    // 先尝试 fence
    const fence = raw.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
    if (fence) {
        try { return JSON.parse(fence[1]); } catch (_) {}
    }
    // 找第一个 { 到最后 }
    const f = raw.indexOf('{');
    const l = raw.lastIndexOf('}');
    if (f >= 0 && l > f) {
        // 去 trailing comma
        let body = raw.slice(f, l + 1).replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(body); } catch (_) {}
    }
    return null;
}

// ────────────────────────────── 5. 多帧聚合 ──────────────────────────────

const AGGREGATE_PROMPT_PREFIX = [
    '你刚刚看了来自同一个视频 clip 的 N 张帧,每张帧都有独立描述。',
    '现在请综合这 N 张帧,判断整个 clip 的内容。',
    '',
    '输出 JSON:',
    '{',
    '  "description": "整个 clip 一句话描述(10-30 字,观众看了能懂)",',
    '  "scene": "主要地点(首帧地点为准,除非有明显移动)",',
    '  "action": "整个 clip 的核心动作",',
    '  "mood": "总氛围",',
    '  "tags": ["去重后 5-10 个标签"],',
    '  "has_visible_text": true/false,',
    '  "clip_type": "静态场景 / 动态场景 / 人物特写 / 对话 / 演讲 / 环境空镜 / 其他",',
    '  "content_suitable_for": ["可能用于哪些内容类型:如 开场 / 过场 / 主镜头 / 结尾"]',
    '}',
    '',
    '各帧描述如下:'
].join('\n');

async function aggregateFrames({ frameResults, model, ollamaUrl, timeoutMs = 60000 }) {
    const parsedList = frameResults.map((r, i) => {
        const p = r.parsed || {};
        return `[帧${i + 1}] scene=${p.scene || '?'} subject=${p.subject || '?'} action=${p.action || '?'} mood=${p.mood || '?'} tags=[${(p.tags || []).join('/')}]`;
    }).join('\n');

    const resp = await axios.post(ollamaUrl, {
        model,  // 聚合可以用文本模型,这里为了一致性仍用 minicpm(它也支持纯文本)
        messages: [{
            role: 'user',
            content: AGGREGATE_PROMPT_PREFIX + '\n' + parsedList
        }],
        stream: false,
        think: false
    }, { timeout: timeoutMs, proxy: false });
    const raw = String(resp?.data?.message?.content || '');
    const parsed = parseFrameJson(raw) || {};
    return { raw, parsed };
}

// ────────────────────────────── 6. 完整 ingest 一个 clip ──────────────────────────────

async function ingestClip(videoPath, opts = {}) {
    const {
        model = DEFAULT_VISION_MODEL,
        ollamaUrl = DEFAULT_OLLAMA_URL,
        frameTimeoutMs = 90000,
        onFrameDone = null,
        minFrames = 2,
        maxFrames = 10
    } = opts;

    const info = probeClip(videoPath);
    if (!info) throw new Error(`probeClip 失败: ${videoPath}`);
    const timestamps = computeFrameTimestamps(info.duration, { minFrames, maxFrames });

    // 逐帧抽取 + 分析(串行,避免 GPU 争抢)
    const frameResults = [];
    for (let i = 0; i < timestamps.length; i += 1) {
        const t = timestamps[i];
        const b64 = await extractFrameBase64(videoPath, t);
        const result = await analyzeFrame({ base64: b64, model, ollamaUrl, timeoutMs: frameTimeoutMs });
        frameResults.push({ timestamp: t, ...result });
        if (onFrameDone) onFrameDone({ index: i, total: timestamps.length, timestamp: t, parsed: result.parsed });
    }

    // 聚合
    const { parsed: aggregated, raw: aggregatedRaw } = await aggregateFrames({
        frameResults, model, ollamaUrl, timeoutMs: frameTimeoutMs
    });

    return {
        probe: info,
        frames: frameResults.map((r) => ({ timestamp: r.timestamp, ...(r.parsed || {}) })),
        summary: aggregated || { description: '(聚合失败)', tags: [] },
        aggregatedRaw
    };
}

// ────────────────────────────── 7. 缓存(指纹) ──────────────────────────────

function fingerprintFile(filePath) {
    try {
        const st = fs.statSync(filePath);
        return {
            mtimeMs: Math.floor(st.mtimeMs),
            size: st.size
        };
    } catch (_) { return null; }
}

function loadCache(cachePath) {
    if (!fs.existsSync(cachePath)) return { clips: {}, schemaVersion: 1 };
    try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (_) { return { clips: {}, schemaVersion: 1 }; }
}

function saveCache(cachePath, data) {
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, cachePath);
}

// ────────────────────────────── 8. 目录批量 ingest ──────────────────────────────

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.avi', '.webm', '.mkv'];

function listVideos(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => !f.startsWith('.') && !f.startsWith('_'))
        .filter((f) => VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
        .map((f) => path.join(dir, f))
        .sort();
}

async function ingestDirectory(dir, opts = {}) {
    const {
        model = DEFAULT_VISION_MODEL,
        ollamaUrl = DEFAULT_OLLAMA_URL,
        onClipStart = null,
        onClipDone = null,
        onFrameDone = null,
        rerun = false,  // true 则忽略缓存全部重跑
        limit = 0,      // 0 = 全部,否则只跑前 N 个
        minFrames = 2,
        maxFrames = 10
    } = opts;

    const videos = listVideos(dir);
    const useVideos = limit > 0 ? videos.slice(0, limit) : videos;
    const cachePath = path.join(dir, '_metadata.json');
    const cache = rerun ? { clips: {}, schemaVersion: 1 } : loadCache(cachePath);
    cache.clips = cache.clips || {};
    cache.schemaVersion = 1;
    cache.lastRun = new Date().toISOString();
    cache.model = model;

    let processed = 0;
    let cached = 0;
    let failed = 0;

    for (let i = 0; i < useVideos.length; i += 1) {
        const video = useVideos[i];
        const fname = path.basename(video);
        const fp = fingerprintFile(video);
        if (!fp) { console.warn(`[ingest] 跳过(探测失败): ${fname}`); failed += 1; continue; }

        const existing = cache.clips[fname];
        if (!rerun && existing && existing.fingerprint && existing.fingerprint.mtimeMs === fp.mtimeMs && existing.fingerprint.size === fp.size && existing.summary) {
            // cache hit
            if (onClipStart) onClipStart({ index: i, total: useVideos.length, fname, status: 'cache' });
            cached += 1;
            continue;
        }

        if (onClipStart) onClipStart({ index: i, total: useVideos.length, fname, status: 'processing' });
        try {
            const result = await ingestClip(video, {
                model, ollamaUrl, onFrameDone,
                minFrames, maxFrames
            });
            cache.clips[fname] = {
                fingerprint: fp,
                probe: result.probe,
                summary: result.summary,
                frames: result.frames,
                analyzedAt: new Date().toISOString()
            };
            saveCache(cachePath, cache);  // 每完成一个 clip 立即存,防中断丢数据
            processed += 1;
            if (onClipDone) onClipDone({ index: i, total: useVideos.length, fname, summary: result.summary });
        } catch (err) {
            console.warn(`[ingest] ${fname} 失败: ${String(err.message || err).slice(0, 200)}`);
            cache.clips[fname] = {
                fingerprint: fp,
                probe: probeClip(video),
                error: String(err.message || err),
                analyzedAt: new Date().toISOString()
            };
            saveCache(cachePath, cache);
            failed += 1;
            if (onClipDone) onClipDone({ index: i, total: useVideos.length, fname, error: err });
        }
    }

    return {
        cachePath,
        totalVideos: useVideos.length,
        processed,
        cached,
        failed,
        cache
    };
}

module.exports = {
    probeClip,
    computeFrameTimestamps,
    extractFrameBase64,
    analyzeFrame,
    aggregateFrames,
    ingestClip,
    ingestDirectory,
    listVideos,
    parseFrameJson,
    fingerprintFile,
    DEFAULT_VISION_MODEL
};
