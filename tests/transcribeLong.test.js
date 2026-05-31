/**
 * transcribeLong 单元测试(纯本地,不打 MLX/ffmpeg)
 * 重点验证 planChunkBoundaries 这个纯函数:长音频分块边界规划 + 静默吸附 + 覆盖完整性。
 * 运行: node --test tests/transcribeLong.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planChunkBoundaries } = require('../src/services/transcribeLong');

// 覆盖完整性:块必须从 0 到 duration 连续不漏不重叠
function assertCoverage(plan, duration) {
    assert.ok(plan.length >= 1, '至少一块');
    assert.equal(plan[0].start, 0, '首块从 0 开始');
    assert.ok(Math.abs(plan[plan.length - 1].end - duration) < 0.01, '末块到 duration');
    for (let i = 0; i < plan.length; i += 1) {
        assert.ok(plan[i].end > plan[i].start, '块时长为正');
        if (i > 0) assert.ok(Math.abs(plan[i].start - plan[i - 1].end) < 0.01, '相邻块首尾相接');
    }
}

test('短音频(<=chunk)不分块,整段一块', () => {
    const plan = planChunkBoundaries(500, [], 600);
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0], { start: 0, end: 500 });
});

test('略超 chunk(800s/600s)切成 2 块', () => {
    const plan = planChunkBoundaries(800, [], 600, 0);
    assertCoverage(plan, 800);
    assert.equal(plan.length, 2);
});

test('48 分钟音频按 600s 切成多块且完整覆盖', () => {
    const dur = 2918;
    const plan = planChunkBoundaries(dur, [], 600, 0); // 无静默 → 硬切
    assertCoverage(plan, dur);
    // 2918 / 600 ≈ 4.86 → 5 块
    assert.equal(plan.length, 5);
    assert.deepEqual(plan.map((p) => p.start), [0, 600, 1200, 1800, 2400]);
});

test('静默吸附:切点被拉到搜索窗内最近的静默中点', () => {
    const dur = 1400;
    // 目标切点 600;静默中点 590 在 ±30 窗内 → 应吸附到 590
    const plan = planChunkBoundaries(dur, [590, 1190], 600, 30);
    assertCoverage(plan, dur);
    assert.equal(plan[0].end, 590);
    assert.equal(plan[1].start, 590);
});

test('静默点超出窗口则不吸附,保持硬切点', () => {
    const dur = 1400;
    // 静默中点 650 距目标 600 有 50 > 30 窗 → 不吸附
    const plan = planChunkBoundaries(dur, [650], 600, 30);
    assert.equal(plan[0].end, 600);
});

test('吸附不会把两刀并到一起(最小间隔保护)', () => {
    const dur = 2000;
    // 制造一堆贴近的静默点,验证相邻切点至少拉开 30s
    const sil = [605, 610, 615, 1205, 1210];
    const plan = planChunkBoundaries(dur, sil, 600, 30);
    assertCoverage(plan, dur);
    for (let i = 1; i < plan.length; i += 1) {
        assert.ok(plan[i].start - plan[i - 1].start >= 30, '相邻块起点间隔 >= 30s');
    }
});

test('duration 为 0 或非法返回空', () => {
    assert.deepEqual(planChunkBoundaries(0, []), []);
    assert.deepEqual(planChunkBoundaries(-5, []), []);
});

test('恰好等于 chunkSec 边界不产生 0 长尾块', () => {
    const plan = planChunkBoundaries(1200, [], 600, 0);
    assertCoverage(plan, 1200);
    // 不应出现 start===end 的空块
    for (const p of plan) assert.ok(p.end - p.start > 0.5);
});
