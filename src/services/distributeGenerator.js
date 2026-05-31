'use strict';

/**
 * 多平台分发包生成器(对应品牌方案 7.1 节"一次内容,十倍分发")
 *
 * 输入一段 seg 内容 + 语境,一次 LLM 调用产出五个平台的独立文案包:
 *   douyin   · 纯钩子观点,硬核 hashtag
 *   kuaishou · 方言/接地气,B+C 混合
 *   xhs      · 小红书,情感/女性视角,首图精致
 *   channel  · 视频号,熟人圈,BGM 固定
 *   gzh      · 公众号,长文思考,周刊化 CTA
 *   twitter  · 纯英文,builder 视角
 *
 * 每个平台给:titles[3] · description · hashtags[] · posting_tip · cover_suggestion
 */

const { callChat } = require('./processor');
const { loadBrand } = require('./brandLoader');

const PLATFORMS = [
    {
        key: 'douyin',
        name: '抖音',
        rule: '观众滑得快,开头 3 秒反常识或数字悬念钩子。' +
              '标题大字号,前 12 字决定生死。描述尽量口语,配 5-8 个硬核 hashtag' +
              '(如 #AI创业 #主权个人 #Bootstrap #数字游民)。封面一张大字标题图。'
    },
    {
        key: 'kuaishou',
        name: '快手',
        rule: '接地气,不包装精英,B+C 混合(观点+真实)。' +
              '语气多用方言口语,讲工厂/草根/反差故事。标题避开高大上词。' +
              'hashtag 5-8 个,偏生活(如 #工厂 #草根创业 #打工人逆袭)。'
    },
    {
        key: 'xhs',
        name: '小红书',
        rule: 'C 类情感为主,女性视角,数字游民爸爸人设。' +
              '标题要有情绪/数字/emoji(最多 2 个),如 "📍出差爸爸不错过孩子的每一天｜30 天复盘"。' +
              '首图建议用真实生活照(酒店窗景/家庭旅行),不要 PPT 截图。' +
              'hashtag 6-10 个,偏生活/情感/地点(如 #数字游民 #出差日记 #创业妈妈 #巴厘岛)。'
    },
    {
        key: 'channel',
        name: '视频号',
        rule: '熟人圈,信任比观点更重要。' +
              '标题前 12 字必须是钩子(视频号 feed 截断逻辑)。' +
              '描述偏平实,写本周做了什么/数据变化/一个洞察。' +
              '评论区 CTA 建议自己第一个留言(如"评论区扣 1 聊下"),' +
              '配合朋友圈首日转发策略。hashtag 3-5 个即可。'
    },
    {
        key: 'gzh',
        name: '公众号',
        rule: '长文思考,周刊化。' +
              '标题偏观点但不标题党,可用副标题补充。' +
              '描述写成 200 字以内的导读 + CTA(关注公众号 / 加微信进群)。' +
              'hashtag 不重要,主要是分组标签(如 主权创业周刊 / Build in Public)。'
    },
    {
        key: 'twitter',
        name: 'Twitter',
        rule: '纯英文,builder / indie hacker 视角。' +
              'titles **必须**给 3 个独立的单条 tweet 候选(每条 ≤280 字符,自成一条,不是 thread 开头),' +
              '不可留空。description 给一个 5-7 条的 thread(每条 ≤280 字符,用 1/ 2/ 3/ 编号)。' +
              '保留具体数字(MRR / users / revenue)。hashtag 3-5 个,' +
              '纯英文如 #buildinpublic #indiehackers #bootstrapping。'
    }
];

