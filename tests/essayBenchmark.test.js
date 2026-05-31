/**
 * essayBenchmark 单元测试 — 纯函数 + 评分校验
 * 运行: node --test tests/essayBenchmark.test.js
 *
 * 关键守护点:
 *   - DIMENSIONS 10 个固定维度
 *   - extractScores 容错 fence/无 fence/trailing comma
 *   - validateScores 强制 Fidelity<5 → overall ≤30
 *   - 缺维度/分超界 / 非对象 都被 validateScores 抓住
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    DIMENSIONS,
    JUDGES,
    extractScores,
    validateScores
} = require('../src/services/essayBenchmark');

// ─── 常量结构 ─────────────────────────────────────────────────────────────

test('DIMENSIONS: 共 10 个维度', () => {
    assert.equal(DIMENSIONS.length, 10);
    assert.ok(DIMENSIONS.includes('fidelity'));
    assert.ok(DIMENSIONS.includes('anti_ai_slop'));
    assert.ok(DIMENSIONS.includes('shareability'));
});

test('JUDGES: minimax / ollama 两种', () => {
    assert.deepEqual(JUDGES, ['minimax', 'ollama']);
});

// ─── extractScores ────────────────────────────────────────────────────────

test('extractScores: 纯 JSON 直接 parse', () => {
    const out = extractScores('{"overall": 80, "verdict": "可发", "scores": {}}');
    assert.equal(out.overall, 80);
    assert.equal(out.verdict, '可发');
});

test('extractScores: ```json``` fence', () => {
    const raw = 'OK 这是评分:\n```json\n{"overall": 75}\n```';
    assert.equal(extractScores(raw).overall, 75);
});

test('extractScores: 无 fence 但被散文包裹', () => {
    const raw = '我的评分是: {"overall": 60} 谢谢';
    assert.equal(extractScores(raw).overall, 60);
});

test('extractScores: trailing comma 容错', () => {
    const out = extractScores('{"overall": 70, "scores": {},}');
    assert.equal(out.overall, 70);
});

test('extractScores: 行注释容错', () => {
    const raw = `{
      "overall": 65, // 这是总分
      "verdict": "需调整"
    }`;
    assert.equal(extractScores(raw).overall, 65);
});

test('extractScores: null/空 / 残缺 返回 null', () => {
    assert.equal(extractScores(null), null);
    assert.equal(extractScores(''), null);
    assert.equal(extractScores('{"overall":'), null);
});

// ─── validateScores ───────────────────────────────────────────────────────

function buildValid(overall = 80, fidelity = 9) {
    const scores = {};
    for (const dim of DIMENSIONS) {
        scores[dim] = { score: dim === 'fidelity' ? fidelity : 8, reason: 'r' };
    }
    return { overall, verdict: 'ok', scores };
}

test('validateScores: 完整有效结构通过', () => {
    const r = validateScores(buildValid());
    assert.equal(r.ok, true);
});

test('validateScores: 非对象 → not_object', () => {
    assert.equal(validateScores(null).error, 'not_object');
    assert.equal(validateScores('foo').error, 'not_object');
});

test('validateScores: 缺 overall → missing_overall', () => {
    const v = buildValid();
    delete v.overall;
    assert.equal(validateScores(v).error, 'missing_overall');
});

test('validateScores: 缺 scores → missing_scores', () => {
    const v = buildValid();
    delete v.scores;
    assert.equal(validateScores(v).error, 'missing_scores');
});

test('validateScores: 缺某维度 → missing_<dim>', () => {
    const v = buildValid();
    delete v.scores.hook;
    assert.equal(validateScores(v).error, 'missing_hook');
});

test('validateScores: 分数 < 0 或 > 10 → out_of_range', () => {
    const v = buildValid();
    v.scores.hook.score = -1;
    assert.equal(validateScores(v).error, 'out_of_range_hook');
    v.scores.hook.score = 11;
    assert.equal(validateScores(v).error, 'out_of_range_hook');
});

test('validateScores: Fidelity < 5 强制把 overall 压到 ≤30', () => {
    const v = buildValid(85, 3); // fidelity=3, overall=85
    const r = validateScores(v);
    assert.equal(r.ok, true);
    assert.equal(v.overall, 30, 'overall 应被强制压到 30');
    assert.ok(v.verdict.includes('fidelity<5'));
});

test('validateScores: Fidelity = 5 不触发强制', () => {
    const v = buildValid(90, 5);
    validateScores(v);
    assert.equal(v.overall, 90, 'fidelity=5 不压 overall');
});

test('validateScores: Fidelity < 5 但 overall 本来就低,保持低值不变', () => {
    const v = buildValid(20, 2);
    validateScores(v);
    assert.equal(v.overall, 20, 'overall 已经低于 30 时不应被改回 30');
});
