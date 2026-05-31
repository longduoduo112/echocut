'use strict';

/**
 * MiniMax 统一 API 客户端
 *
 * 把 MiniMax 平台的能力都收到一个 client 里,给 CLI(echocut minimax)和服务层共用。
 * 已覆盖:TTS(t2a_v2) / image / video(hailuo 异步) / music(复用 musicGenerator) /
 *        music-cover / lyrics / file retrieve。
 *
 * 设计原则:
 *   - 所有 endpoint 走一个 `request()` 带超时 + 统一错误分类
 *   - 错误走 MinimaxApiError,kind 分类(missing_key/http_error/base_resp_error/timeout/network)
 *   - audio/image/video 都尽量返回"本地文件路径",调用者不用关心 URL/hex 解码
 *   - 异步任务(Hailuo video)有 generateVideoBlocking 一键 poll+下载
 *
 * 环境变量:
 *   MINIMAX_API_KEY          必填
 *   MINIMAX_BASE_URL         默认 https://api.minimaxi.com
 *   MINIMAX_TTS_MODEL        默认 speech-2.6-hd
 *   MINIMAX_IMAGE_MODEL      默认 image-01
 *   MINIMAX_VIDEO_MODEL      默认 MiniMax-Hailuo-2.3-Fast
 *   MINIMAX_MUSIC_MODEL      默认 music-2.6(musicGenerator 里用)
 *
 * 关于 endpoint 路径:
 *   高置信:/v1/t2a_v2 · /v1/image_generation · /v1/video_generation ·
 *          /v1/query/video_generation · /v1/files/retrieve · /v1/music_generation
 *   低置信(可能需要 M3 实测后微调):music-cover / lyrics 的 path 走的是文档最常见模板
 *   首次调通后即可锁定。
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com';
const DEFAULTS = {
    ttsModel:   process.env.MINIMAX_TTS_MODEL   || 'speech-2.6-hd',
    imageModel: process.env.MINIMAX_IMAGE_MODEL || 'image-01',
    videoModel: process.env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-2.3-Fast',
    musicModel: process.env.MINIMAX_MUSIC_MODEL || 'music-2.6',
    // memory: feedback_minimax_text_model.md — 统一用 M2.7,不要 -highspeed 后缀
    textModel:  process.env.MINIMAX_TEXT_MODEL  || 'MiniMax-M2.7'
};

const ENDPOINTS = {
    tts:            '/v1/t2a_v2',
    image:          '/v1/image_generation',
    video:          '/v1/video_generation',
    videoQuery:     '/v1/query/video_generation',
    files:          '/v1/files/retrieve',
    music:          '/v1/music_generation',             // 翻唱也走这个 + refer_audio
    musicUpload:    '/v1/music_upload',                 // 上传参考音频,返回 file_id(body 格式需 multipart,待 doc)
    lyrics:         '/v1/lyrics_generation',            // 路径已确认存在(POST 返回 2013),body 字段名待官方 doc
    chat:           '/v1/text/chatcompletion_v2'        // OpenAI 兼容 chat completion(M2.7)
};

class MinimaxApiError extends Error {
    constructor(message, { kind, status, payload, hint } = {}) {
        super(message);
        this.name = 'MinimaxApiError';
        this.kind = kind;      // missing_key / http_error / base_resp_error / timeout / network / invalid_input
        this.status = status;
        this.payload = payload;
        this.hint = hint;
    }
}

// ────────────────── 基础 ──────────────────

function checkApiKey() {
    const key = process.env.MINIMAX_API_KEY;
    if (!key) {
        throw new MinimaxApiError('MINIMAX_API_KEY 未设置', {
            kind: 'missing_key',
            hint: '在 .env 或环境变量里设置 MINIMAX_API_KEY(申请: https://platform.minimaxi.com/user-center/basic-information/interface-key)'
        });
    }
    return key;
}

function resolveOutputPath(outputPath, opts) {
    if (outputPath) return path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
    const base = opts && opts.outputDir
        ? (path.isAbsolute(opts.outputDir) ? opts.outputDir : path.resolve(process.cwd(), opts.outputDir))
        : process.cwd();
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    const name = (opts && opts.name) || `minimax-${Date.now()}`;
    const ext = (opts && opts.ext) || 'bin';
    return path.join(base, `${name}.${ext}`);
}

/**
 * 统一 POST 请求。错误分类和 musicGenerator 对齐。
 */
