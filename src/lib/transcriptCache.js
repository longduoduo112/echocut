'use strict';

/**
 * transcriptCache — 转写结果跨运行缓存
 *
 * 痛点("记忆问题"):同一条视频每次 burn 都重新转写(48min 要 ~17min),
 * 哪怕只是换比例/换样式/改封面重渲染。转写是音频的确定性函数,与样式无关 —— 可安全缓存。
 *
 * 设计:
 *   - 按【源视频指纹】(size + mtime + 首1MB sha256)做 key,源不变就命中,跨运行复用
 *   - key 含 engine + previewSeconds(不同引擎/预览长度结果不同)
 *   - 含 CACHE_VERSION,schema 升级自动失效
 *   - 原子写(tmp + rename),只缓存成功结果
 *   - 缓存目录 .echo-cache/transcript/(已 gitignore)
 *   - ZDE_FRESH=1 / --fresh 绕过
 *
 * 安全性:转写只依赖音频内容,不依赖字幕样式/比例/品牌,所以源指纹命中即可安全复用。
 * (字幕纠错/分段依赖样式,不在这里缓存 —— 那层用 --reuse-captions 显式控制。)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_VERSION = 'v1';

function cacheRoot() {
    return path.resolve(process.cwd(), '.echo-cache', 'transcript');
}

// 源视频指纹:size + mtime + 首 1MB sha256(7GB 文件也秒算,内容/替换即失效)
function sourceFingerprint(filePath) {
    const st = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(Math.min(1024 * 1024, st.size));
        if (buf.length) fs.readSync(fd, buf, 0, buf.length, 0);
        const h = crypto.createHash('sha256');
        h.update(String(st.size));
        h.update(String(Math.floor(st.mtimeMs)));
        h.update(buf);
        return h.digest('hex').slice(0, 16);
    } finally {
        fs.closeSync(fd);
    }
}

function keyFor(filePath, engine, previewSeconds) {
    const fp = sourceFingerprint(filePath);
    const eng = String(engine || 'auto').replace(/[^a-z0-9_]/gi, '');
    const prev = previewSeconds ? `p${Math.round(previewSeconds)}` : 'full';
    return `${fp}_${eng}_${prev}`;
}

function filePathFor(key) {
    return path.join(cacheRoot(), `${key}.json`);
}

/**
 * 读缓存。命中返回 transcribeResult 形状对象;未命中/损坏/版本不符返回 null。
 */
function loadTranscriptCache(filePath, engine, previewSeconds) {
    try {
        const cacheFile = filePathFor(keyFor(filePath, engine, previewSeconds));
        if (!fs.existsSync(cacheFile)) return null;
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (!data || data.version !== CACHE_VERSION) return null;
        if (!Array.isArray(data.words)) return null;
        return {
            words: data.words,
            payload: data.payload || { words: data.words },
            fullText: String(data.fullText || ''),
            transcribeMs: 0,
            stderr: '[transcript-cache] hit',
            usedEngine: data.usedEngine || engine,
            usedScript: data.usedScript || '',
            usedModel: data.usedModel || '',
            fromCache: true
        };
    } catch (_) {
        return null;
    }
}

/**
 * 写缓存(原子)。只在转写成功且有内容时写。
 */
function saveTranscriptCache(filePath, engine, previewSeconds, result) {
    try {
        if (!result || !Array.isArray(result.words) || result.words.length === 0) return false;
        const dir = cacheRoot();
        fs.mkdirSync(dir, { recursive: true });
        const cacheFile = filePathFor(keyFor(filePath, engine, previewSeconds));
        const payload = {
            version: CACHE_VERSION,
            engine,
            words: result.words,
            payload: result.payload || { words: result.words },
            fullText: String(result.fullText || ''),
            usedEngine: result.usedEngine || engine,
            usedScript: result.usedScript || '',
            usedModel: result.usedModel || ''
        };
        const tmp = `${cacheFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        fs.renameSync(tmp, cacheFile);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    sourceFingerprint,
    loadTranscriptCache,
    saveTranscriptCache,
    CACHE_VERSION
};
