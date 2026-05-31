'use strict';

/**
 * transcribeLong.js — 长音频分块转写 + 断点续跑
 *
 * 背景:qwen3(mlx_qwen3_asr)单进程跑 48 分钟音频要 ~18 分钟,此前被 transcriber.js
 * 写死的 15 分钟 execFile 超时 SIGTERM 杀掉(stderr 为空,2 次重试共 30 分钟全废)。
 *
 * 解法:把长音频按 ~CHUNK_SEC 切成多块(尽量切在静默处,不切断句子),逐块独立转写,
 * 每块结果落盘缓存到 .echo-cache/transcribe/<fingerprint>/。好处:
 *   1) 每块时长有界 → 每块超时有界,不会被一个大超时误杀
 *   2) 断点续跑:中途挂了重跑只补未完成的块,已转写的块秒级复用
 *   3) 进度可见:逐块打印 [chunk i/N]
 *   4) 孤儿安全:单块崩溃影响面小
 *
 * 拼接:每块 word 的 start/end 加上该块在原音频里的绝对偏移,full_text 按块序拼接。
 *
 * env:
 *   ZDE_TRANSCRIBE_CHUNK_SEC       每块目标时长秒,默认 600(10 分钟)
 *   ZDE_TRANSCRIBE_SILENCE_WINDOW  边界向静默处吸附的搜索半径秒,默认 30
 *   ZDE_TRANSCRIBE_LONG_THRESHOLD  超过多少秒才启用分块,默认 1500(25 分钟)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_CHUNK_SEC = Math.max(120, Number(process.env.ZDE_TRANSCRIBE_CHUNK_SEC) || 600);
const SILENCE_SNAP_WINDOW = Math.max(0, Number(process.env.ZDE_TRANSCRIBE_SILENCE_WINDOW) || 30);
const LONG_THRESHOLD_SEC = Math.max(0, Number(process.env.ZDE_TRANSCRIBE_LONG_THRESHOLD) || 1500);

function probeDurationSec(audioPath) {
    const res = spawnSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', audioPath
    ], { encoding: 'utf8' });
    const sec = Number(String(res.stdout || '').trim());
    return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

// 与 highlights 缓存同思路:mtime + size + 首 1MB sha256,7GB 文件也秒算,内容变即失效
function audioFingerprint(audioPath) {
    const st = fs.statSync(audioPath);
    const fd = fs.openSync(audioPath, 'r');
    try {
        const buf = Buffer.alloc(Math.min(1024 * 1024, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        const h = crypto.createHash('sha256');
        h.update(String(st.size));
        h.update(String(Math.floor(st.mtimeMs)));
        h.update(buf);
        return h.digest('hex').slice(0, 16);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * 跑 ffmpeg silencedetect,返回每段静默的中点时间(秒,升序)。
 * 中点最适合做切点 — 落在静默正中,左右都不会切断语音。
 * 失败(ffmpeg 报错/无静默)返回空数组,上层退化为硬切。
 */
function detectSilenceMidpoints(audioPath, opts = {}) {
    const noiseDb = String(opts.noiseDb || '-30dB');
    const minSilenceSec = Number(opts.minSilenceSec || 0.5);
    const res = spawnSync('ffmpeg', [
        '-hide_banner', '-nostats', '-i', audioPath,
        '-af', `silencedetect=noise=${noiseDb}:d=${minSilenceSec}`,
        '-f', 'null', '-'
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const text = `${res.stderr || ''}`;
    const mids = [];
    let pendingStart = null;
    for (const line of text.split(/\r?\n/)) {
        let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (m) { pendingStart = Number(m[1]); continue; }
        m = /silence_end:\s*(-?[\d.]+)/.exec(line);
        if (m && pendingStart != null) {
            const end = Number(m[1]);
            if (Number.isFinite(pendingStart) && Number.isFinite(end) && end > pendingStart) {
                mids.push((pendingStart + end) / 2);
            }
            pendingStart = null;
        }
    }
    return mids.sort((a, b) => a - b);
}

/**
 * 规划分块边界(纯函数,便于单测)。
 * 目标切点在 chunkSec、2*chunkSec ... 处,每个目标点向最近的静默中点吸附(限 snapWindow 内)。
 * @returns {{start:number,end:number}[]} 覆盖 [0, duration] 的有序不重叠块
 */
function planChunkBoundaries(durationSec, silenceMidpoints, chunkSec = DEFAULT_CHUNK_SEC, snapWindow = SILENCE_SNAP_WINDOW) {
    const dur = Number(durationSec) || 0;
    if (dur <= 0) return [];
    const chunk = Math.max(60, Number(chunkSec) || DEFAULT_CHUNK_SEC);
    if (dur <= chunk) return [{ start: 0, end: dur }];

    const sil = (Array.isArray(silenceMidpoints) ? silenceMidpoints : [])
        .filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

    const snap = (target) => {
        if (snapWindow <= 0 || !sil.length) return target;
        let best = target;
        let bestDist = snapWindow + 1;
        for (const s of sil) {
            const d = Math.abs(s - target);
            if (d <= snapWindow && d < bestDist) { best = s; bestDist = d; }
            if (s > target + snapWindow) break;
        }
        return best;
    };

    const cuts = [];
    let target = chunk;
    while (target < dur - 1) {
        let cut = snap(target);
        // 保证单调递增且与前一切点拉开至少 30s,避免静默吸附把两刀并到一起
        const prev = cuts.length ? cuts[cuts.length - 1] : 0;
        if (cut <= prev + 30) cut = target;
        if (cut >= dur - 1) break;
        cuts.push(cut);
        target = cut + chunk;
    }

    const boundaries = [0, ...cuts, dur];
    const out = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
        const start = boundaries[i];
        const end = boundaries[i + 1];
        if (end - start > 0.5) out.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
    }
    return out;
}

function extractChunk(audioPath, start, dur, outWav) {
    const res = spawnSync('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', String(start), '-t', String(dur),
        '-i', audioPath,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        outWav
    ], { encoding: 'utf8' });
    if (res.status !== 0 || !fs.existsSync(outWav)) {
        throw new Error(`[transcribeLong] 切块失败 start=${start} dur=${dur}: ${(res.stderr || '').slice(-200)}`);
    }
    return outWav;
}

