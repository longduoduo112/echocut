'use strict';

/**
 * 从视频 transcript 生成公众号文章 — 双模型 × 三风格(对比版)
 *
 * 设计依据:docs/PROSE-RESEARCH.md
 *
 * 三套 prompt:
 *   - structured  结构化观点流(对标刘润 / Keso)1500-1800 字 / SCQA
 *   - narrative   故事娓娓道来流(对标何加盐 / 池建强 / 张潇雨)2000-2800 字
 *   - hardcore    直白叙述 + 段子流(对标半佛 / 和菜头)2200-3500 字
 *
 * 两套模型:
 *   - ollama 本地(默认 qwen3.5:9b)
 *   - minimax 云端(MiniMax-M2.7,reasoning 模型)
 *
 * 跑一次同 transcript × 3 style × 2 model = 6 篇,对比择优。
 *
 * 总原则(所有 prompt 共享):**尽可能遵循原意**。文章是 transcript 的高质量改写,
 * 不是基于话题的二次创作。不能编原视频里没说过的事实、数据、引用。
 */

const axios = require('axios');
const { chatCompletion: minimaxChat, MinimaxApiError } = require('./minimaxClient');
const { loadBrand } = require('./brandLoader');

const STYLES = ['structured', 'narrative', 'hardcore'];
const MODELS = ['ollama', 'minimax'];
const VOICES = ['first', 'third']; // 'first' = 我=Example本人 / 'third' = 旁观者讲Example

// ─── 共享地基:所有风格都要遵守的硬约束 ───────────────────────────────────

// 反 AI 味 12 条(来自 docs/ANTI-AI-SLOP.md 调研沉淀)
// 这是这套 prompt 系统里最关键的一段 — 80% 的 AI 味问题都被这 12 条覆盖
const ANTI_AI_SLOP_RULES = `
【反 AI 味 12 条硬规则 — 这些是底线,违反一条就算失败稿】

1. 全文 markdown 加粗不超过 3 处,且至少 1 处是具体词(数字/人名/地名/动作)。
2. 全文不出现这些词:毋庸置疑、综上所述、由此可见、值得我们深思、
   在这个时代、拥抱变化、复利效应、降维打击、认知升级、底层逻辑、范式转移、赋能、
   不禁让人感叹、引人深思、堪称完美。
3. 全文不出现"首先/其次/再次/然后/最后"的序号化论述。要列要点就用"一是/二是"
   或者直接合并成自然段,不要 1.2.3 排队。
4. "X 不是 A,而是 B" 句式全文最多 1 次,且必须用在最关键处。
   类似的"真正的 X 是 Y" / "请记住这句话"也算同类。
5. 每 800 字至少 1 个具体时间锚点(2024 年 3 月 / 上周二下午 / 今早 7 点)。
   transcript 里没有的话,你可以用"我前阵子""上周"这种模糊但具体的时间。
6. 每 600 字至少 1 个具体场景细节(地点 + 物件 + 动作)。
   例如"望京 SOHO 楼下的星巴克,他点了一杯冰美式没动"。
7. 句长长短交错:每 5 句话至少 1 句 ≤ 15 字的短句。**全是中长句会让眼睛累**。
8. 段落不必每段下判断。允许某段就是描述、就是过渡,以画面/动作/对话结束,
   不强行升华。
9. 比喻优先用"陈旧但准"(像 2010 年的智能手机/像点外卖等了 40 分钟)。
   禁止"新奇但用力过猛"(像数字时代的炼金术士/把私人助理当公共厕所)。
10. 中文破折号(——)全文 ≤ 2 处。Em dash(—)禁用。
11. 至少 1 处犹豫或自我修正:"我也不太确定" / "前面那段写得不对,补充一下" /
    "可能我想多了"。这是反 AI 杀手锏 — AI 文几乎从不犹豫。
12. 结尾收束在画面/动作/自嘲,禁止"愿你""共勉""一起拥抱""从今天开始"等
    号召式金句。让结尾轻一点。
`;

