const fs = require('fs');
const axios = require('axios');
const { getConfigValue, DEFAULT_CONFIGS } = require('../db/configRepo');
const { loadBrand } = require('./brandLoader');
const {
    PERSONA_BASE,
    ARTICLE_MODES,
    MOMENTS_PROMPT,
    XIAOHONGSHU_PROMPT,
    DOUYIN_PROMPT,
    VIDEO_METADATA_PROMPT,
    VIDEO_PUBLISH_PROMPT,
    CAPTION_EMPHASIS_PROMPT
} = require('./promptLibrary');

/**
 * 从当前 brand 读取所有 LLM prompts,brand.llm.xxx 优先,硬编码兜底。
 * 每次调用都读一次(brand 已带模块级缓存,成本极低)。
 */
function getBrandPrompts() {
    let brand = null;
    try { brand = loadBrand(); } catch (_) { /* 兜底到硬编码 */ }
    const llm = brand?.llm || {};
    return {
        personaBase: llm.personaBase || PERSONA_BASE,
        articleModes: llm.articleModes || ARTICLE_MODES,
        momentsPrompt: llm.momentsPrompt || MOMENTS_PROMPT,
        videoMetadataPrompt: llm.videoMetadataPrompt || VIDEO_METADATA_PROMPT,
        videoMetadataPersona: llm.videoMetadataPersona || `${llm.personaBase || PERSONA_BASE}\n你是${brand?.identity?.name || 'Example'}的视频标题策划。`,
        captionEmphasisPrompt: llm.captionEmphasisPrompt || CAPTION_EMPHASIS_PROMPT,
        videoPublishPrompt: llm.videoPublishPrompt || VIDEO_PUBLISH_PROMPT,
        xiaohongshuPrompt: llm.xiaohongshuPrompt || XIAOHONGSHU_PROMPT,
        douyinPrompt: llm.douyinPrompt || DOUYIN_PROMPT
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
    const code = String(error?.code || '');
    if (code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return true;
    const status = Number(error?.response?.status || 0);
    return status >= 500 && status < 600;
}

function parseBoolean(raw, fallback = false) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return fallback;
}

async function callChat(options, messages) {
    const retries = Math.max(0, Number(options.ollamaRetries || 0));
    const timeout = Math.max(10000, Number(options.ollamaTimeoutMs || 120000));
    const think = parseBoolean(
        getConfigValue('ollama_think', options.ollamaThink ? '1' : '0'),
        Boolean(options.ollamaThink)
    );
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await axios.post(options.ollamaUrl, {
                model: options.ollamaModel,
                messages,
                stream: false,
                think
            }, { timeout, proxy: false });
            return response.data.message.content;
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !isRetryable(error)) break;
            await delay((attempt + 1) * 1500);
        }
    }
    throw lastError;
}

/**
 * 获取文章生成的 system prompt
 * 优先使用 promptLibrary 中的模式 prompt，fallback 到 configRepo
 */
function getArticleSystemPrompt(mode) {
    const brandPrompts = getBrandPrompts();
    const modeConfig = brandPrompts.articleModes && brandPrompts.articleModes[mode];
    if (modeConfig) return modeConfig.system;
    // fallback: 使用 configRepo 中的配置(兼容管理后台自定义)
    const promptSystem = getConfigValue('prompt_system', DEFAULT_CONFIGS.prompt_system);
    const officialAccountPrompt = getConfigValue('official_account_prompt', DEFAULT_CONFIGS.official_account_prompt || DEFAULT_CONFIGS.prompt_system);
    const styleGuide = getConfigValue('style_guide', DEFAULT_CONFIGS.style_guide);
    return `${promptSystem}\n\n${officialAccountPrompt}\n\n风格指南：\n${styleGuide}`;
}

/**
 * 获取朋友圈生成的 system prompt
 */
function getMomentsSystemPrompt() {
    return getBrandPrompts().momentsPrompt;
}

async function generateArticle(rawText, options, mode = 'default') {
    const systemPrompt = getArticleSystemPrompt(mode);
    return await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `这是我刚才的原始思考，请改写为公众号长文：\n\n${rawText}` }
    ]);
}

