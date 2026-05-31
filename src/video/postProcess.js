'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const { loadBrand } = require('../services/brandLoader');
const { stripEmoji } = require('../lib/stripEmoji');

const execFileAsync = promisify(execFile);

function toFfmpegColor(hex, fallback = '0x000000') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    return m ? `0x${m[1].toUpperCase()}` : fallback;
}

// 可用的 CTA 品牌字体(用于尾部卡片),自动选择
const FONT_CANDIDATES = [
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
    path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf')
];
function pickCtaFont() {
    for (const p of FONT_CANDIDATES) if (fs.existsSync(p)) return p;
    return '';
}
function escapeDrawtext(text) {
    // 先剥 emoji:品牌字体无 emoji 字形,否则渲染成口字型豆腐块
    return stripEmoji(String(text || ''))
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%');
}

function probeVideoDurationSec(videoPath) {
    const res = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
    ], { encoding: 'utf8' });
    const sec = Number(String(res.stdout || '').trim());
    return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

function probeVideoSize(videoPath) {
    const res = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0:s=x',
        videoPath
    ], { encoding: 'utf8' });
    const raw = String(res.stdout || '').trim();
    const [w, h] = raw.split('x').map((x) => Number(x));
    return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
}

/**
 * 在视频前插入 cover 静态帧 + 视频末尾淡出 + (可选) 结尾 CTA 钩子卡片 + (可选) BGM 混音。
 * 一次 FFmpeg 搞定,输出覆盖或独立路径。
 *
 * @param {object} opts
 * @param {string} opts.inputVideoPath - 已烧字幕的主视频
 * @param {string} [opts.coverPath] - 封面 jpg(includeCover=false 时可省略)
 * @param {string} opts.outputPath - 最终输出
 * @param {boolean} [opts.includeCover=true] - 是否前置 cover 静帧;横屏场景关闭
 * @param {number} [opts.coverDurationSec=0.6]
 * @param {number} [opts.fadeOutSec=0.5]
 * @param {boolean} [opts.ctaEnabled=true]
 * @param {string} [opts.ctaTitle='关注 @example']
 * @param {string} [opts.ctaSubtitle='陪你幸福成长,快乐赚钱']
 * @param {number} [opts.ctaDurationSec=2.0]
 * @param {string} [opts.bgmPath=''] - BGM mp3 绝对路径(空则跳过)
 * @param {number} [opts.bgmVolume=0.08] - BGM 音量(0-1),未戴收音器推荐 0.08,戴收音器可提到 0.12-0.15
 * @param {number} [opts.timeoutMs=600000]
 */