const FORMAT_RULES = `
【排版铁律】
1. 输出纯 Markdown。不输出额外解释、前言、"好的"、"以下是文章"这类元话语。
2. 用 ## 二级标题切段,每 400-600 字一个标题,标题不超过 14 字,不带数字编号。
   小标题贴主题、有温度,不要"现象/逻辑/启示"这种生硬词。
3. 单段不超过 5 行(手机屏一屏的视觉量)。长段必拆。
4. 加粗最多 3 处(见反 AI 第 1 条)。不加粗连接词,不大段加粗。
5. > 引用块全文 ≤ 1 个,只用于 transcript 里的原句或第三方原话。稀缺才有分量。
6. 段落之间用空行分隔。
7. 全文不出现 emoji(hardcore 流派可有 1-2 个,见下)。
`;

const TRANSLATION_RULES = `
【口播→文章转译规则】
1. 删冗余口语连接词:"那么/然后/这个/我跟你说/你知道吗/对吧"全部删除。
   保留"但是/因为/所以"等有逻辑功能的连接词。
2. 同义重复合并:口播里"真的真的很重要"、"非常非常关键"在文章里只留一次。
3. 短句二次组合:口播会拆很碎,文章里把 3-4 个短句合成一个主谓宾完整的复合句,
   但单句不超过 30 字。注意保留长短交错(反 AI 第 7 条)。
4. 把口播里被压在叙述中的精彩判断单独成段,让它"立起来"。
`;

const FIDELITY_HARD_RULE = `
【事实保真硬约束 — 第一红线】
**所有事实、数字、案例、人物引语必须能在 transcript 里追溯。**

- 原文说"我有些朋友放美国",你不能写成"我朋友张三放美国"。
- 原文没提具体收入数字,你不能编"月入十万"。
- 原文如果有"一些团队/某些公司"这种模糊指代,改写时保留模糊性。
- 反 AI 第 5/6 条要求的"时间锚点""场景细节" 不是让你编 — 是从 transcript 已有的
  细节里捞出来强调,或用"我前阵子/上周/那个下午"这种**模糊但真实**的锚点。

保持事实的"原始保真度",形式美感由你雕琢。
`;

const SELF_CHECK_LIST = `
【输出前自检清单 — 必须全部 ✓ 才能输出】

[ ] 我有没有用"首先/其次/最后"序号化论述? → 有就删,改自然段。
[ ] 我有没有用"不是 A,而是 B"句式超过 1 次? → 超了就压到 1 次。
[ ] 我有没有用"毋庸置疑/综上所述/值得我们深思"这类空话? → 有就删。
[ ] 我有没有用"复利/降维/赋能/底层逻辑/认知升级"这类大词? → 用了就换具体例子。
[ ] 全文加粗是否 ≤ 3 处? → 超了就只留最关键的 3 处。
[ ] 我有没有至少 1 处具体时间锚点? → 没有就加(可以模糊真实)。
[ ] 我有没有至少 1 处具体场景细节? → 没有就从 transcript 里捞。
[ ] 我有没有至少 1 句 ≤ 15 字的短句? → 没有就拆一句。
[ ] 我有没有至少 1 处犹豫或自我修正? → 没有就加一句"我也不太确定"或类似。
[ ] 我的结尾是不是号召式金句? → 是就改成画面/动作/自嘲。
[ ] 文章里所有具体人物、数字、引语是否都能在 transcript 找到? → 找不到的删掉。

全部 ✓ 才能输出。任何一项违反都修正后再输出。
`;

// ─── 三套 prompt × 两种 voice ─────────────────────────────────────────────

// Prompt 配置外置在 src/services/essayPrompts.json,每个风格有两个 system:
//   - systemFirst: 第一人称(我=Example本人写)
//   - systemThird: 第三人称(旁观者讲Example的故事)
//
// v06 在 v05(BMK 78.64 最佳基线)之上加了:Example命名固化(去 Bill)+ 章节强制 3-4 个 ##
// + 话外音模糊诚实 + 作者犹豫硬指标 + 大词黑名单扩充 + voice 维度。
//
// 旧版 system 字段(无 voice 维度)做向后兼容:如果 JSON 只有 system 没有 systemFirst,
// 也能工作(只是不支持 voice 切换)。
//
// 换版本只需替换 JSON 文件,代码不动。历史版归档在 docs/prompt-iterations/v0X/。

const PROMPTS = require('./essayPrompts.json');

function pickSystemPrompt(prompt, voice) {
    // 优先级:systemFirst/systemThird(v06+) > system(v05 兼容)
    const key = voice === 'third' ? 'systemThird' : 'systemFirst';
    return prompt[key] || prompt.system;
}

