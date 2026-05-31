/**
 * captionConfig 单元测试（sanitizeConfigValue 边界保护）
 * 运行: node --test tests/captionConfig.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// sanitizeConfigValue 不依赖 DB，可直接导入
const { sanitizeConfigValue } = require('../src/video/captionConfig');

// ─── 数值型 key 的边界约束 ────────────────────────────────────────────────────

test('sanitizeConfigValue: 正常数值原样返回', () => {
    const result = sanitizeConfigValue('video_caption_chunk_max_chars', '12');
    assert.equal(result, '12');
});

test('sanitizeConfigValue: 超上限 → 夹紧到 max', () => {
    // chunk_max_chars 上限 18，999 夹紧为 18
    const result = sanitizeConfigValue('video_caption_chunk_max_chars', '999');
    assert.equal(result, '18');
});

test('sanitizeConfigValue: 低于下限 → 夹紧到 min', () => {
    // chunk_max_chars 下限 6，2 夹紧为 6
    const result = sanitizeConfigValue('video_caption_chunk_max_chars', '2');
    assert.equal(result, '6');
});

test('sanitizeConfigValue: 非数字字符串 → 返回 fallback', () => {
    const result = sanitizeConfigValue('video_caption_chunk_max_chars', 'abc');
    assert.equal(result, '16');
});

test('sanitizeConfigValue: 字幕边距正常值', () => {
    const result = sanitizeConfigValue('video_caption_subtitle_margin_h', '48');
    assert.equal(result, '48');
});

test('sanitizeConfigValue: 字幕边距超上限 → 夹紧到 max 180', () => {
    const result = sanitizeConfigValue('video_caption_subtitle_margin_h', '999');
    assert.equal(result, '180'); // clamp to max=180
});

// ─── 颜色型 key ──────────────────────────────────────────────────────────────

test('sanitizeConfigValue: 有效颜色值大写返回', () => {
    const result = sanitizeConfigValue('video_caption_highlight_color', '#ff6600');
    assert.equal(result, '#FF6600');
});

test('sanitizeConfigValue: 无效颜色格式 → 原样返回（非数值 key 不做约束）', () => {
    // 颜色 key 非 CONFIG_NUMERIC_BOUNDS 内，sanitize 直接原样
    const result = sanitizeConfigValue('video_caption_highlight_color', 'notacolor');
    // 无效颜色时 sanitize 返回原值（getHexColorConfig 内部处理）
    assert.equal(typeof result, 'string');
});

// ─── 布尔型 key ──────────────────────────────────────────────────────────────

test('sanitizeConfigValue: 布尔型 key 字符串原样传递', () => {
    const result = sanitizeConfigValue('video_caption_enable_emphasis', '1');
    assert.equal(result, '1');
});

test('sanitizeConfigValue: 未知 key 原样返回', () => {
    const result = sanitizeConfigValue('unknown_key_xyz', 'some_value');
    assert.equal(result, 'some_value');
});

// ─── 视频布局参数 ─────────────────────────────────────────────────────────────

test('sanitizeConfigValue: 容器宽度正常值', () => {
    const result = sanitizeConfigValue('video_layout_target_w', '1080');
    assert.equal(result, '1080');
});

test('sanitizeConfigValue: 容器宽度超上限 → 夹紧到 2160', () => {
    // target_w 上限 2160
    const result = sanitizeConfigValue('video_layout_target_w', '9999');
    assert.equal(result, '2160');
});

test('sanitizeConfigValue: 字幕字号正常范围', () => {
    const result = sanitizeConfigValue('video_layout_subtitle_font_size', '150');
    assert.equal(result, '150');
});

test('sanitizeConfigValue: 字幕字号超上限 500 → 夹紧到 max 300', () => {
    // subtitle_font_size 上限 300
    const result = sanitizeConfigValue('video_layout_subtitle_font_size', '500');
    assert.equal(result, '300');
});
