'use strict';

/**
 * MiniMax 音乐生成 · 统一服务层
 *
 * 抽自 scripts/generate-bgm.js,供 echocut music CLI 调用。
 * 用户场景:
 *   - 临时一首 ad-hoc: generateMusic({prompt, name, outputPath})
 *   - 批量预设: generateBatch({prompts, outputDir})
 *   - 友好错误处理(API key 缺/配额不足/超时)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_API_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com';
const DEFAULT_MODEL = process.env.MINIMAX_MUSIC_MODEL || 'music-2.6';

class MusicApiError extends Error {
    constructor(message, { kind, status, payload, hint } = {}) {
        super(message);
        this.name = 'MusicApiError';
        this.kind = kind;      // missing_key / http_error / base_resp_error / timeout / network / unknown
        this.status = status;
        this.payload = payload;
        this.hint = hint;
    }
}

// ───────────────────── 前置检查 ─────────────────────

function checkApiKey() {
    const key = process.env.MINIMAX_API_KEY;
    if (!key) {
        throw new MusicApiError('MiniMax API key 未设置', {
            kind: 'missing_key',
            hint: '在 .env 或环境变量里设置 MINIMAX_API_KEY(申请: https://platform.minimaxi.com/user-center/basic-information/interface-key)'
        });
    }
    return key;
}

// ───────────────────── 单首生成 ─────────────────────

/**
 * 生成一首音乐。
 * @param {object} params
 * @param {string} params.prompt      音乐描述(中英都行,英文更精准)
 * @param {string} params.name        文件名(不含扩展,如 'creator-05')
 * @param {string} params.outputDir   输出目录(绝对或相对 ZDE_PROJECT_ROOT)
 * @param {string} [params.model]     默认 music-2.6
 * @param {number} [params.timeoutMs] 默认 240s
 * @param {boolean} [params.skipExisting=true] 已存在同名 mp3 跳过
 * @returns {Promise<{ outputPath, skipped, duration, sizeBytes, elapsedMs }>}
 */
