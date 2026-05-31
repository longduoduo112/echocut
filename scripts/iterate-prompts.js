#!/usr/bin/env node
'use strict';

/**
 * iterate-prompts — 自驱迭代 prompt 10 轮
 *
 * 每轮做:
 *   1. 用当前 prompts.json 跑 12 篇 minimax(4 视频 × 3 风格)
 *   2. 跑 BMK 评分 12 篇
 *   3. 聚合 → round-report.md
 *   4. 让 MiniMax 当 prompt 工程师,基于反馈改进 → 下一轮 prompts.json
 *
 * 全部产物落在 docs/prompt-iterations/v01..v10/
 *
 * 用法:
 *   node scripts/iterate-prompts.js --rounds 10 --videos A,B,C,D
 *
 * 设计依据:
 *   - docs/PROSE-RESEARCH.md(顶流公众号风格)
 *   - docs/ANTI-AI-SLOP.md(反 AI 味 12 条 + 自检清单)
 *   - docs/ESSAY-BENCHMARK-FRAMEWORK.md(10 维度评分)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateEssay, PROMPTS: PRODUCTION_PROMPTS, STYLES } = require('../src/services/essayGenerator');
const { scoreEssay, DIMENSIONS } = require('../src/services/essayBenchmark');
const { chatCompletion: minimaxChat, MinimaxApiError } = require('../src/services/minimaxClient');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m'
};

// ─── 配置 ──────────────────────────────────────────────────────────────────

const VIDEOS = {
    A: { id: '0525', label: '出海主体', dir: 'debug_outputs/video/2026-05-14T10-46-29-014Z/mlx_hq_DJI_20260418180126_0525_D' },
    B: { id: '0637', label: '多记录', dir: 'debug_outputs/video/2026-05-14T14-42-44-915Z/mlx_hq_DJI_20260514222323_0637_D' },
    C: { id: '0639', label: '少要点赞', dir: 'debug_outputs/video/2026-05-14T15-00-20-874Z/mlx_hq_DJI_20260514223033_0639_D' },
    D: { id: '0638', label: '工具焦虑', dir: 'debug_outputs/video/2026-05-14T14-47-09-881Z/mlx_hq_DJI_20260514222655_0638_D' }
};

const ITER_ROOT = 'docs/prompt-iterations';
const WORK_LOG = path.join(ITER_ROOT, 'work-log.md');
const SUMMARY = path.join(ITER_ROOT, 'SUMMARY.md');

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function log(line) {
    const stamp = new Date().toISOString().slice(0, 19);
    const msg = `[${stamp}] ${line}`;
    console.log(msg);
    fs.appendFileSync(WORK_LOG, msg + '\n');
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function readTranscript(videoDir) {
    const tp = path.join(videoDir, 'transcript.json');
    if (!fs.existsSync(tp)) throw new Error(`找不到 ${tp}`);
    return String(JSON.parse(fs.readFileSync(tp, 'utf8')).full_text || '').trim();
}

function readPublishContext(videoDir) {
    const p = path.join(videoDir, 'publish.md');
    if (!fs.existsSync(p)) return {};
    const md = fs.readFileSync(p, 'utf8');
    const ctx = {};
    const dur = md.match(/时长[::]\s*([0-9:]+)/);
    if (dur) ctx.duration = dur[1];
    const title = md.match(/命令标题(?:[(（][^)）]*[)）])?[::]\s*\*\*([^*]+)\*\*/);
    if (title) ctx.title = title[1].trim();
    if (!ctx.title) {
        const g1 = md.match(/##\s*组一[\s\S]*?\*\*标题[::]\*\*\s*([^\n]+)/);
        if (g1) ctx.title = g1[1].trim();
    }
    return ctx;
}

