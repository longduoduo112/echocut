'use strict';

/**
 * echocut vlog — 一步到位(plan + 渲染)
 *
 * 用户只给主题 + 理念,AI 自己编排 + 自己写字幕 + 自己渲染 N 个候选成片。
 * 用户从 N 个里挑最满意的发,剩余删。
 */

const fs = require('fs');
const path = require('path');
const { Spinner } = require('../../lib/cliUtils');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m'
};

function humanSize(b) {
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = async function vlog(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();

    if (!opts.theme || !opts.idea) {
        console.error(`${C.red}✗${C.reset} --theme 和 --idea 都必填`);
        console.error(`   例: ${C.cyan}echocut vlog --ingest ./clips --theme "创业者的一天" --idea "成长·专注" --count 3${C.reset}\n`);
        process.exit(1);
    }

    let ingestDir = opts.ingest ? path.resolve(process.cwd(), opts.ingest) : '';
    if (!ingestDir) { console.error(`${C.red}✗${C.reset} --ingest 必填`); process.exit(1); }
    if (fs.existsSync(ingestDir) && !fs.statSync(ingestDir).isDirectory()) {
        // 如果是 metadata.json 文件,取其所在目录
        ingestDir = path.dirname(ingestDir);
    }
    const ingestPath = path.join(ingestDir, '_metadata.json');
    if (!fs.existsSync(ingestPath)) {
        console.error(`${C.red}✗${C.reset} metadata 不存在: ${ingestPath}`);
        console.error(`   先跑: ${C.cyan}echocut ingest ${ingestDir}${C.reset}\n`);
        process.exit(1);
    }

    const count = Math.max(1, Math.min(5, Number(opts.count) || 3));
    const duration = opts.duration ? Number(opts.duration) : null;
    const style = opts.style || null;
    const bgmHint = opts.bgm || null;

    const outputBaseDir = opts.outputDir
        ? path.resolve(process.cwd(), opts.outputDir)
        : path.resolve(process.cwd(), `vlog-output-${Date.now()}`);
    fs.mkdirSync(outputBaseDir, { recursive: true });
    const plansDir = path.join(outputBaseDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    // 加载配置
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const config = getConfig();
    initDb(config.contentDbPath);
    ensureDefaultConfigs();

    const model = opts.model || config.ollamaModel;

    console.log(`\n${C.bold}${C.magenta}🎬 echocut vlog${C.reset} — AI 一键出 ${count} 条成片`);
    console.log(`   ${C.gray}素材${C.reset}    ${ingestDir}`);
    console.log(`   ${C.gray}主题${C.reset}    ${C.cyan}${opts.theme}${C.reset}`);
    console.log(`   ${C.gray}理念${C.reset}    ${C.cyan}${opts.idea}${C.reset}`);
    console.log(`   ${C.gray}候选${C.reset}    ${count} 条`);
    if (duration) console.log(`   ${C.gray}时长${C.reset}    ${duration}s`);
    if (style) console.log(`   ${C.gray}风格${C.reset}    ${style}`);
    if (bgmHint) console.log(`   ${C.gray}BGM${C.reset}     ${bgmHint}`);
    console.log(`   ${C.gray}模型${C.reset}    ${model}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputBaseDir}`);
    console.log('');

    // ────────────────────────── 阶段 1: AI 写 plan ──────────────────────────
    const { generatePlans } = require('../../services/vlogPlanGenerator');

    const planSpinner = new Spinner('阶段 1:LLM 设计 plan').start();
    let planResult = null;
    try {
        planResult = await generatePlans({
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
            }
        });
        planSpinner.stop(`${planResult.plans.length} 个 plan 就位`);
    } catch (err) {
        planSpinner.fail(String(err.message || err).slice(0, 150));
        if (err.rawOutput) {
            const dumpPath = path.join(outputBaseDir, 'error-raw.txt');
            try { fs.writeFileSync(dumpPath, err.rawOutput, 'utf8'); } catch (_) {}
            console.error(`${C.gray}raw 已存: ${dumpPath}${C.reset}`);
        }
        process.exit(1);
    }

    // 保存 plan
    const planFiles = [];
    for (let i = 0; i < planResult.plans.length; i += 1) {
        const plan = planResult.plans[i];
        const slug = String(plan.title || `plan-${i + 1}`).replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 30);
        const planFile = path.join(plansDir, `${String(i + 1).padStart(2, '0')}-${slug}.json`);
        fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf8');
        planFiles.push({ planFile, plan });
    }

    console.log('');
    console.log(`${C.bold}plan 概览:${C.reset}`);
    for (let i = 0; i < planFiles.length; i += 1) {
        const { plan } = planFiles[i];
        console.log(`  ${C.gray}[${i + 1}/${planFiles.length}]${C.reset} ${C.cyan}${plan.title}${C.reset}  ${C.gray}(${plan.style || '?'} · ${plan.segments.length}段 · ${path.basename(plan.bgm_file)})${C.reset}`);
        if (plan.rationale) console.log(`        ${C.gray}${plan.rationale.slice(0, 60)}${C.reset}`);
    }
    console.log('');

    // ────────────────────────── 阶段 2: 批量渲染 ──────────────────────────
    console.log(`${C.bold}阶段 2:渲染 ${planFiles.length} 条成片${C.reset}`);

    const { renderVlogFromPlan } = require('../../video/vlogRenderer');
    const { generateCover } = require('../../video/coverGenerator');
    const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');

    const brandId = opts.brand || 'example';
    const brand = loadBrandFile(brandId);
    process.env.ZDE_BRAND_CONFIG = brandToEnvString(brand);
    process.env.ZDE_DEFAULT_BRAND = brandId;

    const results = [];
    const overallStart = Date.now();

    for (let i = 0; i < planFiles.length; i += 1) {
        const { planFile, plan } = planFiles[i];
        const workDir = path.join(outputBaseDir, `work-${String(i + 1).padStart(2, '0')}`);
        const outputPath = path.join(outputBaseDir, `${String(i + 1).padStart(2, '0')}-${path.basename(planFile, '.json')}.mp4`);

        console.log(`\n  ${C.bold}[${i + 1}/${planFiles.length}] ${plan.title}${C.reset}`);

        const itemStart = Date.now();
        try {
            // 1. 生成封面
            fs.mkdirSync(workDir, { recursive: true });
            const coverPath = path.join(workDir, 'cover.jpg');
            await generateCover({
                headline: plan.cover.headline,
                subline: plan.cover.subline,
                outputPath: coverPath,
                width: plan.width || 1080,
                height: plan.height || 1920
            });

            // 2. 把 segments 的 clip_id 转绝对路径
            const segments = plan.segments.map((s) => ({
                ...s,
                clip_file: path.join(ingestDir, s.clip_id)
            }));

            // 3. BGM 路径
            const bgmPath = path.isAbsolute(plan.bgm_file) ? plan.bgm_file : path.resolve(root, plan.bgm_file);
            if (!fs.existsSync(bgmPath)) throw new Error(`BGM 不存在: ${bgmPath}`);

            // 4. 调渲染
            const rendered = await renderVlogFromPlan({
                plan: {
                    segments,
                    bgm_path: bgmPath,
                    bgm_volume: plan.bgm_volume || 0.3,
                    cover_path: coverPath,
                    cover_duration: plan.cover_duration || 0.8,
                    width: plan.width || 1080,
                    height: plan.height || 1920,
                    output_path: outputPath,
                    cta: plan.cta
                },
                workDir,
                onStep: (s) => process.stdout.write(`     step: ${s}\n`)
            });

            const itemMs = Date.now() - itemStart;
            const stat = fs.statSync(outputPath);
            console.log(`     ${C.green}✓${C.reset} ${humanSize(stat.size)} · ${rendered.duration.toFixed(1)}s · ${(itemMs / 1000).toFixed(0)}s 渲染`);
            results.push({ planFile, outputPath, ok: true, duration: rendered.duration, sizeBytes: stat.size, elapsedMs: itemMs });
        } catch (err) {
            console.log(`     ${C.red}✗${C.reset} ${String(err.message || err).slice(0, 120)}`);
            results.push({ planFile, outputPath, ok: false, error: err.message });
        }
    }

    const totalMs = Date.now() - overallStart;
    console.log('');
    console.log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    const ok = results.filter((r) => r.ok).length;
    console.log(`${C.green}✓${C.reset} 完成: ${ok}/${results.length} 条成片 · 总 ${(totalMs / 1000).toFixed(0)}s`);
    console.log('');
    console.log(`${C.gray}产出:${C.reset}`);
    for (const r of results) {
        const mark = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        console.log(`  ${mark} ${r.outputPath}`);
    }
    console.log('');
    console.log(`${C.gray}目录:${C.reset} ${outputBaseDir}`);
    console.log(`${C.gray}plan:${C.reset} ${plansDir}`);
    console.log('');
};
