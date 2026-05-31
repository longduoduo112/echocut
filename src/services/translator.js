'use strict';

/**
 * translator — 把中文公众号文章本地化翻译成英文博客文章(your-blog.com 风格)
 *
 * 设计依据: docs/TRANSLATION-RESEARCH.md(12 条翻译铁律)
 * 关键不是逐字翻译,是 localization + rewrite。
 *
 * 默认模型: MiniMax-M2.7
 */

const { chatCompletion: minimaxChat, MinimaxApiError } = require('./minimaxClient');

const SYSTEM_PROMPT = `You are translating a Chinese WeChat essay into a native English blog post.
The author is **Bill**, a Chinese indie hacker / digital nomad writing for an
audience that reads Hacker News, Substack, and Stratechery.

Voice: calm, confident, **humble**, occasionally self-deprecating. Like Paul
Graham crossed with Patrick McKenzie. Plain style, concrete, **never preachy,
never condescending, never talking down to the reader**. The narrator shares
lessons learned from his own mistakes — not lecturing strangers.

**This is NOT word-for-word translation. This is localization + rewrite.**

# 12 RULES (non-negotiable)

1. **SUBJECT FIRST.** Chinese is topic-prominent; English is subject-prominent.
   Every English sentence must have a clear subject doing a clear verb.
   Restructure freely.

2. **AVERAGE 15-18 WORDS PER SENTENCE.** Mix short (5-8) with long (25-30).
   Never two long sentences in a row.

3. **PARAGRAPHS 2-4 SENTENCES, 40-100 WORDS.** If the Chinese paragraph is
   200 words, split it into 2-3 English paragraphs.

4. **KILL "WE".** Use "I" or "you" or direct statement instead. Max 1 "we"
   per 500 words.

5. **KILL FILLER.** Delete on sight: "needless to say", "as we all know",
   "it goes without saying", "in my humble opinion", "at the end of the
   day", "the fact of the matter is". Also: "I think / I feel / I believe"
   max 3 times in a 2000-word piece.

6. **KILL "BRING".** Chinese loves "brings opportunity / brings change". In
   English, use a concrete verb: "opens", "unlocks", "creates", "kills".

7. **KILL FORMULAIC FOUR-CHAR PHRASES.** Chinese loves 4-char rhythm
   (敢想敢做). Translate the meaning, not the form. "You only know what
   you've actually shipped" beats "dare to think and dare to do".

8. **EVERY PARAGRAPH'S FIRST SENTENCE IS A TOPIC SENTENCE.** It carries the
   paragraph's claim. Scan-readers only read first sentences.

9. **CUT HEADINGS IN HALF.** Chinese essays have an H2 every 300 chars.
   English long-form has 2-3 H2s for a 3000-word piece. Let topic sentences
   carry navigation. **If the Chinese source has 5 H2s, your English output
   should have 2-3 H2s; merge related sections.**

10. **EM DASH FOR PARENTHETICAL / TURN / EMPHASIS.** 3-6 per piece, max two
    per sentence, no spaces around it. Use "—" not "..." or "( )" for
    abrupt turns.

11. **CONCRETE OVER ABSTRACT.** Replace "huge / profound / fundamental /
    revolutionary" with specific consequences. "Everything downstream
    of this will change" beats "this is a profound shift".

12. **CULTURAL TERMS — 4-WAY DECISION:**
    a. Functional equivalent exists → replace (公众号 → my newsletter / my Substack)
    b. Cultural artifact, no equivalent → keep pinyin + one-line gloss
       on first mention (Xiaohongshu (China's Instagram-Pinterest hybrid))
    c. Localized metaphor → swap metaphor (北上广房价 → SF real estate)
    d. Must preserve + complex → short parenthetical (last resort)

# AUTHOR NAME — STRICT

The author goes by **Bill** in English. When the Chinese source uses "Example" or
the source author handle — always use the configured author name in your English translation.
**Never invent an author name in your output.**

# ZERO CHINESE CHARACTERS — CRITICAL

**This is the #1 rule. Any Chinese character (CJK) in your output is a
critical failure that will be rejected.**

Common LLM mistakes that leak Chinese:
- 「拼接起来」「冒出在你脑子里」「记录了两天就开始焦虑」
- 「一圈」「对吧」「嗯」「那个」「这种」
- 「废书」「滴答清单」「博览站」(cultural terms)

Self-check protocol BEFORE output:
1. Scan every line for CJK characters (Unicode range U+4E00 to U+9FFF)
2. Any line containing CJK = rewrite the entire sentence in pure English
3. For cultural terms: use pinyin + parenthetical gloss
   - 废书 → "Feishu (a Chinese messaging app)"
   - 滴答清单 → "Dida (a Chinese todo list app)" or just "my todo app"
   - 博览站 → "AsiaWorld-Expo MTR station"
4. For colloquial fillers (一圈/对吧/嗯) — DELETE them, they have no
   English equivalent

**If you find yourself unable to translate a phrase, paraphrase the meaning
in plain English. Never leave the Chinese character.**

# OUTPUT

Pure English markdown. Keep one H1 title at the top. No notes, no "here's the
translation", no commentary. Just the article.

The title should be localized too — don't translate it literally. If the Chinese
title is "他每天往机器人里丢东西,三个月后自己都吓了一跳", an English version
might be "I dumped everything into a bot for three months. The output scared me."
or "What happened after I fed my life into AI for 90 days".

# SELF-CHECK BEFORE OUTPUT

Run through these checks and revise if any fail:
- [ ] Every paragraph 2-4 sentences?
- [ ] Average sentence ~15-18 words?
- [ ] "We" used max twice?
- [ ] Em dashes 3-6, not Chinese-style "..."?
- [ ] H2 count ≤ 50% of Chinese source's H2 count?
- [ ] No "needless to say / it goes without saying / at the end of the day"?
- [ ] Cultural terms have brief gloss on first mention?
- [ ] Author name = configured (configured author)?
- [ ] **Zero Chinese characters anywhere?**

Output only the English markdown. Nothing else.`;

