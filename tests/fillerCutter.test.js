const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeWordText,
    parseFillerList,
    findFillerSpans,
    buildCutIntervals,
    computeKeepIntervals,
    applyFillerCutsToWords,
    buildTrimConcatArgs
} = require('../src/video/fillerCutter');

test('normalizeWordText 去除标点与空白', () => {
    assert.equal(normalizeWordText('对吧?'), '对吧');
    assert.equal(normalizeWordText('  嗯,'), '嗯');
    assert.equal(normalizeWordText('"然后呢"'), '然后呢');
    assert.equal(normalizeWordText(''), '');
});

test('parseFillerList 去重并按长度降序', () => {
    const list = parseFillerList('嗯,对吧,然后呢,嗯,啊');
    assert.deepEqual(list, ['然后呢', '对吧', '嗯', '啊']);
});

test('findFillerSpans 匹配单 word filler', () => {
    const words = [
        { word: '把', start: 0, end: 0.2 },
        { word: '嗯', start: 0.2, end: 0.4 },
        { word: '时间', start: 0.4, end: 0.8 }
    ];
    const spans = findFillerSpans(words, ['嗯']);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].startIdx, 1);
    assert.equal(spans[0].endIdx, 1);
    assert.equal(spans[0].word, '嗯');
});

test('findFillerSpans 滑动窗口合并跨 word 的 "对吧"', () => {
    const words = [
        { word: '对', start: 1.0, end: 1.2 },
        { word: '吧', start: 1.2, end: 1.5 },
        { word: '时间', start: 1.5, end: 2.0 }
    ];
    const spans = findFillerSpans(words, ['对吧']);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].startIdx, 0);
    assert.equal(spans[0].endIdx, 1);
    assert.equal(spans[0].start, 1.0);
    assert.equal(spans[0].end, 1.5);
});

test('findFillerSpans 长词优先(然后呢 > 然后)', () => {
    const words = [
        { word: '然', start: 0, end: 0.2 },
        { word: '后', start: 0.2, end: 0.4 },
        { word: '呢', start: 0.4, end: 0.6 }
    ];
    // 同时有 "然后" 和 "然后呢" 的词典,应匹配长的
    const spans = findFillerSpans(words, ['然后', '然后呢']);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].word, '然后呢');
    assert.equal(spans[0].endIdx, 2);
});

test('buildCutIntervals 合并相邻+过滤过短', () => {
    const spans = [
        { start: 1.0, end: 1.2, word: 'a' },
        { start: 1.3, end: 1.5, word: 'b' }, // 相邻 0.1s(minGap=0.15 合并)
        { start: 5.0, end: 5.05, word: 'c' } // 持续 0.05s (< minDuration 0.12)
    ];
    const cuts = buildCutIntervals(spans, { padding: 0, minGap: 0.15, minDuration: 0.12 });
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].start, 1.0);
    assert.equal(cuts[0].end, 1.5);
});

test('computeKeepIntervals 基本反推', () => {
    const keep = computeKeepIntervals(10, [
        { start: 2, end: 3 },
        { start: 6, end: 7 }
    ]);
    assert.deepEqual(keep, [
        { start: 0, end: 2 },
        { start: 3, end: 6 },
        { start: 7, end: 10 }
    ]);
});

test('computeKeepIntervals cut 从开头或到结尾', () => {
    assert.deepEqual(
        computeKeepIntervals(10, [{ start: 0, end: 2 }]),
        [{ start: 2, end: 10 }]
    );
    assert.deepEqual(
        computeKeepIntervals(10, [{ start: 8, end: 10 }]),
        [{ start: 0, end: 8 }]
    );
});

test('applyFillerCutsToWords 时间平移 + 丢弃命中 word', () => {
    const words = [
        { word: '把', start: 0, end: 0.5 },
        { word: '嗯', start: 1.0, end: 1.3 },     // 落在 cut [1.0, 1.4]
        { word: '时间', start: 1.5, end: 2.0 }
    ];
    const cuts = [{ start: 1.0, end: 1.4 }];
    const adjusted = applyFillerCutsToWords(words, cuts);
    assert.equal(adjusted.length, 2);
    assert.equal(adjusted[0].word, '把');
    assert.equal(adjusted[0].start, 0);
    assert.equal(adjusted[1].word, '时间');
    // 被 cut 掉 0.4s,1.5 → 1.1
    assert.ok(Math.abs(adjusted[1].start - 1.1) < 1e-9);
    assert.ok(Math.abs(adjusted[1].end - 1.6) < 1e-9);
});

test('applyFillerCutsToWords 空 cuts 返回原样', () => {
    const words = [{ word: 'a', start: 0, end: 1 }];
    assert.deepEqual(applyFillerCutsToWords(words, []), words);
});

test('buildTrimConcatArgs 生成正确的 filter_complex', () => {
    const args = buildTrimConcatArgs('in.mp4', [
        { start: 0, end: 2.5 },
        { start: 3.1, end: 5 }
    ], 'out.mp4');
    assert.ok(args.includes('-filter_complex'));
    const idx = args.indexOf('-filter_complex');
    const fc = args[idx + 1];
    assert.ok(fc.includes('trim=0.000:2.500'));
    assert.ok(fc.includes('atrim=3.100:5.000'));
    assert.ok(fc.includes('concat=n=2:v=1:a=1'));
    assert.equal(args[args.length - 1], 'out.mp4');
});
