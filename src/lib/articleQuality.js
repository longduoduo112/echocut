'use strict';

/**
 * 文章质量扫描(AI 腔检测器)
 *
 * 代码级 guardrail:即使 LLM prompt 严禁了 AI 腔,小模型偶尔还是会漏。
 * 生成后纯正则扫一遍,命中就告警,给用户 "要不要重生成" 的判断依据。
 *
 * 7 类 AI 腔(和 example.json::personaBase 的禁忌清单对齐):
 *   1. 时代套话       在这个瞬息万变的时代 / 随着科技飞速发展 / ...
 *   2. 空话连接       毋庸置疑 / 总而言之 / 让我们一起探索 / ...
 *   3. 虚词填充       确确实实 / 切切实实 / 方方面面 / ...
 *   4. 廉价升华       值得我们深思 / 引人深思 / 发人深省 / ...
 *   5. 说教句式       我们应该 / 难道不是吗 / 你有没有想过 / ...
 *   6. 小红书套路     姐妹们 / 家人们 / 绝绝子 / ...
 *   7. 夸赞套路       堪称完美 / 无可挑剔 / 叹为观止 / ...
 */

const PATTERNS = [
    { key: 'era', name: '时代套话', regex: [
        /在这个瞬息万变的时代/g,
        /在当今社会/g,
        /随着(科技|时代|社会|AI)(的)?(飞速)?发展/g,
        /如今[^。,]*?发展迅速/g,
        /在这个(科技|AI|互联网)时代/g
    ]},
    { key: 'filler', name: '空话连接', regex: [
        /毋庸置疑/g,
        /总而言之/g,
        /综上所述/g,
        /不仅.{0,20}而且/g,
        /让我们(一起)?(去)?(探索|思考|发现)/g,
        /值得(我们)?注意的是/g
    ]},
    { key: 'stuffing', name: '虚词填充', regex: [
        /确确实实/g,
        /真真正正/g,
        /切切实实/g,
        /方方面面/g,
        /其实真的/g
    ]},
    { key: 'cheap_lift', name: '廉价升华', regex: [
        /值得(我们)?深思/g,
        /引人深思/g,
        /发人深省/g,
        /令人不禁感叹/g,
        /让人叹(息|服)/g
    ]},
    { key: 'preaching', name: '说教句式', regex: [
        /我们应该(要)?/g,
        /大家(都)?(要|需要)知道/g,
        /你有没有想过/g,
        /难道不(是|能)吗/g,
        /我们(为什么)?不能/g
    ]},
    { key: 'xhs_cliche', name: '小红书套路', regex: [
        /姐妹们/g,
        /家人们/g,
        /宝子们/g,
        /绝绝子/g,
        /太绝了/g,
        /yyds/gi
    ]},
    { key: 'praise_cliche', name: '夸赞套路', regex: [
        /堪称完美/g,
        /无可挑剔/g,
        /叹为观止/g,
        /震撼人心/g,
        /无与伦比/g
    ]}
];

/**
 * 扫描一篇文章的 AI 腔命中情况。
 * 返回 { hits: [{category,name,phrase,count}], totalHits, score }
 * score 0-100,每命中 1 次扣 5 分,封底 0
 */
function scanArticle(text) {
    if (!text) return { hits: [], totalHits: 0, score: 100 };
    const body = String(text);
    const hits = [];
    let total = 0;
    for (const cat of PATTERNS) {
        for (const re of cat.regex) {
            const matches = body.match(re);
            if (matches && matches.length) {
                hits.push({
                    category: cat.key,
                    name: cat.name,
                    phrase: matches[0],
                    count: matches.length
                });
                total += matches.length;
            }
        }
    }
    const score = Math.max(0, 100 - total * 5);
    return { hits, totalHits: total, score };
}

/**
 * 把扫描结果渲染成用户友好的终端提示
 */
function renderScanReport(result, { color = true } = {}) {
    const C = color ? {
        gray: '\x1b[90m', reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m'
    } : { gray: '', reset: '', red: '', yellow: '', green: '', bold: '' };

    if (!result.totalHits) {
        return `${C.green}✓ 无 AI 腔${C.reset}  质量分 ${C.bold}${result.score}${C.reset}/100`;
    }

    const level = result.score >= 80 ? C.green : result.score >= 60 ? C.yellow : C.red;
    const lines = [];
    lines.push(`${level}⚠ AI 腔命中 ${result.totalHits} 处${C.reset}  质量分 ${C.bold}${result.score}${C.reset}/100`);
    const byCat = new Map();
    for (const h of result.hits) {
        const arr = byCat.get(h.name) || [];
        arr.push(`${h.phrase}×${h.count}`);
        byCat.set(h.name, arr);
    }
    for (const [name, phrases] of byCat) {
        lines.push(`  ${C.gray}·${C.reset} ${name}: ${phrases.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * 深度自检重写:把文章和扫描结果一并喂给 LLM,让它对照命中项重写。
 * 额外一次 LLM 调用,afc --deep-review 显式触发。
 *
 * 返回 { rewritten, beforeScore, afterScore, improvement }
 */
async function deepReviewAndRewrite({ article, callChat, options, personaBase = '' }) {
    const scan = scanArticle(article);
    if (!scan.totalHits) {
        return { rewritten: article, beforeScore: scan.score, afterScore: scan.score, improvement: 0, skipped: 'no-issues' };
    }

    const issueLines = scan.hits.map((h) => `- ${h.name}: "${h.phrase}" × ${h.count}`).join('\n');

    const systemPrompt = [
        personaBase,
        '',
        '你是上面这篇文章作者的"自我编辑"。现在你要对照下面列出的"AI 腔命中清单",',
        '把文章改写成**彻底删掉这些表达**的版本。',
        '',
        '硬约束:',
        '- 不能改变原文的核心观点、结构和具体事实(地名/金额/数字/人物)',
        '- 只替换 AI 腔的部分,用Example的正宗口吻(短句成段、具体事实、冷峻客观)',
        '- 保留原文的 markdown 格式(小标题、列表、emoji)',
        '- 保留原文的长度,不要大量扩写或删节',
        '- 输出完整改写后的文章,不要加任何说明、前言或总结',
        '',
        '直接输出新文章全文,从第一段开始。'
    ].join('\n');

    const userPrompt = [
        '下面是需要改写的文章。AI 腔命中清单:',
        issueLines,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━',
        '【原文】',
        '━━━━━━━━━━━━━━━━━━━━━━━━',
        article,
        '━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '请输出删掉所有 AI 腔后的改写版(保留原结构和事实)。'
    ].join('\n');

    const rewritten = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
    const cleaned = String(rewritten || '').trim();
    const afterScan = scanArticle(cleaned);
    return {
        rewritten: cleaned,
        beforeScore: scan.score,
        afterScore: afterScan.score,
        beforeHits: scan.hits,
        afterHits: afterScan.hits,
        improvement: afterScan.score - scan.score
    };
}

module.exports = { scanArticle, renderScanReport, deepReviewAndRewrite, PATTERNS };
