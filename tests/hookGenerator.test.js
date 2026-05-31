/**
 * hookGenerator 单元测试 - 钩子解析 + 相似度去重
 * 运行: node --test tests/hookGenerator.test.js
 *
 * 关键守护点:
 *   - parseHooks 切 `=== #N 风格名 ===` 块
 *   - 5 种风格映射(antithesis/provocative/identity/number/story)
 *   - similarity 字符级 Jaccard,> 0.7 视为重复
 *   - dedupeHooks 保留先来的
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseHooks,
    similarity,
    dedupeHooks,
    HOOK_STYLES
} = require('../src/services/hookGenerator');

// ─── HOOK_STYLES 结构 ──────────────────────────────────────────────────────

test('HOOK_STYLES: 5 种风格,每个有 key/name/rule', () => {
    assert.equal(HOOK_STYLES.length, 5);
    const keys = HOOK_STYLES.map((s) => s.key);
    assert.deepEqual(keys, ['antithesis', 'provocative', 'identity', 'number', 'story']);
    for (const s of HOOK_STYLES) {
        assert.ok(s.key);
        assert.ok(s.name);
        assert.ok(s.rule);
    }
});

// ─── parseHooks ────────────────────────────────────────────────────────────

test('parseHooks: 标准格式 5 块全解析', () => {
    const raw = `
=== #1 反常识 ===
别再 996 了,真正的复利在你的能量管理。

=== #2 挑衅式 ===
90% 的人到 35 岁就废了,你猜原因?

=== #3 自报家门 ===
我从打螺丝的工人变成 HK Summit 演讲嘉宾,只用了 3 年。

=== #4 数字悬念 ===
+200 用户,只做了 1 件事。

=== #5 故事开场 ===
那个深夜,我决定离开大厂。
`;
    const hooks = parseHooks(raw);
    assert.equal(hooks.length, 5);
    assert.equal(hooks[0].style, 'antithesis');
    assert.equal(hooks[0].idx, 1);
    assert.ok(hooks[0].text.includes('996'));
    assert.equal(hooks[1].style, 'provocative');
    assert.equal(hooks[4].style, 'story');
});

test('parseHooks: 只有部分块也能解析(LLM 输出不全)', () => {
    const raw = `
=== #1 反常识 ===
不是你不努力,是方法错了。

=== #3 自报家门 ===
从工厂到投资人。
`;
    const hooks = parseHooks(raw);
    assert.equal(hooks.length, 2);
    assert.equal(hooks[0].idx, 1);
    assert.equal(hooks[1].idx, 3);
    assert.equal(hooks[1].style, 'identity');
});

test('parseHooks: 块内多行只取第一段非空', () => {
    const raw = `
=== #1 反常识 ===

第一行才是钩子。
后面解释这是为啥用反常识写法...
`;
    const hooks = parseHooks(raw);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].text, '第一行才是钩子。');
});

test('parseHooks: 引号包裹被剥掉', () => {
    const raw = `
=== #1 反常识 ===
「不是你不行」
`;
    const hooks = parseHooks(raw);
    assert.equal(hooks[0].text, '不是你不行');
});

test('parseHooks: 空输入返回空数组', () => {
    assert.deepEqual(parseHooks(''), []);
    assert.deepEqual(parseHooks(null), []);
    assert.deepEqual(parseHooks(undefined), []);
});

test('parseHooks: 完全没分隔符返回空', () => {
    const raw = '随便写点啥都没用 === 反常识 === 没有 #N';
    const hooks = parseHooks(raw);
    assert.deepEqual(hooks, []);
});

test('parseHooks: 空 body 跳过(只剩标题没正文)', () => {
    const raw = `
=== #1 反常识 ===

=== #2 挑衅式 ===
真的钩子在这里
`;
    const hooks = parseHooks(raw);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].idx, 2);
});

// ─── similarity ───────────────────────────────────────────────────────────

test('similarity: 完全一致 = 1', () => {
    assert.equal(similarity('你好世界', '你好世界'), 1);
});

test('similarity: 完全不同 = 0', () => {
    assert.equal(similarity('abc', 'xyz'), 0);
});

test('similarity: 部分重叠 0-1 之间', () => {
    const s = similarity('你好世界', '你好朋友');
    assert.ok(s > 0 && s < 1, `应在 (0,1):${s}`);
});

test('similarity: 空字符串返回 0', () => {
    assert.equal(similarity('', 'abc'), 0);
    assert.equal(similarity('abc', ''), 0);
    assert.equal(similarity(null, 'abc'), 0);
});

test('similarity: 忽略空白', () => {
    assert.equal(similarity('a b c', 'abc'), 1);
});

// ─── dedupeHooks ───────────────────────────────────────────────────────────

test('dedupeHooks: 完全相同的 hook 只保留先来的', () => {
    const hooks = [
        { idx: 1, text: '你的人生需要复利' },
        { idx: 2, text: '你的人生需要复利' }, // 完全重复
        { idx: 3, text: '完全不一样的内容' }
    ];
    const out = dedupeHooks(hooks);
    assert.equal(out.length, 2);
    assert.equal(out[0].idx, 1);
    assert.equal(out[1].idx, 3);
});

test('dedupeHooks: similarity > 0.7 也算重复', () => {
    // sim('AAAAA', 'AAAAB') 字符集 {A} vs {A,B} → 1/2=0.5 (不算重)
    // 要做出 > 0.7 需要字符集高度重叠
    const hooks = [
        { idx: 1, text: '你好你好你好世界' },
        { idx: 2, text: '你好你好世界你好' }  // 同字符集,sim=1
    ];
    const out = dedupeHooks(hooks);
    assert.equal(out.length, 1, '同字符集应该被去重');
});

test('dedupeHooks: 自定义阈值生效', () => {
    const hooks = [
        { idx: 1, text: '你好' },
        { idx: 2, text: '你好啊' }
    ];
    // 默认 0.7 这俩接近重复(2/3)
    const lo = dedupeHooks(hooks, 0.4);
    const hi = dedupeHooks(hooks, 0.99);
    assert.ok(lo.length <= hi.length, '阈值越低,认为重复的越多');
});

test('dedupeHooks: 空数组返回空数组', () => {
    assert.deepEqual(dedupeHooks([]), []);
});
