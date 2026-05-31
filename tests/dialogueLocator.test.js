/**
 * dialogueLocator 单元测试
 * 关键守护点:
 *   - scanNameEvents 准确扫描多 role 名字 + 同音字数组
 *   - clusterEvents 相邻 < 3s 聚类
 *   - scoreHostTrigger 主持人触发词识别
 *   - inferSpeakerSegments 段边界推断
 *   - 容错:空输入/缺失字段/没匹配
 *   - 真实数据回放(用今晚 OPC panel 数据 mock)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    scanNameEvents,
    clusterEvents,
    scoreHostTrigger,
    inferSpeakerSegments,
    buildPosTimeIndex,
    HOST_TRIGGER_PATTERNS,
} = require('../src/services/dialogueLocator');

// ─── 工具:mock transcript ───────────────────────────────────────────────

function mockTranscript(text, perCharSec = 0.1) {
    // 把 text 按 char 平均分成 words,每个 char 给 perCharSec 时间
    const words = [];
    let t = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (/\s/.test(ch)) { t += perCharSec; continue; }
        words.push({ word: ch, start: t, end: t + perCharSec });
        t += perCharSec;
    }
    return { text, words };
}

// ─── buildPosTimeIndex ──────────────────────────────────────────────────

test('buildPosTimeIndex: 简单 char→time 映射', () => {
    const { text, words } = mockTranscript('hello', 0.1);
    const lookup = buildPosTimeIndex(text, words);
    assert.equal(lookup(0).toFixed(1), '0.0');  // 'h' 起点
    assert.equal(lookup(2).toFixed(1), '0.2');  // 'l'(第3个字)起点
});

test('buildPosTimeIndex: kind=end 返回 word.end', () => {
    const { text, words } = mockTranscript('ab', 0.5);
    const lookup = buildPosTimeIndex(text, words);
    assert.equal(lookup(0, { kind: 'end' }).toFixed(1), '0.5');
    assert.equal(lookup(1, { kind: 'end' }).toFixed(1), '1.0');
});

test('buildPosTimeIndex: pos 超出范围 → 最后 word.end', () => {
    const { text, words } = mockTranscript('ab', 0.5);
    const lookup = buildPosTimeIndex(text, words);
    assert.equal(lookup(999).toFixed(1), '1.0');
});

// ─── scanNameEvents ─────────────────────────────────────────────────────

test('scanNameEvents: 多 role 多关键词扫描', () => {
    const { text, words } = mockTranscript('请李标你来说,谢谢李标,好 Dennis 接力', 0.1);
    const events = scanNameEvents(text, words, {
        speaker: ['李标'],
        others: ['Dennis'],
    });
    // 李标 出现 2 次 + Dennis 1 次 = 3 events
    assert.equal(events.length, 3);
    assert.equal(events[0].role, 'speaker');
    assert.equal(events[0].kw, '李标');
    assert.equal(events[2].role, 'others');
    assert.equal(events[2].kw, 'Dennis');
    // 按 t 升序
    assert.ok(events[0].t <= events[1].t);
    assert.ok(events[1].t <= events[2].t);
});

test('scanNameEvents: 同音字数组都扫到', () => {
    const { text, words } = mockTranscript('请李标,谢谢李彪', 0.1);
    const events = scanNameEvents(text, words, {
        speaker: ['李标', '李彪'],
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].kw, '李标');
    assert.equal(events[1].kw, '李彪');
});

test('scanNameEvents: 上下文 ctx 字段包含前后 30 字', () => {
    const { text, words } = mockTranscript('panel 开始 请李标 现在介绍', 0.1);
    const events = scanNameEvents(text, words, {
        speaker: ['李标'],
    });
    assert.equal(events.length, 1);
    assert.ok(events[0].ctx.includes('李标'));
    assert.ok(events[0].ctx.includes('请'));
});

test('scanNameEvents: 空输入容错', () => {
    assert.deepEqual(scanNameEvents('', [], {}), []);
    assert.deepEqual(scanNameEvents(null, null, null), []);
    assert.deepEqual(scanNameEvents('hello', [], { speaker: ['hello'] }), []);
});

test('scanNameEvents: 关键词不存在 → 空数组', () => {
    const { text, words } = mockTranscript('hello world', 0.1);
    assert.deepEqual(scanNameEvents(text, words, { speaker: ['李标'] }), []);
});

// ─── clusterEvents ──────────────────────────────────────────────────────

test('clusterEvents: 相邻 < 3s 聚类', () => {
    const events = [
        { t: 10, pos: 0, role: 'speaker', kw: '李标', ctx: '' },
        { t: 11, pos: 5, role: 'speaker', kw: '李彪', ctx: '' },   // < 3s,同 cluster
        { t: 20, pos: 10, role: 'others', kw: 'Dennis', ctx: '' }, // 9s gap,新 cluster
    ];
    const clusters = clusterEvents(events);
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].hits.length, 2);
    assert.equal(clusters[1].hits.length, 1);
});

test('clusterEvents: primaryRole 取出现最多的 role', () => {
    const events = [
        { t: 10, pos: 0, role: 'others', kw: 'X', ctx: '' },
        { t: 10.5, pos: 1, role: 'others', kw: 'Y', ctx: '' },
        { t: 11, pos: 2, role: 'speaker', kw: '李标', ctx: '' },
    ];
    const clusters = clusterEvents(events);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].primaryRole, 'others');
});

test('clusterEvents: 空输入 → 空数组', () => {
    assert.deepEqual(clusterEvents([]), []);
    assert.deepEqual(clusterEvents(null), []);
});

// ─── scoreHostTrigger ───────────────────────────────────────────────────

test('scoreHostTrigger: "请李标" 主持人触发词 hits → score > 0', () => {
    const text = '我们请李标介绍';
    const cluster = { t: 0, pos: text.indexOf('李标'), ctx: text };
    const r = scoreHostTrigger(cluster, text);
    assert.ok(r.score > 0, `score should > 0, got ${r.score}`);
    assert.ok(r.hits.includes('请'));
});

test('scoreHostTrigger: "请李标" 主持人语气', () => {
    const text = '请李标你来说';
    const cluster = { t: 0, pos: text.indexOf('李标'), ctx: text };
    const r = scoreHostTrigger(cluster, text);
    assert.ok(r.score > 0);
});

test('scoreHostTrigger: "像李标那样" 嘉宾内部提及 → score 低', () => {
    const text = '比如说像李标那样';
    const cluster = { t: 0, pos: text.indexOf('李标'), ctx: text };
    const r = scoreHostTrigger(cluster, text);
    // 有 PEER_MENTION '像' '比如说' 触发 → 减分
    assert.ok(r.score < 0.5, `peer mention score should < 0.5, got ${r.score}`);
});

test('scoreHostTrigger: 主持人 + 嘉宾混合 → 净分', () => {
    const text = '请李标';  // 只有 host trigger
    const cluster = { t: 0, pos: text.indexOf('李标'), ctx: text };
    const r = scoreHostTrigger(cluster, text);
    assert.ok(r.score >= 0.5);
});

test('scoreHostTrigger: 空/null 输入容错', () => {
    assert.deepEqual(scoreHostTrigger(null, 'text'), { score: 0, hits: [], kind: 'none' });
    assert.deepEqual(scoreHostTrigger({ pos: 0 }, ''), { score: 0, hits: [], kind: 'none' });
});

test('scoreHostTrigger: kind=start 当窗口含 START 触发词', () => {
    const text = '请李标';
    const r = scoreHostTrigger({ pos: text.indexOf('李标') }, text);
    assert.equal(r.kind, 'start');
    assert.ok(r.score >= 0.5);
});

test('scoreHostTrigger: kind=end 当窗口只有 END 触发词,不算 start', () => {
    const text = 'OK,好的,谢谢李标';  // 含 END "谢谢" / "好的",无 START
    const r = scoreHostTrigger({ pos: text.indexOf('李标') }, text);
    assert.equal(r.kind, 'end', `应该判 end 不是 ${r.kind}`);
});

test('scoreHostTrigger: kind=start 当 start + end 同时出现且 START 更近', () => {
    // 实战场景:"好的,那我我们再回来,请那个李标 和 Dennis"
    // 前 25 字含 END "好的" + START "那" "请那个",但 START 紧贴 pos
    const text = '好的,那我我们再回来,请那个李标和 Dennis';
    const r = scoreHostTrigger({ pos: text.indexOf('李标') }, text);
    assert.equal(r.kind, 'start', `应该判 start 不是 ${r.kind} (hits=${r.hits} endHits=${r.endHits})`);
});

// ─── inferSpeakerSegments ───────────────────────────────────────────────

test('inferSpeakerSegments: 基本场景 — speaker 段从 host 喊起,others 喊止', () => {
    // 模拟 panel:host 喊 speaker (t=10) → speaker 讲 → host 喊 other (t=200) 切换
    const clusters = [
        { t: 10, pos: 0, primaryRole: 'speaker', hits: [], ctx: '请李标' },
        { t: 200, pos: 100, primaryRole: 'others', hits: [], ctx: '请 Dennis' },
    ];
    const text = '请李标'.padEnd(500, ' ') + '请 Dennis';
    // 手动给两个 cluster 设 pos 以匹配 text
    clusters[0].pos = text.indexOf('请李标') + 2;  // pos of 李标
    clusters[1].pos = text.indexOf('请 Dennis') + 2;
    const r = inferSpeakerSegments(clusters, text, { minDurationSec: 60 });
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].startSec, 10);
    assert.equal(r.segments[0].endSec, 200);
    assert.equal(r.segments[0].durationSec, 190);
});

test('inferSpeakerSegments: 段太短(< minDur)被过滤', () => {
    const text = '请李标 ... 请 Dennis';
    const clusters = [
        { t: 10, pos: text.indexOf('李标'), primaryRole: 'speaker', hits: [], ctx: '请李标' },
        { t: 20, pos: text.indexOf('Dennis'), primaryRole: 'others', hits: [], ctx: '请 Dennis' },
    ];
    const r = inferSpeakerSegments(clusters, text, { minDurationSec: 60 });
    assert.equal(r.segments.length, 0);
    assert.ok(r.debug.warnings.length > 0);
});

test('inferSpeakerSegments: startBufferSec 把主持人提问也包进段', () => {
    const text = '请李标'.padEnd(500, ' ') + '请 Dennis';
    const clusters = [
        { t: 100, pos: text.indexOf('李标'), primaryRole: 'speaker', hits: [], ctx: '请李标' },
        { t: 300, pos: text.indexOf('Dennis'), primaryRole: 'others', hits: [], ctx: '请 Dennis' },
    ];
    const r = inferSpeakerSegments(clusters, text, { startBufferSec: 10, minDurationSec: 60 });
    assert.equal(r.segments[0].startSec, 90);  // 100 - 10 buffer
    assert.equal(r.segments[0].endSec, 300);
});

test('inferSpeakerSegments: 没有下一个 other → 用 transcriptDurationSec fallback', () => {
    const text = '请李标'.padEnd(500, ' ');
    const clusters = [
        { t: 100, pos: text.indexOf('李标'), primaryRole: 'speaker', hits: [], ctx: '请李标' },
    ];
    const r = inferSpeakerSegments(clusters, text, {
        minDurationSec: 60,
        transcriptDurationSec: 500,
    });
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].endSec, 500);  // hit fallback (500 < 100+900 maxDur)
});

test('inferSpeakerSegments: maxDurationSec 限制段最长', () => {
    const text = '请李标'.padEnd(500, ' ');
    const clusters = [
        { t: 100, pos: text.indexOf('李标'), primaryRole: 'speaker', hits: [], ctx: '请李标' },
    ];
    const r = inferSpeakerSegments(clusters, text, {
        minDurationSec: 60,
        maxDurationSec: 300,
        transcriptDurationSec: Infinity,
    });
    assert.equal(r.segments[0].endSec, 400);  // 100 + 300 cap
});

test('inferSpeakerSegments: 空 clusters → 空段 + warning', () => {
    const r = inferSpeakerSegments([], '', {});
    assert.equal(r.segments.length, 0);
    assert.equal(r.debug.reason, 'no_clusters');
});

test('inferSpeakerSegments: speaker cluster host trigger score 不达标 → 不算 start', () => {
    const text = '我跟李标';  // peer mention,没有 host trigger
    const clusters = [
        { t: 10, pos: text.indexOf('李标'), primaryRole: 'speaker', hits: [], ctx: '我跟李标' },
        { t: 200, pos: 100, primaryRole: 'others', hits: [], ctx: '请 Dennis' },
    ];
    const r = inferSpeakerSegments(clusters, text, { hostTriggerThreshold: 0.5 });
    assert.equal(r.segments.length, 0);  // speaker cluster 没过 threshold
});

// ─── 集成场景:模拟今晚 OPC panel ───────────────────────────────────────

test('集成: OPC panel 3 段 Bill 发言推断', () => {
    // 简化模拟,只把关键提问点放进 text(实际是 50min 全文)
    // 实战:Bill 1=4:07 起 Dennis 8:47 切;Bill 2=18:04 起 22:03 切;Bill 3=36:35 起 41:50 切
    const text = [
        '主持人:好,先从这个李标开始介绍。',                       // pos 0-,4:07 (247s)
        '李标自我介绍 4 分钟,介绍 PainHunt 旷视 七年',
        '主持人:好的,谢谢,请 Dennis 介绍一下。',                  // pos N,8:47 (527s)
        'Dennis 介绍 wuiai 微点 ai',
        '主持人:好的,谢谢萍萍。请陈慧。',                          // pos N,16:12 (972s)
        '陈慧介绍 OBO 机器人',
        '主持人:好,谢谢,请那个李标 Dennis 来分享 OPC 红利杠杆。',  // pos N,17:50 (1070s) 主持人重新喊 李标
        'Bill 讲杠杆论 OPC 红利所在',
        '主持人:OK,谢谢李标,Dennis 接。',                          // pos N,22:03 (1323s) 主持人切 Dennis
    ].join('\n');
    // 按 char 平均 0.5s 算时间(粗略)
    const { words } = mockTranscript(text, 0.5);

    const events = scanNameEvents(text, words, {
        speaker: ['李标'],
        others: ['Dennis', '萍萍', '陈慧'],
    });
    const clusters = clusterEvents(events);
    assert.ok(clusters.length >= 4, `应至少 4 cluster: ${clusters.length}`);

    const r = inferSpeakerSegments(clusters, text, {
        speakerRole: 'speaker',
        otherSpeakerRoles: ['others'],
        minDurationSec: 5,  // mock 数据时间紧
        startBufferSec: 0,
    });
    // 至少推出 1 段 Bill(可能 2 段)
    assert.ok(r.segments.length >= 1, `应至少 1 段 Bill: ${JSON.stringify(r.debug)}`);
    assert.ok(r.segments[0].durationSec > 0);
});
