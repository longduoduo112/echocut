/**
 * distributeGenerator 单元测试 - LLM 输出的 JSON 提取容错
 * 运行: node --test tests/distributeGenerator.test.js
 *
 * 关键守护点(LLM 输出五花八门,六平台分发命脉):
 *   - ```json ... ``` fence 块解析
 *   - 无 fence 时,从第一个 { 到最后一个 } 抓取
 *   - trailing comma 自动去掉
 *   - // 行注释 + /* * / 块注释 去掉
 *   - 失败返回 null,不抛
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractJson } = require('../src/services/distributeGenerator');

// ─── 基础 JSON 提取 ────────────────────────────────────────────────────────

test('extractJson: 干净 JSON 直接 parse', () => {
    const out = extractJson('{"a": 1, "b": "x"}');
    assert.deepEqual(out, { a: 1, b: 'x' });
});

test('extractJson: ```json``` fence 块', () => {
    const raw = '这是 LLM 的开场白\n```json\n{"platform": "douyin", "title": "测试"}\n```\n后面还有解释';
    const out = extractJson(raw);
    assert.deepEqual(out, { platform: 'douyin', title: '测试' });
});

test('extractJson: ``` (无语言标签) fence 也认', () => {
    const raw = '```\n{"a": 1}\n```';
    const out = extractJson(raw);
    assert.deepEqual(out, { a: 1 });
});

test('extractJson: 无 fence 但被前后散文包裹', () => {
    const raw = '好的,这是结果: {"a": 1, "b": 2} — 希望能用';
    const out = extractJson(raw);
    assert.deepEqual(out, { a: 1, b: 2 });
});

// ─── 容错:trailing comma ──────────────────────────────────────────────────

test('extractJson: 对象 trailing comma 容错', () => {
    const out = extractJson('{"a": 1, "b": 2,}');
    assert.deepEqual(out, { a: 1, b: 2 });
});

test('extractJson: 数组 trailing comma 容错', () => {
    const out = extractJson('{"tags": ["a", "b",]}');
    assert.deepEqual(out, { tags: ['a', 'b'] });
});

test('extractJson: 嵌套 trailing comma 都干掉', () => {
    const out = extractJson('{"outer": {"inner": [1, 2,],}, "last": 3,}');
    assert.deepEqual(out, { outer: { inner: [1, 2] }, last: 3 });
});

// ─── 容错:注释 ────────────────────────────────────────────────────────────

test('extractJson: // 行注释 干掉', () => {
    const raw = `{
        "a": 1, // 这是平台名
        "b": 2  // 这是标题
    }`;
    const out = extractJson(raw);
    assert.deepEqual(out, { a: 1, b: 2 });
});

test('extractJson: /* 块注释 */ 干掉', () => {
    const raw = `{
        "a": 1, /* 这是平台名 */
        "b": 2
    }`;
    const out = extractJson(raw);
    assert.deepEqual(out, { a: 1, b: 2 });
});

test('extractJson: 字符串内的 // 不能被误删(URL 保护)', () => {
    // 字符串里出现 http:// — 应保留(// 前缀是 ":")
    const raw = '{"url": "https://example.com/path"}';
    const out = extractJson(raw);
    assert.deepEqual(out, { url: 'https://example.com/path' });
});

// ─── 失败路径 ─────────────────────────────────────────────────────────────

test('extractJson: null/空字符串返回 null', () => {
    assert.equal(extractJson(null), null);
    assert.equal(extractJson(undefined), null);
    assert.equal(extractJson(''), null);
});

test('extractJson: 完全不是 JSON 的纯文本返回 null', () => {
    assert.equal(extractJson('hello world, no json here'), null);
});

test('extractJson: 残缺 JSON 返回 null(不抛)', () => {
    // 缺右括号 — sanitize 也救不回来
    const out = extractJson('{"a": 1, "b": ');
    assert.equal(out, null);
});

// ─── 复杂真实场景 ─────────────────────────────────────────────────────────

test('extractJson: 模拟 LLM 真实输出(fence + 注释 + trailing comma 全部)', () => {
    const raw = '```json\n{\n  "douyin": {\n    "titles": ["标题1", "标题2",],\n    // 这是描述\n    "description": "测试"\n  },\n}\n```';
    const out = extractJson(raw);
    assert.ok(out);
    assert.ok(out.douyin);
    assert.deepEqual(out.douyin.titles, ['标题1', '标题2']);
    assert.equal(out.douyin.description, '测试');
});

test('extractJson: fence 内有解释文字时抓 { 到 }', () => {
    const raw = '```json\n这是结果:\n{"a": 1}\n后面解释\n```';
    const out = extractJson(raw);
    assert.deepEqual(out, { a: 1 });
});
