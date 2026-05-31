/**
 * 字幕工具函数单元测试
 * 运行: node --test tests/captionUtils.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// 直接引用纯函数，不依赖 DB 或外部服务
const {
    toSrtTime,
    toSrt,
    chunkCaptions,
    buildRobustCaptions,
    applyFillerRemoval,
    parseKeywordList,
    removeFillerWords
} = require('../src/video/captionUtils');

// ─── toSrtTime ────────────────────────────────────────────────────────────────

test('toSrtTime: 0 秒', () => {
    assert.equal(toSrtTime(0), '00:00:00,000');
});

test('toSrtTime: 1.5 秒', () => {
    assert.equal(toSrtTime(1.5), '00:00:01,500');
});

test('toSrtTime: 1 分 2.034 秒', () => {
    assert.equal(toSrtTime(62.034), '00:01:02,034');
});

test('toSrtTime: 跨小时', () => {
    assert.equal(toSrtTime(3661), '01:01:01,000');
});

test('toSrtTime: 负数 → 归零', () => {
    assert.equal(toSrtTime(-5), '00:00:00,000');
});

test('toSrtTime: undefined → 归零', () => {
    assert.equal(toSrtTime(undefined), '00:00:00,000');
});

// ─── toSrt ────────────────────────────────────────────────────────────────────

test('toSrt: 空数组返回空字符串', () => {
    assert.equal(toSrt([]), '');
});

test('toSrt: 单条字幕格式正确', () => {
    const captions = [{ startSec: 0, endSec: 1.5, text: '你好世界' }];
    const result = toSrt(captions);
    assert.ok(result.includes('1\n'));
    assert.ok(result.includes('00:00:00,000 --> 00:00:01,500'));
    assert.ok(result.includes('你好世界'));
});

test('toSrt: 多条字幕序号递增', () => {
    const captions = [
        { startSec: 0, endSec: 1, text: '第一句' },
        { startSec: 1.5, endSec: 3, text: '第二句' }
    ];
    const result = toSrt(captions);
    assert.ok(result.includes('1\n'));
    assert.ok(result.includes('2\n'));
});

// ─── chunkCaptions ────────────────────────────────────────────────────────────

test('chunkCaptions: 空数组', () => {
    assert.deepEqual(chunkCaptions([]), []);
});

test('chunkCaptions: 单词语合并', () => {
    const words = [
        { word: '你好', start: 0, end: 0.5 },
        { word: '世界', start: 0.6, end: 1.0 }
    ];
    const result = chunkCaptions(words, 24, 2.4);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '你好世界');
});

test('chunkCaptions: 超过 maxChars 触发分块', () => {
    const words = [
        { word: '一二三四五', start: 0, end: 0.5 },
        { word: '六七八九十', start: 0.6, end: 1.0 }
    ];
    // maxChars=8 → 5+5=10 超限 → 分两块
    const result = chunkCaptions(words, 8, 10);
    assert.equal(result.length, 2);
});

test('chunkCaptions: 超过 maxDuration 触发分块', () => {
    const words = [
        { word: 'A', start: 0, end: 0.5 },
        { word: 'B', start: 2.0, end: 3.0 }
    ];
    // maxDuration=1.5 → duration=3.0 超限
    const result = chunkCaptions(words, 100, 1.5);
    assert.equal(result.length, 2);
});

test('chunkCaptions: 过滤空 word', () => {
    const words = [
        { word: '', start: 0, end: 0.1 },
        { word: '你好', start: 0.2, end: 0.5 }
    ];
    const result = chunkCaptions(words);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '你好');
});

// ─── parseKeywordList ─────────────────────────────────────────────────────────

test('parseKeywordList: 逗号分隔', () => {
    const result = parseKeywordList('杠杆,闭环,降维打击');
    assert.deepEqual(result, ['杠杆', '闭环', '降维打击']);
});

test('parseKeywordList: 换行分隔', () => {
    const result = parseKeywordList('杠杆\n闭环');
    assert.deepEqual(result, ['杠杆', '闭环']);
});

test('parseKeywordList: 去重', () => {
    const result = parseKeywordList('杠杆,杠杆,闭环');
    assert.deepEqual(result, ['杠杆', '闭环']);
});

test('parseKeywordList: 空字符串', () => {
    assert.deepEqual(parseKeywordList(''), []);
});

// ─── removeFillerWords ────────────────────────────────────────────────────────

test('removeFillerWords: 基本过滤', () => {
    const result = removeFillerWords('嗯然后我们开始', ['嗯', '然后']);
    assert.equal(result, '我们开始');
});

test('removeFillerWords: 无 fillerWords 时原样返回', () => {
    assert.equal(removeFillerWords('你好', []), '你好');
});

test('removeFillerWords: 空数组', () => {
    assert.equal(removeFillerWords('', ['嗯']), '');
});

// ─── applyFillerRemoval ───────────────────────────────────────────────────────

test('applyFillerRemoval: 从字幕数组中过滤', () => {
    const captions = [
        { start: 0, end: 1, startSec: 0, endSec: 1, text: '嗯我们来聊聊' },
        { start: 1, end: 2, startSec: 1, endSec: 2, text: '这个问题' }
    ];
    const result = applyFillerRemoval(captions, ['嗯']);
    assert.equal(result[0].text, '我们来聊聊');
    assert.equal(result[1].text, '这个问题');
});

test('applyFillerRemoval: 过滤后为空的行被丢弃', () => {
    const captions = [
        { start: 0, end: 1, startSec: 0, endSec: 1, text: '嗯' },
        { start: 1, end: 2, startSec: 1, endSec: 2, text: '正文' }
    ];
    const result = applyFillerRemoval(captions, ['嗯']);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '正文');
});

test('applyFillerRemoval: fillerWords 为空时原样返回', () => {
    const captions = [{ start: 0, end: 1, startSec: 0, endSec: 1, text: '你好' }];
    assert.deepEqual(applyFillerRemoval(captions, []), captions);
});

// ─── buildRobustCaptions ──────────────────────────────────────────────────────

test('buildRobustCaptions: 空 payload + fallback', () => {
    const result = buildRobustCaptions({}, '默认文本');
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '默认文本');
    assert.equal(result[0].start, 0);
});

test('buildRobustCaptions: 空 payload + 空 fallback → 空数组', () => {
    const result = buildRobustCaptions({}, '');
    assert.deepEqual(result, []);
});

test('buildRobustCaptions: 从 words 数组生成字幕', () => {
    const payload = {
        words: [
            { word: '这是', start: 0, end: 0.4 },
            { word: '一段', start: 0.5, end: 0.9 },
            { word: '测试', start: 1.0, end: 1.4 }
        ]
    };
    const result = buildRobustCaptions(payload, '', { renderStyle: 'sentence' });
    assert.ok(result.length >= 1);
    const combined = result.map((r) => r.text).join('');
    assert.ok(combined.includes('这是') || combined.includes('一段') || combined.includes('测试'));
});

test('buildRobustCaptions: replacementMapRaw 替换生效', () => {
    const payload = {
        words: [{ word: 'echocut科技', start: 0, end: 1 }]
    };
    const result = buildRobustCaptions(payload, '', { replacementMapRaw: 'echocut科技=echocut' });
    assert.ok(result.some((r) => r.text.includes('echocut')));
});

test('buildRobustCaptions: 从 segments 回退生成字幕', () => {
    const payload = {
        segments: [
            { start: 0, end: 2, text: '从片段生成的字幕' }
        ]
    };
    const result = buildRobustCaptions(payload, '');
    assert.ok(result.length >= 1);
    const combined = result.map((r) => r.text).join('');
    assert.ok(combined.includes('生成'));
});

// ─── 语义分句 (semanticBreak) ──────────────────────────────────────────────────

test('buildRobustCaptions: 句号后强制断句产生两条字幕', () => {
    const payload = {
        words: [
            { word: '这是', start: 0, end: 0.5 },
            { word: '第一句。', start: 0.5, end: 1.2 },
            { word: '这是', start: 1.3, end: 1.6 },
            { word: '第二句。', start: 1.6, end: 2.0 }
        ]
    };
    const result = buildRobustCaptions(payload, '', { renderStyle: 'sentence', semanticBreak: true, sentenceMaxChars: 20 });
    // 两个句号边界 → 应产生 2 条字幕
    assert.ok(result.length >= 2, `期望 >= 2 条字幕，实际 ${result.length} 条`);
    const texts = result.map((r) => r.text);
    assert.ok(texts.some((t) => t.includes('第一句')), '第一句应在某条字幕中');
    assert.ok(texts.some((t) => t.includes('第二句')), '第二句应在某条字幕中');
});

test('buildRobustCaptions: semanticBreak=false 时逗号不强制断句（短chunk仍合并）', () => {
    const payload = {
        words: [
            { word: '这个，', start: 0, end: 0.4 },
            { word: '问题', start: 0.4, end: 0.8 }
        ]
    };
    const resultOn = buildRobustCaptions(payload, '', { renderStyle: 'sentence', semanticBreak: true, sentenceMaxChars: 20 });
    const resultOff = buildRobustCaptions(payload, '', { renderStyle: 'sentence', semanticBreak: false, sentenceMaxChars: 20 });
    // semanticBreak=true: 逗号 chunk 未达 60% maxChars → 不强制断
    // semanticBreak=false: 逗号会触发 containsBoundary 断句
    // 主要验证两种模式都不崩溃，结果非空
    assert.ok(resultOn.length >= 1);
    assert.ok(resultOff.length >= 1);
});

// ─── 字幕时间偏移 (subtitleOffsetMs) ─────────────────────────────────────────

test('buildRobustCaptions: subtitleOffsetMs 正偏移', () => {
    const payload = {
        words: [
            { word: '你好', start: 1.0, end: 1.5 },
            { word: '世界', start: 1.6, end: 2.0 }
        ]
    };
    const result = buildRobustCaptions(payload, '', { subtitleOffsetMs: 200 });
    assert.ok(result.length >= 1);
    // 所有 start 应 >= 1.2 (原始 1.0 + 0.2s)
    result.forEach((cap) => {
        assert.ok(cap.start >= 1.19, `start=${cap.start} 应 >= 1.2`);
    });
});

test('buildRobustCaptions: subtitleOffsetMs 负偏移不产生负时间', () => {
    const payload = {
        words: [
            { word: '你好', start: 0.1, end: 0.5 }
        ]
    };
    const result = buildRobustCaptions(payload, '', { subtitleOffsetMs: -500 });
    assert.ok(result.length >= 1);
    // 原始 0.1 - 0.5 = -0.4，应被钳制为 0
    result.forEach((cap) => {
        assert.ok(cap.start >= 0, `start=${cap.start} 不应小于 0`);
    });
});

test('buildRobustCaptions: subtitleOffsetMs=0 时时间不变', () => {
    const payload = {
        words: [
            { word: '测试', start: 1.0, end: 1.5 }
        ]
    };
    const resultZero = buildRobustCaptions(payload, '', { subtitleOffsetMs: 0 });
    const resultDefault = buildRobustCaptions(payload, '', {});
    assert.equal(resultZero[0].start, resultDefault[0].start);
});