// CJK 字符检测正则 - 用于 post-process 中文残留 detect
const CJK_REGEX = /[一-鿿㐀-䶿！-～　-〿]/g;

function detectCJK(text) {
    const matches = String(text || '').match(CJK_REGEX) || [];
    return matches.length > 0 ? matches : null;
}

function findCJKLines(text) {
    return String(text || '').split('\n')
        .map((line, idx) => ({ idx: idx + 1, line, cjk: line.match(CJK_REGEX) || [] }))
        .filter((x) => x.cjk.length > 0);
}

/**
 * 翻译单篇中文 markdown
 *
 * @param {object} p
 * @param {string} p.chineseMd        中文 markdown 全文(含/不含 front matter 均可)
 * @param {string} [p.minimaxModel]   覆盖 MiniMax 文本模型
 * @param {number} [p.maxTokens]      默认 24576(英文 ~2k 词上限)
 * @param {number} [p.timeoutMs]      默认 300000(5 分钟,长文本翻译可能慢)
 * @returns {Promise<{ english:string, elapsedMs:number, usage:object }>}
 */
async function translateToEnglish(p) {
    const { chineseMd } = p;
    if (!chineseMd || typeof chineseMd !== 'string' || !chineseMd.trim()) {
        throw new Error('chineseMd 不能为空');
    }

    // 剥 front matter(只翻译正文,front matter 单独保留并加注)
    const fmMatch = chineseMd.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
    const frontMatter = fmMatch ? fmMatch[1] : '';
    const body = fmMatch ? fmMatch[2].trim() : chineseMd.trim();

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
            role: 'user',
            content: `Translate this Chinese essay into a native English blog post for your-blog.com.\n\nFollow all 12 rules. Author name = configured.\n\n--- CHINESE SOURCE START ---\n\n${body}\n\n--- CHINESE SOURCE END ---\n\nOutput only the English markdown (with one # title at top). Don't include any notes or commentary.`
        }
    ];

    const t0 = Date.now();
    let lastErr = null;
    let prevEnglish = null;
    let prevCJK = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const maxTokens = attempt === 1 ? (p.maxTokens || 24576) : 32768;
            // 第 2/3 次 attempt:如果上次有 CJK 残留,把残留信息塞给 LLM 让它专门修
            const attemptMessages = attempt > 1 && prevCJK
                ? [
                    ...messages,
                    { role: 'assistant', content: prevEnglish },
                    {
                        role: 'user',
                        content: `Your previous output contained Chinese characters. This is a critical failure.\n\nChinese leaked: ${prevCJK.slice(0, 30).join(' ')}\n\nRewrite the entire English translation from scratch, with **ZERO Chinese characters anywhere**. For any term you struggle to translate, paraphrase in plain English or use pinyin with parenthetical gloss. Output only the corrected English markdown.`
                    }
                ]
                : messages;

            const r = await minimaxChat({
                messages: attemptMessages,
                model: p.minimaxModel,
                temperature: 0.5, // 重试时温度降低,更保守
                topP: 0.9,
                maxCompletionTokens: maxTokens,
                timeoutMs: p.timeoutMs || 300000
            });
            const english = cleanupEnglish(r.content);

            // CJK 残留检测
            const cjk = detectCJK(english);
            if (cjk) {
                prevEnglish = english;
                prevCJK = cjk;
                if (attempt < 3) {
                    // 还能重试,记录后继续
                    continue;
                }
                // 最后一次还残留 — 包装错误抛出
                const lines = findCJKLines(english);
                const sample = lines.slice(0, 3).map((l) => `  L${l.idx}: ${l.line.slice(0, 80)}...`).join('\n');
                throw new Error(`英文翻译有 ${cjk.length} 个中文字符残留(3 次重试后仍有):\n${sample}`);
            }

            return {
                english,
                elapsedMs: Date.now() - t0,
                usage: r.usage,
                frontMatter,
                attempts: attempt
            };
        } catch (e) {
            lastErr = e;
            const recoverable = /推理 token 吃完|content 为空|finish_reason|socket hang up|HTTP 5/.test(e.message || '');
            if (!recoverable || attempt >= 3) break;
            await new Promise((res) => setTimeout(res, 3000));
        }
    }
    throw lastErr;
}

function cleanupEnglish(raw) {
    let s = String(raw || '').trim();
    // 剥 ```markdown 包裹
    s = s.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
    // 剥头部元话语 "Here's the translation:" / "Sure, here's..."
    const meta = /^(here'?s\s+(the\s+)?(translation|english\s+version)|sure,?\s+here|i'?ll?\s+translate|below\s+is)/i;
    const firstNewline = s.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 100) {
        const firstLine = s.slice(0, firstNewline);
        if (meta.test(firstLine)) s = s.slice(firstNewline + 1).trim();
    }
    return s;
}

module.exports = {
    translateToEnglish,
    cleanupEnglish,
    detectCJK,
    findCJKLines,
    SYSTEM_PROMPT
};