async function postJson(endpoint, body, { timeoutMs = 120000, apiKey = null } = {}) {
    const key = apiKey || checkApiKey();
    const url = `${DEFAULT_BASE}${endpoint}`;
    try {
        const resp = await axios.post(url, body, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: timeoutMs,
            proxy: false
        });
        return resp.data;
    } catch (err) {
        throw mapAxiosError(err, timeoutMs);
    }
}

async function getJson(endpoint, params = {}, { timeoutMs = 60000, apiKey = null } = {}) {
    const key = apiKey || checkApiKey();
    const url = `${DEFAULT_BASE}${endpoint}`;
    try {
        const resp = await axios.get(url, {
            params,
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs,
            proxy: false
        });
        return resp.data;
    } catch (err) {
        throw mapAxiosError(err, timeoutMs);
    }
}

function mapAxiosError(err, timeoutMs) {
    const status = err.response?.status || 0;
    const data = err.response?.data;
    if (err.code === 'ECONNABORTED') {
        return new MinimaxApiError(`请求超时(${Math.round(timeoutMs / 1000)}s)`, {
            kind: 'timeout', status,
            hint: '高峰期可稍后重试或增加 timeoutMs'
        });
    }
    if (!err.response) {
        return new MinimaxApiError(`网络错误: ${err.message}`, {
            kind: 'network', hint: '检查网络连接 / MINIMAX_BASE_URL'
        });
    }
    if (status === 401 || status === 403) {
        return new MinimaxApiError(`API 认证失败 HTTP ${status}`, {
            kind: 'http_error', status, payload: data,
            hint: 'MINIMAX_API_KEY 失效或权限不足,到 platform.minimaxi.com 重新生成'
        });
    }
    if (status === 429 || status === 402) {
        return new MinimaxApiError(`API 配额不足 HTTP ${status}`, {
            kind: 'http_error', status, payload: data,
            hint: '到 platform.minimaxi.com/user-center 查看额度'
        });
    }
    if (status === 404) {
        return new MinimaxApiError(`endpoint 404(可能 path 变更)HTTP ${status}`, {
            kind: 'http_error', status, payload: data,
            hint: '检查 MINIMAX_BASE_URL 和 client 里 ENDPOINTS 表。如 music-cover/lyrics 先参照 platform.minimaxi.com 最新文档'
        });
    }
    return new MinimaxApiError(`HTTP ${status}: ${JSON.stringify(data || err.message).slice(0, 200)}`, {
        kind: 'http_error', status, payload: data
    });
}

/**
 * 把 MiniMax 的 base_resp 错误抛成 MinimaxApiError。
 */
function checkBaseResp(data, contextLabel = '') {
    const baseResp = data?.base_resp || {};
    if (baseResp.status_code !== 0 && baseResp.status_code !== undefined) {
        const code = baseResp.status_code;
        const hintMap = {
            1001: '权限验证失败',
            1002: '配额不足',
            1004: '认证失败',
            1008: 'prompt 违规或被过滤,调整描述后重试',
            1013: '参数错误',
            1039: 'prompt 触发内容审核',
            2013: '输入参数不合法'
        };
        throw new MinimaxApiError(`MiniMax 返回错误 ${contextLabel}: ${baseResp.status_msg || code}`, {
            kind: 'base_resp_error', payload: baseResp, hint: hintMap[code] || ''
        });
    }
}

// ────────────────── TTS ──────────────────

