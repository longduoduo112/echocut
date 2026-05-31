/**
 * pillarClassifier 单元测试 - 三支柱启发式分类
 * 运行: node --test tests/pillarClassifier.test.js
 *
 * 关键守护点:
 *   - hook_type → pillar 基础权重
 *   - 关键词指纹加成(MRR/数字 → A,主权/契约 → B,家人/旅途 → C)
 *   - rankPlatforms 按 pillar 排序六平台
 *   - 边界:空输入 / 未知 hook_type
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifySeg, rankPlatforms, PLATFORM_WEIGHTS, PILLAR_INFO } = require('../src/lib/pillarClassifier');

// ─── classifySeg ──────────────────────────────────────────────────────────

test('classifySeg: hook_type=故事 → C 真实生活', () => {
    const r = classifySeg({ hook_type: '故事', context_note: '我女儿出生那天' });
    assert.equal(r.pillar, 'C');
});

test('classifySeg: hook_type=地理见闻 → C', () => {
    const r = classifySeg({ hook_type: '地理见闻', context_note: '在新加坡街头喝椰浆' });
    assert.equal(r.pillar, 'C');
});

test('classifySeg: hook_type=实用 → A 硬核', () => {
    const r = classifySeg({ hook_type: '实用', context_note: '我们 API 部署在 49 节点上' });
    assert.equal(r.pillar, 'A');
});

test('classifySeg: hook_type=反常识 → B 思想', () => {
    const r = classifySeg({ hook_type: '反常识', context_note: '主权个人才是终极杠杆' });
    assert.equal(r.pillar, 'B');
});

test('classifySeg: hook_type=观点 → B', () => {
    const r = classifySeg({ hook_type: '观点' });
    assert.equal(r.pillar, 'B');
});

// ─── 关键词加成测试 ──────────────────────────────────────────────────────────

test('classifySeg: A 关键词命中(MRR/收入)能逆转默认', () => {
    // 提问默认 B>A,但 corpus 含 MRR 会把 A 拉到最高
    const r = classifySeg({
        hook_type: '提问',
        context_note: '我们 MRR 从 0 涨到 $5000 用了多久?'
    });
    assert.equal(r.pillar, 'A');
});

test('classifySeg: B 关键词命中(主权/契约/降维)拉到 B', () => {
    const r = classifySeg({
        hook_type: '提问',
        context_note: '降维打击的本质是什么?',
        tags: ['杠杆', '主权']
    });
    assert.equal(r.pillar, 'B');
});

test('classifySeg: C 关键词命中(家人/早餐)拉到 C', () => {
    const r = classifySeg({
        hook_type: '提问',
        context_note: '陪女儿吃早餐是最快乐的'
    });
    assert.equal(r.pillar, 'C');
});

test('classifySeg: 关键词在 title/tags 里也算', () => {
    const r1 = classifySeg({ hook_type: '观点', title: '我们的 ARR 突破 $10k' });
    assert.equal(r1.pillar, 'A');
    const r2 = classifySeg({ hook_type: '观点', tags: ['契约精神', '反脆弱'] });
    assert.equal(r2.pillar, 'B');
});

// ─── 边界 ─────────────────────────────────────────────────────────────────

test('classifySeg: null 输入安全 fallback', () => {
    const r = classifySeg(null);
    assert.equal(r.pillar, 'A');
    assert.ok(r.confidence >= 0);
    assert.ok(r.reason);
});

test('classifySeg: 空对象 → 均匀分布(默认 A)', () => {
    const r = classifySeg({});
    assert.equal(r.pillar, 'A');
});

test('classifySeg: 未知 hook_type → 均匀分布', () => {
    const r = classifySeg({ hook_type: '外星人' });
    // 三个 pillar 都是 0.33 左右,A 排第一(实现里的 tie-break)
    assert.ok(['A', 'B', 'C'].includes(r.pillar));
});

test('classifySeg: 返回字段齐全', () => {
    const r = classifySeg({ hook_type: '故事' });
    assert.ok('pillar' in r);
    assert.ok('confidence' in r);
    assert.ok('reason' in r);
    assert.ok(typeof r.confidence === 'number');
    assert.ok(typeof r.reason === 'string');
});

// ─── rankPlatforms ────────────────────────────────────────────────────────

test('rankPlatforms: pillar=B 时,抖音/快手/公众号 应排前(都偏 B)', () => {
    const ranked = rankPlatforms('B');
    const top3 = ranked.slice(0, 3).map((x) => x.platform);
    // douyin/kuaishou 都是 B=0.5,gzh 也是 B=0.5 — 前三应包含这些
    assert.ok(top3.includes('douyin') || top3.includes('kuaishou') || top3.includes('gzh'));
});

test('rankPlatforms: pillar=A 时 twitter 必排第一(weight 0.8 最高)', () => {
    const ranked = rankPlatforms('A');
    assert.equal(ranked[0].platform, 'twitter');
    assert.equal(ranked[0].weight, 0.8);
});

test('rankPlatforms: pillar=C 时 xhs 排前(weight 0.5)', () => {
    const ranked = rankPlatforms('C');
    assert.equal(ranked[0].platform, 'xhs');
});

test('rankPlatforms: 返回 6 个平台,降序排列', () => {
    const ranked = rankPlatforms('A');
    assert.equal(ranked.length, 6);
    for (let i = 1; i < ranked.length; i += 1) {
        assert.ok(ranked[i - 1].weight >= ranked[i].weight, '应降序');
    }
});

test('rankPlatforms: 未知 pillar 时 weight 全 0', () => {
    const ranked = rankPlatforms('X');
    for (const r of ranked) assert.equal(r.weight, 0);
});

// ─── 数据结构 ─────────────────────────────────────────────────────────────

test('PLATFORM_WEIGHTS: 每个平台 A+B+C 加起来 ≈ 1', () => {
    for (const [name, w] of Object.entries(PLATFORM_WEIGHTS)) {
        const sum = w.A + w.B + w.C;
        assert.ok(Math.abs(sum - 1) < 0.01, `${name} weights 加和应 ≈ 1: ${sum}`);
    }
});

test('PILLAR_INFO: 3 个支柱都有 name/short/emoji', () => {
    for (const k of ['A', 'B', 'C']) {
        assert.ok(PILLAR_INFO[k].name);
        assert.ok(PILLAR_INFO[k].short);
        assert.ok(PILLAR_INFO[k].emoji);
    }
});
