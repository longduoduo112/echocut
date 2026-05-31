'use strict';

/**
 * Vlog 渲染器 — 多素材 → 成片流水线
 *
 * 输入:plan.json(segments 列表,每个含 clip/trim/subtitle)+ 素材目录 + BGM 路径
 * 输出:成片 mp4(含字幕 + BGM,静音原声)
 *
 * 核心策略:
 *   1. 每个 segment:精确 trim + 尺寸统一(横竖混编 → blur pad)+ 静音
 *   2. concat 所有 segment(filter 重编码,不 demuxer,保证参数一致)
 *   3. 烧录字幕(ASS 过滤器,复用现有 captionConfig 的品牌字体/颜色)
 *   4. 混入 BGM(循环到视频总长,末尾 1 秒淡出)
 *   5. (可选)头部拼封面静态帧 + 尾部淡出
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runFfmpegWithProgress } = require('../lib/ffmpegProgress');

// ────────────────────────────── 工具 ──────────────────────────────

function probeVideo(videoPath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'json', videoPath
    ], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return null;
    const info = JSON.parse(r.stdout || '{}');
    const s = (info.streams || [])[0] || {};
    const f = info.format || {};
    const [num, den] = String(s.r_frame_rate || '30/1').split('/');
    return {
        width: Number(s.width) || 0,
        height: Number(s.height) || 0,
        duration: Number(f.duration) || 0,
        fps: Number(num) / (Number(den) || 1) || 30
    };
}

function probeAudioDuration(audioPath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nk=1:nw=1', audioPath
    ], { encoding: 'utf8' });
    return Number(r.stdout || 0) || 0;
}

// ────────────────────────────── Segment trim + pad ──────────────────────────────

/**
 * 把一个 clip 的 [start, start+duration] 段 trim 出来,统一到目标尺寸,静音原声。
 * 横竖屏混编时,用 blur-pad(背景模糊放大 + 前景保持比例居中)。
 * 产出 mp4 参数严格一致(1080×1920 / 30fps / h264 / yuv420p / aac 静音轨)
 * 这样后面 concat 不会出问题。
 */
async function trimSegment({
    input, start, duration, output,
    targetWidth = 1080, targetHeight = 1920, targetFps = 30,
    bitrate = '6M',
    onProgress
}) {
    const info = probeVideo(input);
    if (!info) throw new Error(`probe failed: ${input}`);

    // 判断要不要 blur-pad(目标比例 vs 源比例)
    const sourceRatio = info.width / info.height;
    const targetRatio = targetWidth / targetHeight;
    const ratioDiff = Math.abs(sourceRatio - targetRatio);
    const needBlurPad = ratioDiff > 0.1;  // 源和目标比例差 > 0.1,才走 blur-pad

    let videoFilter;
    if (needBlurPad) {
        // split=2 → 背景(放大到目标尺寸 + 模糊 + 裁) + 前景(保持比例缩到目标内)
        videoFilter = [
            // 背景:填满画布 + 强模糊
            `[0:v]split=2[bg][fg];`,
            `[bg]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,`,
            `crop=${targetWidth}:${targetHeight},boxblur=30:1[blurred];`,
            // 前景:保持比例居中
            `[fg]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg_scaled];`,
            // 叠加
            `[blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${targetFps}[v]`
        ].join('');
    } else {
        // 源和目标比例相近,简单 scale + crop 居中
        videoFilter = [
            `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,`,
            `crop=${targetWidth}:${targetHeight},setsar=1,fps=${targetFps}[v]`
        ].join('');
    }

    // 生成空音轨(静音 AAC)对齐时长 — 方便后续 concat
    // 用 anullsrc 直接生成静音
    const args = [
        '-y',
        '-ss', String(start),
        '-i', input,
        '-f', 'lavfi',
        '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
        '-filter_complex', videoFilter,
        '-map', '[v]',
        '-map', '1:a',
        '-t', String(duration),
        '-c:v', 'h264_videotoolbox', '-b:v', bitrate,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        output
    ];

    try {
        await runFfmpegWithProgress(args, { durationSec: duration, onProgress });
    } catch (err) {
        // fallback to libx264
        const sw = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const bi = sw.indexOf('-b:v'); if (bi > 0) sw.splice(bi, 2, '-preset', 'fast', '-crf', '20');
        await runFfmpegWithProgress(sw, { durationSec: duration, onProgress });
    }
    return output;
}