/**
 * 文本转语音(t2a_v2 同步版)
 * @param {object} p
 * @param {string} p.text          文本(支持中英混)
 * @param {string} [p.voiceId]     voice_id(默认 'male-qn-qingse',MiniMax 公共音色)
 * @param {string} [p.outputPath]  输出 mp3 绝对路径;不填走 outputDir+name+ext=mp3
 * @param {string} [p.outputDir]
 * @param {string} [p.name]        默认 tts-<时间戳>
 * @param {string} [p.model]       默认 speech-2.6-hd
 * @param {string} [p.format]      mp3 / pcm / flac / wav(默认 mp3)
 * @param {number} [p.sampleRate]  默认 32000
 * @param {number} [p.bitrate]     默认 128000
 * @param {number} [p.speed]       0.5-2.0,默认 1.0
 * @param {number} [p.vol]         0-10,默认 1.0
 * @param {number} [p.pitch]       -12~12,默认 0
 * @param {string} [p.emotion]     happy / sad / angry / fearful / disgusted / surprised / neutral
 * @returns {Promise<{outputPath, sizeBytes, audioLengthMs, elapsedMs}>}
 */
async function textToSpeech(p = {}) {
    if (!p.text || !String(p.text).trim()) throw new MinimaxApiError('text 不能为空', { kind: 'invalid_input' });
    const started = Date.now();
    const format = p.format || 'mp3';
    const outputPath = resolveOutputPath(p.outputPath, {
        outputDir: p.outputDir,
        name: p.name || `tts-${Date.now()}`,
        ext: format
    });

    const body = {
        model: p.model || DEFAULTS.ttsModel,
        text: String(p.text),
        voice_setting: {
            voice_id: p.voiceId || 'male-qn-qingse',
            speed: p.speed ?? 1.0,
            vol: p.vol ?? 1.0,
            pitch: p.pitch ?? 0,
            ...(p.emotion ? { emotion: p.emotion } : {})
        },
        audio_setting: {
            sample_rate: p.sampleRate || 32000,
            bitrate: p.bitrate || 128000,
            format,
            channel: p.channel || 1
        }
    };

    const data = await postJson(ENDPOINTS.tts, body, { timeoutMs: p.timeoutMs || 180000 });
    checkBaseResp(data, 'tts');

    const audioHex = data?.data?.audio;
    const audioUrl = data?.data?.audio_url;
    let buffer;
    if (audioUrl && /^https?:/.test(audioUrl)) {
        const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
        buffer = Buffer.from(dl.data);
    } else if (audioHex) {
        buffer = Buffer.from(String(audioHex), 'hex');
    } else {
        throw new MinimaxApiError('TTS 返回缺少 audio 字段', { kind: 'base_resp_error', payload: data });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    return {
        outputPath,
        sizeBytes: buffer.length,
        audioLengthMs: data?.extra_info?.audio_length ?? null,
        elapsedMs: Date.now() - started
    };
}

// ────────────────── Image ──────────────────

/**
 * 文生图 image-01
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.aspectRatio]   '1:1' | '16:9' | '9:16' | '4:3' | '3:4'(默认 9:16)
 * @param {number} [p.n]             张数(1-9,默认 1)
 * @param {string} [p.outputDir]     输出目录,每张图写 <outputDir>/<name>-NN.jpg
 * @param {string} [p.name]          默认 image-<时间戳>
 * @param {boolean} [p.promptOptimizer=true]
 * @param {string} [p.responseFormat] 'url' | 'base64' (默认 url)
 * @returns {Promise<{outputPaths: string[], prompt, elapsedMs}>}
 */
async function generateImage(p = {}) {
    if (!p.prompt || !String(p.prompt).trim()) throw new MinimaxApiError('prompt 不能为空', { kind: 'invalid_input' });
    const started = Date.now();
    const n = Math.max(1, Math.min(9, Number(p.n) || 1));
    const outputDir = p.outputDir
        ? (path.isAbsolute(p.outputDir) ? p.outputDir : path.resolve(process.cwd(), p.outputDir))
        : process.cwd();
    const baseName = p.name || `image-${Date.now()}`;
    fs.mkdirSync(outputDir, { recursive: true });

    const body = {
        model: p.model || DEFAULTS.imageModel,
        prompt: String(p.prompt),
        aspect_ratio: p.aspectRatio || '9:16',
        n,
        prompt_optimizer: p.promptOptimizer !== false,
        response_format: p.responseFormat || 'url'
    };

    const data = await postJson(ENDPOINTS.image, body, { timeoutMs: p.timeoutMs || 180000 });
    checkBaseResp(data, 'image');

    // 兼容 image_urls (url 模式) / base64 (base64 模式)
    const urls = data?.data?.image_urls || data?.data?.images?.map((x) => x.url) || [];
    const base64s = data?.data?.image_base64 || data?.data?.images?.map((x) => x.base64).filter(Boolean) || [];

    const outputPaths = [];
    for (let i = 0; i < n; i += 1) {
        const filename = n === 1 ? `${baseName}.jpg` : `${baseName}-${String(i + 1).padStart(2, '0')}.jpg`;
        const fp = path.join(outputDir, filename);
        if (urls[i]) {
            const dl = await axios.get(urls[i], { responseType: 'arraybuffer', timeout: 120000, proxy: false });
            fs.writeFileSync(fp, Buffer.from(dl.data));
        } else if (base64s[i]) {
            fs.writeFileSync(fp, Buffer.from(String(base64s[i]), 'base64'));
        } else {
            break;
        }
        outputPaths.push(fp);
    }

    if (outputPaths.length === 0) {
        throw new MinimaxApiError('image 返回无有效图片数据', { kind: 'base_resp_error', payload: data });
    }

    return { outputPaths, prompt: body.prompt, elapsedMs: Date.now() - started };
}

// ────────────────── Video(Hailuo 异步)──────────────────

/**
 * 创建视频生成任务(异步)。成功返回 task_id。
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.firstFrameImage] 本地文件路径 or base64 data URL
 * @param {string} [p.model]
 * @param {number} [p.duration]        6 / 10(Hailuo 通常)
 * @param {string} [p.resolution]      '512P' / '768P' / '1080P'
 * @param {boolean} [p.promptOptimizer=true]
 * @returns {Promise<{taskId}>}
 */
async function createVideoTask(p = {}) {
    if (!p.prompt || !String(p.prompt).trim()) throw new MinimaxApiError('prompt 不能为空', { kind: 'invalid_input' });
    const body = {
        model: p.model || DEFAULTS.videoModel,
        prompt: String(p.prompt),
        prompt_optimizer: p.promptOptimizer !== false,
        ...(p.duration ? { duration: Number(p.duration) } : {}),
        ...(p.resolution ? { resolution: p.resolution } : {})
    };

    // first_frame_image:若给本地路径,读文件转 base64 data URL
    if (p.firstFrameImage) {
        const v = p.firstFrameImage;
        if (v.startsWith('data:image') || /^https?:/.test(v)) {
            body.first_frame_image = v;
        } else if (fs.existsSync(v)) {
            const ext = (path.extname(v) || '.jpg').slice(1).toLowerCase();
            const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
            const b64 = fs.readFileSync(v).toString('base64');
            body.first_frame_image = `data:${mime};base64,${b64}`;
        } else {
            throw new MinimaxApiError(`first_frame_image 不存在: ${v}`, { kind: 'invalid_input' });
        }
    }

    const data = await postJson(ENDPOINTS.video, body, { timeoutMs: p.timeoutMs || 60000 });
    checkBaseResp(data, 'video create');
    const taskId = data?.task_id || data?.data?.task_id;
    if (!taskId) throw new MinimaxApiError('未返回 task_id', { kind: 'base_resp_error', payload: data });
    return { taskId };
}

/**
 * 查询视频任务状态。
 * @returns {Promise<{status: 'Queueing'|'Preparing'|'Processing'|'Success'|'Fail', fileId, raw}>}
 */
async function queryVideoTask({ taskId } = {}) {
    if (!taskId) throw new MinimaxApiError('taskId 不能为空', { kind: 'invalid_input' });
    const data = await getJson(ENDPOINTS.videoQuery, { task_id: taskId }, { timeoutMs: 30000 });
    checkBaseResp(data, 'video query');
    const status = data?.status || data?.data?.status;
    const fileId = data?.file_id || data?.data?.file_id;
    return { status, fileId, raw: data };
}

/**
 * 下载 File API 里的文件。
 */
async function retrieveFile({ fileId, outputPath }) {
    if (!fileId) throw new MinimaxApiError('fileId 不能为空', { kind: 'invalid_input' });
    const data = await getJson(ENDPOINTS.files, { file_id: fileId }, { timeoutMs: 30000 });
    checkBaseResp(data, 'file retrieve');
    const url = data?.file?.download_url || data?.data?.download_url;
    if (!url) throw new MinimaxApiError('未返回 download_url', { kind: 'base_resp_error', payload: data });
    if (!outputPath) return { downloadUrl: url, raw: data };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000, proxy: false });
    fs.writeFileSync(outputPath, Buffer.from(dl.data));
    return { downloadUrl: url, outputPath, sizeBytes: dl.data.byteLength };
}