// 校验:必须包含三个流派 + 各自含硬约束关键字(防止 JSON 文件被改坏)
for (const _s of STYLES) {
    if (!PROMPTS[_s]) {
        throw new Error(`essayPrompts.json 缺 ${_s}`);
    }
    const _sys = pickSystemPrompt(PROMPTS[_s], 'first');
    if (!_sys) throw new Error(`essayPrompts.json 缺 ${_s}.system / systemFirst`);
    if (!_sys.includes('反 AI 味 12 条') || !_sys.includes('事实保真') || !_sys.includes('自检清单')) {
        throw new Error(`essayPrompts.json 里 ${_s} system 缺关键硬约束字段(反 AI 味/事实保真/自检清单)`);
    }
}

// ─── 用户消息构造 ──────────────────────────────────────────────────────────

function buildUserMessage({ transcript, context, style, voice = 'first' }) {
    return buildUserMessageWith(PROMPTS, { transcript, context, style, voice });
}

function buildUserMessageWith(prompts, { transcript, context, style, voice = 'first' }) {
    const blocks = [];
    blocks.push(`【主题】${context.title || '(未提供 — 你自己从转写里提炼)'}`);
    if (context.subline) blocks.push(`【副标题】${context.subline}`);
    if (context.duration) blocks.push(`【时长】${context.duration}`);
    if (context.hookType) blocks.push(`【hook 类型】${context.hookType}`);
    if (context.brandName) blocks.push(`【作者身份】${context.brandName}`);
    blocks.push(`【口吻】${voice === 'third' ? '第三人称(旁观叙述者讲Example的故事)' : '第一人称(我=Example本人在说)'}`);
    blocks.push('');
    blocks.push('【完整口播原文(你的任务是改写成文章,事实必须 100% 来自这里)】');
    blocks.push(transcript);
    blocks.push('');
    blocks.push(`【任务】把以上口播改写成一篇符合 "${prompts[style].label}" 风格的公众号 Markdown 文章,`);
    blocks.push(`目标字数 ${prompts[style].targetCharCount}。**严守"事实来自原文,形式自由发挥"的边界**。`);
    blocks.push('直接输出 Markdown,不要任何前言、解释、"好的"之类元话语。');
    return blocks.join('\n');
}

// ─── 模型调用封装 ──────────────────────────────────────────────────────────

async function callOllama({ messages, ollamaUrl, ollamaModel, timeoutMs = 300000 }) {
    const url = ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
    const model = ollamaModel || process.env.OLLAMA_MODEL || 'qwen3.5:9b';
    const t0 = Date.now();
    const resp = await axios.post(url, {
        model, messages, stream: false, think: false
    }, { timeout: timeoutMs, proxy: false });
    const content = String(resp.data?.message?.content || '').trim();
    if (!content) throw new Error('ollama 返回空 content');
    return {
        content,
        elapsedMs: Date.now() - t0,
        usage: {
            prompt_tokens: resp.data?.prompt_eval_count,
            completion_tokens: resp.data?.eval_count,
            total_duration_ms: resp.data?.total_duration ? Math.round(resp.data.total_duration / 1e6) : null
        }
    };
}

async function callMinimax({ messages, model, timeoutMs = 300000, maxCompletionTokens = 16384 }) {
    // M2.7 是 reasoning 模型,推理 token 容易吃掉 8k+,加上 3500 字成文要 ~4k token,
    // 默认开到 16384 给足余量。hardcore 长文偶尔触顶,再重试一次(可能瞬时空 content)。
    const tryOnce = async (max) => {
        const r = await minimaxChat({
            messages,
            model,
            temperature: 0.7,
            topP: 0.95,
            maxCompletionTokens: max,
            timeoutMs
        });
        return r;
    };
    const t0 = Date.now();
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const max = attempt === 1 ? maxCompletionTokens : Math.min(24576, maxCompletionTokens * 1.5);
            const r = await tryOnce(max);
            return {
                content: r.content,
                elapsedMs: Date.now() - t0,
                reasoning: r.reasoning ? r.reasoning.slice(0, 200) + '...' : '',
                usage: r.usage,
                attempts: attempt
            };
        } catch (e) {
            lastErr = e;
            // 只在 reasoning 吃完 / 空 content 这两种"应该可恢复"场景重试
            const recoverable = /推理 token 吃完|content 为空|finish_reason/.test(e.message || '');
            if (!recoverable || attempt >= 2) break;
            // 短暂退避,避免 MiniMax 端瞬时拥塞
            await new Promise((res) => setTimeout(res, 2000));
        }
    }
    throw lastErr;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 生成单篇文章。
 *
 * @param {object} p
 * @param {string} p.transcript     视频转写全文(必填)
 * @param {object} [p.context]      { title, subline, duration, hookType, brandName }
 * @param {string} p.style          'structured' / 'narrative' / 'hardcore'
 * @param {string} p.model          'ollama' / 'minimax'
 * @param {string} [p.ollamaUrl]    覆盖 OLLAMA_URL
 * @param {string} [p.ollamaModel]  覆盖 OLLAMA_MODEL
 * @param {string} [p.minimaxModel] 覆盖 MINIMAX_TEXT_MODEL
 * @returns {Promise<{ markdown:string, style:string, model:string, elapsedMs:number, usage:object, reasoning?:string }>}
 */
