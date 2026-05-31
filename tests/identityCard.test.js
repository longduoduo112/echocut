/**
 * identityCard 单元测试
 * 关键守护点:
 *   - buildIdentityFilter 正确生成 drawbox + drawtext filter chain
 *   - position 选项正确映射
 *   - 单行 vs 双行 (无 title) 都正常
 *   - 缺 name / 非法 position 抛 error
 *   - 文字 escape(单引号 / 冒号)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildIdentityFilter,
    POSITION_PRESETS,
    DEFAULT_FONT_FILE,
} = require('../src/video/identityCard');

const fs = require('fs');

// ─── buildIdentityFilter ────────────────────────────────────────────────

test('buildIdentityFilter: 基本两行(name + title)', () => {
    const f = buildIdentityFilter({ name: '李标 Bill', title: 'echocut CEO' });
    assert.ok(f.includes('drawbox='), '应含 drawbox');
    // 两个 drawtext(name + title)
    const drawtextCount = (f.match(/drawtext=/g) || []).length;
    assert.equal(drawtextCount, 2);
    assert.ok(f.includes('李标 Bill'));
    assert.ok(f.includes('echocut CEO'));
});

test('buildIdentityFilter: 单行(无 title)只画 name', () => {
    const f = buildIdentityFilter({ name: '李标 Bill' });
    const drawtextCount = (f.match(/drawtext=/g) || []).length;
    assert.equal(drawtextCount, 1);
    assert.ok(f.includes('李标 Bill'));
});

test('buildIdentityFilter: 默认位置 bottom-left', () => {
    const f = buildIdentityFilter({ name: 'X' });
    // bottom-left: x=40, y=H-...-180
    assert.ok(f.includes('x=40'));
    assert.ok(f.includes('h-'));
});

test('buildIdentityFilter: position=top-right', () => {
    const f = buildIdentityFilter({ name: 'X', position: 'top-right' });
    assert.ok(f.includes('w-'));   // x 基于 W
    assert.ok(f.includes('y=80')); // top
});

test('buildIdentityFilter: position=bottom-right', () => {
    const f = buildIdentityFilter({ name: 'X', position: 'bottom-right' });
    assert.ok(f.includes('w-'));
    assert.ok(f.includes('h-'));
});

test('buildIdentityFilter: 自定义字号 / 颜色', () => {
    const f = buildIdentityFilter({
        name: 'X',
        title: 'Y',
        nameFontSize: 48,
        titleFontSize: 32,
        nameColor: '#00FF00',
        titleColor: '#FF0000',
    });
    assert.ok(f.includes('fontsize=48'));
    assert.ok(f.includes('fontsize=32'));
    assert.ok(f.includes('#00FF00'));
    assert.ok(f.includes('#FF0000'));
});

test('buildIdentityFilter: 文字含 单引号 → escape', () => {
    const f = buildIdentityFilter({ name: "Bill's name" });
    // 单引号被 \\' 转义
    assert.ok(f.includes("Bill\\'s name"));
});

test('buildIdentityFilter: 文字含 冒号 → escape', () => {
    const f = buildIdentityFilter({ name: 'Title: Hero' });
    assert.ok(f.includes('Title\\: Hero'));
});

// ─── 边界 ───────────────────────────────────────────────────────────────

test('buildIdentityFilter: 缺 name → throw', () => {
    assert.throws(() => buildIdentityFilter({}), /name required/);
    assert.throws(() => buildIdentityFilter({ name: '' }), /name required/);
    assert.throws(() => buildIdentityFilter({ name: '   ' }), /name required/);
    assert.throws(() => buildIdentityFilter({ name: null }), /name required/);
});

test('buildIdentityFilter: 非法 position → throw', () => {
    assert.throws(
        () => buildIdentityFilter({ name: 'X', position: 'middle-center' }),
        /unsupported position/
    );
});

test('buildIdentityFilter: 字体文件不存在 → throw', () => {
    assert.throws(
        () => buildIdentityFilter({ name: 'X', fontFile: '/no/such/font.ttf' }),
        /font file not exists/
    );
});

// ─── POSITION_PRESETS 完整性 ─────────────────────────────────────────────

test('POSITION_PRESETS: 4 个位置都有 x/y 表达式', () => {
    const expected = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
    for (const k of expected) {
        assert.ok(POSITION_PRESETS[k], `应有 ${k}`);
        assert.ok('x' in POSITION_PRESETS[k]);
        assert.ok('y' in POSITION_PRESETS[k]);
    }
});

// ─── DEFAULT_FONT_FILE(macOS PingFang 通常存在) ────────────────────────

test('DEFAULT_FONT_FILE: macOS 默认字体路径(允许不存在 — Linux/CI 跑这条 skip)', () => {
    assert.equal(typeof DEFAULT_FONT_FILE, 'string');
    assert.ok(DEFAULT_FONT_FILE.length > 0);
    // 实际是否存在不强制(CI 可能在 Linux 跑)
});