function buildSystemPrompt(brand, pillarHint = null) {
    const personaBase = brand?.llm?.personaBase || '';
    const platformLines = PLATFORMS
        .map((p) => `【${p.name} / ${p.key}】 ${p.rule}`)
        .join('\n\n');

    // pillar 加权:如果上游给了 pillar + Top 2 平台,告诉 LLM 对这两个平台格外发力
    let pillarBlock = '';
    if (pillarHint && pillarHint.topPlatforms && pillarHint.topPlatforms.length) {
        const top = pillarHint.topPlatforms.join(' / ');
        pillarBlock = [
            '',
            `【本条内容的 pillar 定位】`,
            `这是 ${pillarHint.pillar} 类(${pillarHint.pillarName})内容,主战场是 **${top}**。`,
            `这两个平台的标题/钩子/描述要格外下功夫(钩子更狠、描述更具体、hashtag 更精准),`,
            `其他平台保持合格水平即可,不要平均用力。`
        ].join('\n');
    }

    return [
        personaBase,
        '',
        '你现在是个"一次内容,十倍分发"策划人。给定一段视频/文章的原始素材和语境,',
        '你要为 6 个平台分别输出定制化的标题 + 描述 + hashtag + 发布建议 + 封面建议。',
        pillarBlock,
        '',
        '各平台风格规则(严格遵守):',
        '',
        platformLines,
        '',
        '硬约束:',
        '- 所有内容必须基于原稿真实内容,不编造事实',
        '- Twitter 输出必须是纯英文,其他平台必须是中文',
        '- 不使用 AI 套话("在这个...时代" / "毋庸置疑" / "让我们探索")',
        '- 每个平台的标题不能雷同,要各自有钩子',
        '- 不用在内地公域提"主权个人 / 网络国家 / 主权货币"这类敏感词,改用"数字游民 / 杠杆 / AI 时代创业者"',
        '',
        '输出格式(严格遵守 JSON 结构,不加任何解释):',
        '```json',
        '{',
        '  "douyin":   { "titles": ["..3个.."], "description": "..", "hashtags": ["#a","#b"], "posting_tip": "..", "cover_suggestion": ".." },',
        '  "kuaishou": { ... 同上 ... },',
        '  "xhs":      { ... 同上 ... },',
        '  "channel":  { ... 同上 ... },',
        '  "gzh":      { ... 同上 ... },',
        '  "twitter":  { ... 同上(英文) ... }',
        '}',
        '```',
        '只输出一个 JSON 对象,不要有 markdown 代码块包裹之外的任何文字。'
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
        if (context.hook_type) pieces.push(`- hook_type: ${context.hook_type}`);
        if (context.narrative_arc) pieces.push(`- 叙事弧: ${context.narrative_arc}`);
        if (Array.isArray(context.tags) && context.tags.length) {
            pieces.push(`- 关键词: ${context.tags.join('、')}`);
        }
    }
    pieces.push('');
    pieces.push('请一次性输出 JSON,六个平台都要有。');
    return pieces.join('\n');
}

// 容错 sanitize:去掉 // /* */ 注释 + trailing comma。
function sanitizeJsonish(s) {
    let out = String(s);
    // 去掉 // 行尾注释(避开字符串内的 "http://" 之类 → 限制必须前面是空白)
    out = out.replace(/(^|[\s,{\[])\/\/[^\n]*/g, '$1');
    // 去掉 /* */ 块注释
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    // 去掉 ,} 和 ,] 这种 trailing comma
    out = out.replace(/,\s*([}\]])/g, '$1');
    return out;
}

function tryParseVariants(text) {
    const candidates = [text, sanitizeJsonish(text)];
    for (const c of candidates) {
        try { return JSON.parse(c); } catch (_) { /* next */ }
    }
    return null;
}

// 从 LLM 输出里剥出 JSON(容错:允许 ```json``` / 无 fence / trailing comma / // 注释)
function extractJson(raw) {
    if (!raw) return null;
    const text = String(raw);
    // 1. 优先找 ```json ... ``` 或 ``` ... ``` 块(非贪婪)
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenceMatch) {
        const body = fenceMatch[1].trim();
        const parsed = tryParseVariants(body);
        if (parsed) return parsed;
        // fence 内可能有多余文字,尝试抓第一个 { 到最后一个 }
        const f = body.indexOf('{');
        const l = body.lastIndexOf('}');
        if (f >= 0 && l > f) {
            const tight = body.slice(f, l + 1);
            const p2 = tryParseVariants(tight);
            if (p2) return p2;
        }
    }
    // 2. 无 fence:第一个 { 到最后一个 }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const body = text.slice(first, last + 1);
        const parsed = tryParseVariants(body);
        if (parsed) return parsed;
    }
    return null;
}

