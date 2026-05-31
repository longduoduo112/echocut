'use strict';

/**
 * 公众号文章 BMK 评分员 — 用 LLM 当 10 年公众号编辑给文章打分。
 *
 * 设计依据: docs/ESSAY-BENCHMARK-FRAMEWORK.md (10 维度评分)
 *
 * 评委默认: MiniMax-M2.7(reasoning 模型,评分稳)。
 * 可选: Ollama(用同一模型给评分员 — 用于"多评委投票" 减偏好)。
 *
 * 单篇用法:
 *   const { scoreEssay } = require('./essayBenchmark');
 *   const r = await scoreEssay({ essay, transcript, context, style, judge: 'minimax' });
 *
 * r = {
 *   overall: 78,
 *   verdict: '可发(...)',
 *   scores: { fidelity: {score, reason}, anti_ai_slop: {...}, ... },
 *   top_strengths: [...],
 *   top_improvements: [...],
 *   judge: 'minimax',
 *   elapsedMs: 12345,
 *   raw: <LLM 原始响应>
 * }
 */

const axios = require('axios');
const { chatCompletion: minimaxChat } = require('./minimaxClient');

const DIMENSIONS = [
    'fidelity',
    'anti_ai_slop',
    'hook',
    'cadence',
    'insight_density',
    'readability',
    'warmth',
    'closing',
    'coherence',
    'shareability'
];

const JUDGES = ['minimax', 'ollama'];

/**
 * 评委 system prompt — 10 年公众号资深编辑兼营销大师人设。
 * 严格、有依据、不留情面。
 */
const JUDGE_SYSTEM = `你是一位写了 10 年的资深公众号编辑兼内容营销大师。

你看过 1000+ 篇 10w+ 爆款,亲手写过几十篇 50w+ 大爆款。你给一线品牌做过内容顾问,
深知什么样的文章能在公众号信息流里被点开、读完、转发。

你的评分原则:**严格、有依据、不留情面**。看到 AI 腔、空话、套路、自嗨,直接扣分,
理由里点名指出具体问题。看到真情实感、独特视角、节奏感强,大方给高分,但也要说出哪里好。

你必须严格按 10 个维度打分,每维 0-10 分。每个分数都要附 1 句具体理由(不超过 60 字),
理由必须引用文章里的具体片段或问题,**不能说"整体不错"这种废话**。

【10 个评分维度】

1. **fidelity 原意保真度**:文章是否忠实于 transcript 的事实和判断?有没有编原文没说过的人物/数字/案例/引语?
   - 10 分:所有事实可追溯 transcript;模糊指代保持模糊
   - 5 分:有 1 处明显编造(如把"我朋友"写成"我朋友张三")
   - 3 分以下:严重背离原意,加入了 transcript 从未提及的核心论据
   - **Fidelity < 5 直接否决整篇,总分自动归 30 分以下**

2. **anti_ai_slop AI 味识别度**:读者第一眼能看出 AI 写的吗?越像人类越高分。
   扣分点(每发现一处扣 1-2 分):"毋庸置疑/综上所述/值得我们深思/在这个时代";
   "X 不是 A,而是 B"/"真正的 X 是 Y"句式滥用;段段加粗判断;
   排比/对偶/三连滥用;比喻过度精致;结尾喊口号

3. **hook 开头钩子**:第一段(前两行)能否让读者停下手指继续看?
   - 10 分:具体场景/反常识判断/数字悬念/提问,且不套路
   - 5 分:钩子尚可但偏套路
   - 0-3 分:开头就有 AI 腔(如"在 AI 飞速发展的今天")

4. **cadence 节奏感**:句子长短交替,段落张弛有度。
   - 10 分:短句和中长句穿插得当,关键判断单独成段,读起来像人在说话
   - 5 分:大部分句子长度均匀,缺乏起伏
   - 0-3 分:全断行短句(碎片化)或全长句(疲劳)

5. **insight_density 金句密度**:多少句话让读者想划线/截屏/转发?
   - 10 分:全文 3-5 句"被发朋友圈也站得住"的判断,且来自 transcript 真观点
   - 5 分:1-2 处亮眼,更多平铺直叙
   - 0-3 分:全篇都是"正确的废话"
   - **金句必须是 transcript 里有的判断的提炼,不是 LLM 自己造句**

6. **readability 可读性**:手机端阅读体验。
   - 10 分:段落 ≤5 行,## 切段合理,加粗节制(≤3 处),> 引用块稀缺(≤2 个)
   - 5 分:段落偶尔过长,加粗过密
   - 0-3 分:无 ## 切段;或每行都加粗

7. **warmth 情感温度**:文章有没有作者的"体温"?
   - 10 分:第一人称多次,有具体经历、犹豫、情绪
   - 5 分:基本第三方观察口吻,冰冷讲道理
   - 0-3 分:百度百科/教科书口吻,无任何作者特征

8. **closing 结尾收束**:余韵悠长 vs 喊口号/戛然而止?
   - 10 分:收在具体动作/画面/轻判断,读完读者会"嗯..."停顿
   - 5 分:陈述总结,无惊喜也无不适
   - 0-3 分:喊"从今天开始/愿你.../共勉"口号;或突然结束

9. **coherence 风格一致性**:前后风格统一,贴合流派定位?
   structured 应:短句强观点 SCQA 金句压尾;narrative 应:场景细节人物动作自然过渡;
   hardcore 应:反共识对比结构信息密度有态度

10. **shareability 二次传播力**:读完想转发吗?
    - 10 分:有 1-2 个明确分享点(金句/反共识/实用清单/戳人故事)
    - 5 分:读完无感,转给朋友也想不出理由
    - 0-3 分:读完立刻忘,甚至读不完

【输出格式 — 严格 JSON,不准额外解释】

\`\`\`json
{
  "overall": 78,
  "verdict": "可发 / 需调整 / 不可发 (一句话理由)",
  "scores": {
    "fidelity":        { "score": 0-10, "reason": "<≤60 字>" },
    "anti_ai_slop":    { "score": 0-10, "reason": "<≤60 字>" },
    "hook":            { "score": 0-10, "reason": "<≤60 字>" },
    "cadence":         { "score": 0-10, "reason": "<≤60 字>" },
    "insight_density": { "score": 0-10, "reason": "<≤60 字>" },
    "readability":     { "score": 0-10, "reason": "<≤60 字>" },
    "warmth":          { "score": 0-10, "reason": "<≤60 字>" },
    "closing":         { "score": 0-10, "reason": "<≤60 字>" },
    "coherence":       { "score": 0-10, "reason": "<≤60 字>" },
    "shareability":    { "score": 0-10, "reason": "<≤60 字>" }
  },
  "top_strengths": ["<≤40 字>", "<≤40 字>", "<≤40 字>"],
  "top_improvements": ["<≤40 字>", "<≤40 字>", "<≤40 字>"]
}
\`\`\`

只输出 JSON,不输出别的。`;

