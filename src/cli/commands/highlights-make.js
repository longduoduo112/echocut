'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { preflightCheck } = require('../../lib/preflight');
const { acquireLock } = require('../../lib/processLock');
const { Spinner, formatDuration } = require('../../lib/cliUtils');
const { runFfmpegWithProgress } = require('../../lib/ffmpegProgress');
const cache = require('../../services/highlightsCache');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

// 精确切出 [start, end] 时间段的视频子片段(重编码,不用 -c copy 避免关键帧对齐问题)
// M4 Pro 用 h264_videotoolbox 硬编(比 libx264 preset=fast 快 3-5x),失败 fallback 软编
async function clipSegment(videoPath, startSec, endSec, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const dur = Math.max(1, endSec - startSec);
    // -ss 在 -i 之前是"快速 seek"会掉帧,在 -i 之后是精确但慢。我们要精确。
    const baseArgs = [
        '-y',
        '-i', videoPath,
        '-ss', String(startSec),
        '-t', String(dur),
    ];
    const tailArgs = [
        '-c:a', 'aac', '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
    ];
    // 优先 h264_videotoolbox 硬编(Apple Silicon),失败回退 libx264
    const hwArgs = [...baseArgs, '-c:v', 'h264_videotoolbox', '-b:v', '10M', '-maxrate', '12M', '-bufsize', '20M', ...tailArgs];
    const swArgs = [...baseArgs, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ...tailArgs];
    try {
        await runFfmpegWithProgress(hwArgs, { durationSec: dur, onProgress: null, timeoutMs: 30 * 60 * 1000 });
    } catch (err) {
        console.warn(`[hmk] videotoolbox 切片失败,fallback libx264: ${String(err.message || '').slice(0, 120)}`);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        await runFfmpegWithProgress(swArgs, { durationSec: dur, onProgress: null, timeoutMs: 30 * 60 * 1000 });
    }
}

function selectCandidates(allCandidates, opts) {
    if (opts.seg) {
        // --seg seg-01 或 --seg 1 或 --seg 1,3,5
        const wanted = String(opts.seg).split(',').map((x) => x.trim()).filter(Boolean);
        const normalized = wanted.map((w) => {
            if (/^\d+$/.test(w)) return `seg-${String(w).padStart(2, '0')}`;
            if (/^seg-\d+$/.test(w)) return w;
            return w;
        });
        return allCandidates.filter((c) => normalized.includes(c.id));
    }
    if (opts.minScore != null) {
        const min = Number(opts.minScore);
        return allCandidates.filter((c) => (c.quality_score || 0) >= min);
    }
    if (opts.all) return allCandidates;
    // 默认:只出 top 1(最高分)
    const sorted = [...allCandidates].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
    return sorted.slice(0, 1);
}

function spawnBurn(videoPath, headline, subline, extraArgs = [], cutOpts = {}) {
    return new Promise((resolve, reject) => {
        const args = ['burn', videoPath];
        // cut-fillers / cut-silence 默认开,可通过 hmk 的 --no-cut-fillers / --no-cut-silence 关
        if (cutOpts.cutFillers !== false) args.push('--cut-fillers');
        if (cutOpts.cutSilence !== false) args.push('--cut-silence');
        args.push(...extraArgs);
        if (headline) args.push(`--headline=${headline}`);
        if (subline) args.push(`--subline=${subline}`);
        const child = spawn('echocut', args, { stdio: 'inherit', cwd: process.env.ZDE_PROJECT_ROOT || process.cwd() });
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`burn exit ${code}`)));
        child.on('error', reject);
    });
}