// 从长描述里抠出 N 条候选"短句"作为 title fallback
// 逻辑:按换行/句号切分,筛 < 80 字的短句,取前 3 条
function extractTitlesFromDescription(desc, maxCount = 3) {
    if (!desc) return [];
    const sentences = String(desc)
        .split(/\n|(?<=[。.!?])\s*/)
        .map((s) => s.trim())
        .filter((s) => s && s.length >= 8 && s.length <= 80);
    // Twitter description 通常以 "1/N" 开头每条,抽掉前缀
    const cleaned = sentences.map((s) => s.replace(/^\d+\/\d+\s*/, '').trim()).filter(Boolean);
    const out = [];
    for (const s of cleaned) {
        if (out.length >= maxCount) break;
        if (!out.includes(s)) out.push(s);
    }
    return out;
}

function normalizePack(pack) {
    const out = {};
    for (const p of PLATFORMS) {
        const v = pack && pack[p.key] ? pack[p.key] : null;
        let titles = Array.isArray(v?.titles) ? v.titles.slice(0, 3).map((x) => String(x).trim()).filter(Boolean) : [];
        const description = String(v?.description || '').trim();
        // Fallback:titles 空但 description 非空 → 从 description 抠短句补上
        if (!titles.length && description) {
            titles = extractTitlesFromDescription(description, 3);
        }
        out[p.key] = {
            platform: p.key,
            name: p.name,
            titles,
            titles_source: (Array.isArray(v?.titles) && v.titles.length) ? 'llm' : (titles.length ? 'fallback-from-desc' : 'empty'),
            description,
            hashtags: Array.isArray(v?.hashtags) ? v.hashtags.map((x) => String(x).trim()).filter(Boolean) : [],
            posting_tip: String(v?.posting_tip || '').trim(),
            cover_suggestion: String(v?.cover_suggestion || '').trim()
        };
    }
    return out;
}

async function generateDistributePack({ rawText, context, options, brand, pillarHint = null }) {
    const brandObj = brand || (() => { try { return loadBrand(); } catch (_) { return null; } })();
    const systemPrompt = buildSystemPrompt(brandObj, pillarHint);
    const userPrompt = buildUserPrompt({ rawText, context: context || {} });
    const rawOutput = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
    const parsed = extractJson(rawOutput);
    if (!parsed) {
        const err = new Error('LLM 输出未能解析出 JSON');
        err.rawOutput = rawOutput;
        throw err;
    }
    return { pack: normalizePack(parsed), rawOutput };
}

function renderPlatformMarkdown(platform, data) {
    const lines = [];
    lines.push(`# ${data.name} / ${platform}`);
    lines.push('');
    const titleHeader = data.titles_source === 'fallback-from-desc'
        ? '## 标题(从 description 提取,LLM 未直接输出)'
        : '## 标题(3 个候选)';
    lines.push(titleHeader);
    lines.push('');
    data.titles.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push('');
    lines.push('## 描述 / 正文');
    lines.push('');
    lines.push(data.description || '(空)');
    lines.push('');
    lines.push('## 标签 / Hashtag');
    lines.push('');
    lines.push(data.hashtags.join(' ') || '(空)');
    lines.push('');
    lines.push('## 发布建议');
    lines.push('');
    lines.push(`- 时机: ${data.posting_tip || '(空)'}`);
    lines.push(`- 封面: ${data.cover_suggestion || '(空)'}`);
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    PLATFORMS,
    generateDistributePack,
    renderPlatformMarkdown,
    extractJson,
    normalizePack
};