async function attachCoverAndFadeOut(opts) {
    // 从当前 brand 读 CTA 默认字段,caller 仍可通过 opts 覆盖
    let brand = null;
    try { brand = loadBrand(); } catch (_) { /* 兜底 */ }
    const brandCta = brand?.cta || {};
    const brandBrandTag = brand?.visual?.brandTag || '@example';
    const tagBgColor = toFfmpegColor(brand?.visual?.tagBgColor, '0xFFD54F');
    const tagTextColor = toFfmpegColor(brand?.visual?.tagTextColor, '0x0B0F1A');

    const {
        inputVideoPath,
        coverPath,
        outputPath,
        includeCover = true,
        coverDurationSec = 0.6,
        fadeOutSec = 0.5,
        ctaEnabled = brandCta.enabled !== false,
        ctaTitle = brandCta.title || '关注 @example',
        ctaSubtitle = brandCta.subtitle || '陪你幸福成长,快乐赚钱',
        ctaHint = brandCta.hint || '↓ 点赞 · 关注 · 下期更精彩 ↓',
        ctaBrandTag = brandBrandTag,
        ctaDurationSec = brandCta.durationSec || 2.0,
        bgmPath = '',
        bgmVolume = brand?.bgm?.defaultVolume || 0.08,
        denoise = process.env.ZDE_DENOISE === '1',
        denoiseMix = Number(process.env.ZDE_DENOISE_MIX || 0.85),
        timeoutMs = 600000
    } = opts || {};

    const bgmEnabled = !!(bgmPath && fs.existsSync(bgmPath));
    // RNNoise 通用人声降噪模型(GregorR/rnnoise-models 的 cb.rnnn,公开 MIT)
    const rnnoiseModelPath = path.resolve(__dirname, '..', '..', 'assets', 'denoise', 'cb.rnnn');
    const denoiseEnabled = !!(denoise && fs.existsSync(rnnoiseModelPath));
    if (denoise && !denoiseEnabled) {
        console.warn(`[denoise] 模型文件缺失,跳过: ${rnnoiseModelPath}`);
    }

    if (!fs.existsSync(inputVideoPath)) throw new Error(`[postProcess] 输入视频不存在: ${inputVideoPath}`);
    if (includeCover && (!coverPath || !fs.existsSync(coverPath))) {
        throw new Error(`[postProcess] 封面不存在: ${coverPath}`);
    }

    const mainDuration = probeVideoDurationSec(inputVideoPath);
    if (!mainDuration) throw new Error('[postProcess] 无法获取主视频 duration');
    const { width, height } = probeVideoSize(inputVideoPath);
    if (!width || !height) throw new Error('[postProcess] 无法获取主视频尺寸');

    const fadeStart = Math.max(0, mainDuration - fadeOutSec);
    const fps = 30;

    // 判断 output 和 input 同名 → 先写临时文件再 rename
    const isInPlace = path.resolve(outputPath) === path.resolve(inputVideoPath);
    const actualOutput = isInPlace
        ? `${outputPath}.postprocess.tmp.mp4`
        : outputPath;

    fs.mkdirSync(path.dirname(actualOutput), { recursive: true });

    // CTA 字体
    const ctaFont = pickCtaFont();
    const ctaFontArg = ctaFont ? `:fontfile='${ctaFont.replace(/'/g, "\\'")}'` : '';

    // 动态 input index
    const inputArgs = [];
    let idx = 0;
    let coverIdx = -1;
    let coverSilenceIdx = -1;
    if (includeCover) {
        inputArgs.push('-loop', '1', '-t', String(coverDurationSec), '-i', coverPath);
        coverIdx = idx++;
        inputArgs.push('-f', 'lavfi', '-t', String(coverDurationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        coverSilenceIdx = idx++;
    }
    inputArgs.push('-i', inputVideoPath);
    const mainIdx = idx++;
    let ctaVIdx = -1;
    let ctaAIdx = -1;
    if (ctaEnabled) {
        inputArgs.push('-f', 'lavfi', '-t', String(ctaDurationSec), '-i', `color=0x0B0F1A:s=${width}x${height}:r=${fps}`);
        ctaVIdx = idx++;
        inputArgs.push('-f', 'lavfi', '-t', String(ctaDurationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        ctaAIdx = idx++;
    }
    let bgmIdx = -1;
    if (bgmEnabled) {
        inputArgs.push('-stream_loop', '-1', '-i', bgmPath);
        bgmIdx = idx++;
    }

    const filterParts = [];
    if (includeCover) {
        // 封面虚化铺满:背景=封面放大裁剪铺满当前画幅后强模糊,前景=封面等比缩放居中(清晰)。
        // 封面比例≠视频比例时(竖封面进横屏第一帧)→ 两侧是封面自身虚化填充,不留黑边、不诡异;
        // 比例相同时(竖封面进竖屏)→ 前景刚好铺满,背景被完全覆盖,效果等同直接铺满。向后兼容。
        filterParts.push(
            `[${coverIdx}:v]split=2[cvbg][cvfg]`,
            `[cvbg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:4,setsar=1[cvb]`,
            `[cvfg]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[cvf]`,
            `[cvb][cvf]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps}[cv]`
        );
    }
    filterParts.push(
        `[${mainIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},fade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOutSec}[mv]`
    );
    // 主音轨 label:默认原始,启用降噪时先走 arnndn → [dn]
    let mainATag = `[${mainIdx}:a]`;
    if (denoiseEnabled) {
        // RNNoise 要求 48kHz 重采样,mix=0..1 控制"降噪力度"(1=完全用神经网络输出,0.85=稳妥防止人声被过度切削)
        const modelEscaped = rnnoiseModelPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
        const mixVal = Math.max(0, Math.min(1, Number(denoiseMix) || 0.85)).toFixed(2);
        filterParts.push(
            `[${mainIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,arnndn=m='${modelEscaped}':mix=${mixVal}[dn]`
        );
        mainATag = '[dn]';
    }
    if (bgmEnabled) {
        filterParts.push(
            `[${bgmIdx}:a]volume=${bgmVolume.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[bgm]`,
            `${mainATag}[bgm]amix=inputs=2:duration=first:dropout_transition=2[mix]`,
            `[mix]afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOutSec}[ma]`
        );
    } else {
        filterParts.push(
            `${mainATag}afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOutSec}[ma]`
        );
    }

    if (ctaEnabled) {
        const titleStr = escapeDrawtext(ctaTitle);
        const subtitleStr = escapeDrawtext(ctaSubtitle);
        const hintStr = escapeDrawtext(ctaHint);
        const brandTagStr = escapeDrawtext(ctaBrandTag);
        // 竖屏(>=1000 高)走三段撑开 + 装饰线布局,空间撑开;
        // 横屏(<1000)字号 scale=0.55 后空间紧张,沿用居中紧凑布局避免互相覆盖
        const isPortrait = height >= 1000;
        const ctaScale = Math.max(0.55, Math.min(1.0, height / 1920));
        // 字号:竖屏比旧版略增(140→160 / 60→72 / 52→60),让大屏可读性更好
        const tagFont = Math.round((isPortrait ? 80 : 72) * ctaScale);
        const titleFont = Math.round((isPortrait ? 160 : 140) * ctaScale);
        const subtitleFont = Math.round((isPortrait ? 72 : 60) * ctaScale);
        const hintFont = Math.round((isPortrait ? 60 : 52) * ctaScale);
        const tagPad = Math.round(28 * ctaScale);
        const tagH = tagFont + tagPad * 2;
        const titleBorderW = Math.max(2, Math.round(3 * ctaScale));

        let drawChain;
        if (isPortrait) {
            // === 三段撑开:顶 / 中(带上下分隔线)/ 底 ===
            // 锚点(以 1920 高为参照,其他比例按 height/1920 缩放)
            const tagY = Math.round(height * 0.20);                          // ~380
            const divider1Y = tagY + tagH + Math.round(height * 0.046);      // ~600
            const titleY = divider1Y + Math.round(height * 0.067);           // ~730
            const subtitleY = titleY + titleFont + Math.round(height * 0.016); // ~920
            const divider2Y = subtitleY + subtitleFont + Math.round(height * 0.047); // ~1080
            const hintY = height - Math.round(height * 0.167) - hintFont;    // ~1600(贴底,留拇指位置)

            // 装饰线:两条短横 + 中间小方点(用 drawbox,不依赖字体里是否有 ─ 字符)
            // ⚠️ drawbox 的 x 表达式在不同 ffmpeg 版本里对 `(w/2-...)` 解析不稳,
            //    实测竖屏 1512×2688 下用表达式只渲染出左线 — 这里全部预计算成整数像素
            const lineColor = tagBgColor; // 跟胶囊同色,黄色调
            const lineLen = Math.round(width * 0.15);                        // 162
            const lineThick = Math.max(2, Math.round(3 * ctaScale));         // 3
            const dotSize = Math.max(8, Math.round(12 * ctaScale));          // 12
            const lineGap = Math.round(width * 0.04);                        // 距中线两侧的缝隙
            const cx = Math.round(width / 2);
            const leftX = cx - lineGap - lineLen;
            const rightX = cx + lineGap;
            const dotX = cx - Math.round(dotSize / 2);
            // 让横线和方点视觉中线对齐:线条 y 是顶边,方点 y = lineY - (dotSize - lineThick)/2
            const dotYOffset = Math.round((dotSize - lineThick) / 2);

            const dividerDraw = (lineY) =>
                `drawbox=x=${leftX}:y=${lineY}:w=${lineLen}:h=${lineThick}:color=${lineColor}@0.7:t=fill,`
                + `drawbox=x=${rightX}:y=${lineY}:w=${lineLen}:h=${lineThick}:color=${lineColor}@0.7:t=fill,`
                + `drawbox=x=${dotX}:y=${lineY - dotYOffset}:w=${dotSize}:h=${dotSize}:color=${lineColor}:t=fill`;

            drawChain =
                `drawtext=text='${brandTagStr}':fontcolor=${tagTextColor}:fontsize=${tagFont}:box=1:boxcolor=${tagBgColor}:boxborderw=${tagPad}:x=(w-text_w)/2:y=${tagY}${ctaFontArg},`
                + `${dividerDraw(divider1Y)},`
                + `drawtext=text='${titleStr}':fontcolor=${tagBgColor}:fontsize=${titleFont}:x=(w-text_w)/2:y=${titleY}:borderw=${titleBorderW}:bordercolor=0x000000${ctaFontArg},`
                + `drawtext=text='${subtitleStr}':fontcolor=0xFFFFFF:fontsize=${subtitleFont}:x=(w-text_w)/2:y=${subtitleY}${ctaFontArg},`
                + `${dividerDraw(divider2Y)},`
                + `drawtext=text='${hintStr}':fontcolor=${tagBgColor}:fontsize=${hintFont}:x=(w-text_w)/2:y=${hintY}${ctaFontArg}`;
        } else {
            // === 横屏:旧紧凑居中布局 ===
            const gap1 = Math.round(50 * ctaScale);
            const gap2 = Math.round(30 * ctaScale);
            const gap3 = Math.round(40 * ctaScale);
            const totalH = tagH + gap1 + titleFont + gap2 + subtitleFont + gap3 + hintFont;
            const blockTop = Math.max(20, Math.floor((height - totalH) / 2));
            const tagY = blockTop;
            const titleY = tagY + tagH + gap1;
            const subtitleY = titleY + titleFont + gap2;
            const hintY = subtitleY + subtitleFont + gap3;
            drawChain =
                `drawtext=text='${brandTagStr}':fontcolor=${tagTextColor}:fontsize=${tagFont}:box=1:boxcolor=${tagBgColor}:boxborderw=${tagPad}:x=(w-text_w)/2:y=${tagY}${ctaFontArg},`
                + `drawtext=text='${titleStr}':fontcolor=${tagBgColor}:fontsize=${titleFont}:x=(w-text_w)/2:y=${titleY}:borderw=${titleBorderW}:bordercolor=0x000000${ctaFontArg},`
                + `drawtext=text='${subtitleStr}':fontcolor=0xFFFFFF:fontsize=${subtitleFont}:x=(w-text_w)/2:y=${subtitleY}${ctaFontArg},`
                + `drawtext=text='${hintStr}':fontcolor=${tagBgColor}:fontsize=${hintFont}:x=(w-text_w)/2:y=${hintY}${ctaFontArg}`;
        }

        filterParts.push(
            `[${ctaVIdx}:v]${drawChain},fade=t=in:st=0:d=0.35,fade=t=out:st=${(ctaDurationSec - 0.3).toFixed(2)}:d=0.3[cta_v]`
        );
    }

    // 拼接 concat
    const concatSegments = [];
    if (includeCover) concatSegments.push(`[cv][${coverSilenceIdx}:a]`);
    concatSegments.push(`[mv][ma]`);
    if (ctaEnabled) concatSegments.push(`[cta_v][${ctaAIdx}:a]`);
    const n = concatSegments.length;
    if (n === 1) {
        // 只有主视频,不需要 concat
        filterParts.push(`[mv]null[outv]`, `[ma]anull[outa]`);
    } else {
        filterParts.push(`${concatSegments.join('')}concat=n=${n}:v=1:a=1[outv][outa]`);
    }

    const filter = filterParts.join(';');

    const baseArgs = [
        '-y',
        ...inputArgs,
        '-filter_complex', filter,
        '-map', '[outv]',
        '-map', '[outa]',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart'
    ];

    // 智能码率:优先用 caller 传入的 targetBitrate(来自原始源探测),否则探测 burn 输出
    const targetBitrateMbps = (() => {
        if (opts.targetBitrate && Number.isFinite(Number(opts.targetBitrate))) {
            return Math.max(1.5, Number(opts.targetBitrate));
        }
        const res = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', inputVideoPath], { encoding: 'utf8', timeout: 10000 });
        const bps = Number(String(res.stdout || '').trim());
        return bps > 0 ? Math.max(1.5, Math.round(bps / 1000000 * 1.2)) : 6;
    })();
    const hwCodec = ['-c:v', 'h264_videotoolbox', '-b:v', `${targetBitrateMbps}M`];
    const swCodec = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];

    // 为进度条计算输出总时长(封面秒 + 主视频 + CTA 秒)
    const mainDur = probeVideoDurationSec(inputVideoPath) || 0;
    const progressDurSec = (includeCover ? coverDurationSec : 0) + mainDur + (ctaEnabled ? ctaDurationSec : 0);
    const { runFfmpegWithProgress } = require('../lib/ffmpegProgress');
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    try {
        await runFfmpegWithProgress([...baseArgs, ...hwCodec, actualOutput], {
            durationSec: progressDurSec, onProgress, timeoutMs
        });
    } catch (err) {
        const tail = String(err.message || '').split('\n').slice(-6).join('\n');
        console.warn('[postProcess] h264_videotoolbox 失败,fallback libx264\n', tail.slice(0, 300));
        await runFfmpegWithProgress([...baseArgs, ...swCodec, actualOutput], {
            durationSec: progressDurSec, onProgress, timeoutMs
        });
    }

    if (!fs.existsSync(actualOutput)) {
        throw new Error(`[postProcess] 输出失败: ${actualOutput}`);
    }

    // In-place: 把临时文件 rename 回原名
    if (isInPlace) {
        fs.renameSync(actualOutput, outputPath);
    }

    return outputPath;
}

module.exports = {
    attachCoverAndFadeOut,
    probeVideoDurationSec,
    probeVideoSize
};