/**
 * 一键出视频:create → poll → download。
 * @param {object} p 透传到 createVideoTask,再加:
 * @param {string} p.outputPath     最终 mp4 路径(必填)
 * @param {number} [p.pollIntervalMs=6000]
 * @param {number} [p.maxWaitMs=600000]     10 min
 * @param {function} [p.onStatus({status, elapsedMs})]
 * @returns {Promise<{outputPath, taskId, fileId, sizeBytes, elapsedMs}>}
 */
async function generateVideoBlocking(p = {}) {
    if (!p.outputPath) throw new MinimaxApiError('outputPath 必填', { kind: 'invalid_input' });
    const started = Date.now();
    const { taskId } = await createVideoTask(p);

    const pollInterval = p.pollIntervalMs || 6000;
    const maxWait = p.maxWaitMs || 600000;
    while (true) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const elapsed = Date.now() - started;
        if (elapsed > maxWait) {
            throw new MinimaxApiError(`等待超过 ${Math.round(maxWait / 1000)}s 仍未完成`, {
                kind: 'timeout', hint: `task_id=${taskId},可稍后手动 query`
            });
        }
        const q = await queryVideoTask({ taskId });
        if (p.onStatus) p.onStatus({ status: q.status, elapsedMs: elapsed });
        if (q.status === 'Success' && q.fileId) {
            const out = await retrieveFile({ fileId: q.fileId, outputPath: p.outputPath });
            return {
                outputPath: out.outputPath, taskId, fileId: q.fileId,
                sizeBytes: out.sizeBytes, elapsedMs: Date.now() - started
            };
        }
        if (q.status === 'Fail') {
            throw new MinimaxApiError(`视频生成失败 task_id=${taskId}`, {
                kind: 'base_resp_error', payload: q.raw,
                hint: 'prompt 可能触发审核,或服务繁忙'
            });
        }
    }
}

