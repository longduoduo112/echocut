'use strict';

/**
 * identityCard — 持久身份卡片 overlay(issue #9)
 *
 * 在视频指定位置画一个"半透明矩形容器 + 两行文字"(姓名 + 头衔),
 * 整段视频持续可见,用作 lower-third / 演讲嘉宾身份提示。
 *
 * 设计:opt-in 二次处理(`echocut identity-card <input>`),不动 burn 流水线。
 * 输入:已经 burn 好的成片(1080×1920 / 1080×1080 / 1920×1080),输出叠卡片版本。
 *
 * 位置选项:
 *   - bottom-left:竖屏默认(字幕在底部黑边时,卡片在主画面区左下角)
 *   - bottom-right:横屏默认
 *   - top-left / top-right:其他场景
 *
 * 样式:
 *   - 黑色 70% 透明矩形 padding 24px
 *   - 姓名:白色 36px 粗体
 *   - 头衔:品牌黄 #FFD54F 28px
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 中文 font fallback chain(项目自带阿里普惠 > 系统 STHeiti > Arial Unicode)
const FONT_CANDIDATES = [
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',         // macOS Catalina 之前
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',  // Linux 备用
];

function pickDefaultFont() {
    for (const p of FONT_CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

const DEFAULT_FONT_FILE = pickDefaultFont();

const POSITION_PRESETS = {
    'bottom-left':  { x: 'mw=40',          y: 'mh-th-180' },   // 字幕区上方 ~180px
    'bottom-right': { x: 'mw=W-tw-40',     y: 'mh-th-180' },
    'top-left':     { x: 'mw=40',          y: '120' },          // 标题区下方
    'top-right':    { x: 'mw=W-tw-40',     y: '120' },
};

/**
 * 计算 drawbox + drawtext filter
 * @param {Object} opts
 *   - name: string  姓名(必需)
 *   - title: string 头衔(可选,无则只画一行)
 *   - position: 'bottom-left' (默认)
 *   - nameFontSize: 36
 *   - titleFontSize: 28
 *   - nameColor: '#FFFFFF'
 *   - titleColor: '#FFD54F'
 *   - boxColor: 'black@0.7'
 *   - paddingX: 24, paddingY: 18
 *   - fontFile: 自定义字体
 * @returns {string} ffmpeg -vf filter
 */
function buildIdentityFilter(opts = {}) {
    if (!opts.name || typeof opts.name !== 'string' || !opts.name.trim()) {
        throw new Error('opts.name required');
    }
    const name = opts.name.trim();
    const title = (opts.title || '').trim();
    const position = opts.position || 'bottom-left';
    const pos = POSITION_PRESETS[position];
    if (!pos) throw new Error(`unsupported position: ${position}`);

    const nameFontSize = Number(opts.nameFontSize) || 36;
    const titleFontSize = Number(opts.titleFontSize) || 28;
    const nameColor = opts.nameColor || '#FFFFFF';
    const titleColor = opts.titleColor || '#FFD54F';
    const boxColor = opts.boxColor || 'black@0.7';
    const paddingX = Number(opts.paddingX) || 24;
    const paddingY = Number(opts.paddingY) || 18;
    const fontFile = opts.fontFile || DEFAULT_FONT_FILE;
    if (!fs.existsSync(fontFile)) {
        throw new Error(`font file not exists: ${fontFile}`);
    }

    // 估算卡片宽:max(name字数*nameFontSize, title字数*titleFontSize) + paddingX*2
    // 高:nameFontSize + (title ? gap+titleFontSize : 0) + paddingY*2
    const cardW = Math.max(
        name.length * nameFontSize * 0.85,
        title ? title.length * titleFontSize * 0.85 : 0,
    ) + paddingX * 2;
    const lineGap = 8;
    const cardH = nameFontSize + (title ? lineGap + titleFontSize : 0) + paddingY * 2;

    // 位置(基于视频画面 W/H — ffmpeg drawbox/drawtext 用小写 w/h)
    let baseX;
    let baseY;
    if (position.endsWith('left')) baseX = String(40);
    else baseX = `w-${Math.ceil(cardW)}-40`;
    if (position.startsWith('top')) baseY = String(80);
    else baseY = `h-${Math.ceil(cardH)}-180`;  // 距底部 180px(字幕之上)

    const filters = [];
    // 1. 画背景框
    filters.push(`drawbox=x=${baseX}:y=${baseY}:w=${Math.ceil(cardW)}:h=${Math.ceil(cardH)}:color=${boxColor}:t=fill`);
    // 2. 画姓名(在 box 内左上)
    const escName = name.replace(/'/g, "\\'").replace(/:/g, '\\:');
    filters.push(`drawtext=fontfile=${fontFile}:text='${escName}':fontsize=${nameFontSize}:fontcolor=${nameColor}:x=${baseX}+${paddingX}:y=${baseY}+${paddingY}`);
    // 3. 画头衔(在姓名下方)
    if (title) {
        const escTitle = title.replace(/'/g, "\\'").replace(/:/g, '\\:');
        filters.push(`drawtext=fontfile=${fontFile}:text='${escTitle}':fontsize=${titleFontSize}:fontcolor=${titleColor}:x=${baseX}+${paddingX}:y=${baseY}+${paddingY + nameFontSize + lineGap}`);
    }
    return filters.join(',');
}

/**
 * 在已有视频上叠加身份卡片(opt-in 后处理,不动 burn 流水线)
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object} opts (见 buildIdentityFilter + crf/preset)
 * @returns {{ filter: string, outputPath: string }}
 */
function applyIdentityCard(inputPath, outputPath, opts = {}) {
    if (!fs.existsSync(inputPath)) throw new Error(`input not exists: ${inputPath}`);
    const filter = buildIdentityFilter(opts);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = [
        '-y', '-i', inputPath,
        '-vf', filter,
        '-c:v', 'libx264', '-preset', String(opts.preset || 'medium'), '-crf', String(opts.crf || '18'),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
    ];
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`identity card ffmpeg failed (exit=${r.status}): ${(r.stderr || '').slice(-400)}`);
    }
    return { filter, outputPath };
}

module.exports = {
    applyIdentityCard,
    buildIdentityFilter,
    POSITION_PRESETS,
    DEFAULT_FONT_FILE,
};