async function generateMoments(rawText, draftArticle, options) {
    const systemPrompt = getMomentsSystemPrompt();
    return await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `原始素材：\n${rawText}\n\n长文草稿：\n${draftArticle}\n\n请输出朋友圈文案（3个版本）：` }
    ]);
}

async function generateContentBundle(rawText, options, mode = 'default') {
    const draftArticle = await generateArticle(rawText, options, mode);
    const hookMoment = await generateMoments(rawText, draftArticle, options);
    return { draftArticle, hookMoment };
}

// 从口播转写里发现"爆点词",合并到字幕高亮词典,让字幕高亮真正对上这个视频的语境。
// 失败返回空数组(上层 fallback 到静态 preset emphasisWords)。
async function extractEmphasisKeywords(rawText, options) {
    const text = String(rawText || '').trim();
    if (!text) return [];
    // 3000 字以内,保证 prompt 不过载
    const trimmed = text.slice(0, 3000);
    let response;
    try {
        response = await callChat(options, [
            { role: 'system', content: getBrandPrompts().captionEmphasisPrompt },
            { role: 'user', content: `口播转写文本:\n${trimmed}` }
        ]);
    } catch (err) {
        console.error('[emphasis] LLM 调用失败:', err.message || err);
        return [];
    }
    const raw = String(response || '').replace(/```json|```/g, '').trim();
    // 1. 完整 JSON parse
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.keywords)) return normalizeKeywords(parsed.keywords);
    } catch (_) { /* fallthrough */ }
    // 2. substring 提取 {...}
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(raw.slice(start, end + 1));
            if (Array.isArray(parsed?.keywords)) return normalizeKeywords(parsed.keywords);
        } catch (_) { /* fallthrough */ }
    }
    console.error('[emphasis] JSON parse 失败,原始响应:', raw.slice(0, 200));
    return [];
}

function normalizeKeywords(raw) {
    return (raw || [])
        .map((x) => String(x || '').trim().replace(/[,。!?、;:""''「」『』()《》【】\s·—…]/g, ''))
        .filter((x) => x && x.length >= 2 && x.length <= 6)  // 2-6 字(留余量)
        .filter((x, i, arr) => arr.indexOf(x) === i)
        .slice(0, 40);  // 最多 40 个,防止 LLM 失控
}

async function generateVideoMetadata(rawText, options) {
    const bp = getBrandPrompts();
    const prompt = `${bp.videoMetadataPrompt}\n\n内容：\n${rawText}`;

    const response = await callChat(options, [
        { role: 'system', content: bp.videoMetadataPersona },
        { role: 'user', content: prompt }
    ]);

    const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        console.error('JSON parse failed for video metadata:', String(response).slice(0, 200));
        throw new Error(`metadata_parse_failed: ${e.message}`);
    }
    if (!parsed || typeof parsed.headline !== 'string' || typeof parsed.subline !== 'string') {
        throw new Error('metadata_invalid_shape');
    }
    if (!parsed.headline.trim() || !parsed.subline.trim()) {
        throw new Error('metadata_empty_fields');
    }
    return parsed;
}

/**
 * 从可能截断的 JSON 中提取完整的 group 对象。
 * Ollama 输出有 token 上限，4组×120字的 JSON 可能被截断。
 * 逐字符扫描，找到每个完整的 {title, description} 对象。
 */
