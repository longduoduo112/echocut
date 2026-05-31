'use strict';

/**
 * 钩子候选生成器(对应品牌方案第 6 节缺陷 1"钩子太软")
 *
 * 给定口播原稿(+ 可选的 seg 语境),让 LLM 生成 5 个风格不同的前 3 秒钩子。
 *
 * 5 种风格:
 *   1. 反常识   — 挑战固有认知("别再 / 不是 / 其实")
 *   2. 挑衅式   — 尖锐对立、数字威胁("90% 会死")
 *   3. 自报家门 — 反差身份引发好奇("从...到...只做 X")
 *   4. 数字悬念 — 具体数字 + 留悬念("+N 用户 / 只做 1 件事")
 *   5. 故事开场 — 时间/地点钩子("那个深夜 / 那年冬天")
 */

const { callChat } = require('./processor');
const { loadBrand } = require('./brandLoader');

const HOOK_STYLES = [
    { key: 'antithesis', name: '反常识', rule: '挑战读者固有认知,用"别再"/"不是"/"其实"等词开头,打破共识' },
    { key: 'provocative', name: '挑衅式', rule: '抛出尖锐对立/风险/预警(如"90% 会死"),读者不看就难受' },
    { key: 'identity', name: '自报家门', rule: '用反差身份引发好奇(如"从流水线工人到 HK 演讲")' },
    { key: 'number', name: '数字悬念', rule: '给一个具体数字但留悬念(如"+N 个用户/只做 1 件事")' },
    { key: 'story', name: '故事开场', rule: '时间/地点/场景钩子,让人想知道"然后呢"(如"那个深夜")' }
];

function buildSystemPrompt() {
    let personaBase = '';
    try {
        const brand = loadBrand();
        personaBase = brand?.llm?.personaBase || '';
    } catch (_) { /* fallback 兜空 */ }

    const styleLines = HOOK_STYLES
        .map((s, i) => `${i + 1}. ${s.name} — ${s.rule}`)
        .join('\n');

    return [
        personaBase,
        '',
        '你是一个短视频钩子策划人。给定一段口播原稿(也许带语境标签),',
        '输出 5 个不同风格的"前 3 秒钩子",每个 15-30 个汉字,',
        '必须一句话让读者停下滑动。',
        '',
        '5 种风格(严格按顺序产出,不可跳过、不可合并):',
        styleLines,
        '',
        '输出格式(严格遵守,markdown 风格):',
        '=== #1 反常识 ===',
        '<钩子文本>',
        '',
        '=== #2 挑衅式 ===',
        '<钩子文本>',
        '',
        '=== #3 自报家门 ===',
        '<钩子文本>',
        '',
        '=== #4 数字悬念 ===',
        '<钩子文本>',
        '',
        '=== #5 故事开场 ===',
        '<钩子文本>',
        '',
        '硬约束:',
        '- 每个钩子只基于原稿真实内容,不编造事实(地名/金额/人物必须来自原稿)',
        '- 不使用 AI 套话(如"在这个...时代"、"毋庸置疑"、"让我们探索")',
        '- 每个风格打不同卖点,不重复',
        '- 不加 emoji、不加 1️⃣、不加引号、不加 markdown bold'
    ].join('\n');
}

function buildUserPrompt({ rawText, context }) {
    const pieces = [];
    pieces.push(`【原稿】(${rawText.length} 字)`);
    pieces.push(rawText);
    if (context && Object.keys(context).length) {
        pieces.push('');
        pieces.push('【语境】');
        if (context.title) pieces.push(`- 候选标题: ${context.title}`);
        if (context.context_note) pieces.push(`- 场景: ${context.context_note}`);
        if (context.value_note) pieces.push(`- 核心价值: ${context.value_note}`);
        if (context.hook_type) pieces.push(`- 本段 hook_type: ${context.hook_type}`);
        if (Array.isArray(context.tags) && context.tags.length) {
            pieces.push(`- 关键词: ${context.tags.join('、')}`);
        }
    }
    pieces.push('');
    pieces.push('请输出 5 个钩子候选,严格按格式。');
    return pieces.join('\n');
}

