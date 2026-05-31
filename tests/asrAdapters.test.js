/**
 * asrAdapters 单元测试 - 动态长音频阈值
 * 运行: node --test tests/asrAdapters.test.js
 *
 * 关键守护点:
 *   - LONG_AUDIO_THRESHOLD_SEC env 永远是最高优先级
 *   - 没有 env 时按可用内存档位:>=16GB→1800s, >=8GB→900s, 其他→600s
 *   - 数值无效(0/负数/NaN/字符串)时回退到动态档位
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getLongAudioThresholdSec } = require('../src/video/asrAdapters');

function withEnv(envValue, fn) {
    const original = process.env.LONG_AUDIO_THRESHOLD_SEC;
    if (envValue === null) delete process.env.LONG_AUDIO_THRESHOLD_SEC;
    else process.env.LONG_AUDIO_THRESHOLD_SEC = envValue;
    try { return fn(); }
    finally {
        if (original === undefined) delete process.env.LONG_AUDIO_THRESHOLD_SEC;
        else process.env.LONG_AUDIO_THRESHOLD_SEC = original;
    }
}

test('getLongAudioThresholdSec: 显式 env 覆盖一切 (数字 1234)', () => {
    withEnv('1234', () => {
        assert.equal(getLongAudioThresholdSec(), 1234);
    });
});

test('getLongAudioThresholdSec: env=600 跟默认保守档一致', () => {
    withEnv('600', () => {
        assert.equal(getLongAudioThresholdSec(), 600);
    });
});

test('getLongAudioThresholdSec: env=0 (无效) 回退到动态', () => {
    withEnv('0', () => {
        const v = getLongAudioThresholdSec();
        // 不指定时回退动态,内存越大值越大,但一定 >=600
        assert.ok(v >= 600, `应至少回退到 600,实际 ${v}`);
        assert.ok([600, 900, 1800].includes(v), `应是档位值之一,实际 ${v}`);
    });
});

test('getLongAudioThresholdSec: env=负数 回退动态', () => {
    withEnv('-1', () => {
        const v = getLongAudioThresholdSec();
        assert.ok([600, 900, 1800].includes(v));
    });
});

test('getLongAudioThresholdSec: env=字符串(无效数字)回退动态', () => {
    withEnv('abc', () => {
        const v = getLongAudioThresholdSec();
        assert.ok([600, 900, 1800].includes(v));
    });
});

test('getLongAudioThresholdSec: 没 env 时按可用内存,大内存机器 >= 900s', () => {
    withEnv(null, () => {
        const { getAvailableMemoryGB } = require('../src/lib/preflight');
        const avail = getAvailableMemoryGB();
        const v = getLongAudioThresholdSec();
        if (avail >= 16) assert.equal(v, 1800, '>=16GB 应得 1800');
        else if (avail >= 8) assert.equal(v, 900, '>=8GB 应得 900');
        else assert.equal(v, 600, '<8GB 应保守 600');
    });
});

test('getLongAudioThresholdSec: 档位都是合理整数', () => {
    withEnv(null, () => {
        const v = getLongAudioThresholdSec();
        assert.ok(Number.isInteger(v));
        assert.ok(v > 0 && v <= 7200, `档位值应在 (0, 7200]: ${v}`);
    });
});
