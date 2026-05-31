/**
 * asrNameSanitizer 单元测试
 * 运行: node --test tests/asrNameSanitizer.test.js
 *
 * 关键守护点:
 *   - 精确字符串替换(不模糊匹配,避免误改)
 *   - wrong 支持单字符串或数组
 *   - 空/null/无效输入不抛异常
 *   - 全局多次出现都替换
 *   - countHits 准确计数
 *   - brand 配置提取
 *
 * 实战场景:
 *   2026-05-24 Bill 在 OPC 红利 panel 现场,ASR 把以下名字识别错:
 *     李标 → 李彪 / Pan Hunt → Pan Hunt(对的,但需统一)
 *     WUI.AI → We点AI / 微点AI / 位点AI
 *     ORBOT → Oboat / OBO
 *     拥抱智序 → 拥抱秩序
 *     成慧 → 陈慧 / 陈辉
 *     张拼拼 → 张萍萍 / 拼拼 → 萍萍 / 平平
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeText,
    sanitizeCaptions,
    countHits,
    getBrandCorrections,
    getTechTermCorrections,
    isValidCorrection,
} = require('../src/lib/asrNameSanitizer');

// ─── 空 / 无效输入 ──────────────────────────────────────────────────────────

test('sanitizeText: 空字符串 → 空字符串', () => {
    assert.equal(sanitizeText('', [{ wrong: 'X', right: 'Y' }]), '');
});

test('sanitizeText: null 输入 → 空字符串', () => {
    assert.equal(sanitizeText(null, [{ wrong: 'X', right: 'Y' }]), '');
});

test('sanitizeText: undefined 输入 → 空字符串', () => {
    assert.equal(sanitizeText(undefined, []), '');
});

test('sanitizeText: 数字输入 → 空字符串(防意外)', () => {
    assert.equal(sanitizeText(123, [{ wrong: '1', right: 'A' }]), '');
});

test('sanitizeText: corrections 为 null → 原值返回', () => {
    assert.equal(sanitizeText('hello', null), 'hello');
});

test('sanitizeText: corrections 为空数组 → 原值返回', () => {
    assert.equal(sanitizeText('hello', []), 'hello');
});

// ─── 基本替换 ────────────────────────────────────────────────────────────

test('sanitizeText: 单 wrong 替换', () => {
    const out = sanitizeText('先从这个李彪开始', [{ wrong: '李彪', right: '李标 Bill' }]);
    assert.equal(out, '先从这个李标 Bill开始');
});

test('sanitizeText: wrong 数组(多个错别字都替换)', () => {
    const out = sanitizeText('我是 We点AI 的 微点AI 也是 位点AI', [
        { wrong: ['We点AI', '微点AI', '位点AI'], right: 'WUI.AI' }
    ]);
    assert.equal(out, '我是 WUI.AI 的 WUI.AI 也是 WUI.AI');
});

test('sanitizeText: 同一字符串出现多次都替换(全局)', () => {
    const out = sanitizeText('陈慧 是 陈慧 的 陈慧', [{ wrong: '陈慧', right: '成慧' }]);
    assert.equal(out, '成慧 是 成慧 的 成慧');
});

test('sanitizeText: 多条 correction 全部执行', () => {
    const out = sanitizeText(
        '李彪 是 PanHunt CEO,陈慧 是 Oboat 的',
        [
            { wrong: '李彪', right: '李标 Bill' },
            { wrong: '陈慧', right: '成慧' },
            { wrong: 'Oboat', right: 'ORBOT' },
        ]
    );
    assert.equal(out, '李标 Bill 是 PanHunt CEO,成慧 是 ORBOT 的');
});

// ─── 边界情况 ────────────────────────────────────────────────────────────

test('sanitizeText: wrong 跟 right 相同 → 不无意义自替换', () => {
    const out = sanitizeText('hello', [{ wrong: 'hello', right: 'hello' }]);
    assert.equal(out, 'hello');
});

test('sanitizeText: wrong 为空字符串 → 跳过', () => {
    const out = sanitizeText('hello', [{ wrong: '', right: 'X' }]);
    assert.equal(out, 'hello');
});

test('sanitizeText: wrong 数组里某些是空 → 跳过空,处理非空', () => {
    const out = sanitizeText('AB', [{ wrong: ['', 'A'], right: 'X' }]);
    assert.equal(out, 'XB');
});

test('sanitizeText: right 为空字符串 → 视为无效 correction 跳过', () => {
    const out = sanitizeText('hello', [{ wrong: 'hello', right: '' }]);
    assert.equal(out, 'hello');
});

test('sanitizeText: correction 不是 object → 跳过', () => {
    const out = sanitizeText('hello', [null, undefined, 'str', { wrong: 'h', right: 'H' }]);
    assert.equal(out, 'Hello');
});

test('sanitizeText: 替换顺序按 corrections 数组顺序(允许链式)', () => {
    // 先把 A 换成 B,再把 B 换成 C
    const out = sanitizeText('A B', [
        { wrong: 'A', right: 'B' },
        { wrong: 'B', right: 'C' },
    ]);
    // A → B,然后 'B B' → 'C C'
    assert.equal(out, 'C C');
});

// ─── 中文/英文/混合 ──────────────────────────────────────────────────────

test('sanitizeText: 纯中文替换', () => {
    assert.equal(
        sanitizeText('拥抱秩序的创始人', [{ wrong: '拥抱秩序', right: '拥抱智序' }]),
        '拥抱智序的创始人'
    );
});

test('sanitizeText: 英文公司名替换', () => {
    assert.equal(
        sanitizeText('Oboat 首席科学家', [{ wrong: 'Oboat', right: 'ORBOT' }]),
        'ORBOT 首席科学家'
    );
});

test('sanitizeText: 大小写敏感', () => {
    // 不应把 obo 当 OBO
    const out = sanitizeText('OBO 与 obo 不同', [{ wrong: 'OBO', right: 'ORBOT' }]);
    assert.equal(out, 'ORBOT 与 obo 不同');
});

// ─── caption 数组 ────────────────────────────────────────────────────────

test('sanitizeCaptions: 数组里每段 .text 字段都过校正', () => {
    const caps = [
        { text: '李彪你好', start: 0, end: 1 },
        { text: '陈慧再见', start: 1, end: 2 },
    ];
    const out = sanitizeCaptions(caps, [
        { wrong: '李彪', right: '李标 Bill' },
        { wrong: '陈慧', right: '成慧' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, '李标 Bill你好');
    assert.equal(out[1].text, '成慧再见');
    // 不修改入参
    assert.equal(caps[0].text, '李彪你好');
});

test('sanitizeCaptions: 支持 .word 字段(qwen3 segment 格式)', () => {
    const segs = [
        { word: '李彪', start: 0, end: 0.5 },
        { word: '说话', start: 0.5, end: 1.0 },
    ];
    const out = sanitizeCaptions(segs, [{ wrong: '李彪', right: '李标' }]);
    assert.equal(out[0].word, '李标');
    assert.equal(out[1].word, '说话');
});

test('sanitizeCaptions: 非数组 → 空数组', () => {
    assert.deepEqual(sanitizeCaptions(null, []), []);
    assert.deepEqual(sanitizeCaptions('not array', []), []);
});

test('sanitizeCaptions: 数组里有 null/非对象项 → 保留', () => {
    const caps = [{ text: '李彪' }, null, 'string'];
    const out = sanitizeCaptions(caps, [{ wrong: '李彪', right: '李标' }]);
    assert.equal(out[0].text, '李标');
    assert.equal(out[1], null);
    assert.equal(out[2], 'string');
});

test('sanitizeCaptions: 空 corrections → 返回浅复制', () => {
    const caps = [{ text: 'a' }];
    const out = sanitizeCaptions(caps, []);
    assert.deepEqual(out, caps);
    assert.notEqual(out, caps);  // 不同对象引用(slice 后)
});

// ─── countHits ──────────────────────────────────────────────────────────

test('countHits: 命中数准确', () => {
    const r = countHits('李彪 是 李彪 的朋友 李彪', [
        { wrong: '李彪', right: '李标' },
    ]);
    assert.equal(r.totalHits, 3);
    assert.equal(r.perCorrection.length, 1);
    assert.equal(r.perCorrection[0].hits, 3);
});

test('countHits: 多个 correction 分别统计', () => {
    const r = countHits('李彪 与 陈慧 一起', [
        { wrong: '李彪', right: '李标' },
        { wrong: '陈慧', right: '成慧' },
        { wrong: '不存在', right: 'X' },
    ]);
    assert.equal(r.totalHits, 2);
    assert.equal(r.perCorrection.length, 2);
});

test('countHits: 不命中 perCorrection 不出现', () => {
    const r = countHits('hello', [{ wrong: 'X', right: 'Y' }]);
    assert.equal(r.totalHits, 0);
    assert.deepEqual(r.perCorrection, []);
});

test('countHits: 空文本/空 corrections → 0', () => {
    assert.equal(countHits('', [{ wrong: 'a', right: 'b' }]).totalHits, 0);
    assert.equal(countHits('hello', null).totalHits, 0);
    assert.equal(countHits(null, []).totalHits, 0);
});

// ─── brand 配置提取 ─────────────────────────────────────────────────────

test('getBrandCorrections: brand 没配 → 空数组', () => {
    assert.deepEqual(getBrandCorrections({}), []);
    assert.deepEqual(getBrandCorrections(null), []);
    assert.deepEqual(getBrandCorrections({ asrNameCorrections: 'not array' }), []);
});

test('getBrandCorrections: 正常提取', () => {
    const brand = {
        asrNameCorrections: [
            { wrong: '李彪', right: '李标' },
            { wrong: 'X', right: 'Y' },
        ]
    };
    const out = getBrandCorrections(brand);
    assert.equal(out.length, 2);
    assert.equal(out[0].right, '李标');
});

test('getBrandCorrections: 过滤无效项', () => {
    const brand = {
        asrNameCorrections: [
            { wrong: '李彪', right: '李标' },     // 有效
            { wrong: '', right: 'X' },              // 无效(wrong 空)
            null,                                   // 无效
            'string',                               // 无效
            { wrong: 'A' },                         // 无效(没 right)
        ]
    };
    const out = getBrandCorrections(brand);
    assert.equal(out.length, 1);
    assert.equal(out[0].right, '李标');
});

// ─── isValidCorrection ─────────────────────────────────────────────────

test('isValidCorrection: 各种无效输入', () => {
    assert.equal(isValidCorrection(null), false);
    assert.equal(isValidCorrection(undefined), false);
    assert.equal(isValidCorrection('string'), false);
    assert.equal(isValidCorrection({}), false);
    assert.equal(isValidCorrection({ wrong: 'a' }), false);              // 缺 right
    assert.equal(isValidCorrection({ right: 'a' }), false);              // 缺 wrong
    assert.equal(isValidCorrection({ wrong: '', right: 'a' }), false);   // wrong 空
    assert.equal(isValidCorrection({ wrong: 'a', right: '' }), false);   // right 空
    assert.equal(isValidCorrection({ wrong: [], right: 'a' }), false);   // wrong 空数组
    assert.equal(isValidCorrection({ wrong: [''], right: 'a' }), false); // wrong 数组全空
});

test('isValidCorrection: 有效输入', () => {
    assert.equal(isValidCorrection({ wrong: 'a', right: 'b' }), true);
    assert.equal(isValidCorrection({ wrong: ['a'], right: 'b' }), true);
    assert.equal(isValidCorrection({ wrong: ['', 'a'], right: 'b' }), true);  // 至少一个非空
});

// ─── 集成场景:本期 panel 实战数据 ───────────────────────────────────────

test('集成: OPC panel 字幕全量校正', () => {
    const corrections = [
        { wrong: ['李彪'], right: '李标 Bill' },
        { wrong: ['We点AI', '微点AI', '位点AI', 'WeAI'], right: 'WUI.AI' },
        { wrong: ['张萍萍', '萍萍', '平平'], right: '张拼拼' },
        { wrong: ['陈慧', '陈辉'], right: '成慧' },
        { wrong: ['Oboat', 'OBO', 'O B O'], right: 'ORBOT' },
        { wrong: ['拥抱秩序'], right: '拥抱智序' },
    ];
    const raw = '今天的 panel 嘉宾有 李彪 Pan Hunt 创始人,We点AI 的 CEO,拥抱秩序 的 张萍萍,Oboat 的 陈慧';
    const fixed = sanitizeText(raw, corrections);
    assert.ok(fixed.includes('李标 Bill'), 'should fix 李彪');
    assert.ok(fixed.includes('WUI.AI'), 'should fix We点AI');
    assert.ok(fixed.includes('拥抱智序'), 'should fix 拥抱秩序');
    assert.ok(fixed.includes('张拼拼'), 'should fix 张萍萍');
    assert.ok(fixed.includes('ORBOT'), 'should fix Oboat');
    assert.ok(fixed.includes('成慧'), 'should fix 陈慧');
    assert.ok(!fixed.includes('李彪'), 'should not contain 李彪');
    assert.ok(!fixed.includes('We点AI'), 'should not contain We点AI');
});

// ─── 全局技术术语词库 ────────────────────────────────────────────────────────

test('getTechTermCorrections 加载共享词库且条目合法', () => {
    const terms = getTechTermCorrections();
    assert.ok(Array.isArray(terms) && terms.length > 0, '应加载到词条');
    for (const c of terms) assert.ok(isValidCorrection(c), '每条都应合法');
    // 缓存稳定:二次调用返回同一引用
    assert.strictEqual(getTechTermCorrections(), terms);
});

test('技术词库把 Cloud Code 校正为 Claude Code(本次实战错别字)', () => {
    const terms = getTechTermCorrections();
    const fixed = sanitizeText('今天讲一下 Cloud Code 这个工具', terms);
    assert.ok(fixed.includes('Claude Code'), 'should fix Cloud Code');
    assert.ok(!fixed.includes('Cloud Code'), 'should not contain Cloud Code');
});

test('技术词库大小写规范化 github→GitHub,且不误伤普通文本', () => {
    const terms = getTechTermCorrections();
    assert.equal(sanitizeText('打开 github 仓库', terms), '打开 GitHub 仓库');
    assert.equal(sanitizeText('这是一段普通文本', terms), '这是一段普通文本');
});

test('技术词 + 品牌词可合并使用', () => {
    const merged = [...getTechTermCorrections(), { wrong: ['李彪'], right: '李标' }];
    const fixed = sanitizeText('李彪 在讲 Cloud Code', merged);
    assert.ok(fixed.includes('李标'), 'brand 词生效');
    assert.ok(fixed.includes('Claude Code'), 'tech 词生效');
});
