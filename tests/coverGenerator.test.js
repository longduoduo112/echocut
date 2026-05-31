/**
 * coverGenerator 单元测试 - 字号自适应 + 转义 + 颜色解析
 * 运行: node --test tests/coverGenerator.test.js
 *
 * 关键守护点:
 *   - autoFitFontSize 中英混合宽度估算(中文 1.0x,英文 0.58x)
 *   - escapeDrawtext 转义 ffmpeg drawtext 特殊字符(\:'  %)
 *   - toFfmpegColor #RRGGBB → 0xRRGGBB,无效值回退默认
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { autoFitFontSize, escapeDrawtext, toFfmpegColor } = require('../src/video/coverGenerator');

// ─── autoFitFontSize ─────────────────────────────────────────────────────────

test('autoFitFontSize: 空字符串返回 maxFontSize', () => {
    assert.equal(autoFitFontSize('', 1000, 124), 124);
    assert.equal(autoFitFontSize(null, 1000, 124), 124);
});

test('autoFitFontSize: 短文本不需要缩,返回 maxFontSize', () => {
    // "你好" 2 个中文字符,maxWidth=1000,124px 足够装
    const fs = autoFitFontSize('你好', 1000, 124);
    assert.equal(fs, 124);
});

test('autoFitFontSize: 长中文文本超宽,字号下调', () => {
    // 20 个中文字符,124px 渲染宽度约 20*124*0.98 = 2430px,maxWidth=1000 装不下
    const text = '帮你高效创作自媒体并赚到第一桶金真的不容易';
    const fs = autoFitFontSize(text, 1000, 124);
    assert.ok(fs < 124, `应该被缩小,实际 ${fs}`);
    assert.ok(fs >= 28, `不能低于 minFontSize 28,实际 ${fs}`);
});

test('autoFitFontSize: 英文字符按 0.58 加权 — 同字数下英文字号更大', () => {
    // 字数相同(9 字符),英文加权 9*0.58=5.22,中文加权 9*1.0=9.0
    // → 同 maxWidth 下英文可以装更大字号
    const enFontSize = autoFitFontSize('abcdefghi', 600, 120);
    const zhFontSize = autoFitFontSize('你好世界测试通过哦', 600, 120);
    assert.ok(enFontSize > zhFontSize, `同字数英文 (${enFontSize}) 应大于中文 (${zhFontSize})`);
});

test('autoFitFontSize: 极窄 maxWidth 触发 minFontSize 兜底', () => {
    const fs = autoFitFontSize('非常长的中文标题字数比较多撑爆容器', 50, 124, 28);
    assert.equal(fs, 28, '应封底 28');
});

test('autoFitFontSize: 自定义 minFontSize 生效', () => {
    const fs = autoFitFontSize('非常长非常长非常长非常长非常长', 50, 124, 40);
    assert.equal(fs, 40);
});

test('autoFitFontSize: 不能超过 maxFontSize 上限', () => {
    // 单字 + 大空间,即使能撑更大也封顶 maxFontSize
    const fs = autoFitFontSize('A', 5000, 100);
    assert.equal(fs, 100);
});

// ─── escapeDrawtext ─────────────────────────────────────────────────────────

test('escapeDrawtext: 单引号转义', () => {
    assert.equal(escapeDrawtext("it's"), "it\\'s");
});

test('escapeDrawtext: 冒号转义', () => {
    assert.equal(escapeDrawtext('time: 12'), 'time\\: 12');
});

test('escapeDrawtext: 反斜杠先转义(避免双重处理)', () => {
    assert.equal(escapeDrawtext('a\\b'), 'a\\\\b');
});

test('escapeDrawtext: 百分号转义', () => {
    assert.equal(escapeDrawtext('50%'), '50\\%');
});

test('escapeDrawtext: 中文无需转义', () => {
    assert.equal(escapeDrawtext('你好世界'), '你好世界');
});

test('escapeDrawtext: null/undefined 返回空字符串', () => {
    assert.equal(escapeDrawtext(null), '');
    assert.equal(escapeDrawtext(undefined), '');
});

test('escapeDrawtext: 数字转字符串', () => {
    assert.equal(escapeDrawtext(123), '123');
});

// ─── toFfmpegColor ──────────────────────────────────────────────────────────

test('toFfmpegColor: #RRGGBB → 0xRRGGBB(大写)', () => {
    assert.equal(toFfmpegColor('#ffd54f'), '0xFFD54F');
    assert.equal(toFfmpegColor('#0B0F1A'), '0x0B0F1A');
});

test('toFfmpegColor: 不带 # 也认', () => {
    assert.equal(toFfmpegColor('ffd54f'), '0xFFD54F');
});

test('toFfmpegColor: 无效值用默认 fallback', () => {
    assert.equal(toFfmpegColor(''), '0x000000');
    assert.equal(toFfmpegColor(null), '0x000000');
    assert.equal(toFfmpegColor('not-a-color'), '0x000000');
    assert.equal(toFfmpegColor('#ZZZ'), '0x000000');
});

test('toFfmpegColor: 自定义 fallback 生效', () => {
    assert.equal(toFfmpegColor('', '0xFFFFFF'), '0xFFFFFF');
    assert.equal(toFfmpegColor('bad', '0xFF0000'), '0xFF0000');
});

test('toFfmpegColor: #RGB 短格式不支持,走 fallback', () => {
    // 当前实现只匹配 6 位,3 位短格式回退
    assert.equal(toFfmpegColor('#f0a'), '0x000000');
});