// ────────────────────────────── Concat 多段 ──────────────────────────────

async function concatSegments({ segmentPaths, output, onProgress }) {
    // 因为 trimSegment 已经把所有段统一到同尺寸同 fps,这里可以用 concat demuxer
    // (重编码还是保险一点用 filter)
    const inputs = [];
    segmentPaths.forEach((p) => { inputs.push('-i', p); });
    const n = segmentPaths.length;
    const labels = Array.from({ length: n }, (_, i) => `[${i}:v][${i}:a]`).join('');
    const filter = `${labels}concat=n=${n}:v=1:a=1[v][a]`;

    const args = [
        '-y',
        ...inputs,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        output
    ];
    const totalDur = segmentPaths.reduce((sum, p) => sum + (probeVideo(p)?.duration || 0), 0);
    try {
        await runFfmpegWithProgress(args, { durationSec: totalDur, onProgress });
    } catch (err) {
        const sw = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const bi = sw.indexOf('-b:v'); if (bi > 0) sw.splice(bi, 2, '-preset', 'fast', '-crf', '20');
        await runFfmpegWithProgress(sw, { durationSec: totalDur, onProgress });
    }
    return output;
}

// ────────────────────────────── ASS 字幕生成 ──────────────────────────────

/**
 * 把每段的字幕文本生成 ASS 文件
 * segments: [{ startInFinal, duration, subtitle }]
 */
