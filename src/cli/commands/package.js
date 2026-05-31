'use strict';

/**
 * echocut package <input>
 *
 * "Brand 包装" 子命令 — 给已经剪好的视频(任意来源:剪映/Premiere/Final Cut)
 * 加品牌封面 + BGM + CTA 尾卡 + 末尾淡出。**不做字幕烧录 / 不做 ASR**。
 *
 * 典型工作流:
 *   1. Bill 用剪映把"原始素材"剪出"画面 + 字幕"(剪映自动字幕识别准确度高,所见即所得)
 *   2. 导出剪映成片(任意分辨率,字幕已烧在画面里)
 *   3. echocut package <剪映成片> --headline "..." --subline "..."
 *      → 自动:首帧封面(brand 品牌封面 + 标题)→ Bill 视频主体 → 末尾淡出 + CTA → 全程 BGM
 *
 * 跟 burn 的区别:
 *   - burn = ASR 转写 → LLM 校正字幕 → 烧字幕 → 顶部黑带标题 → 封面 → BGM → CTA(全自动)
 *   - package = 用户已剪好(含字幕) → 只加 封面 + BGM + CTA(brand 包装)
 *
 * 不传 --headline 时,headline 从输入文件名提取(去后缀)。
 */

const fs = require('fs');
const path = require('path');
const { generateCover } = require('../../video/coverGenerator');
const { attachCoverAndFadeOut } = require('../../video/postProcess');
const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');
const { acquireLock } = require('../../lib/processLock');

function resolveBgmPath(bgmName, projectRoot) {
    if (!bgmName || bgmName === 'none') return '';
    const bgmDir = path.join(projectRoot, 'assets', 'bgm');
    // 完全匹配
    const exact = path.join(bgmDir, bgmName.endsWith('.mp3') ? bgmName : `${bgmName}.mp3`);
    if (fs.existsSync(exact)) return exact;
    // 模糊匹配
    if (fs.existsSync(bgmDir)) {
        const files = fs.readdirSync(bgmDir).filter((f) => f.endsWith('.mp3'));
        const hit = files.find((f) => f.includes(bgmName));
        if (hit) return path.join(bgmDir, hit);
    }
    return '';
}

module.exports = async function packageCmd(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到文件: ${abs}`);
        process.exit(1);
    }

    // 进程锁(防并发抢 ffmpeg)
    try { acquireLock('package.lock', { allowWait: true }); }
    catch (err) { console.error(`\x1b[31m✗\x1b[0m ${err.message}`); process.exit(1); }

    // 加载 brand
    const brandId = opts.brand || 'example';
    let brand;
    try {
        brand = loadBrandFile(brandId);
        process.env.ZDE_BRAND_CONFIG = brandToEnvString(brand);
        process.env.ZDE_DEFAULT_BRAND = brandId;
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m brand 加载失败: ${err.message}`);
        process.exit(1);
    }

    // 标题:CLI 优先 → 文件名(去后缀)
    const stem = path.basename(abs, path.extname(abs));
    const headline = opts.headline || stem;
    const subline = opts.subline || '';

    // 输出路径
    const outDir = opts.outDir ? path.resolve(opts.outDir) : path.dirname(abs);
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = opts.out
        ? path.resolve(opts.out)
        : path.join(outDir, `${stem}_packaged${path.extname(abs)}`);

    // 封面生成
    const coverPath = opts.cover
        ? path.resolve(opts.cover)
        : path.join(outDir, `${stem}_packaged_cover.jpg`);

    // BGM 解析
    const bgmName = opts.bgm || (brand?.bgm?.defaultName) || '02-guzheng-zen';
    const bgmPath = resolveBgmPath(bgmName, root);
    const bgmVolume = Number(opts.bgmVolume) > 0 ? Number(opts.bgmVolume) : (brand?.bgm?.defaultVolume || 0.08);

    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
    console.log(`\n${C.cyan}📦 echocut package${C.reset}`);
    console.log(`   ${C.gray}输入${C.reset}   ${path.basename(abs)}`);
    console.log(`   ${C.gray}品牌${C.reset}   ${C.green}${brandId}${C.reset} — ${brand.displayName || ''}`);
    console.log(`   ${C.gray}标题${C.reset}   ${headline}`);
    if (subline) console.log(`   ${C.gray}副标题${C.reset} ${subline}`);
    console.log(`   ${C.gray}BGM${C.reset}    ${bgmPath ? path.basename(bgmPath) : '(none)'} @${bgmVolume}`);
    console.log(`   ${C.gray}封面${C.reset}   ${path.relative(process.cwd(), coverPath)}`);
    console.log(`   ${C.gray}输出${C.reset}   ${path.relative(process.cwd(), outputPath)}`);
    console.log('');

    // 1. 生成封面(用 brand 默认 bandTopY/bandHeight,跟历史一致)
    console.log(`${C.cyan}[1/2]${C.reset} 生成封面`);
    const t1 = Date.now();
    try {
        await generateCover({
            outputPath: coverPath,
            headline,
            subline,
            // 不覆盖 brand 默认参数(bandTopY/bandHeight 跟历史一致)
        });
        console.log(`  ✓ ${((Date.now() - t1) / 1000).toFixed(1)}s → ${path.relative(process.cwd(), coverPath)}`);
    } catch (err) {
        console.error(`${C.red}✗${C.reset} 封面生成失败: ${err.message}`);
        process.exit(1);
    }

    // 2. 视频后处理:封面前置 + BGM + CTA + 末尾淡出
    console.log(`${C.cyan}[2/2]${C.reset} 封面前置 + BGM + CTA 尾卡 + 末尾淡出`);
    const t2 = Date.now();
    try {
        await attachCoverAndFadeOut({
            inputVideoPath: abs,
            coverPath,
            outputPath,
            includeCover: opts.cover !== 'none',
            bgmPath,
            bgmVolume,
            // CTA 默认从 brand.cta 读取,可通过 opts 覆盖
            ctaTitle: opts.ctaTitle,
            ctaSubtitle: opts.ctaSubtitle,
            ctaHint: opts.ctaHint,
            ctaEnabled: opts.cta !== false,
            denoise: !!opts.denoise,
            denoiseMix: Number(opts.denoiseMix) || 0.85,
        });
        const dt = ((Date.now() - t2) / 1000).toFixed(1);
        console.log(`  ✓ ${dt}s`);
    } catch (err) {
        console.error(`${C.red}✗${C.reset} 后处理失败: ${err.message}`);
        process.exit(1);
    }

    console.log(`\n${C.green}✓ 完成${C.reset}  → ${outputPath}`);
};