function repairPublishKitGroups(raw) {
    const str = raw.replace(/```json|```/g, '').trim();
    // 1. 优先完整 JSON.parse
    try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed?.groups)) return parsed.groups;
    } catch (_) {}
    // 2. 修复：逐字符扫描，提取所有完整的 {...} 对象
    const groups = [];
    let pos = 0;
    while (pos < str.length) {
        const start = str.indexOf('{', pos);
        if (start < 0) break;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let end = -1;
        for (let i = start; i < str.length; i++) {
            if (esc) { esc = false; continue; }
            if (str[i] === '\\' && inStr) { esc = true; continue; }
            if (str[i] === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (str[i] === '{') depth++;
            if (str[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) { pos = start + 1; continue; } // 跳过不完整的外层容器，继续找内层对象
        try {
            const obj = JSON.parse(str.slice(start, end + 1));
            if (typeof obj.title === 'string' && typeof obj.description === 'string') {
                groups.push(obj);
            }
        } catch (_) {}
        pos = end + 1;
    }
    return groups;
}

/**
 * 截断 Whisper 幻觉循环：当某个 token 连续出现 5 次以上时视为幻觉，在第一次出现前截断。
 * 常见模式："weeks weeks weeks weeks weeks..." 或 "我走了 我走了 我走了..."
 */
function stripHallucinatedLoop(text) {
    const match = /(\S+)(\s+\1){4,}/i.exec(text);
    if (!match) return text;
    return text.slice(0, match.index).trimEnd();
}

// 生成宣发素材包：4组标题+简介(含#标签)，供各平台直接使用
// commandHeadline 为已烧录到视频的标题，可作为组一参考
async function generatePublishKit(transcript, commandHeadline, options) {
    // 先截断幻觉循环，再限制 2000 字
    const text = stripHallucinatedLoop(String(transcript || '')).slice(0, 2000);
    if (!text.trim()) return [];
    const userMsg = commandHeadline
        ? `命令标题（已烧录到视频）：${commandHeadline}\n\n视频转写内容：\n${text}`
        : `视频转写内容：\n${text}`;

    // 两次尝试(LLM 偶发输出格式不稳,retry 一次能救回 70%+)
    let lastRaw = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await callChat(options, [
                { role: 'system', content: getBrandPrompts().videoPublishPrompt },
                { role: 'user', content: userMsg + (attempt > 0 ? '\n\n注意:严格按 JSON 格式 {"groups":[...]} 输出,不要加任何解释。' : '') }
            ]);
            lastRaw = response;
            const groups = repairPublishKitGroups(response);
            const valid = groups
                .slice(0, 4)
                .filter((g) => g && typeof g.title === 'string' && typeof g.description === 'string');
            if (valid.length >= 1) {
                if (attempt > 0) console.log(`[publish] 第 2 次 retry 成功 (${valid.length} 组)`);
                return valid;
            }
            if (attempt === 0) {
                console.warn('[publish] 第 1 次 parse 失败,retry...  raw 前 200:', response.slice(0, 200));
            }
        } catch (err) {
            console.warn('[publish] attempt', attempt + 1, '失败:', String(err.message || err).slice(0, 120));
        }
    }

    // 两次都失败:启发式兜底(从 transcript 抽 4 条短句当标题)
    console.warn('[publish] 两次 LLM parse 都失败,启用启发式兜底。最后一次 raw:\n' + lastRaw.slice(0, 500));
    const fallback = heuristicPublishKit(text, commandHeadline);
    if (fallback.length) {
        console.log(`[publish] 启发式兜底产出 ${fallback.length} 组(质量不如 LLM,人工审核用)`);
    }
    return fallback;
}

// 启发式兜底:从 transcript 抽 4 条短句当标题,简介用首段 + 标签
// 质量不如 LLM,但总比返回空数组强
function heuristicPublishKit(text, commandHeadline = '') {
    if (!text || text.length < 50) return [];
    // 按 句号/问号/感叹号/分号 切句,过滤太短/太长
    const sentences = String(text)
        .split(/[。!?！？;；]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && s.length <= 30);
    if (!sentences.length) return [];
    // 取前 4 个有信息量的(含数字/专名/钩子词优先)
    const scored = sentences.map((s) => {
        let score = s.length; // 基础分
        if (/\d/.test(s)) score += 20; // 含数字
        if (/[A-Za-z]{3,}/.test(s)) score += 10; // 含英文名词
        if (/不是|其实|原来|居然|竟然|就是/.test(s)) score += 15; // 反差词
        return { text: s, score };
    }).sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 4).map((x) => x.text);
    const firstChunk = text.slice(0, 120).trim();
    const fallbackTags = ['#一人公司', '#数字游民', '#AI创业', '#独立开发'];
    return top.map((title, i) => ({
        title: (commandHeadline && i === 0 ? commandHeadline : title).slice(0, 15),
        description: `${firstChunk}... ${fallbackTags.join(' ')}`
    }));
}

/**
 * 解析小红书/抖音 JSON 输出，容错处理截断情况
 */
