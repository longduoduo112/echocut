'use strict';

/**
 * echocut vlog-plan — AI 写 Vlog plan(v0.11.4 核心能力)
 *
 * 用户给主题 + 核心理念 → LLM 看 metadata + 风格 + 品牌 + BGM 库 → 输出 N 个候选 plan
 */

const fs = require('fs');
const path = require('path');
const { Spinner } = require('../../lib/cliUtils');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m'
};

module.exports = async function vlogPlan(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();

    // 必填
    if (!opts.theme) {
        console.error(`${C.red}✗${C.reset} --theme 必填`);
        console.error(`   例: ${C.cyan}echocut vlog-plan --ingest ./clips --theme "创业者的一天" --idea "成长 · 专注"${C.reset}\n`);
        process.exit(1);
    }
    if (!opts.idea) {
        console.error(`${C.red}✗${C.reset} --idea 必填(你想表达的核心理念)`);
        console.error(`   例: ${C.cyan}--idea "一个人坚持 · 不孤独 · 专注"${C.reset}\n`);
        process.exit(1);
    }

    // ingest 路径:支持 dir(自动找 _metadata.json)或直接 json 文件
    let ingestPath = opts.ingest ? path.resolve(process.cwd(), opts.ingest) : '';
    if (!ingestPath) {
        console.error(`${C.red}✗${C.reset} --ingest 必填(指向已 ingest 过的素材目录或 _metadata.json)`);
        process.exit(1);
    }
    if (fs.existsSync(ingestPath) && fs.statSync(ingestPath).isDirectory()) {
        ingestPath = path.join(ingestPath, '_metadata.json');
    }
    if (!fs.existsSync(ingestPath)) {
        console.error(`${C.red}✗${C.reset} metadata 不存在: ${ingestPath}`);
        console.error(`   先跑: ${C.cyan}echocut ingest <dir>${C.reset}\n`);
        process.exit(1);
    }

    const count = Math.max(1, Math.min(8, Number(opts.count) || 3));
    const duration = opts.duration ? Number(opts.duration) : null;
    const style = opts.style || null;
    const bgmHint = opts.bgm || null;

    const outputDir = opts.outputDir
        ? path.resolve(process.cwd(), opts.outputDir)
        : path.resolve(process.cwd(), 'vlog-plans');
    fs.mkdirSync(outputDir, { recursive: true });

    // 加载配置
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const config = getConfig();
    initDb(config.contentDbPath);
    ensureDefaultConfigs();

    const model = opts.model || config.ollamaModel;

    console.log(`\n${C.bold}${C.magenta}🎬 echocut vlog-plan${C.reset} — AI 写 plan`);
    console.log(`   ${C.gray}素材${C.reset}    ${ingestPath}`);
    console.log(`   ${C.gray}主题${C.reset}    ${C.cyan}${opts.theme}${C.reset}`);
    console.log(`   ${C.gray}理念${C.reset}    ${C.cyan}${opts.idea}${C.reset}`);
    console.log(`   ${C.gray}数量${C.reset}    ${count} 个 plan`);
    if (duration) console.log(`   ${C.gray}时长${C.reset}    ${duration}s`);
    if (style) console.log(`   ${C.gray}风格${C.reset}    ${style}`);
    if (bgmHint) console.log(`   ${C.gray}BGM${C.reset}     ${bgmHint}`);
    console.log(`   ${C.gray}模型${C.reset}    ${model}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputDir}`);
    console.log('');

    const { generatePlans } = require('../../services/vlogPlanGenerator');

    const spinner = new Spinner('LLM 设计 plan 中').start();
    let result = null;
    try {
        result = await generatePlans({
            ingestPath,
            theme: opts.theme,
            idea: opts.idea,
            count,
            duration,
            style,
            bgmHint,
            projectRoot: root,
            options: {
                ollamaUrl: config.ollamaUrl,
                ollamaModel: model,
                ollamaTimeoutMs: 420000,
                ollamaRetries: 1
            },
            onProgress: (ev) => { /* silent */ }
        });
        spinner.stop(`${result.plans.length} 个 plan(LLM 给 ${result.rawCount},校验后保留 ${result.plans.length})`);
    } catch (err) {
        spinner.fail(String(err.message || err).slice(0, 150));
        if (err.rawOutput) {
            const dumpPath = path.join(outputDir, 'error-raw.txt');
            try {
                fs.writeFileSync(dumpPath, err.rawOutput, 'utf8');
                console.error(`\n${C.gray}完整 LLM 输出已存: ${dumpPath} (${err.rawOutput.length} 字)${C.reset}`);
                console.error(`${C.gray}末尾 300 字:${C.reset}\n${err.rawOutput.slice(-300)}\n`);
            } catch (_) {}
        }
        process.exit(1);
    }

    // 保存每个 plan
    console.log('');
    const savedPaths = [];
    for (let i = 0; i < result.plans.length; i += 1) {
        const plan = result.plans[i];
        // 文件名从 plan.title 生成 slug(中文也 OK)
        const slug = String(plan.title || `plan-${i + 1}`)
            .replace(/[\/\\:*?"<>|]/g, '')
            .replace(/\s+/g, '_')
            .slice(0, 30);
        const filename = `${String(i + 1).padStart(2, '0')}-${slug}.json`;
        const outPath = path.join(outputDir, filename);
        fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
        savedPaths.push(outPath);

        // 打印摘要
        console.log(`${C.bold}━━━ [${i + 1}/${result.plans.length}] ${plan.title}${C.reset}`);
        console.log(`   ${C.gray}风格${C.reset}  ${plan.style || '-'}`);
        if (plan.rationale) console.log(`   ${C.gray}叙事${C.reset}  ${plan.rationale}`);
        console.log(`   ${C.gray}段数${C.reset}  ${plan.segments.length} 段`);
        console.log(`   ${C.gray}BGM${C.reset}   ${path.basename(plan.bgm_file)}`);
        console.log(`   ${C.gray}封面${C.reset}  ${plan.cover.headline}  ${C.gray}·${C.reset}  ${plan.cover.subline}`);
        // 显示字幕预览(前 3 段)
        console.log(`   ${C.gray}字幕预览${C.reset}`);
        plan.segments.slice(0, 3).forEach((s, j) => {
            console.log(`     ${C.gray}${j + 1}.${C.reset} ${s.subtitle.replace(/\\n|\n/g, ' | ')}`);
        });
        if (plan.segments.length > 3) console.log(`     ${C.gray}... 共 ${plan.segments.length} 段${C.reset}`);
        console.log(`   ${C.gray}→${C.reset} ${C.green}${outPath}${C.reset}`);
        console.log('');
    }

    console.log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    console.log(`${C.green}✓${C.reset} 完成。${result.plans.length} 个 plan 就位 · 素材 ${result.materialCount} clip · BGM ${result.bgmCount} 首`);
    console.log('');
    console.log(`${C.gray}下一步 — 渲染某个 plan:${C.reset}`);
    console.log(`  ${C.cyan}node scripts/render-vlog-from-plan.js ${savedPaths[0] || '<plan.json>'} <clips-dir> <out.mp4>${C.reset}`);
    console.log('');
    console.log(`${C.gray}或一次全渲染:${C.reset}`);
    console.log(`  ${C.cyan}echocut vlog --ingest ${path.dirname(ingestPath)} --theme "..." --idea "..." --count ${count}${C.reset}`);
    console.log('');

    return { plans: result.plans, savedPaths, outputDir };
};