// ────────────────── Music Cover / Lyrics ──────────────────
// 实测探测发现:
//   · music-cover 实际走 /v1/music_generation,body 里带 refer_audio(file_id) + lyrics;
//     refer_audio 的 file_id 需要先调 /v1/music_upload(multipart)上传音频获得。
//   · /v1/lyrics_generation path 存在(POST 返回 base_resp 2013 invalid_params),但 body
//     字段名穷举未中(prompt / desc / theme / topic / keywords / content 等都不对)。
// 在官方 doc 补完前,这两个方法把目前已知信息暴露给调用者,不做假实现。

/**
 * MiniMax-M2.7 文本对话生成(OpenAI 兼容 chat completions)
 *
 * @param {object} p
 * @param {Array<{role:string,content:string}>} p.messages  消息数组
 * @param {string} [p.model]                                默认 DEFAULTS.textModel (MiniMax-M2.7)
 * @param {number} [p.temperature=0.7]                      0-2,文章生成建议 0.6-0.8
 * @param {number} [p.topP=0.95]
 * @param {number} [p.maxCompletionTokens=4096]             ⚠️ M2.7 是 reasoning 模型,会先消耗 token 思考,
 *                                                          长文章必须给足(默认 4096,跟 OpenAI 标准 cap 2048 不同 —
 *                                                          实测 MiniMax 这边没有强制 2048 cap)
 * @param {number} [p.timeoutMs=180000]                     M2.7 推理+长文输出最长可能 2-3 分钟
 * @returns {Promise<{ content:string, reasoning:string, usage:object, raw:object }>}
 *   content: assistant 回复文本(已剥离 reasoning_content)
 *   reasoning: 推理过程文本(可选,长文场景一般不用)
 *   usage: { total_tokens, prompt_tokens, completion_tokens }
 *   raw: 完整响应体
 */