function buildJudgeUserMessage({ essay, transcript, context, style }) {
    const blocks = [];
    blocks.push('【待评文章】');
    blocks.push('风格定位: ' + (style || '(未提供)'));
    if (context.title) blocks.push('视频主题: ' + context.title);
    if (context.duration) blocks.push('视频时长: ' + context.duration);
    blocks.push('');
    blocks.push('--- 文章 markdown 全文(评分对象)---');
    blocks.push(essay);
    blocks.push('--- 文章结束 ---');
    blocks.push('');
    blocks.push('【transcript 原文(对照 fidelity 用)】');
    blocks.push(transcript);
    blocks.push('');
    blocks.push('现在按 10 个维度评分,严格按 JSON 格式输出。');
    return blocks.join('\n');
}

/**
 * 从 LLM 输出里抠出 JSON(允许 ```json``` fence)
 */
function extractScores(raw) {
    if (!raw) return null;
    const text = String(raw);
    const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    const body = fence ? fence[1].trim() : (() => {
        const f = text.indexOf('{');
        const l = text.lastIndexOf('}');
        return f >= 0 && l > f ? text.slice(f, l + 1) : text;
    })();
    try {
        return JSON.parse(body);
    } catch (_) {
        // 尝试清掉 trailing comma + 行注释
        const cleaned = body
            .replace(/(^|[\s,{\[])\/\/[^\n]*/g, '$1')
            .replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(cleaned); } catch (_) { return null; }
    }
}

function validateScores(parsed) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'not_object' };
    if (typeof parsed.overall !== 'number') return { ok: false, error: 'missing_overall' };
    if (!parsed.scores || typeof parsed.scores !== 'object') return { ok: false, error: 'missing_scores' };
    for (const dim of DIMENSIONS) {
        const s = parsed.scores[dim];
        if (!s || typeof s.score !== 'number') return { ok: false, error: `missing_${dim}` };
        if (s.score < 0 || s.score > 10) return { ok: false, error: `out_of_range_${dim}` };
    }
    // Fidelity < 5 → overall ≤ 30 强制约束(双保险)
    if (parsed.scores.fidelity.score < 5 && parsed.overall > 30) {
        parsed.overall = 30;
        parsed.verdict = (parsed.verdict || '') + '(fidelity<5,总分强制 ≤30)';
    }
    return { ok: true };
}

/**
 * 调 MiniMax M2.7 评分
 */
async function judgeWithMinimax({ messages, maxCompletionTokens = 12288 }) {
    const r = await minimaxChat({
        messages,
        temperature: 0.3, // 评分要稳,温度低
        topP: 0.9,
        maxCompletionTokens,
        timeoutMs: 240000
    });
    return r;
}

/**
 * 调 Ollama 评分
 */
async function judgeWithOllama({ messages, ollamaUrl, ollamaModel, timeoutMs = 300000 }) {
    const url = ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
    const model = ollamaModel || process.env.OLLAMA_MODEL || 'qwen3.5:9b';
    const resp = await axios.post(url, {
        model, messages, stream: false, think: false
    }, { timeout: timeoutMs, proxy: false });
    return { content: String(resp.data?.message?.content || '').trim(), reasoning: '' };
}

/**
 * 主入口:评一篇文章
 */
async function scoreEssay({ essay, transcript, context = {}, style, judge = 'minimax', retries = 1 }) {
    if (!essay || typeof essay !== 'string') throw new Error('essay 不能为空');
    if (!transcript || typeof transcript !== 'string') throw new Error('transcript 不能为空(评 fidelity 需要)');
    if (!JUDGES.includes(judge)) throw new Error(`judge 必须是 ${JUDGES.join(' / ')}`);

    const messages = [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: buildJudgeUserMessage({ essay, transcript, context, style }) }
    ];

    const t0 = Date.now();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const r = judge === 'minimax'
                ? await judgeWithMinimax({ messages })
                : await judgeWithOllama({ messages });
            const parsed = extractScores(r.content);
            const validate = validateScores(parsed);
            if (!validate.ok) throw new Error(`scores 解析失败: ${validate.error}`);
            return {
                ...parsed,
                judge,
                elapsedMs: Date.now() - t0,
                raw: r.content
            };
        } catch (e) {
            lastErr = e;
            if (attempt < retries) {
                await new Promise((res) => setTimeout(res, 1500));
            }
        }
    }
    throw lastErr;
}

module.exports = {
    scoreEssay,
    DIMENSIONS,
    JUDGES,
    JUDGE_SYSTEM,
    extractScores,
    validateScores
};
