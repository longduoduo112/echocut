'use strict';

/**
 * 中→英 cross-lang bundle 生成器(对应品牌方案 7.3 节)
 *
 * 一条中文视频/seg,自动产出:
 *   - en-twitter-thread.md      5-7 条 Twitter thread(英文)
 *   - en-article.md              英文公众号/博客长文(800-1200 词)
 *   - en-hooks.md                5 个英文版钩子候选
 *
 * 单次 LLM 调用 JSON 输出,复用 distribute 的 extractJson 容错。
 *
 * 风格定位(来自品牌方案 5.2 Twitter / 1 海外表达):
 *   "Sovereign AI Builder — bootstrapping global SaaS from my own stack,
 *    publishing every pain and every dollar along the way."
 */

const { callChat } = require('./processor');
const { loadBrand } = require('./brandLoader');
const { extractJson } = require('./distributeGenerator');

// 支持的目标语言(中→X),每种带 prompt 本地化描述
const LANG_PROFILES = {
    en: {
        name: 'English',
        voice: 'indie hacker / builder-in-public. Think Pieter Levels, Marc Lou, Tibo.',
        taglineKey: 'taglineEn',
        taglineFallback: 'Sovereign AI Builder',
        realNameFallback: 'Bill Li',
        threadHashtags: '#buildinpublic #indiehackers #bootstrapping',
        cliches: 'no "In today\'s fast-paced world", no "It\'s worth noting", no "undoubtedly"',
        asciiGuardThreshold: 0.85
    },
    ja: {
        name: '日本語 (Japanese)',
        voice: 'solo entrepreneur / 一人起業家. Think Pieter Levels in Japanese tech Twitter.',
        taglineKey: 'taglineJa',
        taglineFallback: 'AI 時代のソブリン・ビルダー',
        realNameFallback: 'Bill Li',
        threadHashtags: '#個人開発 #indiehackers #bootstrapping',
        cliches: '避けるべき:「〜と言っても過言ではない」「〜に違いない」「まさしく」といった冗長表現',
        asciiGuardThreshold: 0 // 日语允许 kanji/kana
    },
    es: {
        name: 'Español (Spanish)',
        voice: 'indie hacker / emprendedor solitario. Think LatAm / Spanish dev Twitter.',
        taglineKey: 'taglineEs',
        taglineFallback: 'Constructor soberano de IA',
        realNameFallback: 'Bill Li',
        threadHashtags: '#buildinpublic #indiehackers #bootstrapping',
        cliches: 'no uses "en esta era vertiginosa", "sin lugar a dudas", "cabe destacar"',
        asciiGuardThreshold: 0.80 // 西语有 ñ/á/é 等非 ASCII
    }
};

function getLangProfile(lang) {
    return LANG_PROFILES[lang] || LANG_PROFILES.en;
}

function buildSystemPrompt(brand, targetLang = 'en') {
    const profile = getLangProfile(targetLang);
    const personaBase = brand?.llm?.personaBase || '';
    const tagline = brand?.identity?.[profile.taglineKey] || profile.taglineFallback;
    const realName = brand?.identity?.realName || brand?.identity?.name || profile.realNameFallback;

    return [
        personaBase,
        '',
        `You are now crafting the ${profile.name} twin of this Chinese creator. Persona: "${realName}" — ${tagline}.`,
        `Voice: ${profile.voice}`,
        '',
        `Task: given Chinese transcript + context, produce three ${profile.name} deliverables:`,
        '',
        '1. **hooks** — 5 punchy one-liners (each ≤80 chars). Each must grab attention in 2 seconds.',
        '   Styles (in order): contrarian / provocative / identity-reveal / number-driven / story-open',
        '',
        '2. **twitter_thread** — a 5-7 tweet thread. Each tweet ≤280 chars.',
        '   - Tweet 1/N: hook',
        '   - Middle tweets: concrete details (numbers, names, dollar amounts from transcript)',
        '   - Final tweet: insight + CTA (follow for more build-log)',
        '   - Use "1/N" prefix. Preserve concrete facts from the source.',
        '',
        `3. **article** — 800-1200 word ${profile.name} article for blog/Substack.`,
        '   - Structure: punchy opener / 3-4 subsections with concrete evidence / reflective close',
        '   - Builder voice: "I noticed", "we tried", "what I learned" — not "readers should"',
        `   - No LLM cliches: ${profile.cliches}`,
        '   - Keep ALL real details from source (places, numbers, names) — translate, don\'t abstract',
        '',
        'Hard rules:',
        `- ${profile.name} only for all three outputs. NO Chinese characters.`,
        '- Never invent facts not in the transcript. Translate reality.',
        '- Keep the indie/builder energy — numbers, dollar signs, transparency beats polished prose.',
        `- For hashtags in the thread, use ${profile.threadHashtags} as baseline.`,
        '',
        'Output format — STRICT JSON, no markdown fences outside:',
        '{',
        '  "hooks": ["...5 strings..."],',
        '  "twitter_thread": ["1/N ...", "2/N ...", ...],',
        '  "article": "full article markdown..."',
        '}'
    ].join('\n');
}