/**
 * 长音频分块转写主入口。
 * @param {string} audioPath
 * @param {object} opts
 * @param {string} opts.pythonBin
 * @param {string} opts.scriptPath          单块转写脚本(transcribe_qwen3.py)
 * @param {object} [opts.env]
 * @param {number} [opts.chunkSec]
 * @param {function} [opts.onProgress]       (idx, total, info) => void
 * @returns {Promise<{words:Array,full_text:string,used_model:string,chunks:number,durationSec:number}>}
 */
async function transcribeLongAudio(audioPath, opts = {}) {
    const pythonBin = opts.pythonBin || 'python3';
    const scriptPath = opts.scriptPath;
    if (!scriptPath) throw new Error('[transcribeLong] 缺少 scriptPath');
    const env = opts.env || process.env;
    const chunkSec = Math.max(120, Number(opts.chunkSec) || DEFAULT_CHUNK_SEC);

    const durationSec = probeDurationSec(audioPath);
    if (!durationSec) throw new Error('[transcribeLong] 无法获取音频时长');

    const silence = detectSilenceMidpoints(audioPath);
    const plan = planChunkBoundaries(durationSec, silence, chunkSec, SILENCE_SNAP_WINDOW);
    const total = plan.length;

    const fp = audioFingerprint(audioPath);
    const cacheDir = path.resolve(process.cwd(), '.echo-cache', 'transcribe', fp);
    fs.mkdirSync(cacheDir, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zde_chunk_'));

    // 每块超时:块时长 / 1.5(保守 RTF 下界,实测 ~2.7x)+ 模型加载/抖动余量 120s
    const perChunkTimeoutMs = Math.max(180000, Math.round((chunkSec / 1.5) * 1000) + 120000);

    const allWords = [];
    const textParts = [];
    let usedModel = '';
    let reused = 0;

    try {
        for (let i = 0; i < total; i += 1) {
            const { start, end } = plan[i];
            const dur = end - start;
            const cacheFile = path.join(cacheDir, `c${String(i).padStart(2, '0')}_${Math.round(start)}-${Math.round(end)}.json`);

            let payload = null;
            if (fs.existsSync(cacheFile)) {
                try {
                    payload = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                    reused += 1;
                    if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, total, { cached: true, start, end });
                } catch (_) { payload = null; }
            }

            if (!payload) {
                if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, total, { cached: false, start, end });
                const chunkWav = path.join(workDir, `chunk_${i}.wav`);
                const chunkOut = path.join(workDir, `chunk_${i}.json`);
                extractChunk(audioPath, start, dur, chunkWav);
                await execFileAsync(pythonBin, [scriptPath, chunkWav, chunkOut], {
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: perChunkTimeoutMs,
                    env
                });
                if (!fs.existsSync(chunkOut)) throw new Error(`[transcribeLong] chunk ${i} 无产出`);
                payload = JSON.parse(fs.readFileSync(chunkOut, 'utf8'));
                // 原子落盘缓存,供下次断点续跑复用
                const tmp = `${cacheFile}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
                fs.renameSync(tmp, cacheFile);
                try { fs.unlinkSync(chunkWav); } catch (_) {}
                try { fs.unlinkSync(chunkOut); } catch (_) {}
            }

            // 拼接:word 时间戳加该块绝对偏移
            const words = Array.isArray(payload.words) ? payload.words : [];
            for (const w of words) {
                allWords.push({
                    word: w.word,
                    start: Number(w.start || 0) + start,
                    end: Number(w.end || 0) + start
                });
            }
            if (payload.full_text) textParts.push(String(payload.full_text));
            if (!usedModel && payload.used_model) usedModel = String(payload.used_model);
        }
    } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }

    return {
        words: allWords,
        full_text: textParts.join('').trim(),
        used_model: usedModel,
        chunks: total,
        reusedChunks: reused,
        durationSec
    };
}

module.exports = {
    transcribeLongAudio,
    planChunkBoundaries,
    detectSilenceMidpoints,
    probeDurationSec,
    audioFingerprint,
    DEFAULT_CHUNK_SEC,
    LONG_THRESHOLD_SEC
};