/**
 * 解析 LLM 输出 → { style, name, text }[]
 * 容错:正则找 "=== #N <名> ===",抓下方第一行非空内容。
 */
function parseHooks(raw) {
    const blocks = String(raw || '').split(/===\s*#(\d+)\s+([^=]+?)\s*===/g);
    // 切分后结构: [before, idx1, name1, body1, idx2, name2, body2, ...]
    const out = [];
    for (let i = 1; i + 2 < blocks.length; i += 3) {
        const idx = Number(blocks[i]);
        const name = String(blocks[i + 1] || '').trim();
        const body = String(blocks[i + 2] || '').trim();
        // 取第一段非空内容
        const text = body.split('\n').map((x) => x.trim()).find((x) => x) || '';
        if (!text) continue;
        const style = HOOK_STYLES[idx - 1] || { key: 'unknown', name };
        out.push({ idx, style: style.key, name: style.name, text: text.replace(/^[「『"]|[」』"]$/g, '').trim() });
    }
    return out;
}

async function generateHooks({ rawText, context, options }) {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({ rawText, context: context || {} });
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];
    const rawOutput = await callChat(options, messages);
    const hooks = parseHooks(rawOutput);
    return { hooks, rawOutput };
}

// 两段文本相似度(字符级 set overlap),> 0.7 视为重复
function similarity(a, b) {
    if (!a || !b) return 0;
    const sa = new Set(Array.from(String(a).replace(/\s+/g, '')));
    const sb = new Set(Array.from(String(b).replace(/\s+/g, '')));
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const c of sa) if (sb.has(c)) inter += 1;
    const union = sa.size + sb.size - inter;
    return inter / union;
}

// 去重:完全相同或相似度 > 0.7 视为重复,保留先来的
function dedupeHooks(hooks, simThreshold = 0.7) {
    const out = [];
    for (const h of hooks) {
        const seen = out.some((e) => similarity(e.text, h.text) > simThreshold);
        if (!seen) out.push(h);
    }
    return out;
}

/**
 * A/B 模式:跑 N 轮,每轮 5 候选,合并 + 去重,取 Top K。
 * rounds=1 时退化为 generateHooks。
 */
async function generateHooksMultiRound({ rawText, context, options, rounds = 1, topK = 5, onRoundDone }) {
    const allHooks = [];
    const allRaw = [];
    for (let r = 1; r <= rounds; r += 1) {
        const { hooks, rawOutput } = await generateHooks({ rawText, context, options });
        // 每个 hook 加上轮次标签,方便 trace
        for (const h of hooks) allHooks.push({ ...h, round: r });
        allRaw.push(rawOutput);
        if (typeof onRoundDone === 'function') onRoundDone(r, hooks.length, allHooks.length);
    }
    // 先按风格分组(保证 5 风格都覆盖),每组内去重,取最短(越短越有冲击力)
    const byStyle = new Map();
    for (const h of allHooks) {
        const arr = byStyle.get(h.style) || [];
        arr.push(h);
        byStyle.set(h.style, arr);
    }
    const deduped = [];
    for (const [, arr] of byStyle) {
        const unique = dedupeHooks(arr);
        // 每个风格取最短的 1 个(更冲击)
        unique.sort((a, b) => a.text.length - b.text.length);
        if (unique[0]) deduped.push(unique[0]);
    }
    // 按原始 idx 排序(反常识→挑衅→身份→数字→故事)
    deduped.sort((a, b) => (a.idx || 0) - (b.idx || 0));
    return { hooks: deduped.slice(0, topK), allHooks, rawOutputs: allRaw };
}

module.exports = { generateHooks, generateHooksMultiRound, parseHooks, dedupeHooks, similarity, HOOK_STYLES };