function generateAss({
    segments, outputPath,
    width = 1080, height = 1920,
    fontName = 'Noto Sans SC',
    fontSize = 64,
    marginV = 180
}) {
    const lines = [];
    lines.push('[Script Info]');
    lines.push('ScriptType: v4.00+');
    lines.push(`PlayResX: ${width}`);
    lines.push(`PlayResY: ${height}`);
    lines.push('WrapStyle: 2');
    lines.push('ScaledBorderAndShadow: yes');
    lines.push('');
    lines.push('[V4+ Styles]');
    lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
    // 白字 + 黑描边 + 阴影(大字幕)
    lines.push(`Style: Main,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,5,3,2,60,60,${marginV},1`);
    lines.push('');
    lines.push('[Events]');
    lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

    // v2 (2026-04-23 用户反馈):字幕提前 0.3s 消失,让画面最后 0.3s 呼吸空间
    // 且字幕起点延迟 0.15s,避免切换瞬间字幕糊脸
    const SUBTITLE_IN_DELAY = 0.15;
    const SUBTITLE_OUT_EARLY = 0.3;
    for (const seg of segments) {
        if (!seg.subtitle) continue;
        const rawStart = seg.startInFinal + SUBTITLE_IN_DELAY;
        const rawEnd = seg.startInFinal + seg.duration - SUBTITLE_OUT_EARLY;
        if (rawEnd - rawStart < 0.5) continue;  // 段太短,字幕索性不显示
        const startT = formatAssTime(rawStart);
        const endT = formatAssTime(rawEnd);
        const text = String(seg.subtitle).replace(/\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        lines.push(`Dialogue: 0,${startT},${endT},Main,,0,0,0,,${text}`);
    }

    fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
    return outputPath;
}

function formatAssTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec - h * 3600) / 60);
    const s = sec - h * 3600 - m * 60;
    const cs = Math.floor((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ────────────────────────────── 烧字幕 ──────────────────────────────

async function burnAssSubtitles({ input, assPath, output, onProgress }) {
    // Escape for ffmpeg filter
    const escapedAss = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\'");
    const args = [
        '-y',
        '-i', input,
        '-vf', `ass='${escapedAss}'`,
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        output
    ];
    const totalDur = probeVideo(input)?.duration || 0;
    try {
        await runFfmpegWithProgress(args, { durationSec: totalDur, onProgress });
    } catch (err) {
        const sw = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const bi = sw.indexOf('-b:v'); if (bi > 0) sw.splice(bi, 2, '-preset', 'fast', '-crf', '20');
        await runFfmpegWithProgress(sw, { durationSec: totalDur, onProgress });
    }
    return output;
}

// ────────────────────────────── 混入 BGM + 淡出 ──────────────────────────────

async function mixBgm({ input, bgmPath, output, volume = 0.25, fadeOutSec = 1.5, onProgress }) {
    const videoDur = probeVideo(input)?.duration || 0;
    if (!videoDur) throw new Error('mixBgm: 无法探测视频时长');

    // BGM stream_loop 循环,对齐视频长度,视频末尾音频淡出
    const fadeStart = Math.max(0, videoDur - fadeOutSec);

    const args = [
        '-y',
        '-i', input,
        '-stream_loop', '-1', '-i', bgmPath,
        '-filter_complex', [
            `[1:a]volume=${volume.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOutSec}[bgm];`,
            // 丢弃原音轨(已经是静音了),只用 BGM
            `[bgm]asetpts=PTS-STARTPTS[a]`,
            `;[0:v]fade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOutSec}[v]`
        ].join(''),
        '-map', '[v]', '-map', '[a]',
        '-t', String(videoDur),
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        output
    ];
    try {
        await runFfmpegWithProgress(args, { durationSec: videoDur, onProgress });
    } catch (err) {
        const sw = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const bi = sw.indexOf('-b:v'); if (bi > 0) sw.splice(bi, 2, '-preset', 'fast', '-crf', '20');
        await runFfmpegWithProgress(sw, { durationSec: videoDur, onProgress });
    }
    return output;
}

// ────────────────────────────── CTA 尾卡 ──────────────────────────────

/**
 * 在视频末尾追加 2 秒 CTA 尾卡(品牌胶囊 + 主标题 + 副标题 + 提示)。
 * 参数从 brand.cta 读取,或通过 opts.cta 覆盖。
 * 纯黑底 + 品牌黄色胶囊,淡入淡出。
 */
async function appendCtaCard({ input, output, cta, width = 1080, height = 1920, fps = 30, onProgress }) {
    const duration = cta.durationSec || 2.0;
    const brandTag = cta.tag || '@example';
    const title = cta.title || '关注我';
    const subtitle = cta.subtitle || '';
    const hint = cta.hint || '↓ 点赞 · 关注 · 下期更精彩 ↓';
    const tagBgColor = cta.tagBgColor || '#FFD54F';
    const tagTextColor = cta.tagTextColor || '#0B0F1A';

    // 找字体
    const fontCandidates = [
        path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
        path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf')
    ];
    const fontPath = fontCandidates.find((p) => fs.existsSync(p)) || '';
    const fontArg = fontPath ? `:fontfile='${fontPath.replace(/'/g, "\\\\'")}'` : '';

    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
    const toHex = (h) => `0x${String(h).replace('#', '').toUpperCase()}`;

    // 排版:胶囊居中上,主标题中,副标题下,提示最下
    const tagFont = 64;
    const tagPad = 22;
    const titleFont = 104;
    const subtitleFont = 52;
    const hintFont = 42;
    const gap1 = 50;
    const gap2 = 32;
    const gap3 = 48;
    const tagH = tagFont + tagPad * 2;
    const totalH = tagH + gap1 + titleFont + gap2 + subtitleFont + gap3 + hintFont;
    const blockTop = Math.max(40, Math.floor((height - totalH) / 2));
    const tagY = blockTop;
    const titleY = tagY + tagH + gap1;
    const subtitleY = titleY + titleFont + gap2;
    const hintY = subtitleY + subtitleFont + gap3;

    // 生成 CTA 段 + concat 到 input 后
    const ctaClipTmp = output + '.cta.mp4';

    // 1. 生成 2s CTA 段(黑底 + drawtext)
    await runFfmpegWithProgress([
        '-y',
        '-f', 'lavfi', '-t', String(duration), '-i', `color=0x0B0F1A:s=${width}x${height}:r=${fps}`,
        '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex',
        `[0:v]` +
        `drawtext=text='${esc(brandTag)}':fontcolor=${toHex(tagTextColor)}:fontsize=${tagFont}:box=1:boxcolor=${toHex(tagBgColor)}:boxborderw=${tagPad}:x=(w-text_w)/2:y=${tagY}${fontArg},` +
        `drawtext=text='${esc(title)}':fontcolor=${toHex(tagBgColor)}:fontsize=${titleFont}:x=(w-text_w)/2:y=${titleY}:borderw=3:bordercolor=0x000000${fontArg},` +
        (subtitle ? `drawtext=text='${esc(subtitle)}':fontcolor=0xFFFFFF:fontsize=${subtitleFont}:x=(w-text_w)/2:y=${subtitleY}${fontArg},` : '') +
        `drawtext=text='${esc(hint)}':fontcolor=${toHex(tagBgColor)}:fontsize=${hintFont}:x=(w-text_w)/2:y=${hintY}${fontArg},` +
        `fade=t=in:st=0:d=0.35,fade=t=out:st=${(duration - 0.3).toFixed(2)}:d=0.3[v]`,
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        ctaClipTmp
    ], { durationSec: duration });

    // 2. concat input + cta(重编码,确保参数一致)
    const inputInfo = probeVideo(input);
    await runFfmpegWithProgress([
        '-y',
        '-i', input,
        '-i', ctaClipTmp,
        '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        output
    ], { durationSec: (inputInfo?.duration || 0) + duration, onProgress });

    try { fs.unlinkSync(ctaClipTmp); } catch (_) {}
    return output;
}

// ────────────────────────────── 封面前置 ──────────────────────────────

async function prependCover({ input, coverPath, output, coverDuration = 0.8, onProgress }) {
    // 用 cover jpg 生成一段静态视频(coverDuration 秒)然后 concat 到前面
    const info = probeVideo(input);
    if (!info) throw new Error('prependCover: probe failed');

    const tmpCover = output + '.cover.mp4';
    // 1. cover jpg → 静态视频(无音频)
    await runFfmpegWithProgress([
        '-y',
        '-loop', '1', '-i', coverPath,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-vf', `scale=${info.width}:${info.height}:force_original_aspect_ratio=decrease,pad=${info.width}:${info.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${Math.round(info.fps)}`,
        '-t', String(coverDuration),
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        tmpCover
    ], { durationSec: coverDuration });

    // 2. concat cover + input
    await runFfmpegWithProgress([
        '-y',
        '-i', tmpCover,
        '-i', input,
        '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'h264_videotoolbox', '-b:v', '6M',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        output
    ], { durationSec: info.duration + coverDuration, onProgress });

    try { fs.unlinkSync(tmpCover); } catch (_) {}
    return output;
}

// ────────────────────────────── 主流程 ──────────────────────────────

/**
 * 根据 plan 渲染一条 vlog
 * plan: {
 *   title, segments: [{ clip_file, trim_start, trim_end, subtitle }],
 *   bgm_path, cover_path, width, height, output_path
 * }
 */
async function renderVlogFromPlan({ plan, workDir, onStep, onFfmpegProgress }) {
    fs.mkdirSync(workDir, { recursive: true });
    const W = plan.width || 1080;
    const H = plan.height || 1920;

    // 1. 逐段 trim + pad
    if (onStep) onStep('trim');
    const segmentPaths = [];
    const segmentMeta = [];
    let cursorInFinal = 0;
    for (let i = 0; i < plan.segments.length; i += 1) {
        const seg = plan.segments[i];
        if (!fs.existsSync(seg.clip_file)) throw new Error(`clip not found: ${seg.clip_file}`);
        const duration = seg.trim_end - seg.trim_start;
        if (duration <= 0) throw new Error(`seg ${i} duration ≤ 0`);
        const out = path.join(workDir, `seg-${String(i).padStart(2, '0')}.mp4`);
        await trimSegment({
            input: seg.clip_file,
            start: seg.trim_start,
            duration,
            output: out,
            targetWidth: W, targetHeight: H,
            onProgress: onFfmpegProgress
        });
        segmentPaths.push(out);
        segmentMeta.push({ subtitle: seg.subtitle || '', startInFinal: cursorInFinal, duration });
        cursorInFinal += duration;
    }

    // 2. concat
    if (onStep) onStep('concat');
    const mergedPath = path.join(workDir, 'merged.mp4');
    await concatSegments({ segmentPaths, output: mergedPath, onProgress: onFfmpegProgress });

    // 3. 生成 ASS + 烧字幕
    if (onStep) onStep('subtitle');
    const assPath = path.join(workDir, 'subs.ass');
    generateAss({ segments: segmentMeta, outputPath: assPath, width: W, height: H });
    const subbedPath = path.join(workDir, 'subbed.mp4');
    await burnAssSubtitles({ input: mergedPath, assPath, output: subbedPath, onProgress: onFfmpegProgress });

    // 4. 混 BGM
    if (onStep) onStep('bgm');
    const bgmMixedPath = path.join(workDir, 'bgm-mixed.mp4');
    await mixBgm({
        input: subbedPath,
        bgmPath: plan.bgm_path,
        output: bgmMixedPath,
        volume: plan.bgm_volume || 0.25,
        onProgress: onFfmpegProgress
    });

    // 5. 前置封面(可选)
    let finalPath = bgmMixedPath;
    if (plan.cover_path && fs.existsSync(plan.cover_path)) {
        if (onStep) onStep('cover');
        finalPath = path.join(workDir, 'with-cover.mp4');
        await prependCover({
            input: bgmMixedPath,
            coverPath: plan.cover_path,
            output: finalPath,
            coverDuration: plan.cover_duration || 0.8,
            onProgress: onFfmpegProgress
        });
    }

    // 6. CTA 尾卡(默认开启,可用 plan.cta_enabled === false 显式关闭)
    let ctaAppended = false;
    if (plan.cta_enabled !== false) {
        if (onStep) onStep('cta');
        const ctaPath = path.join(workDir, 'with-cta.mp4');
        const ctaConfig = plan.cta || {};
        try {
            await appendCtaCard({
                input: finalPath,
                output: ctaPath,
                cta: {
                    tag: ctaConfig.tag || plan.brand_tag || '@example',
                    title: ctaConfig.title || '关注 @example',
                    subtitle: ctaConfig.subtitle || '陪你幸福成长,快乐赚钱',
                    hint: ctaConfig.hint || '↓ 点赞 · 关注 · 下期更精彩 ↓',
                    tagBgColor: ctaConfig.tagBgColor || '#FFD54F',
                    tagTextColor: ctaConfig.tagTextColor || '#0B0F1A',
                    durationSec: ctaConfig.durationSec || 2.0
                },
                width: W, height: H,
                fps: 30,
                onProgress: onFfmpegProgress
            });
            finalPath = ctaPath;
            ctaAppended = true;
        } catch (err) {
            console.warn(`[cta] 失败(继续输出无 CTA 版本): ${String(err.message || err).slice(0, 120)}`);
        }
    }

    // 7. 搬到目标路径
    const target = plan.output_path || path.join(workDir, 'vlog.mp4');
    fs.copyFileSync(finalPath, target);
    const ctaExtra = ctaAppended ? (plan.cta?.durationSec || 2.0) : 0;
    const coverExtra = plan.cover_path ? (plan.cover_duration || 0.8) : 0;
    return { outputPath: target, workDir, duration: cursorInFinal + coverExtra + ctaExtra };
}

module.exports = {
    probeVideo,
    trimSegment,
    concatSegments,
    generateAss,
    burnAssSubtitles,
    mixBgm,
    prependCover,
    appendCtaCard,
    renderVlogFromPlan
};