async function generateMusic({
    prompt, name, outputDir,
    model = DEFAULT_MODEL,
    timeoutMs = 240000,
    skipExisting = true
}) {
    if (!prompt || !String(prompt).trim()) throw new MusicApiError('prompt 不能为空', { kind: 'invalid_input' });
    if (!name) throw new MusicApiError('name 不能为空', { kind: 'invalid_input' });
    if (!outputDir) throw new MusicApiError('outputDir 不能为空', { kind: 'invalid_input' });

    const apiKey = checkApiKey();
    const apiUrl = `${DEFAULT_API_BASE}/v1/music_generation`;

    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${name}.mp3`);

    // 已存在则跳过(可配置)
    if (skipExisting && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
        return {
            outputPath, skipped: true,
            sizeBytes: fs.statSync(outputPath).size, duration: null, elapsedMs: 0
        };
    }

    const started = Date.now();
    const body = {
        model,
        prompt,
        is_instrumental: true,
        audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: 'mp3'
        },
        output_format: 'url'
    };

    // 1) 调 API
    let resp;
    try {
        resp = await axios.post(apiUrl, body, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: timeoutMs,
            proxy: false
        });
    } catch (err) {
        const status = err.response?.status || 0;
        const data = err.response?.data;
        if (err.code === 'ECONNABORTED') {
            throw new MusicApiError(`请求超时(${Math.round(timeoutMs / 1000)}s)`, {
                kind: 'timeout', status,
                hint: '高峰期 API 可能慢,可稍后重试或增加 timeoutMs'
            });
        }
        if (!err.response) {
            throw new MusicApiError(`网络错误: ${err.message}`, {
                kind: 'network', hint: '检查网络连接 / MINIMAX_BASE_URL'
            });
        }
        if (status === 401 || status === 403) {
            throw new MusicApiError(`API 认证失败 HTTP ${status}`, {
                kind: 'http_error', status, payload: data,
                hint: 'MINIMAX_API_KEY 可能失效,到 platform.minimaxi.com 重新生成'
            });
        }
        if (status === 429 || status === 402) {
            throw new MusicApiError(`API 配额不足 HTTP ${status}`, {
                kind: 'http_error', status, payload: data,
                hint: 'music-2.6 每天 100 首配额,检查余量: platform.minimaxi.com'
            });
        }
        throw new MusicApiError(`HTTP ${status}: ${JSON.stringify(data || err.message).slice(0, 200)}`, {
            kind: 'http_error', status, payload: data
        });
    }

    // 2) 解析响应
    const data = resp.data || {};
    const baseResp = data.base_resp || {};
    const inner = data.data || {};

    if (baseResp.status_code !== 0) {
        const hint = baseResp.status_code === 1008
            ? 'prompt 违规或被过滤,调整描述后重试'
            : baseResp.status_code === 1002
            ? '配额不足'
            : '';
        throw new MusicApiError(`MiniMax 返回错误: ${baseResp.status_msg || baseResp.status_code}`, {
            kind: 'base_resp_error', payload: baseResp, hint
        });
    }

    const audio = inner.audio;
    const apiStatus = inner.status;
    if (apiStatus !== 2 || !audio) {
        throw new MusicApiError(`生成未完成,status=${apiStatus}`, {
            kind: 'base_resp_error', payload: inner,
            hint: 'MiniMax 返回未完成状态,稍后重试'
        });
    }

    // 3) 下载/解码音频
    let buffer;
    try {
        if (String(audio).startsWith('http')) {
            const dl = await axios.get(audio, {
                responseType: 'arraybuffer',
                timeout: 120000,
                proxy: false
            });
            buffer = Buffer.from(dl.data);
        } else {
            // 兼容 hex 格式
            buffer = Buffer.from(String(audio), 'hex');
        }
    } catch (err) {
        throw new MusicApiError(`下载音频失败: ${err.message}`, {
            kind: 'network', hint: '重试或检查 output url 是否可达'
        });
    }

    // 4) 落盘
    fs.writeFileSync(outputPath, buffer);
    const durationMs = data.extra_info?.music_duration;
    return {
        outputPath,
        skipped: false,
        sizeBytes: buffer.length,
        duration: durationMs ? durationMs / 1000 : null,
        elapsedMs: Date.now() - started
    };
}

// ───────────────────── 批量 ─────────────────────

/**
 * 批量生成。串行(MiniMax 单 API key 并发意义不大),出错继续下一个。
 * @param {object} params
 * @param {Array<{name, prompt}>} params.prompts
 * @param {string} params.outputDir
 * @param {function} [params.onItemStart({index, total, item})]
 * @param {function} [params.onItemDone({index, total, item, result, error})]
 * @param {number} [params.delayBetweenMs=1000]
 * @returns {Promise<{ total, ok, skipped, failed, items[] }>}
 */
async function generateBatch({
    prompts, outputDir,
    onItemStart = null,
    onItemDone = null,
    delayBetweenMs = 1000,
    ...genOpts
}) {
    if (!Array.isArray(prompts) || !prompts.length) {
        throw new MusicApiError('prompts 不能为空', { kind: 'invalid_input' });
    }
    checkApiKey();  // 早失败

    const items = [];
    let ok = 0, skipped = 0, failed = 0;

    for (let i = 0; i < prompts.length; i += 1) {
        const item = prompts[i];
        if (onItemStart) onItemStart({ index: i, total: prompts.length, item });
        try {
            const result = await generateMusic({
                prompt: item.prompt,
                name: item.name,
                outputDir,
                ...genOpts
            });
            if (result.skipped) skipped += 1; else ok += 1;
            items.push({ ...item, status: result.skipped ? 'skipped' : 'ok', ...result });
            if (onItemDone) onItemDone({ index: i, total: prompts.length, item, result });
        } catch (err) {
            failed += 1;
            items.push({ ...item, status: 'failed', error: err.message, kind: err.kind, hint: err.hint });
            if (onItemDone) onItemDone({ index: i, total: prompts.length, item, error: err });
            // 认证/配额类错误立即停(无意义继续重试)
            if (err.kind === 'missing_key' || (err.kind === 'http_error' && [401, 402, 403, 429].includes(err.status))) {
                return { total: prompts.length, ok, skipped, failed, items, aborted: true };
            }
        }
        if (i < prompts.length - 1 && delayBetweenMs > 0) {
            await new Promise((r) => setTimeout(r, delayBetweenMs));
        }
    }

    return { total: prompts.length, ok, skipped, failed, items };
}

// ───────────────────── 预设批次 ─────────────────────
// 提供给 CLI --set=<name> 使用。从 scripts/generate-bgm.js 的 SETS 拉出来。

function loadPresetSet(setName) {
    // require 的时候会执行 scripts/generate-bgm.js 的顶层,
    // 为避免副作用(它顶层有 IIFE 调 API),用 fs 读文件 + 手解析
    // 更简洁做法:复制 SETS 定义到 JSON;但当前代码共用更保险
    // 折衷:直接返回内置预设清单(和 generate-bgm.js 保持同名)
    const PRESET_DEFS = require('./musicPresets');
    return PRESET_DEFS[setName] || null;
}

function listPresetNames() {
    const PRESET_DEFS = require('./musicPresets');
    return Object.keys(PRESET_DEFS);
}

module.exports = {
    generateMusic,
    generateBatch,
    checkApiKey,
    loadPresetSet,
    listPresetNames,
    MusicApiError,
    DEFAULT_MODEL
};