module.exports = async function highlightsMake(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`${C.red}✗${C.reset} 找不到文件: ${abs}`);
        process.exit(1);
    }
    // 切到项目根(同 hls,否则 transcriber/ffmpeg 相对路径解析会找错)
    try { process.chdir(root); } catch (_) {}

    const { hash, dir } = cache.getCacheDir(abs, root);
    if (!cache.isCacheFresh(abs, dir)) {
        console.error(`${C.red}✗${C.reset} 没有缓存的分析结果,请先跑:`);
        console.error(`   ${C.cyan}echocut highlights ls ${path.basename(abs)}${C.reset}\n`);
        process.exit(1);
    }
    const all = (cache.readCandidates(dir) || {}).candidates || [];
    const selected = selectCandidates(all, opts);
    if (!selected.length) {
        console.error(`${C.red}✗${C.reset} 没有匹配的候选片段`);
        console.error(`   用 ${C.cyan}echocut highlights ls ${path.basename(abs)}${C.reset} 查看所有候选`);
        process.exit(1);
    }

    console.log(`\n${C.bold}${C.cyan}🎬 echocut highlights make${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}       ${path.basename(abs)}`);
    console.log(`   ${C.gray}将产出${C.reset}     ${selected.length} 个片段`);
    console.log(`   ${C.gray}缓存${C.reset}       ${dir}\n`);

    // 跑前守门 + 锁(每个 seg 都会调 burn,burn 里会再锁一次,所以这里不锁避免死锁)
    preflightCheck(abs, { engine: 'mlx_hq' });

    for (let i = 0; i < selected.length; i += 1) {
        const seg = selected[i];
        console.log(`\n${C.bold}━━━ [${i + 1}/${selected.length}] ${seg.id}  ${seg.title}${C.reset}`);
        console.log(`   ${C.gray}时间${C.reset}   ${seg.start.toFixed(1)}s → ${seg.end.toFixed(1)}s  (${formatDuration(seg.duration * 1000)})`);
        console.log(`   ${C.gray}评分${C.reset}   ${seg.quality_score.toFixed(2)}  ${C.cyan}${(seg.tags || []).map((t) => '#' + t).join(' ')}${C.reset}`);

        // 1. 精确切出子视频(文件名嵌 start/end 秒,让 LLM 更新后自动重切,
        //    防止命中旧版本的短 clip——之前用户反馈"尾巴没说完"根因就是这)
        const prodDir = cache.getProductDir(dir, seg.id);
        const startTag = Math.round(seg.start);
        const endTag = Math.round(seg.end);
        const clipPath = path.join(prodDir, `${seg.id}_${startTag}-${endTag}.mp4`);
        const expectedDur = seg.end - seg.start;
        // 额外防御:即使文件名一致,若时长与 LLM 给的差 > 1s 也重切
        let alreadyClipped = fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024;
        if (alreadyClipped) {
            try {
                const { execSync } = require('child_process');
                const actualDur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${clipPath}"`, { encoding: 'utf8' }).trim());
                if (Math.abs(actualDur - expectedDur) > 1.5) {
                    console.warn(`   ${C.yellow}⚠${C.reset} 已有 clip 时长 ${actualDur.toFixed(1)}s 与 LLM 期望 ${expectedDur.toFixed(1)}s 不符,重切`);
                    alreadyClipped = false;
                }
            } catch (_) { alreadyClipped = false; }
        }
        const clipSpinner = new Spinner('ffmpeg 精确切片(重编码)').start();
        try {
            if (!alreadyClipped) {
                await clipSegment(abs, seg.start, seg.end, clipPath);
            }
            clipSpinner.stop(alreadyClipped ? '(已存在,跳过)' : `(${(fs.statSync(clipPath).size / 1e6).toFixed(1)} MB)`);
        } catch (err) {
            clipSpinner.fail();
            console.error(`   ${C.red}✗${C.reset} 切片失败: ${err.message.slice(0, 200)}`);
            continue;
        }

        // 2. 调 burn 处理这个切片(完整 pipeline:字幕 + 标题 + 封面 + BGM + CTA)
        // subline 如果没给上下文,尝试用 context_note 补(v2.3 改进,让观众知道场景)
        let effectiveSubline = seg.suggested_subline || '';
        if (seg.context_note && effectiveSubline && !effectiveSubline.includes(seg.context_note.slice(0, 4))) {
            // subline 里没提场景词,前置 context_note 作为情境
            effectiveSubline = `${seg.context_note}·${effectiveSubline}`.slice(0, 40);
        } else if (seg.context_note && !effectiveSubline) {
            effectiveSubline = seg.context_note;
        }
        // 记录 spawn burn 前最新目录,便于之后重命名
        const videoRoot = path.join(process.env.ZDE_PROJECT_ROOT || process.cwd(), 'debug_outputs', 'video');
        const dirsBefore = fs.existsSync(videoRoot) ? new Set(fs.readdirSync(videoRoot)) : new Set();

        try {
            await spawnBurn(
                clipPath,
                seg.suggested_headline || seg.title,
                effectiveSubline,
                [
                    ...(opts.denoise ? ['--denoise'] : []),
                    ...(opts.bgm ? ['--bgm', opts.bgm] : []),
                    ...(opts.brand ? ['--brand', opts.brand] : []),
                    // v0.10+ 黄金 3 秒 forward 给 burn
                    ...(opts.goldenHook ? ['--golden-hook'] : []),
                    ...(opts.goldenStart != null && opts.goldenStart !== '' ? ['--golden-start', String(opts.goldenStart)] : []),
                    ...(opts.goldenDuration != null && opts.goldenDuration !== '' ? ['--golden-duration', String(opts.goldenDuration)] : [])
                ],
                { cutFillers: opts.cutFillers, cutSilence: opts.cutSilence }
            );
        } catch (err) {
            console.error(`   ${C.red}✗${C.reset} burn 失败: ${err.message}`);
            continue;
        }

        // 把新产出的目录重命名为 <时间戳>__<slug> 形式,方便 Finder 里认视频
        try {
            const dirsAfter = fs.existsSync(videoRoot) ? fs.readdirSync(videoRoot) : [];
            const newDir = dirsAfter.find((d) => !dirsBefore.has(d));
            if (newDir) {
                const headline = String(seg.suggested_headline || seg.title || seg.id).trim();
                const slug = headline
                    .replace(/[\/\\:*?"<>|]/g, '')
                    .replace(/\s+/g, '_')
                    .slice(0, 40);
                if (slug) {
                    const renamed = `${newDir}__${slug}`;
                    fs.renameSync(path.join(videoRoot, newDir), path.join(videoRoot, renamed));
                    console.log(`   ${C.gray}📂${C.reset} 产出目录已重命名为 ${C.cyan}${renamed}${C.reset}`);
                }
            }
        } catch (renameErr) {
            console.warn(`   ${C.yellow}⚠${C.reset} 目录重命名失败(不阻塞): ${renameErr.message}`);
        }
    }

    console.log(`\n${C.green}✓${C.reset} highlights make 完成。产出在 ${C.gray}debug_outputs/video/${C.reset}。`);
    console.log(`${C.gray}  切片视频(再剪辑用):${C.reset} ${path.join(dir, 'products')}/\n`);
};
