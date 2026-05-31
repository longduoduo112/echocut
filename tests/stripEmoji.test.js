/**
 * stripEmoji 单元测试 —— 剥离 emoji 防 drawtext 豆腐块
 * 运行: node --test tests/stripEmoji.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripEmoji } = require('../src/lib/stripEmoji');

test('剥离常见 emoji(表情/符号/旗帜),收掉残留空格', () => {
    assert.equal(stripEmoji('🚀 从 0 到 1 上手 Claude Code'), '从 0 到 1 上手 Claude Code');
    assert.equal(stripEmoji('生产力实操 ✨'), '生产力实操');
    assert.equal(stripEmoji('AI 🚀 工具'), 'AI 工具');
    assert.equal(stripEmoji('✅ 已完成 ❤️'), '已完成');
    assert.equal(stripEmoji('🇨🇳 中国'), '中国');
});

test('剥离 ⭐ keycap ZWJ 组合等', () => {
    assert.equal(stripEmoji('⭐ 收藏'), '收藏');
    // keycap "1️⃣":基底数字 '1' 是正常字符保留,只剥 emoji 化组合符(FE0F+20E3),无豆腐块
    assert.equal(stripEmoji('1️⃣ 第一'), '1 第一');
    assert.equal(stripEmoji('👨‍💻 工程师'), '工程师'); // ZWJ 组合两个 emoji 都剥
});

test('保留箭头 → ↓ ↑(字体支持,标题/CTA 常用)', () => {
    assert.equal(stripEmoji('探索 → 规划 → 动手'), '探索 → 规划 → 动手');
    assert.equal(stripEmoji('↓ 点赞 · 关注 ↓'), '↓ 点赞 · 关注 ↓');
});

test('保留 CJK 文字 / 标点 / 技术符号 ⌘', () => {
    assert.equal(stripEmoji('「AI 军团进化论」· 共建知识库'), '「AI 军团进化论」· 共建知识库');
    assert.equal(stripEmoji('按 ⌘K 打开'), '按 ⌘K 打开');
    assert.equal(stripEmoji('正常中文标题不变'), '正常中文标题不变');
});

test('空 / 非字符串安全', () => {
    assert.equal(stripEmoji(''), '');
    assert.equal(stripEmoji(null), '');
    assert.equal(stripEmoji(undefined), '');
    assert.equal(stripEmoji(123), '');
});

test('纯 emoji → 空字符串', () => {
    assert.equal(stripEmoji('🚀✨❤️'), '');
});