async function chatCompletion(p = {}) {
    const messages = Array.isArray(p.messages) ? p.messages : null;
    if (!messages || !messages.length) {
        throw new MinimaxApiError('messages 不能为空', { kind: 'invalid_input' });
    }
    for (const m of messages) {
        if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
            throw new MinimaxApiError('messages 每项需要 {role, content} 字符串', { kind: 'invalid_input', payload: m });
        }
    }
    const body = {
        model: p.model || DEFAULTS.textModel,
        messages,
        temperature: Number.isFinite(p.temperature) ? p.temperature : 0.7,
        top_p: Number.isFinite(p.topP) ? p.topP : 0.95,
        max_completion_tokens: Number.isFinite(p.maxCompletionTokens) ? p.maxCompletionTokens : 4096
    };
    const data = await postJson(ENDPOINTS.chat, body, { timeoutMs: p.timeoutMs || 180000 });
    checkBaseResp(data, 'chatCompletion');
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    if (!choice || !choice.message) {
        throw new MinimaxApiError('chat 响应缺 choices[0].message', { kind: 'base_resp_error', payload: data });
    }
    const content = String(choice.message.content || '').trim();
    const reasoning = String(choice.message.reasoning_content || '').trim();
    if (!content) {
        // finish_reason=length 且 completion_tokens_details.reasoning_tokens 全吃完 — 给的 max_completion_tokens 太小
        const reasonHint = choice.finish_reason === 'length'
            ? `推理 token 吃完 (reasoning_tokens=${data?.usage?.completion_tokens_details?.reasoning_tokens || '?'}),给 max_completion_tokens 加大`
            : '模型返回空 content,可能触发安全审查或参数异常';
        throw new MinimaxApiError(`chat content 为空: ${reasonHint}`, {
            kind: 'base_resp_error',
            hint: reasonHint,
            payload: { finish_reason: choice.finish_reason, usage: data?.usage }
        });
    }
    return { content, reasoning, usage: data?.usage || {}, raw: data };
}

async function generateMusicCover(/* p = {} */) {
    throw new MinimaxApiError('music-cover 待官方 doc 补完', {
        kind: 'not_implemented',
        hint: [
            '探测发现:走 POST /v1/music_generation,body 至少要 { model, refer_audio, lyrics }。',
            'refer_audio 需要先调 /v1/music_upload(multipart 上传音频)拿 file_id。',
            '官方 music-cover 完整 body spec 请以 https://platform.minimaxi.com 文档为准。',
            '待实现好后通过 minimaxClient.generateMusicCover 调用。'
        ].join('\n         ')
    });
}

async function generateLyrics(/* p = {} */) {
    throw new MinimaxApiError('lyrics 待官方 doc 补完', {
        kind: 'not_implemented',
        hint: [
            '探测发现:endpoint POST /v1/lyrics_generation 存在,任意 body 均返回 2013 invalid_params。',
            '正确字段名(可能是嵌套 setting / song object)需参考官方文档。',
            '官方 doc 就位后在 minimaxClient 补 body 即可。'
        ].join('\n         ')
    });
}

// ────────────────── 导出 ──────────────────

module.exports = {
    // 基础
    MinimaxApiError,
    checkApiKey,
    DEFAULTS,
    ENDPOINTS,
    // 能力
    textToSpeech,
    generateImage,
    createVideoTask,
    queryVideoTask,
    retrieveFile,
    generateVideoBlocking,
    chatCompletion,
    generateMusicCover,
    generateLyrics,
    // 内部(给测试用)
    _postJson: postJson,
    _getJson: getJson
};