function buildUserPrompt({ rawText, context }) {
    const lines = [];
    lines.push(`[Source Chinese transcript] (${rawText.length} chars)`);
    lines.push(rawText);
    if (context && Object.keys(context).length) {
        lines.push('');
        lines.push('[Context]');
        if (context.title) lines.push(`- Working title: ${context.title}`);
        if (context.context_note) lines.push(`- Scene: ${context.context_note}`);
        if (context.value_note) lines.push(`- Core insight: ${context.value_note}`);
        if (context.hook_type) lines.push(`- hook_type: ${context.hook_type}`);
        if (context.narrative_arc) lines.push(`- Narrative arc: ${context.narrative_arc}`);
    }
    lines.push('');
    lines.push('Produce the JSON bundle now.');
    return lines.join('\n');
}

function normalizeBundle(raw) {
    return {
        hooks: Array.isArray(raw?.hooks) ? raw.hooks.map((s) => String(s).trim()).filter(Boolean).slice(0, 5) : [],
        twitter_thread: Array.isArray(raw?.twitter_thread) ? raw.twitter_thread.map((s) => String(s).trim()).filter(Boolean) : [],
        article: String(raw?.article || '').trim()
    };
}

// Stage 1: 把中文原稿翻译为目标语言。
// 原因:qwen3.5:9b 看到中文 input 强烈 bias 输出中文,
// 先翻译出一个 target-language-only 的中间层,Stage 2 全目标语言环境,输出正确语言的概率大增。
async function translateToTargetLang({ rawText, context, options, targetLang = 'en' }) {
    const profile = getLangProfile(targetLang);
    const systemPrompt = [
        `You are a professional translator (Chinese → ${profile.name}).`,
        `Translate the given Chinese transcript faithfully into natural, concise ${profile.name}.`,
        'Keep ALL concrete facts (names, numbers, dates, places, dollar amounts) exactly as stated.',
        `Use ${profile.name} idioms where natural, but do not invent or embellish.`,
        `Output ONLY the ${profile.name} translation. No preamble, no commentary, no Chinese characters.`
    ].join('\n');

    const userLines = ['Chinese source:', rawText];
    if (context && context.title) userLines.push('', `Working title: ${context.title}`);
    if (context && context.context_note) userLines.push(`Scene: ${context.context_note}`);
    userLines.push('', `Now output the ${profile.name} translation only.`);

    const output = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userLines.join('\n') }
    ]);
    return String(output || '').trim();
}

// 向后兼容(旧 API)
async function translateToEnglish(params) {
    return translateToTargetLang({ ...params, targetLang: 'en' });
}

// 粗略判断一段文本是不是基本无中文(用于验证 Stage 1 输出没有 fallback 中文)
// 中文 → 英文:检查 ASCII 占比 ≥ threshold
// 中文 → 日文:日文允许 kanji,只检查是否没有明显的"中文独有"表达 — 放宽到仅检查 ASCII+假名+汉字占比
// 中文 → 西文:西文有 ñ/á/é 等非 ASCII,阈值放宽
function isMostlyTargetLang(text, targetLang = 'en') {
    if (!text) return false;
    const s = String(text);
    const total = s.length;
    if (total === 0) return false;
    if (targetLang === 'ja') {
        // 日文:允许 ASCII、Hiragana(U+3040-U+309F)、Katakana(U+30A0-U+30FF)、CJK 汉字
        // 但要求 Hiragana + Katakana 占比 >= 10%(确保真是日文而非纯中文)
        const kana = (s.match(/[぀-ヿ]/g) || []).length;
        return (kana / total) >= 0.10;
    }
    // en / es 默认用 ASCII 占比
    const threshold = getLangProfile(targetLang).asciiGuardThreshold || 0.85;
    const asciiLike = (s.match(/[\x20-\x7E\r\n\t¡¿áéíóúñÑÁÉÍÓÚ]/g) || []).length;
    return (asciiLike / total) >= threshold;
}

