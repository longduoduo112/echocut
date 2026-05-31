'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadBrand, resolveBrandAsset } = require('../services/brandLoader');
const { stripEmoji } = require('../lib/stripEmoji');

const execFileAsync = promisify(execFile);

const DEFAULT_TEMPLATE = path.resolve(__dirname, '..', '..', 'assets', 'brand', 'cover-bg.png');

function toFfmpegColor(hex, fallback = '0x000000') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    return m ? `0x${m[1].toUpperCase()}` : fallback;
}

const FONT_CANDIDATES = [
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf')
];

function pickDefaultTitleFont() {
    for (const p of FONT_CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

// FFmpeg drawtext 特殊字符转义(先剥 emoji:品牌字体无 emoji 字形,否则渲染成口字型豆腐块)
function escapeDrawtext(text) {
    return stripEmoji(String(text || ''))
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%');
}

function escapeAssPath(p) {
    return String(p || '').replace(/'/g, "\\'");
}

// 估算中文+英文混合文本的渲染宽度,动态缩小 fontSize 让它适应 maxWidth
// charWidthRatio: 中文字约 1.0x fontSize,英文字母约 0.55x。粗糙加权平均 0.95。
function autoFitFontSize(text, maxWidth, maxFontSize, minFontSize = 28, charWidthRatio = 0.98) {
    const chars = [...String(text || '')];
    if (!chars.length) return maxFontSize;
    // 英文字符按 0.58 加权,中文/标点按 1.0
    const weightedWidth = chars.reduce((sum, c) => sum + (/[\x00-\x7f]/.test(c) ? 0.58 : 1.0), 0);
    const fitted = Math.floor(maxWidth / (weightedWidth * charWidthRatio));
    return Math.max(minFontSize, Math.min(maxFontSize, fitted));
}

/**
 * 生成统一品牌封面 jpg
 *
 * 设计:
 * - 底层: 模板图(泳池Example) scale 到高 1920,再以人物为中心 crop 1080 宽
 * - 顶部: 半透明黑色渐变遮罩(600 px,让标题可读)
 * - 左上: 黄色胶囊 @example
 * - 居中上方: 主标题 + 副标题
 *
 * @param {object} opts
 * @param {string} opts.headline - 主标题
 * @param {string} opts.subline - 副标题
 * @param {string} opts.outputPath - 输出 jpg 绝对路径
 * @param {string} [opts.templatePath] - 背景模板 png,默认 assets/brand/example-portrait.png
 * @param {string} [opts.titleFontPath] - 标题字体文件(阿里普惠 Black),不传走系统默认
 * @param {string} [opts.brandTag='@example']
 * @param {number} [opts.width=1080]
 * @param {number} [opts.height=1920]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<string>} outputPath
 */
async function generateCover(opts) {
    // 从当前 brand 读默认值;caller 可以 opts 里显式覆盖
    let brand = null;
    try { brand = loadBrand(); } catch (_) { /* 没品牌配置时用硬编码兜底 */ }
    const brandTemplate = brand?.visual?.coverTemplate
        ? resolveBrandAsset(brand, brand.visual.coverTemplate)
        : DEFAULT_TEMPLATE;
    const brandTagDefault = brand?.visual?.brandTag || '@example';
    const tagBgColor = toFfmpegColor(brand?.visual?.tagBgColor, '0xFFD54F');
    const tagTextColor = toFfmpegColor(brand?.visual?.tagTextColor, '0x0B0F1A');

    const {
        headline = '',
        subline = '',
        outputPath,
        templatePath = brandTemplate,
        titleFontPath: titleFontPathOverride = '',
        brandTag = brandTagDefault,
        width = 1080,
        height = 1920,
        // 黑条位置参数(覆盖在胸前位置,v2-chest-std 用户选定版)
        bandTopY = 820,        // 黑条起始 y(胸前中线偏上)
        bandHeight = 440,      // 黑条高度(胶囊 + 主标题 + 副标题)
        bandOpacity = 0.88,    // 半透明(既可读又能看到底下的人物轮廓)
        timeoutMs = 60000
    } = opts || {};
    const titleFontPath = titleFontPathOverride || pickDefaultTitleFont();

    if (!outputPath) throw new Error('generateCover: outputPath required');
    if (!fs.existsSync(templatePath)) {
        throw new Error(`generateCover: 模板图不存在 ${templatePath}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const fontArg = titleFontPath && fs.existsSync(titleFontPath)
        ? `:fontfile='${escapeAssPath(titleFontPath)}'`
        : '';

    // 版面参数:图片铺满封面,黑条半透明覆盖在胸前位置
    const tagX = 56;
    const tagFontSize = 52;
    const tagPad = 20;
    const textMaxWidth = width - 96;
    const headlineFontSize = autoFitFontSize(headline, textMaxWidth, 124, 56);
    const sublineFontSize = autoFitFontSize(subline, textMaxWidth, 62, 36);
    // 黑条内部布局:胶囊居顶,主标题中,副标题底
    const tagY = bandTopY + 28;
    const headlineY = tagY + tagFontSize + tagPad * 2 + 32;
    const sublineY = headlineY + headlineFontSize + 24;

    // 空字符串保持空(不画),不再用 'echocut·回声' 兜底——
    // 无口播视频上游已经把 headline 显式置空,这里若兜底就会重新出现"echocut·回声"假标题
    const safeHeadline = headline ? escapeDrawtext(headline) : '';
    const safeSubline = subline ? escapeDrawtext(subline) : '';
    const safeTag = escapeDrawtext(brandTag);

    // 策略:图片填满封面,黑条半透明覆盖胸前位置(保留头部+电脑动作)
    // 1. scale=-2:1920 保持比例到高 1920 → 约 2937×1920
    // 2. crop 1080×1920 以人物为中心(iw*0.62-540)
    // 3. drawbox 半透明黑条在 bandTopY,bandHeight
    // 4. 胶囊 + 主标题 + 副标题覆盖在黑条内
    const cropX = `max(0\\,min(iw-${width}\\,iw*0.62-${width}/2))`;

    const vfParts = [
        `scale=-2:${height}`,
        `crop=${width}:${height}:${cropX}:0`,
        // 胸前位置的黑条半透明背景
        `drawbox=x=0:y=${bandTopY}:w=iw:h=${bandHeight}:color=0x000000@${bandOpacity.toFixed(2)}:t=fill`,
        // 胶囊
        `drawtext=text='${safeTag}':fontcolor=${tagTextColor}:fontsize=${tagFontSize}:box=1:boxcolor=${tagBgColor}:boxborderw=${tagPad}:x=${tagX}:y=${tagY}${fontArg}`,
        // 主标题
        safeHeadline
            ? `drawtext=text='${safeHeadline}':fontcolor=${tagBgColor}:fontsize=${headlineFontSize}:x=(w-text_w)/2:y=${headlineY}:borderw=3:bordercolor=0x000000${fontArg}`
            : '',
        // 副标题
        safeSubline
            ? `drawtext=text='${safeSubline}':fontcolor=0xFFFFFF:fontsize=${sublineFontSize}:x=(w-text_w)/2:y=${sublineY}${fontArg}`
            : ''
    ].filter(Boolean);

    const vf = vfParts.join(',');

    const args = [
        '-y',
        '-i', templatePath,
        '-vf', vf,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
    ];

    try {
        await execFileAsync('ffmpeg', args, { timeout: timeoutMs });
    } catch (err) {
        const tail = String(err.stderr || err.message || '').split('\n').slice(-8).join('\n');
        throw new Error(`[cover] ffmpeg 失败: ${tail}`);
    }

    if (!fs.existsSync(outputPath)) {
        throw new Error(`[cover] 生成失败,文件不存在: ${outputPath}`);
    }
    return outputPath;
}

module.exports = {
    generateCover,
    DEFAULT_TEMPLATE,
    pickDefaultTitleFont,
    // 导出纯函数便于单测
    autoFitFontSize,
    escapeDrawtext,
    toFfmpegColor
};
