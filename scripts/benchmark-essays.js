#!/usr/bin/env node
'use strict';

/**
 * benchmark-essays — 用 LLM-as-Judge 给 essay 产出打分
 *
 * 设计:docs/ESSAY-BENCHMARK-FRAMEWORK.md(10 维度评分)
 * 评分员:src/services/essayBenchmark.js(默认 MiniMax M2.7)
 *
 * 用法:
 *   node scripts/benchmark-essays.js [--judge minimax|ollama] <essay-dir-or-glob...>
 *
 * 例子:
 *   # 评单个 essays/ 目录(6 篇)
 *   node scripts/benchmark-essays.js debug_outputs/video/<run>/<engine>_<stem>/essays/
 *
 *   # 评多个视频
 *   node scripts/benchmark-essays.js debug_outputs/video/*\/mlx_hq_*\/essays/
 *
 *   # 也可以直接传 .md 文件
 *   node scripts/benchmark-essays.js path/to/essay.md
 *
 * 产出:
 *   - 每篇 essay 同目录下生成 <essay>.scores.json
 *   - 汇总报告 docs/ESSAY-BENCHMARK-REPORT-<YYYYMMDD-HHmm>.md
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { scoreEssay, DIMENSIONS } = require('../src/services/essayBenchmark');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function args() {
    const a = process.argv.slice(2);
    const opts = { judge: 'minimax', paths: [], rerun: false };
    for (let i = 0; i < a.length; i += 1) {
        const x = a[i];
        if (x === '--judge') { opts.judge = a[++i]; continue; }
        if (x === '--rerun') { opts.rerun = true; continue; }
        if (x === '--help') {
            console.log('Usage: node scripts/benchmark-essays.js [--judge minimax|ollama] [--rerun] <essay-dir-or-md...>');
            process.exit(0);
        }
        opts.paths.push(x);
    }
    if (!opts.paths.length) {
        console.error('请指定至少一个 essay 目录或 md 文件');
        process.exit(1);
    }
    return opts;
}

/**
 * 给定一个路径,展开成 .md 文件列表
 *   - 目录:扫所有 essay-*.md
 *   - 文件:直接返回
 */
function expandPath(p) {
    if (!fs.existsSync(p)) {
        console.warn(`${C.yellow}⚠${C.reset}  跳过不存在的路径: ${p}`);
        return [];
    }
    const stat = fs.statSync(p);
    if (stat.isFile()) return [p];
    return fs.readdirSync(p)
        .filter((f) => f.startsWith('essay-') && f.endsWith('.md'))
        .map((f) => path.join(p, f));
}

/**
 * 从 essay 文件解析 front matter + 正文
 */
function parseEssay(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`essay 缺 front matter: ${filePath}`);
    const fm = {};
    for (const line of m[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
    }
    return { frontMatter: fm, body: m[2].trim(), raw };
}

/**
 * 找 transcript:essay 在 essays/ 下,transcript.json 在父目录
 */
function findTranscript(essayPath) {
    const essayDir = path.dirname(essayPath);
    if (path.basename(essayDir) === 'essays') {
        const parent = path.dirname(essayDir);
        const t = path.join(parent, 'transcript.json');
        if (fs.existsSync(t)) return t;
    }
    // fallback: front matter 的 source_transcript
    const { frontMatter } = parseEssay(essayPath);
    if (frontMatter.source_transcript) {
        const abs = path.isAbsolute(frontMatter.source_transcript)
            ? frontMatter.source_transcript
            : path.resolve(process.cwd(), frontMatter.source_transcript);
        if (fs.existsSync(abs)) return abs;
    }
    return null;
}

function readTranscript(transcriptPath) {
    const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    return String(data.full_text || '').trim();
}