function repairPlatformJson(raw, requiredFields) {
    const str = String(raw || '').replace(/```json|```/g, '').trim();
    // 1. 完整解析
    try {
        const parsed = JSON.parse(str);
        if (requiredFields.every((f) => parsed[f] !== undefined)) return parsed;
    } catch (_) {}
    // 2. 逐字符找最外层 {}
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    let end = -1;
    for (let i = 0; i < str.length; i++) {
        if (esc) { esc = false; continue; }
        if (str[i] === '\\' && inStr) { esc = true; continue; }
        if (str[i] === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (str[i] === '{') { if (depth === 0) start = i; depth++; }
        if (str[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(str.slice(start, end + 1));
            if (requiredFields.every((f) => parsed[f] !== undefined)) return parsed;
        } catch (_) {}
    }
    return null;
}

/**
 * 生成小红书图文笔记
 * 返回 { title, body, tags } 或 null
 */
async function generateXiaohongshu(text, options) {
    const cleanText = stripHallucinatedLoop(String(text || '')).slice(0, 2000);
    if (!cleanText.trim()) return null;
    const response = await callChat(options, [
        { role: 'system', content: getBrandPrompts().xiaohongshuPrompt },
        { role: 'user', content: `请根据以下内容生成小红书图文笔记：\n\n${cleanText}` }
    ]);
    const parsed = repairPlatformJson(response, ['title', 'body', 'tags']);
    if (!parsed) {
        console.error('[xiaohongshu] JSON parse failed, raw length:', response.length, '\nraw:', response.slice(0, 300));
        return null;
    }
    return {
        title: String(parsed.title || '').slice(0, 60),
        body: String(parsed.body || '').slice(0, 1200),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5).map((t) => String(t)) : []
    };
}

/**
 * 生成抖音/视频号描述文案
 * 返回 { desc, tags } 或 null
 */
async function generateDouyinDesc(text, options) {
    const cleanText = stripHallucinatedLoop(String(text || '')).slice(0, 2000);
    if (!cleanText.trim()) return null;
    const response = await callChat(options, [
        { role: 'system', content: getBrandPrompts().douyinPrompt },
        { role: 'user', content: `请根据以下内容生成抖音/视频号描述文案：\n\n${cleanText}` }
    ]);
    const parsed = repairPlatformJson(response, ['desc', 'tags']);
    if (!parsed) {
        console.error('[douyin] JSON parse failed, raw length:', response.length, '\nraw:', response.slice(0, 300));
        return null;
    }
    return {
        desc: String(parsed.desc || '').slice(0, 200),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3).map((t) => String(t)) : []
    };
}

async function processOriginalThought(rawText, options, mode = 'default') {
    const { draftArticle } = await generateContentBundle(rawText, options, mode);
    return draftArticle;
}

/**
 * 用本地视觉模型（minicpm-v / deepseek-ocr）分析图片内容
 * 优先提取文字；无文字时输出画面描述，供后续内容生成使用
 */
async function analyzeImage(imagePath, options) {
    const model = String(options.ollamaVisionModel || process.env.OLLAMA_VISION_MODEL || 'minicpm-v:latest');
    const timeout = Math.max(30000, Number(options.ollamaTimeoutMs || 120000));
    const imageBase64 = fs.readFileSync(imagePath).toString('base64');
    const prompt = '请识别并提取图片中所有可见文字（OCR）。如果图片以文字为主，直接输出全部文字，保持原有段落结构；如果文字较少或无文字，简要描述画面内容（不超过200字）。只输出提取结果，不要解释或说明。';
    const response = await axios.post(options.ollamaUrl, {
        model,
        messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
        stream: false
    }, { timeout, proxy: false });
    return String(response.data?.message?.content || '').trim();
}

/**
 * 用 LLM 纠正转写字幕中的错别字。
 * 输入：字幕段落数组 [{start, end, text}, ...]
 * 输出：同结构数组，text 已纠错（时间戳不变）
 * 分批处理避免单次上下文过长，每批 ~800 字。
 */
