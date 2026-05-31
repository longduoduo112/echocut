/**
 * acceptCaptionFix 单元测试 —— 字幕纠错防错位守卫
 * 背景:LLM(qwen3.5:9b)有时违反"逐行纠错不增删"指令,把文本跨行重排,
 * 贴回原时间窗导致字幕和音频错位(实战:一条 16 字字幕被 LLM 撑到 23 字,
 * 时间窗只有 1.44s,字幕跑到音频前面)。守卫:长度偏差过大就丢弃纠错保原文。
 * 运行: node --test tests/captionCorrectGuard.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acceptCaptionFix } = require('../src/services/processor');

test('等长纠错(同音字)→ 接受', () => {
    assert.equal(acceptCaptionFix('已经可以快速瞄一', '已经可以快速秒一'), true);
    assert.equal(acceptCaptionFix('飞书很好用', '废书很好用'), true); // 同长度即接受(此处只测长度规则)
});

test('小幅增删(≤4字且≤30%)→ 接受', () => {
    assert.equal(acceptCaptionFix('We点AI很强', 'WUI.AI很强'), true); // 5→6
    assert.equal(acceptCaptionFix('这个网站的效果', '这个网站的效果啊'), true); // +1
});

test('大幅变长(LLM 跨行重排)→ 拒绝,保原文', () => {
    // 实战 case:原 16 字被撑到 23 字
    assert.equal(acceptCaptionFix('伙伴们我们来看一下这个代码前面那', '伙伴们我们来看一下这个代码前面哪个视频给大家讲了'), false);
});

test('大幅变短(LLM 把文本挪走)→ 拒绝', () => {
    assert.equal(acceptCaptionFix('它这个网站的效果已经可以快速瞄一', '它这个网站'), false);
});

test('空/非字符串纠错 → 拒绝(回退原文)', () => {
    assert.equal(acceptCaptionFix('原文', ''), false);
    assert.equal(acceptCaptionFix('原文', null), false);
    assert.equal(acceptCaptionFix('原文', undefined), false);
});

test('短字幕的小幅变化:delta≤4 一律接受(不被 30% 误伤)', () => {
    // 4 字字幕 +3 → delta 3 ≤4,接受(避免短句正常纠错被拒)
    assert.equal(acceptCaptionFix('对吧那', '对吧那么说'), true);
});

test('边界:delta=5 且超 30% → 拒绝', () => {
    // 10 字 → 15 字,delta=5>4 且 5>3 → 拒绝
    assert.equal(acceptCaptionFix('一二三四五六七八九十', '一二三四五六七八九十甲乙丙丁戊'), false);
});
