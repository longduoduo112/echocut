/**
 * articleQuality 单元测试 - AI 腔扫描
 * 运行: node --test tests/articleQuality.test.js
 *
 * 关键守护点:
 *   - scanArticle 命中 7 类 AI 腔 phrase
 *   - score 0-100,每命中 -5 分,封底 0
 *   - 空文本/null 不 crash 返回 score=100
 *   - hits 携带 category/name/phrase/count
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scanArticle, PATTERNS } = require('../src/lib/articleQuality');

// ─── 空输入边界 ──────────────────────────────────────────────────────────────

test('scanArticle: 空字符串 → score=100 hits=[]', () => {
    const r = scanArticle('');
    assert.equal(r.score, 100);
    assert.deepEqual(r.hits, []);
    assert.equal(r.totalHits, 0);
});

test('scanArticle: null/undefined → score=100', () => {
    assert.equal(scanArticle(null).score, 100);
    assert.equal(scanArticle(undefined).score, 100);
});

test('scanArticle: 干净文章 → score=100', () => {
    const text = '昨晚在新加坡吃了一碗椰浆饭,辣得我冒汗。这种小吃要趁热,不然椰香就散了。';
    const r = scanArticle(text);
    assert.equal(r.score, 100);
    assert.equal(r.totalHits, 0);
});

// ─── 7 类各击中一次 ─────────────────────────────────────────────────────────

test('scanArticle: 时代套话 击中', () => {
    const r = scanArticle('在这个瞬息万变的时代,我们要拥抱变化。');
    const hit = r.hits.find((h) => h.category === 'era');
    assert.ok(hit, '应该命中时代套话');
    assert.equal(hit.count, 1);
    assert.ok(r.score < 100);
});

test('scanArticle: 空话连接 击中', () => {
    const r = scanArticle('毋庸置疑,这是个好选择。综上所述,我们应该试试。');
    const filler = r.hits.find((h) => h.category === 'filler');
    assert.ok(filler);
    assert.ok(r.totalHits >= 2);
});

test('scanArticle: 虚词填充 击中', () => {
    const r = scanArticle('这件事确确实实是真真正正发生过的。');
    const stuff = r.hits.find((h) => h.category === 'stuffing');
    assert.ok(stuff);
});

test('scanArticle: 廉价升华 击中', () => {
    const r = scanArticle('这种做法值得我们深思,引人深思。');
    const hit = r.hits.find((h) => h.category === 'cheap_lift');
    assert.ok(hit);
});

test('scanArticle: 说教句式 击中', () => {
    const r = scanArticle('大家都要知道这一点。我们应该这样做,难道不是吗?');
    const hit = r.hits.find((h) => h.category === 'preaching');
    assert.ok(hit);
});

test('scanArticle: 小红书套路 击中', () => {
    const r = scanArticle('姐妹们!这个店真的绝绝子!太绝了 yyds!');
    const hit = r.hits.find((h) => h.category === 'xhs_cliche');
    assert.ok(hit);
    assert.ok(r.totalHits >= 3);
});

test('scanArticle: 夸赞套路 击中', () => {
    const r = scanArticle('这部作品堪称完美,无可挑剔,叹为观止。');
    const hit = r.hits.find((h) => h.category === 'praise_cliche');
    assert.ok(hit);
    assert.ok(r.totalHits >= 3);
});

// ─── 评分逻辑 ───────────────────────────────────────────────────────────────

test('scanArticle: 1 命中 → score=95', () => {
    const r = scanArticle('毋庸置疑这是好事');
    assert.equal(r.score, 95);
    assert.equal(r.totalHits, 1);
});

test('scanArticle: 20 命中 → score 封底 0', () => {
    const text = ('毋庸置疑 '.repeat(20));
    const r = scanArticle(text);
    assert.equal(r.score, 0, `${r.totalHits} 命中应该封底`);
});

test('scanArticle: count 反映同一短语多次出现', () => {
    const text = '毋庸置疑这第一次。毋庸置疑这第二次。毋庸置疑第三次。';
    const r = scanArticle(text);
    const hit = r.hits.find((h) => h.phrase === '毋庸置疑');
    assert.ok(hit);
    assert.equal(hit.count, 3);
});

// ─── 数据结构 ──────────────────────────────────────────────────────────────

test('PATTERNS: 共 7 类,每类至少一个正则', () => {
    assert.equal(PATTERNS.length, 7);
    for (const p of PATTERNS) {
        assert.ok(p.key, 'key 必填');
        assert.ok(p.name, 'name 必填');
        assert.ok(Array.isArray(p.regex) && p.regex.length > 0, `${p.name} 应该至少有一个正则`);
        for (const re of p.regex) {
            assert.ok(re.global, `${p.key} 正则必须带 g flag 以便 match 多次`);
        }
    }
});

test('scanArticle: hits 元素含 category/name/phrase/count 四个字段', () => {
    const r = scanArticle('毋庸置疑');
    assert.equal(r.hits.length, 1);
    const h = r.hits[0];
    assert.ok('category' in h);
    assert.ok('name' in h);
    assert.ok('phrase' in h);
    assert.ok('count' in h);
});

test('scanArticle: 综合长文混合命中,score 区分度合理', () => {
    const heavyAi = '在这个瞬息万变的时代,毋庸置疑值得我们深思,姐妹们绝绝子!';
    const lightAi = '我昨天去新加坡转了一圈,毋庸置疑那地方还行。';
    const clean = '昨天去新加坡转了一圈,挺好玩的。';
    assert.ok(scanArticle(clean).score > scanArticle(lightAi).score);
    assert.ok(scanArticle(lightAi).score > scanArticle(heavyAi).score);
});