function fmtTime(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m${s.toString().padStart(2, '0')}s`;
}

/**
 * 主流程
 */
async function main() {
    const opts = args();
    const allEssays = opts.paths.flatMap(expandPath);
    if (!allEssays.length) {
        console.error('没找到 essay');
        process.exit(1);
    }

    console.log('');
    console.log(`${C.cyan}📊 essay benchmark${C.reset}`);
    console.log(`   ${C.gray}评委${C.reset}      ${opts.judge}`);
    console.log(`   ${C.gray}待评篇数${C.reset}  ${allEssays.length}`);
    console.log(`   ${C.gray}rerun${C.reset}     ${opts.rerun ? '是' : '否(已有 .scores.json 会跳过)'}`);
    console.log('');

    const records = [];
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < allEssays.length; i += 1) {
        const essayPath = allEssays[i];
        const rel = path.relative(process.cwd(), essayPath);
        const tag = `[${i + 1}/${allEssays.length}]`;
        const scoresPath = essayPath.replace(/\.md$/, '.scores.json');

        if (!opts.rerun && fs.existsSync(scoresPath)) {
            const cached = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
            console.log(`${C.gray}${tag} 已缓存 (${cached.overall || '?'} 分): ${rel}${C.reset}`);
            records.push({ essayPath, scores: cached, cached: true });
            okCount += 1;
            continue;
        }

        try {
            const { frontMatter, body } = parseEssay(essayPath);
            const transcriptPath = findTranscript(essayPath);
            if (!transcriptPath) throw new Error('找不到 transcript.json(fidelity 评分需要)');
            const transcript = readTranscript(transcriptPath);

            const context = {
                title: frontMatter.source_title || '',
                duration: frontMatter.source_duration || '',
                style: frontMatter.style || '',
                model: frontMatter.model || ''
            };

            process.stdout.write(`${tag} 评分中 ${rel}...`);
            const t0 = Date.now();
            const scores = await scoreEssay({
                essay: body,
                transcript,
                context,
                style: frontMatter.style,
                judge: opts.judge,
                retries: 1
            });
            const elapsed = Date.now() - t0;

            // 补 essay 元信息进 scores
            scores.essay_meta = {
                file: rel,
                style: frontMatter.style,
                model: frontMatter.model,
                char_count: Number(frontMatter.char_count) || 0,
                source_title: frontMatter.source_title || ''
            };

            fs.writeFileSync(scoresPath, JSON.stringify(scores, null, 2));
            console.log(`\r${tag} ${C.green}✓${C.reset} ${scores.overall} 分 (${fmtTime(elapsed)}) ${C.gray}${rel}${C.reset}`);
            records.push({ essayPath, scores });
            okCount += 1;
        } catch (e) {
            console.log(`\r${tag} ${C.red}✗${C.reset} ${e.message.slice(0, 100)} ${C.gray}${rel}${C.reset}`);
            failCount += 1;
        }
    }

    // 汇总报告
    console.log('');
    console.log(`${C.gray}${'─'.repeat(70)}${C.reset}`);
    console.log(`${C.green}✓${C.reset} 评分完成 ${okCount}/${allEssays.length} 篇,失败 ${failCount} 篇`);

    if (!records.length) {
        console.log('没有有效评分,跳过报告');
        return;
    }

    // 出报告
    const reportPath = generateReport(records);
    console.log('');
    console.log(`${C.cyan}📄 完整报告${C.reset}: ${reportPath}`);
    console.log('');
}

/**
 * 汇总报告 — markdown,放 docs/
 */
function generateReport(records) {
    const ts = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);
    const reportPath = path.join('docs', `ESSAY-BENCHMARK-REPORT-${ts}.md`);
    const lines = [];

    lines.push(`# Essay Benchmark Report`);
    lines.push('');
    lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`);
    lines.push(`评分员: ${records[0]?.scores?.judge || 'minimax'} (10 维度评分,见 docs/ESSAY-BENCHMARK-FRAMEWORK.md)`);
    lines.push(`总篇数: ${records.length}`);
    lines.push('');

    // ─── 1. 总排行榜 ───
    lines.push(`## 🏆 总排行榜(按 overall 降序)`);
    lines.push('');
    lines.push(`| 排名 | overall | verdict | 风格 | 模型 | 视频主题 | 文件 |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    const sorted = [...records].sort((a, b) => (b.scores.overall || 0) - (a.scores.overall || 0));
    sorted.forEach((r, i) => {
        const m = r.scores.essay_meta || {};
        lines.push(`| ${i + 1} | **${r.scores.overall || '-'}** | ${(r.scores.verdict || '').slice(0, 24)} | ${m.style || ''} | ${m.model || ''} | ${(m.source_title || '').slice(0, 22)} | ${(m.file || '').replace(/^.+\/essays\//, '')} |`);
    });
    lines.push('');

    // ─── 2. 10 维度全表 ───
    lines.push(`## 📊 10 维度分项(按 overall 降序)`);
    lines.push('');
    const cols = ['file', 'fidelity', 'anti_ai', 'hook', 'cadence', 'insight', 'read', 'warmth', 'closing', 'coherence', 'share', 'overall'];
    lines.push(`| ${cols.join(' | ')} |`);
    lines.push(`|${cols.map(() => '---').join('|')}|`);
    sorted.forEach((r) => {
        const m = r.scores.essay_meta || {};
        const s = r.scores.scores || {};
        const file = (m.file || '').replace(/^.+\/essays\//, '').replace(/^essay-/, '').replace(/\.md$/, '');
        const cells = [
            file,
            s.fidelity?.score ?? '-',
            s.anti_ai_slop?.score ?? '-',
            s.hook?.score ?? '-',
            s.cadence?.score ?? '-',
            s.insight_density?.score ?? '-',
            s.readability?.score ?? '-',
            s.warmth?.score ?? '-',
            s.closing?.score ?? '-',
            s.coherence?.score ?? '-',
            s.shareability?.score ?? '-',
            `**${r.scores.overall || '-'}**`
        ];
        lines.push(`| ${cells.join(' | ')} |`);
    });
    lines.push('');

    // ─── 3. 模型对比(平均分) ───
    lines.push(`## 🤖 模型对比(各维度平均分)`);
    lines.push('');
    const byModel = groupByMeta(records, 'model');
    lines.push(`| 维度 | ${Object.keys(byModel).join(' | ')} |`);
    lines.push(`|---|${Object.keys(byModel).map(() => '---').join('|')}|`);
    for (const dim of DIMENSIONS) {
        const row = [dim];
        for (const m of Object.keys(byModel)) {
            row.push(avg(byModel[m].map((r) => r.scores.scores?.[dim]?.score)).toFixed(1));
        }
        lines.push(`| ${row.join(' | ')} |`);
    }
    // overall 总平均
    const overallRow = ['**overall**'];
    for (const m of Object.keys(byModel)) {
        overallRow.push('**' + avg(byModel[m].map((r) => r.scores.overall)).toFixed(1) + '**');
    }
    lines.push(`| ${overallRow.join(' | ')} |`);
    lines.push('');

    // ─── 4. 风格对比(平均分) ───
    lines.push(`## 🎨 风格对比(各维度平均分)`);
    lines.push('');
    const byStyle = groupByMeta(records, 'style');
    lines.push(`| 维度 | ${Object.keys(byStyle).join(' | ')} |`);
    lines.push(`|---|${Object.keys(byStyle).map(() => '---').join('|')}|`);
    for (const dim of DIMENSIONS) {
        const row = [dim];
        for (const s of Object.keys(byStyle)) {
            row.push(avg(byStyle[s].map((r) => r.scores.scores?.[dim]?.score)).toFixed(1));
        }
        lines.push(`| ${row.join(' | ')} |`);
    }
    const overallRowS = ['**overall**'];
    for (const s of Object.keys(byStyle)) {
        overallRowS.push('**' + avg(byStyle[s].map((r) => r.scores.overall)).toFixed(1) + '**');
    }
    lines.push(`| ${overallRowS.join(' | ')} |`);
    lines.push('');

    // ─── 5. Top 3 ───
    lines.push(`## 🥇 Top 3 详细分析`);
    lines.push('');
    sorted.slice(0, 3).forEach((r, i) => {
        const m = r.scores.essay_meta || {};
        lines.push(`### 第 ${i + 1} 名 · ${r.scores.overall} 分 · ${m.style} × ${m.model}`);
        lines.push('');
        lines.push(`**视频主题**: ${m.source_title || '(未知)'}`);
        lines.push(`**文件**: \`${m.file || ''}\``);
        lines.push(`**评委一句话**: ${r.scores.verdict || ''}`);
        lines.push('');
        if (r.scores.top_strengths?.length) {
            lines.push(`✅ **强项**:`);
            r.scores.top_strengths.forEach((s) => lines.push(`- ${s}`));
            lines.push('');
        }
        if (r.scores.top_improvements?.length) {
            lines.push(`⚠️ **改进点**:`);
            r.scores.top_improvements.forEach((s) => lines.push(`- ${s}`));
            lines.push('');
        }
    });

    // ─── 6. Bottom 3 ───
    lines.push(`## 🚨 Bottom 3(需要重点优化)`);
    lines.push('');
    sorted.slice(-3).reverse().forEach((r) => {
        const m = r.scores.essay_meta || {};
        lines.push(`### ${r.scores.overall} 分 · ${m.style} × ${m.model}`);
        lines.push('');
        lines.push(`**视频**: ${m.source_title || '(未知)'} | **文件**: \`${(m.file || '').replace(/^.+\/essays\//, '')}\``);
        lines.push(`**评委一句话**: ${r.scores.verdict || ''}`);
        lines.push('');
        if (r.scores.top_improvements?.length) {
            lines.push(`需要改进:`);
            r.scores.top_improvements.forEach((s) => lines.push(`- ${s}`));
            lines.push('');
        }
    });

    // ─── 7. 编辑视角洞察 ───
    lines.push(`## 💡 编辑视角洞察(基于全部 ${records.length} 篇)`);
    lines.push('');
    const insights = analyzeAcrossSamples(records);
    insights.forEach((line) => lines.push(line));
    lines.push('');

    // ─── 8. 下一轮 prompt 优化建议 ───
    lines.push(`## 🔧 下一轮 Prompt 优化建议`);
    lines.push('');
    const advice = generateAdvice(records);
    advice.forEach((line) => lines.push(line));
    lines.push('');

    fs.writeFileSync(reportPath, lines.join('\n'));
    return reportPath;
}

function groupByMeta(records, key) {
    const out = {};
    for (const r of records) {
        const v = r.scores.essay_meta?.[key] || 'unknown';
        if (!out[v]) out[v] = [];
        out[v].push(r);
    }
    return out;
}

function avg(arr) {
    const xs = arr.filter((x) => typeof x === 'number');
    if (!xs.length) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function analyzeAcrossSamples(records) {
    const lines = [];
    const dimAvg = {};
    for (const dim of DIMENSIONS) {
        dimAvg[dim] = avg(records.map((r) => r.scores.scores?.[dim]?.score));
    }
    const dimEntries = Object.entries(dimAvg).sort((a, b) => a[1] - b[1]);
    const weakest = dimEntries.slice(0, 3);
    const strongest = dimEntries.slice(-3).reverse();
    lines.push(`**全样本最薄弱的 3 个维度**(整体平均分最低,LLM 通用短板):`);
    weakest.forEach(([d, s]) => lines.push(`- \`${d}\` 平均 ${s.toFixed(1)} / 10`));
    lines.push('');
    lines.push(`**全样本最强的 3 个维度**:`);
    strongest.forEach(([d, s]) => lines.push(`- \`${d}\` 平均 ${s.toFixed(1)} / 10`));
    lines.push('');

    const totalAvg = avg(records.map((r) => r.scores.overall));
    lines.push(`**总平均分**: ${totalAvg.toFixed(1)} / 100`);

    // 模型 vs 风格交叉
    const byBoth = {};
    for (const r of records) {
        const k = `${r.scores.essay_meta?.style}-${r.scores.essay_meta?.model}`;
        if (!byBoth[k]) byBoth[k] = [];
        byBoth[k].push(r.scores.overall || 0);
    }
    const bestCombo = Object.entries(byBoth)
        .map(([k, vs]) => [k, vs.reduce((a, b) => a + b, 0) / vs.length])
        .sort((a, b) => b[1] - a[1]);
    if (bestCombo.length) {
        lines.push('');
        lines.push(`**最佳风格 × 模型组合**(平均分降序):`);
        bestCombo.forEach(([k, s]) => lines.push(`- \`${k}\` 平均 ${s.toFixed(1)}`));
    }
    return lines;
}

function generateAdvice(records) {
    const lines = [];
    const dimAvg = {};
    for (const dim of DIMENSIONS) {
        dimAvg[dim] = avg(records.map((r) => r.scores.scores?.[dim]?.score));
    }
    // 给出针对性建议
    const adviceMap = {
        fidelity: '加强 transcript 引用强制 — 在 prompt 里要求每个具体名词标注"出处:transcript 第 X 段"',
        anti_ai_slop: '反 AI 味 12 条要进一步强化,可以加白名单允许的连接词列表',
        hook: '开头钩子需更具体场景化,可在 prompt 里给 5 个开头范例(few-shot)',
        cadence: '在 prompt 里加显式句长检查"每 5 句至少 1 句 ≤15 字"',
        insight_density: '要求 LLM 从 transcript 里识别 3-5 句最有价值的判断作为金句候选',
        readability: '排版铁律(加粗 ≤3 处、引用 ≤1 个)需更明确警告',
        warmth: '加强第一人称示例,在 prompt 里给"我前阵子"这种锚点的示范',
        closing: '禁用号召式结尾,可加白名单"好的结尾示范"3-5 条',
        coherence: '加强风格定位的细节,如 hardcore 流派的"反共识 + 数据撑住"双约束',
        shareability: '要求 LLM 自检"这篇能不能让人想转发",输出前自评'
    };
    const weakDims = Object.entries(dimAvg).sort((a, b) => a[1] - b[1]).slice(0, 5);
    lines.push(`下一轮 prompt v3 的优先优化方向(按薄弱程度排序):`);
    lines.push('');
    weakDims.forEach(([d, s], i) => {
        lines.push(`${i + 1}. **${d}** (当前平均 ${s.toFixed(1)}/10): ${adviceMap[d] || ''}`);
    });
    return lines;
}

main().catch((e) => {
    console.error('benchmark failed:', e.message);
    process.exit(1);
});