function avg(arr) {
    const xs = arr.filter((x) => typeof x === 'number');
    if (!xs.length) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─── 1. 初始化 v01 = 生产版本 ──────────────────────────────────────────────

function snapshotProductionPrompts() {
    return {
        structured: { label: PRODUCTION_PROMPTS.structured.label, targetCharCount: PRODUCTION_PROMPTS.structured.targetCharCount, system: PRODUCTION_PROMPTS.structured.system },
        narrative: { label: PRODUCTION_PROMPTS.narrative.label, targetCharCount: PRODUCTION_PROMPTS.narrative.targetCharCount, system: PRODUCTION_PROMPTS.narrative.system },
        hardcore: { label: PRODUCTION_PROMPTS.hardcore.label, targetCharCount: PRODUCTION_PROMPTS.hardcore.targetCharCount, system: PRODUCTION_PROMPTS.hardcore.system }
    };
}

// ─── 2. 跑一轮:12 篇生成 + 评分 + 聚合 ──────────────────────────────────────

async function runRound(roundN, prompts, videoIds) {
    const roundDir = path.join(ITER_ROOT, `v${String(roundN).padStart(2, '0')}`);
    const essaysDir = path.join(roundDir, 'essays');
    const scoresDir = path.join(roundDir, 'scores');
    ensureDir(essaysDir);
    ensureDir(scoresDir);

    // 保存当前 prompts.json
    fs.writeFileSync(path.join(roundDir, 'prompts.json'), JSON.stringify(prompts, null, 2));

    const records = [];

    for (const vid of videoIds) {
        const video = VIDEOS[vid];
        const transcript = readTranscript(video.dir);
        const context = readPublishContext(video.dir);

        for (const style of STYLES) {
            const tag = `v${roundN} · ${vid}-${style}`;
            const t0 = Date.now();
            log(`  ${C.gray}→${C.reset} 生成 ${tag}...`);
            try {
                const result = await generateEssay({
                    transcript,
                    context: { ...context, brandName: 'Bill(Example / 数字游民创业者)' },
                    style,
                    model: 'minimax',
                    promptsOverride: prompts
                });
                const md = result.markdown;
                const charCount = md.replace(/\s+/g, '').length;
                const essayPath = path.join(essaysDir, `${vid}-${style}.md`);
                const fm = [
                    '---',
                    `round: ${roundN}`,
                    `video: ${vid}`,
                    `video_title: "${context.title || ''}"`,
                    `style: ${style}`,
                    `model: minimax`,
                    `char_count: ${charCount}`,
                    `elapsed_ms: ${Date.now() - t0}`,
                    `generated: ${new Date().toISOString()}`,
                    '---',
                    ''
                ].join('\n');
                fs.writeFileSync(essayPath, fm + md + '\n');
                log(`    ${C.green}✓${C.reset} ${tag} ${charCount}字 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

                // 立即评分(串行)
                log(`  ${C.gray}→${C.reset} 评分 ${tag}...`);
                const tj0 = Date.now();
                const scores = await scoreEssay({
                    essay: md,
                    transcript,
                    context: { title: context.title, duration: context.duration },
                    style,
                    judge: 'minimax',
                    retries: 1
                });
                scores.essay_meta = { video: vid, video_title: context.title || '', style, model: 'minimax', char_count: charCount, file: path.relative(process.cwd(), essayPath) };
                fs.writeFileSync(path.join(scoresDir, `${vid}-${style}.scores.json`), JSON.stringify(scores, null, 2));
                log(`    ${C.green}✓${C.reset} 评分 ${tag} = ${scores.overall} 分 (${((Date.now() - tj0) / 1000).toFixed(1)}s)`);
                records.push({ video: vid, style, scores, essayPath });
            } catch (e) {
                log(`    ${C.red}✗${C.reset} ${tag} 失败: ${(e.message || '').slice(0, 100)}`);
                records.push({ video: vid, style, error: e.message });
            }
        }
    }

    // 聚合
    const okRecords = records.filter((r) => r.scores);
    const overallAvg = avg(okRecords.map((r) => r.scores.overall));
    const dimAvg = {};
    for (const dim of DIMENSIONS) {
        dimAvg[dim] = avg(okRecords.map((r) => r.scores.scores?.[dim]?.score));
    }
    const weakest = Object.entries(dimAvg).sort((a, b) => a[1] - b[1]).slice(0, 4);
    const allImprovements = okRecords.flatMap((r) => r.scores.top_improvements || []);

    const roundMeta = {
        round: roundN,
        overall_avg: Number(overallAvg.toFixed(2)),
        dim_avg: Object.fromEntries(Object.entries(dimAvg).map(([k, v]) => [k, Number(v.toFixed(2))])),
        weakest_dims: weakest.map(([d, v]) => ({ dim: d, score: Number(v.toFixed(2)) })),
        ok: okRecords.length,
        failed: records.length - okRecords.length,
        all_improvements: allImprovements,
        scores_summary: okRecords.map((r) => ({ video: r.video, style: r.style, overall: r.scores.overall }))
    };
    fs.writeFileSync(path.join(roundDir, 'meta.json'), JSON.stringify(roundMeta, null, 2));

    // 写 round-report.md(给人看)
    const report = [];
    report.push(`# Round ${roundN} 报告`);
    report.push('');
    report.push(`- 平均分: **${roundMeta.overall_avg}**`);
    report.push(`- 成功: ${okRecords.length}/${records.length}`);
    report.push('');
    report.push(`## 分项排行`);
    report.push('| 视频 | 风格 | 分数 | 评委一句话 |');
    report.push('|---|---|---|---|');
    [...okRecords].sort((a, b) => b.scores.overall - a.scores.overall).forEach((r) => {
        report.push(`| ${r.video}(${VIDEOS[r.video]?.label || ''}) | ${r.style} | **${r.scores.overall}** | ${(r.scores.verdict || '').slice(0, 50)} |`);
    });
    report.push('');
    report.push(`## 维度平均分`);
    report.push('| 维度 | 平均分 |');
    report.push('|---|---|');
    Object.entries(dimAvg).sort((a, b) => b[1] - a[1]).forEach(([d, v]) => {
        report.push(`| ${d} | ${v.toFixed(2)} |`);
    });
    report.push('');
    report.push(`## 最薄弱 4 维度`);
    weakest.forEach(([d, v]) => report.push(`- \`${d}\`: ${v.toFixed(2)} / 10`));
    report.push('');
    report.push(`## 评委提的所有改进点(${allImprovements.length} 条)`);
    allImprovements.forEach((s, i) => report.push(`${i + 1}. ${s}`));
    fs.writeFileSync(path.join(roundDir, 'round-report.md'), report.join('\n'));

    return { roundMeta, records: okRecords };
}

// ─── 3. 让 MiniMax 当 prompt 工程师改进 prompts ─────────────────────────────

const META_PROMPT_SYSTEM = `你是顶级的 prompt 工程师,专攻"把视频口播改写成公众号文章"场景的中文 LLM prompt。

【任务】基于"上一轮的评分员反馈",改进当前 prompt → 下一版。

【硬约束(必须 100% 保留,改了就是失败)】
1. 反 AI 味 12 条规则(完整段落,以"【反 AI 味 12 条硬规则"开头到结尾)
2. 排版铁律(完整段落,以"【排版铁律"开头)
3. 口播→文章转译规则(完整段落)
4. 事实保真硬约束(完整段落,以"【事实保真硬约束"开头)
5. 输出前自检清单(完整段落,以"【输出前自检清单"开头)
6. 三位老编辑的人设:structured = 老刘 / narrative = 老何 / hardcore = 老吴(自我介绍口吻保留)
7. 字数目标各风格:structured 1500-1800 / narrative 2000-2800 / hardcore 2200-3500
8. 风格定位三流派:刘润流 / 何加盐流 / 半佛流(不要替换)
9. label 字段格式保留

【你可以改的(应该针对性优化)】
1. 老编辑的"教徒弟话术"细化或新增示范(few-shot)
2. 开头钩子的具体示范(好开头 + 烂开头各举 1-2 个)
3. 结尾收束的具体示范(好结尾 + 烂结尾各举 1-2 个)
4. 自检清单细化(根据反馈,可补检查项)
5. 字数控制语气强弱(可以更严格)
6. 风格特定的细化规则(如 hardcore 的"反共识对比"必须 ≥3 处)
7. 加新的"反 AI 味"具体规则(如发现某个 AI 套路句式高频出现,可专门禁掉)

【你输出的 JSON schema(严格)】

\`\`\`json
{
  "change_log": "本轮 prompt 改了哪些(每行一项,30-50 字一条,3-6 条)",
  "structured": {
    "label": "...",
    "targetCharCount": "1500-1800 字",
    "system": "完整 system prompt,从 '小友:' 开头到 '去吧。' 结尾"
  },
  "narrative": { "label": "...", "targetCharCount": "2000-2800 字", "system": "..." },
  "hardcore":   { "label": "...", "targetCharCount": "2200-3500 字", "system": "..." }
}
\`\`\`

只输出 JSON,不要输出其他任何东西。`;

function buildIterUserMsg(currentPrompts, lastMeta) {
    const blocks = [];
    blocks.push(`【上一轮平均分】${lastMeta.overall_avg} / 100`);
    blocks.push('');
    blocks.push('【各维度平均分(0-10)】');
    Object.entries(lastMeta.dim_avg).sort((a, b) => a[1] - b[1]).forEach(([d, v]) => {
        blocks.push(`- ${d}: ${v}`);
    });
    blocks.push('');
    blocks.push('【最薄弱 4 个维度】');
    lastMeta.weakest_dims.forEach((w) => blocks.push(`- ${w.dim}: ${w.score} / 10`));
    blocks.push('');
    blocks.push('【评委提的所有 top_improvements(去重前)】');
    lastMeta.all_improvements.forEach((s, i) => blocks.push(`${i + 1}. ${s}`));
    blocks.push('');
    blocks.push('【当前 prompt v_n】');
    blocks.push('');
    blocks.push('--- structured.system ---');
    blocks.push(currentPrompts.structured.system);
    blocks.push('');
    blocks.push('--- narrative.system ---');
    blocks.push(currentPrompts.narrative.system);
    blocks.push('');
    blocks.push('--- hardcore.system ---');
    blocks.push(currentPrompts.hardcore.system);
    blocks.push('');
    blocks.push('请基于反馈写 v_{n+1} 的三个 prompt。输出 JSON,严格 schema。');
    return blocks.join('\n');
}

function extractJsonStrict(raw) {
    const text = String(raw || '');
    const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    const body = fence ? fence[1].trim() : (() => {
        const f = text.indexOf('{');
        const l = text.lastIndexOf('}');
        return f >= 0 && l > f ? text.slice(f, l + 1) : text;
    })();
    try { return JSON.parse(body); } catch (_) {}
    // sanitize: trailing comma + 行注释
    const cleaned = body
        .replace(/(^|[\s,{\[])\/\/[^\n]*/g, '$1')
        .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch (_) { return null; }
}

function validateNewPrompts(parsed) {
    if (!parsed || typeof parsed !== 'object') return 'not_object';
    if (!parsed.change_log) return 'missing_change_log';
    for (const s of STYLES) {
        if (!parsed[s]) return `missing_${s}`;
        if (!parsed[s].system) return `missing_${s}_system`;
        if (!parsed[s].label) return `missing_${s}_label`;
        const sys = parsed[s].system;
        // 硬约束 sanity check
        if (!sys.includes('反 AI 味 12 条')) return `${s} 丢了反 AI 12 条`;
        if (!sys.includes('排版铁律')) return `${s} 丢了排版铁律`;
        if (!sys.includes('口播→文章转译规则')) return `${s} 丢了转译规则`;
        if (!sys.includes('事实保真')) return `${s} 丢了事实保真`;
        if (!sys.includes('自检清单')) return `${s} 丢了自检清单`;
        // 人设保留
        const personaMap = { structured: '老刘', narrative: '老何', hardcore: '老吴' };
        if (!sys.includes(personaMap[s])) return `${s} 丢了 ${personaMap[s]} 人设`;
    }
    return null;
}

async function iteratePrompts(currentPrompts, lastMeta) {
    const messages = [
        { role: 'system', content: META_PROMPT_SYSTEM },
        { role: 'user', content: buildIterUserMsg(currentPrompts, lastMeta) }
    ];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const t0 = Date.now();
        try {
            const r = await minimaxChat({
                messages,
                temperature: 0.5,
                topP: 0.92,
                maxCompletionTokens: 24576, // 三个 system prompt 总和很长
                timeoutMs: 300000
            });
            const parsed = extractJsonStrict(r.content);
            const err = validateNewPrompts(parsed);
            if (err) {
                log(`  ${C.yellow}⚠${C.reset} 迭代 prompt 校验失败 (attempt ${attempt}): ${err},retrying...`);
                if (attempt >= 3) throw new Error(`迭代 prompt 校验 3 次失败: ${err}`);
                await new Promise((res) => setTimeout(res, 3000));
                continue;
            }
            log(`  ${C.green}✓${C.reset} prompt 迭代成功 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            return parsed;
        } catch (e) {
            log(`  ${C.yellow}⚠${C.reset} 迭代 attempt ${attempt} 失败: ${e.message.slice(0, 80)}`);
            if (attempt >= 3) throw e;
            await new Promise((res) => setTimeout(res, 5000));
        }
    }
}

// ─── 4. 主 loop ─────────────────────────────────────────────────────────────

async function main() {
    const a = process.argv.slice(2);
    let rounds = 10;
    let videoIds = ['A', 'B', 'C', 'D'];
    let resumeFrom = 1;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] === '--rounds') rounds = Number(a[++i]);
        else if (a[i] === '--videos') videoIds = a[++i].split(',');
        else if (a[i] === '--resume-from') resumeFrom = Number(a[++i]);
    }

    ensureDir(ITER_ROOT);
    fs.writeFileSync(WORK_LOG, fs.existsSync(WORK_LOG) ? fs.readFileSync(WORK_LOG, 'utf8') : '', { flag: 'a' });
    log('');
    log(`${C.cyan}════ iterate-prompts 启动 ════${C.reset}`);
    log(`rounds=${rounds}, videos=${videoIds.join(',')}, resume_from=${resumeFrom}`);

    // 初始化:v01 = 生产版本(老编辑私信 v2)
    let currentPrompts;
    const v01Dir = path.join(ITER_ROOT, 'v01');
    if (resumeFrom > 1 && fs.existsSync(path.join(ITER_ROOT, `v${String(resumeFrom).padStart(2, '0')}`, 'prompts.json'))) {
        currentPrompts = JSON.parse(fs.readFileSync(path.join(ITER_ROOT, `v${String(resumeFrom).padStart(2, '0')}`, 'prompts.json'), 'utf8'));
        log(`resume: 从 v${resumeFrom} prompts.json 加载`);
    } else {
        currentPrompts = snapshotProductionPrompts();
        if (resumeFrom === 1) {
            ensureDir(v01Dir);
            fs.writeFileSync(path.join(v01Dir, 'prompts.json'), JSON.stringify(currentPrompts, null, 2));
            log('v01 = 生产版本(老编辑私信 + 反 AI 12 条)snapshot 完成');
        }
    }

    const allMeta = [];
    let bestRound = null;

    for (let round = resumeFrom; round <= rounds; round += 1) {
        log('');
        log(`${C.bold}${C.cyan}═══ Round ${round} / ${rounds} START ═══${C.reset}`);
        const tR0 = Date.now();

        try {
            const { roundMeta } = await runRound(round, currentPrompts, videoIds);
            const tR = ((Date.now() - tR0) / 1000).toFixed(0);
            log(`${C.green}✓${C.reset} Round ${round} 完成,平均分 ${roundMeta.overall_avg},用时 ${tR}s`);
            allMeta.push(roundMeta);

            if (!bestRound || roundMeta.overall_avg > bestRound.overall_avg) {
                bestRound = roundMeta;
                log(`${C.magenta}★${C.reset} 当前最佳: Round ${round} = ${roundMeta.overall_avg}`);
            }

            // 写 SUMMARY 增量(每轮都更新,防意外断电)
            writeSummary(allMeta, bestRound, currentPrompts, videoIds);

            // 不是最后一轮 → 迭代 prompt
            if (round < rounds) {
                log(`  ${C.gray}迭代 prompt v${round} → v${round + 1}...${C.reset}`);
                const nextPrompts = await iteratePrompts(currentPrompts, roundMeta);
                const nextDir = path.join(ITER_ROOT, `v${String(round + 1).padStart(2, '0')}`);
                ensureDir(nextDir);
                fs.writeFileSync(path.join(nextDir, 'prompts.json'), JSON.stringify({
                    structured: nextPrompts.structured,
                    narrative: nextPrompts.narrative,
                    hardcore: nextPrompts.hardcore
                }, null, 2));
                fs.writeFileSync(path.join(nextDir, 'change-log.md'), `# v${round + 1} 改了什么(相对 v${round})\n\n${nextPrompts.change_log}\n`);
                currentPrompts = nextPrompts;
            }
        } catch (e) {
            log(`${C.red}✗${C.reset} Round ${round} 失败: ${e.message}`);
            log(`继续下一轮(若有)...`);
        }
    }

    // 最终 SUMMARY
    writeSummary(allMeta, bestRound, currentPrompts, videoIds);
    log('');
    log(`${C.bold}${C.green}════ ALL DONE ════${C.reset}`);
    log(`总轮次: ${allMeta.length}, 最佳: Round ${bestRound?.round} = ${bestRound?.overall_avg}`);
}

function writeSummary(allMeta, bestRound, finalPrompts, videoIds) {
    const lines = [];
    lines.push('# Prompt 迭代总览 SUMMARY');
    lines.push('');
    lines.push(`生成时间: ${new Date().toISOString()}`);
    lines.push(`视频集: ${videoIds.join(', ')} (每轮 ${videoIds.length * 3} 篇)`);
    lines.push(`完成轮次: ${allMeta.length}`);
    lines.push('');
    if (bestRound) {
        lines.push(`## 🏆 当前最佳: Round ${bestRound.round} = **${bestRound.overall_avg}** 分`);
        lines.push('');
    }
    lines.push('## 各轮平均分趋势');
    lines.push('');
    lines.push('| 轮次 | 平均分 | 最薄弱 4 维度 | 详细 |');
    lines.push('|---|---|---|---|');
    for (const m of allMeta) {
        const weak = m.weakest_dims.map((w) => `${w.dim}(${w.score})`).join(', ');
        lines.push(`| v${m.round} | **${m.overall_avg}** | ${weak} | [round-report](v${String(m.round).padStart(2, '0')}/round-report.md) |`);
    }
    lines.push('');
    lines.push('## 各维度跨轮趋势');
    lines.push('');
    lines.push('| 轮次 | fidelity | anti_ai | hook | cadence | insight | read | warmth | closing | coherence | share | overall |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of allMeta) {
        const d = m.dim_avg;
        lines.push(`| v${m.round} | ${d.fidelity} | ${d.anti_ai_slop} | ${d.hook} | ${d.cadence} | ${d.insight_density} | ${d.readability} | ${d.warmth} | ${d.closing} | ${d.coherence} | ${d.shareability} | **${m.overall_avg}** |`);
    }
    lines.push('');
    lines.push('## 推荐版本');
    lines.push('');
    if (bestRound) {
        lines.push(`**推荐使用 v${String(bestRound.round).padStart(2, '0')}/prompts.json**(平均分 ${bestRound.overall_avg})`);
        lines.push('');
        lines.push(`复制路径: \`docs/prompt-iterations/v${String(bestRound.round).padStart(2, '0')}/prompts.json\``);
        lines.push('');
        lines.push('对照其他版本 prompts.json 可参考 各 round-report.md。');
    }
    fs.writeFileSync(SUMMARY, lines.join('\n'));
}

main().catch((e) => {
    log(`${C.red}FATAL${C.reset} ${e.stack || e.message}`);
    process.exit(1);
});
