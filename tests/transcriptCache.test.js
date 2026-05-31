/**
 * transcriptCache 单元测试(纯本地)
 * 验证转写跨运行缓存:save→load round-trip、engine/preview key 隔离、空结果不缓存、损坏返回 null。
 * 运行: node --test tests/transcriptCache.test.js
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sourceFingerprint, loadTranscriptCache, saveTranscriptCache } = require('../src/lib/transcriptCache');

const cacheDir = path.resolve(process.cwd(), '.echo-cache', 'transcript');
let preexisting = new Set();
let tmpSrc = '';

before(() => {
    // 记录测试前已存在的缓存文件,测试后只清理本测试新建的
    try { preexisting = new Set(fs.readdirSync(cacheDir)); } catch (_) { preexisting = new Set(); }
    tmpSrc = path.join(os.tmpdir(), `zde_tc_test_${process.pid}_${Date.now()}.bin`);
    fs.writeFileSync(tmpSrc, Buffer.from('fake-video-bytes-for-fingerprint-' + Math.random()));
});

after(() => {
    try { fs.unlinkSync(tmpSrc); } catch (_) {}
    try {
        for (const f of fs.readdirSync(cacheDir)) {
            if (!preexisting.has(f)) fs.unlinkSync(path.join(cacheDir, f));
        }
    } catch (_) {}
});

const sample = {
    words: [{ word: '你好', start: 0, end: 0.5 }, { word: '世界', start: 0.5, end: 1 }],
    payload: { words: [{ word: '你好', start: 0, end: 0.5 }] },
    fullText: '你好世界',
    usedEngine: 'qwen3',
    usedScript: 'transcribe_qwen3.py',
    usedModel: 'Qwen3-ASR-1.7B'
};

test('sourceFingerprint 稳定且对同文件一致', () => {
    const a = sourceFingerprint(tmpSrc);
    const b = sourceFingerprint(tmpSrc);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
});

test('save → load round-trip 命中', () => {
    assert.equal(saveTranscriptCache(tmpSrc, 'qwen3', 0, sample), true);
    const got = loadTranscriptCache(tmpSrc, 'qwen3', 0);
    assert.ok(got, '应命中');
    assert.equal(got.fromCache, true);
    assert.equal(got.words.length, 2);
    assert.equal(got.fullText, '你好世界');
    assert.equal(got.usedModel, 'Qwen3-ASR-1.7B');
    assert.equal(got.transcribeMs, 0);
});

test('engine 不同 → 未命中(key 隔离)', () => {
    saveTranscriptCache(tmpSrc, 'qwen3', 0, sample);
    assert.equal(loadTranscriptCache(tmpSrc, 'mlx', 0), null);
});

test('previewSeconds 不同 → 未命中(局部音频不串)', () => {
    saveTranscriptCache(tmpSrc, 'qwen3', 0, sample);
    assert.equal(loadTranscriptCache(tmpSrc, 'qwen3', 20), null);
});

test('空 words 不缓存', () => {
    const r = saveTranscriptCache(tmpSrc, 'emptytest', 0, { words: [], fullText: '' });
    assert.equal(r, false);
    assert.equal(loadTranscriptCache(tmpSrc, 'emptytest', 0), null);
});

test('源文件内容变化 → 指纹变化 → 旧缓存不串', () => {
    saveTranscriptCache(tmpSrc, 'qwen3', 0, sample);
    const before = sourceFingerprint(tmpSrc);
    fs.writeFileSync(tmpSrc, Buffer.from('different-content-' + Math.random()));
    const afterFp = sourceFingerprint(tmpSrc);
    assert.notEqual(before, afterFp);
    assert.equal(loadTranscriptCache(tmpSrc, 'qwen3', 0), null, '内容变了不应命中旧缓存');
});