// 字幕纠错防错位守卫:错别字/同音字纠错是等长的(一个字换一个字)。
// 若 LLM 违反"不合并/拆分/增删行"指令、把文本跨行重排,纠错后文本会变长/变短,
// 贴回原时间窗就会错位(字幕跑在音频前/后)。长度相对原文偏差过大时拒绝该行纠错、
// 保留原文本以保住时间对齐。小幅增删(≤4 字且 ≤30%,容纳如 We点AI→WUI.AI)仍接受。
function acceptCaptionFix(orig, fixed) {
    if (typeof fixed !== 'string' || !fixed) return false;
    const o = String(orig || '');
    const delta = Math.abs(fixed.length - o.length);
    if (delta > 4 && delta > o.length * 0.3) return false;
    return true;
}

async function correctCaptions(captions, options) {
    if (!Array.isArray(captions) || !captions.length) return captions;

    // brand.typoFixes 硬规则:LLM 前先过一遍让纠错 LLM 基于正确上下文判断,
    // LLM 后再过一遍兜底(避免 LLM 把品牌专有名词改坏)。
    let typoFixes = {};
    try {
        const { loadBrand } = require('./brandLoader');
        const brand = loadBrand();
        if (brand && typeof brand.typoFixes === 'object' && brand.typoFixes) {
            typoFixes = brand.typoFixes;
        }
    } catch (_) { /* 兜底为空 */ }
    const applyTypoFixes = (text) => {
        let out = String(text || '');
        for (const [wrong, right] of Object.entries(typoFixes)) {
            if (!wrong) continue;
            out = out.split(wrong).join(right);
        }
        return out;
    };
    const pre = Object.keys(typoFixes).length
        ? captions.map((c) => ({ ...c, text: applyTypoFixes(c.text) }))
        : captions;

    const BATCH_CHAR_LIMIT = 800;
    const batches = [];
    let currentBatch = [];
    let currentLen = 0;
    for (const cap of pre) {
        const len = (cap.text || '').length;
        if (currentBatch.length && currentLen + len > BATCH_CHAR_LIMIT) {
            batches.push(currentBatch);
            currentBatch = [];
            currentLen = 0;
        }
        currentBatch.push(cap);
        currentLen += len;
    }
    if (currentBatch.length) batches.push(currentBatch);

    const corrected = [];
    for (const batch of batches) {
        const lines = batch.map((c, i) => `${i}|${c.text}`);
        const prompt = lines.join('\n');
        try {
            const response = await callChat(options, [
                {
                    role: 'system',
                    content: '你是中文字幕纠错助手。用户输入格式为"序号|字幕文本"，每行一条。'
                        + '请逐行修正明显的错别字、同音字误识别，保持原意和口语风格不变。'
                        + '不要添加标点、不要合并或拆分行、不要改变语序、不要润色。'
                        + '输出格式与输入完全相同："序号|修正后文本"，每行一条，不要输出任何其他内容。'
                },
                { role: 'user', content: prompt }
            ]);
            const correctedMap = {};
            for (const line of String(response).split('\n')) {
                const sep = line.indexOf('|');
                if (sep <= 0) continue;
                const idx = parseInt(line.slice(0, sep), 10);
                const text = line.slice(sep + 1).trim();
                if (!isNaN(idx) && text) correctedMap[idx] = text;
            }
            for (let i = 0; i < batch.length; i++) {
                const orig = batch[i].text || '';
                const fixed = acceptCaptionFix(orig, correctedMap[i]) ? correctedMap[i] : orig;
                corrected.push({ ...batch[i], text: fixed });
            }
        } catch (err) {
            console.error('[correctCaptions] LLM batch failed, using original:', err.message);
            corrected.push(...batch);
        }
    }
    // LLM 后再过一遍 typoFixes 兜底(防 LLM 把已修好的品牌词改回错词)
    if (Object.keys(typoFixes).length) {
        return corrected.map((c) => ({ ...c, text: applyTypoFixes(c.text) }));
    }
    return corrected;
}

module.exports = { processOriginalThought, generateContentBundle, generateArticle, generateMoments, generateVideoMetadata, generatePublishKit, generateXiaohongshu, generateDouyinDesc, analyzeImage, stripHallucinatedLoop, correctCaptions, acceptCaptionFix, extractEmphasisKeywords, callChat };
