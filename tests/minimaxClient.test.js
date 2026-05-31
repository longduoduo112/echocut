/**
 * minimaxClient 单元测试(纯本地,不打 API)
 * 验证:
 *   · checkApiKey() 环境变量缺失 / 存在 的行为
 *   · 输入校验(text/prompt 不能为空 等)
 *   · MinimaxApiError 字段完整
 *   · ENDPOINTS / DEFAULTS 导出稳定
 * 运行: node --test tests/minimaxClient.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const origEnv = process.env.MINIMAX_API_KEY;

function withEnv(value, fn) {
    const prev = process.env.MINIMAX_API_KEY;
    if (value === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = value;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.MINIMAX_API_KEY;
        else process.env.MINIMAX_API_KEY = prev;
    }
}

const {
    MinimaxApiError, checkApiKey, DEFAULTS, ENDPOINTS,
    textToSpeech, generateImage, createVideoTask, queryVideoTask, retrieveFile,
    generateMusicCover, generateLyrics
} = require('../src/services/minimaxClient');

// ─── 常量 / 导出稳定性 ────────────────────────────────────────────────────

test('DEFAULTS 包含四个模型名', () => {
    assert.equal(typeof DEFAULTS.ttsModel, 'string');
    assert.equal(typeof DEFAULTS.imageModel, 'string');
    assert.equal(typeof DEFAULTS.videoModel, 'string');
    assert.equal(typeof DEFAULTS.musicModel, 'string');
});

test('ENDPOINTS 覆盖已实现能力', () => {
    for (const key of ['tts', 'image', 'video', 'videoQuery', 'files', 'music', 'musicUpload', 'lyrics']) {
        assert.ok(ENDPOINTS[key], `ENDPOINTS.${key} 缺失`);
        assert.ok(ENDPOINTS[key].startsWith('/'), `ENDPOINTS.${key} 应以 / 开头`);
    }
});

// ─── checkApiKey ────────────────────────────────────────────────────

test('checkApiKey: env 未设置时抛 missing_key', () => {
    withEnv(undefined, () => {
        try { checkApiKey(); assert.fail('应该抛异常'); }
        catch (err) {
            assert.equal(err.name, 'MinimaxApiError');
            assert.equal(err.kind, 'missing_key');
            assert.ok(err.hint && err.hint.includes('MINIMAX_API_KEY'));
        }
    });
});

test('checkApiKey: env 存在时返回 key', () => {
    withEnv('sk-test-key', () => {
        assert.equal(checkApiKey(), 'sk-test-key');
    });
});

// ─── MinimaxApiError 字段 ────────────────────────────────────────────────────

test('MinimaxApiError 保留 kind / status / hint / payload', () => {
    const err = new MinimaxApiError('something broke', {
        kind: 'http_error', status: 500,
        hint: 'retry later', payload: { foo: 'bar' }
    });
    assert.equal(err.name, 'MinimaxApiError');
    assert.equal(err.message, 'something broke');
    assert.equal(err.kind, 'http_error');
    assert.equal(err.status, 500);
    assert.equal(err.hint, 'retry later');
    assert.deepEqual(err.payload, { foo: 'bar' });
});

// ─── 入参校验(不触发网络请求)────────────────────────────────────────────

test('textToSpeech: text 为空立即抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await textToSpeech({ text: '' }); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

test('textToSpeech: text 只有空白字符也抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await textToSpeech({ text: '   \n\t ' }); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

test('generateImage: prompt 为空抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await generateImage({ prompt: '' }); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

test('createVideoTask: prompt 为空抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await createVideoTask({}); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

test('createVideoTask: firstFrameImage 不存在路径抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try {
            await createVideoTask({
                prompt: 'a cat',
                firstFrameImage: '/tmp/definitely-not-exist-xyz-12345.png'
            });
            assert.fail('应抛');
        } catch (err) {
            assert.equal(err.kind, 'invalid_input');
            assert.ok(err.message.includes('不存在'));
        }
    });
});

test('queryVideoTask: taskId 缺失抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await queryVideoTask({}); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

test('retrieveFile: fileId 缺失抛 invalid_input', async () => {
    await withEnv('sk-test', async () => {
        try { await retrieveFile({}); assert.fail('应抛'); }
        catch (err) {
            assert.equal(err.kind, 'invalid_input');
        }
    });
});

// ─── 占位方法 ────────────────────────────────────────────────────

test('generateMusicCover: 返回 not_implemented 且 hint 包含探测到的信息', async () => {
    try { await generateMusicCover({ referenceAudio: 'x' }); assert.fail('应抛'); }
    catch (err) {
        assert.equal(err.kind, 'not_implemented');
        assert.ok(err.hint.includes('music_generation'));
        assert.ok(err.hint.includes('refer_audio'));
    }
});

test('generateLyrics: 返回 not_implemented 且 hint 指向 lyrics_generation', async () => {
    try { await generateLyrics({ prompt: 'x' }); assert.fail('应抛'); }
    catch (err) {
        assert.equal(err.kind, 'not_implemented');
        assert.ok(err.hint.includes('/v1/lyrics_generation'));
    }
});

// ─── 环境变量在 test 结束后恢复 ────────────────────────────────────────────

test('后置:MINIMAX_API_KEY 环境未被污染', () => {
    assert.equal(process.env.MINIMAX_API_KEY, origEnv);
});
