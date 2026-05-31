'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// .echo-cache/highlights/<hash-prefix-12>/ 目录结构:
//   meta.json          视频元信息 + 分析信息
//   transcript.json    完整转写(避免重跑 30s+ 的 MLX)
//   candidates.json    LLM 识别的候选片段
//   thumbnails/        (预留) 每 30s 一张关键帧
//   products/          每次 `make` 的产物

const SCHEMA_VERSION = 2;
const PROMPT_VERSION = 'v2.4-pause-sentence-sublimation';

// 视频唯一指纹:mtime + size + 首 1MB SHA256(快,不读整个 7GB 视频)
function computeVideoFingerprint(videoPath) {
    const stat = fs.statSync(videoPath);
    const fd = fs.openSync(videoPath, 'r');
    const buf = Buffer.alloc(Math.min(1024 * 1024, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const hash = crypto.createHash('sha256')
        .update(String(stat.size))
        .update(String(Math.floor(stat.mtimeMs)))
        .update(buf)
        .digest('hex');
    return hash.slice(0, 12);
}

function getCacheDir(videoPath, cwd = process.cwd()) {
    const hash = computeVideoFingerprint(videoPath);
    const dir = path.join(cwd, '.echo-cache', 'highlights', hash);
    return { hash, dir };
}

function readMeta(dir) {
    const p = path.join(dir, 'meta.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeMeta(dir, meta) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'meta.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, path.join(dir, 'meta.json'));
}

function readTranscript(dir) {
    const p = path.join(dir, 'transcript.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeTranscript(dir, transcript) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'transcript.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2));
    fs.renameSync(tmp, path.join(dir, 'transcript.json'));
}

function readCandidates(dir) {
    const p = path.join(dir, 'candidates.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeCandidates(dir, candidates) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'candidates.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(candidates, null, 2));
    fs.renameSync(tmp, path.join(dir, 'candidates.json'));
}

// 缓存是否新鲜可复用。失效条件:
//  - 视频指纹变化(mtime/size/首 1MB)
//  - schema 版本或 prompt 版本升级
//  - 缺 candidates.json
function isCacheFresh(videoPath, cacheDir) {
    const meta = readMeta(cacheDir);
    if (!meta) return false;
    if (meta.schema_version !== SCHEMA_VERSION) return false;
    if (meta.prompt_version !== PROMPT_VERSION) return false;
    if (!readCandidates(cacheDir)) return false;
    try {
        const fp = computeVideoFingerprint(videoPath);
        if (meta.video_hash !== fp) return false;
    } catch (_) { return false; }
    return true;
}

function getProductDir(cacheDir, segId) {
    return path.join(cacheDir, 'products', segId);
}

module.exports = {
    SCHEMA_VERSION,
    PROMPT_VERSION,
    computeVideoFingerprint,
    getCacheDir,
    readMeta,
    writeMeta,
    readTranscript,
    writeTranscript,
    readCandidates,
    writeCandidates,
    isCacheFresh,
    getProductDir
};