async function generateEssay(p) {
    const { transcript, context = {}, style, model, voice = 'first' } = p;
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
        throw new Error('transcript 不能为空');
    }
    if (!STYLES.includes(style)) {
        throw new Error(`style 必须是 ${STYLES.join(' / ')},收到 "${style}"`);
    }
    if (!MODELS.includes(model)) {
        throw new Error(`model 必须是 ${MODELS.join(' / ')},收到 "${model}"`);
    }
    if (!VOICES.includes(voice)) {
        throw new Error(`voice 必须是 ${VOICES.join(' / ')},收到 "${voice}"`);
    }

    // 自动注入作者人设(默认Example — 用户钦定不再用 Bill)
    if (!context.brandName) {
        try {
            const brand = loadBrand();
            if (brand?.identity?.name) {
                context.brandName = `${brand.identity.name}${brand.identity.title ? '(' + brand.identity.title + ')' : ''}`;
            }
        } catch (_) { /* 没品牌就空着 */ }
    }
    // 强制把品牌名替换成"Example"(prompt 里硬规则:不用 Bill)
    if (context.brandName && context.brandName.includes('Bill')) {
        context.brandName = context.brandName.replace(/Bill/g, 'Example');
    }
    if (!context.brandName || !context.brandName.includes('Example')) {
        // 不论 brand 配什么,主角恒等于Example
        context.brandName = 'Example(数字游民创业者 / AI 出海实践者)';
    }

    // 允许外部覆盖 prompts(orchestrator 迭代用):p.promptsOverride = { structured: {systemFirst, systemThird, label, targetCharCount}, ... }
    const promptsToUse = p.promptsOverride && p.promptsOverride[style] ? p.promptsOverride : PROMPTS;
    const systemPrompt = pickSystemPrompt(promptsToUse[style], voice);
    // buildUserMessage 用 prompts 的 label
    const userMessage = buildUserMessageWith(promptsToUse, { transcript: transcript.trim(), context, style, voice });

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
    ];

    const result = model === 'ollama'
        ? await callOllama({ messages, ollamaUrl: p.ollamaUrl, ollamaModel: p.ollamaModel })
        : await callMinimax({ messages, model: p.minimaxModel });

    return {
        markdown: cleanupMarkdown(result.content),
        style,
        model,
        elapsedMs: result.elapsedMs,
        usage: result.usage,
        reasoning: result.reasoning
    };
}

/**
 * 清洗 LLM 输出常见瑕疵:
 *   - 头部 ```markdown / ``` 包裹剥掉
 *   - 头部"好的"、"以下是"、"# 一篇..."这种元话语
 *   - 尾部 ``` 剥掉
 */
function cleanupMarkdown(raw) {
    let s = String(raw || '').trim();
    // ```markdown 或 ``` 开头
    s = s.replace(/^```(?:markdown)?\s*\n/i, '').replace(/\n```\s*$/, '');
    // 前缀元话语(只看第一行)
    const meta = /^(好的|以下是|这是|这里是|根据.{0,20}我.{0,10}(写|改写|输出).{0,20}[::])/;
    const firstNewline = s.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 80) {
        const firstLine = s.slice(0, firstNewline);
        if (meta.test(firstLine)) s = s.slice(firstNewline + 1).trim();
    }
    return s;
}

module.exports = {
    generateEssay,
    STYLES,
    MODELS,
    VOICES,
    PROMPTS,
    pickSystemPrompt,
    cleanupMarkdown,
    buildUserMessage
};