// 向后兼容
function isMostlyEnglish(text, threshold = 0.85) {
    return isMostlyTargetLang(text, 'en');
}

async function generateCrossLangBundle({ rawText, context, options, brand, targetLang = 'en', onProgress }) {
    const brandObj = brand || (() => { try { return loadBrand(); } catch (_) { return null; } })();
    const profile = getLangProfile(targetLang);

    // Stage 1: translate Chinese → target lang
    if (onProgress) onProgress('stage1:translate');
    const targetSource = await translateToTargetLang({ rawText, context, options, targetLang });
    if (!isMostlyTargetLang(targetSource, targetLang)) {
        const err = new Error(`Stage 1 翻译输出仍含大量中文,未能完成 ${profile.name} 翻译(建议 --model deepseek-r1:14b)`);
        err.rawOutput = targetSource;
        throw err;
    }

    // Stage 2: 基于目标语言原稿生成 bundle
    if (onProgress) onProgress('stage2:bundle');
    const systemPrompt = buildSystemPrompt(brandObj, targetLang);
    const userPrompt = buildUserPrompt({ rawText: targetSource, context: context || {} });
    const rawOutput = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
    const parsed = extractJson(rawOutput);
    if (!parsed) {
        const err = new Error('Stage 2 LLM 输出未能解析出 JSON');
        err.rawOutput = rawOutput;
        err.targetSource = targetSource;
        throw err;
    }
    const bundle = normalizeBundle(parsed);
    if (!bundle.article || (!bundle.twitter_thread.length && !bundle.hooks.length)) {
        const err = new Error('Stage 2 LLM 输出缺失关键字段(article / thread / hooks)');
        err.rawOutput = rawOutput;
        err.partial = bundle;
        err.targetSource = targetSource;
        throw err;
    }
    const allBundleText = [bundle.article, bundle.twitter_thread.join('\n'), bundle.hooks.join('\n')].join('\n');
    if (!isMostlyTargetLang(allBundleText, targetLang)) {
        const err = new Error(`Stage 2 输出包含大量中文,LLM 未遵循 ${profile.name} only(建议 --model deepseek-r1:14b)`);
        err.rawOutput = rawOutput;
        err.partial = bundle;
        err.targetSource = targetSource;
        throw err;
    }
    // 向后兼容 enSource 字段名
    return { bundle, rawOutput, targetSource, enSource: targetSource, targetLang };
}

function renderHooksMd(bundle, context = {}) {
    const lines = [];
    lines.push('# English Hooks · 5 candidates');
    lines.push('');
    if (context.title) lines.push(`> Source: ${context.title}`);
    lines.push('');
    bundle.hooks.forEach((h, i) => {
        lines.push(`## #${i + 1}`);
        lines.push('');
        lines.push(h);
        lines.push('');
    });
    return lines.join('\n');
}

function renderThreadMd(bundle, context = {}) {
    const lines = [];
    lines.push('# English Twitter Thread');
    lines.push('');
    if (context.title) lines.push(`> Source: ${context.title}`);
    lines.push('');
    bundle.twitter_thread.forEach((t, i) => {
        lines.push(`### Tweet ${i + 1}`);
        lines.push('');
        lines.push(t);
        lines.push('');
    });
    lines.push('---');
    lines.push('');
    lines.push('Ready to copy-paste into X.com. First tweet usually lands best 09:00 or 17:00 PT.');
    return lines.join('\n');
}

function renderArticleMd(bundle, context = {}) {
    const lines = [];
    lines.push('---');
    if (context.title) lines.push(`source_title_zh: ${context.title}`);
    if (context.context_note) lines.push(`context: ${context.context_note}`);
    lines.push(`generated_at: ${new Date().toISOString()}`);
    lines.push('language: en');
    lines.push('---');
    lines.push('');
    lines.push(bundle.article);
    return lines.join('\n');
}

module.exports = {
    generateCrossLangBundle,
    renderHooksMd,
    renderThreadMd,
    renderArticleMd,
    normalizeBundle,
    LANG_PROFILES,
    getLangProfile,
    isMostlyTargetLang
};
