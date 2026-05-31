'use strict';

/**
 * echocut cover — 独立封面生成命令
 *
 * 用途:用别的工具剪视频(剪映/CapCut/专业后期),但封面用统一品牌规格生成。
 * 所以这个命令只出一张 jpg,不涉及视频处理。
 *
 * 用法:
 *   echocut cover --headline "主标题" --subline "副标题" --output ./cover.jpg
 *   echocut cover --headline "..." --brand lisi
 *   echocut cover --headline "..." --ratio 16:9    # 横屏
 *
 * 产出:一张 jpg,含:品牌胶囊 + 主标题 + 副标题 + 胸前黑条 + 品牌底图
 */

const fs = require('fs');
const path = require('path');
const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');
const { generateCover } = require('../../video/coverGenerator');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m',
    bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

// 支持的比例 → 输出尺寸
// 当前 example-portrait.png 是 1080x1920 竖版模板,所以只能出竖屏/方图
// 横屏/3:4 需要另外准备横版模板(v0.11 候选),现在不开放
const RATIO_TO_SIZE = {
    '9:16': { width: 1080, height: 1920, bandTopY: 820, bandHeight: 440 },   // 竖屏默认(抖音/视频号/小红书)
    '1:1':  { width: 1080, height: 1080, bandTopY: 540, bandHeight: 400 }    // 方图(公众号头图)— 黑条位置按 1080 高度调整
};
const UNSUPPORTED_RATIOS = {
    '16:9': '横屏模板待 v0.11',
    '3:4': '模板待 v0.11'
};

module.exports = async function cover(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();

    // 校验参数
    const headline = String(opts.headline || '').trim();
    if (!headline) {
        console.error(`${C.red}✗${C.reset} --headline <text> 必填`);
        console.error(`   例: ${C.cyan}echocut cover --headline "读书买书,家里要无条件满足"${C.reset}\n`);
        process.exit(1);
    }
    const subline = String(opts.subline || '').trim();

    // 尺寸
    const ratio = String(opts.ratio || '9:16').trim();
    const size = RATIO_TO_SIZE[ratio];
    if (!size) {
        if (UNSUPPORTED_RATIOS[ratio]) {
            console.error(`${C.red}✗${C.reset} 暂不支持 ${ratio}(${UNSUPPORTED_RATIOS[ratio]})`);
            console.error(`   当前品牌模板是竖版 1080x1920,横屏/非标比例需要另做横版模板`);
        } else {
            console.error(`${C.red}✗${C.reset} 未知比例: ${ratio}`);
        }
        console.error(`   可选: ${Object.keys(RATIO_TO_SIZE).join(' / ')}\n`);
        process.exit(1);
    }

    // 输出路径(默认 ./cover.jpg,若已存在且没 --force 则加时间戳后缀)
    let outputPath = opts.output ? path.resolve(process.cwd(), opts.output) : path.resolve(process.cwd(), 'cover.jpg');
    if (fs.existsSync(outputPath) && !opts.force) {
        const dir = path.dirname(outputPath);
        const base = path.basename(outputPath, path.extname(outputPath));
        const ext = path.extname(outputPath);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outputPath = path.join(dir, `${base}_${stamp}${ext}`);
        console.log(`${C.yellow}⚠${C.reset} 目标文件已存在,改为: ${path.basename(outputPath)}(加 --force 可覆盖)`);
    }

    // 加载品牌(复用 burn / hmk 的机制)
    const brandId = opts.brand || 'example';
    let brand = null;
    try {
        brand = loadBrandFile(brandId);
        // 把 brand 塞到 env 让 coverGenerator 里的 loadBrand() 能拿到
        process.env.ZDE_BRAND_CONFIG = brandToEnvString(brand);
        process.env.ZDE_DEFAULT_BRAND = brandId;
    } catch (err) {
        console.error(`${C.red}✗${C.reset} 品牌加载失败: ${err.message}`);
        process.exit(1);
    }

    console.log(`\n${C.bold}${C.cyan}🎨 echocut cover${C.reset}`);
    console.log(`   ${C.gray}品牌${C.reset}    ${C.green}${brand.id}${C.reset} — ${brand.displayName || brand.identity?.name || ''}`);
    console.log(`   ${C.gray}主标${C.reset}    ${headline}`);
    if (subline) console.log(`   ${C.gray}副标${C.reset}    ${subline}`);
    console.log(`   ${C.gray}比例${C.reset}    ${ratio}  (${size.width}x${size.height})`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputPath}`);
    console.log('');

    const t0 = Date.now();
    try {
        await generateCover({
            headline,
            subline,
            outputPath,
            width: size.width,
            height: size.height,
            bandTopY: size.bandTopY,
            bandHeight: size.bandHeight
        });
    } catch (err) {
        console.error(`\n${C.red}✗ 封面生成失败:${C.reset} ${err.message}`);
        process.exit(1);
    }

    const elapsed = Date.now() - t0;
    const stat = fs.statSync(outputPath);
    console.log(`${C.green}✓${C.reset} 生成完成  ${(elapsed / 1000).toFixed(1)}s  ${(stat.size / 1024).toFixed(0)} KB`);
    console.log(`   ${C.cyan}${outputPath}${C.reset}\n`);
};
