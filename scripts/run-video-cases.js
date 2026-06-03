const fs = require('fs');
const path = require('path');
const { Spinner, makeProgressBar, checkMemory, StepTimeline, formatDuration } = require('../src/lib/cliUtils');
const { downloadYoutubeVideo } = require('../src/services/youtubeDl');
const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs, getConfigValue } = require('../src/db/configRepo');
const { createContent, appendProcessTrace } = require('../src/db/contentsRepo');
const { generateVideoMetadata, generatePublishKit, stripHallucinatedLoop, correctCaptions, extractEmphasisKeywords } = require('../src/services/processor');
const { transcribeByEngine } = require('../src/video/asrAdapters');
const { buildRobustCaptions, toSrt, applyFillerRemoval } = require('../src/video/captionUtils');
const { cutFillersFromVideo } = require('../src/video/fillerCutter');
const { generateCover } = require('../src/video/coverGenerator');
const { attachCoverAndFadeOut } = require('../src/video/postProcess');
const { getVideoCaptionOptions } = require('../src/video/captionConfig');
const { loadBrand } = require('../src/services/brandLoader');
const { sanitizeCaptions, getBrandCorrections, getTechTermCorrections, countHits } = require('../src/lib/asrNameSanitizer');
const { loadTranscriptCache, saveTranscriptCache } = require('../src/lib/transcriptCache');
const {
    ensureDir,
    prepareBundle,
    copyAudioToPublic,
    transcodeAudioToAacIfNeeded,
    renderCaptionVideo,
    burnSubtitleVideo,
    extractAudioFromVideo,
    probeVideoSize,
    probeVideoDuration
} = require('../src/video/remotionRunner');

function getMediaFiles(dirPath, pattern, recursive = false) {
    if (!fs.existsSync(dirPath)) return [];
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return [];
    if (!recursive) {
        return fs.readdirSync(dirPath)
            .filter((name) => pattern.test(name))
            .map((name) => path.join(dirPath, name));
    }
    const results = [];
    const queue = [dirPath];
    while (queue.length) {
        const current = queue.shift();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(abs);
                continue;
            }
            if (entry.isFile() && pattern.test(entry.name)) {
                results.push(abs);
            }
        }
    }
    return results;
}

function toAbsPath(rawPath) {
    if (!rawPath) return '';
    return path.resolve(process.cwd(), rawPath);
}

function resolveArg(name) {
    const match = process.argv.find((x) => x.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : '';
}

function asPositiveInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.floor(n));
}

function asNonNegativeInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.max(0, Math.floor(n));
}

function asFiniteNumber(raw) {
    // resolveArg 找不到参数时返回 '',Number('') === 0 会让所有未传参数默认变成 0
    // 这会造成 preset 的 subtitleMarginV=260 被 0 覆盖(历史遗留坑)
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function normalizeInlineText(text, maxLen) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    return source.slice(0, Math.max(2, maxLen));
}

// Load completed video file paths from a previous run's summary.json for --resume
function loadCompletedPaths(debugOutputBase) {
    const videoBase = path.join(process.cwd(), debugOutputBase || 'debug_outputs', 'video');
    if (!fs.existsSync(videoBase)) return new Set();
    const runs = fs.readdirSync(videoBase)
        .filter((name) => fs.statSync(path.join(videoBase, name)).isDirectory())
        .sort()
        .reverse(); // newest first
    const completed = new Set();
    for (const run of runs) {
        const summaryPath = path.join(videoBase, run, 'summary.json');
        if (!fs.existsSync(summaryPath)) continue;
        try {
            const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            if (!Array.isArray(summary.results)) continue;
            for (const r of summary.results) {
                if (r.file) completed.add(r.file); // basename
            }
        } catch (_) {}
        if (completed.size > 0) break; // use most recent run that has results
    }
    return completed;
}

function parseArgs() {
    return {
        showHelp: process.argv.includes('--help') || process.argv.includes('-h'),
        engine: resolveArg('--engine') || 'qwen3',
        limit: asNonNegativeInt(resolveArg('--limit'), 0),
        recursive: process.argv.includes('--recursive'),
        concurrency: asPositiveInt(resolveArg('--concurrency'), 1),
        fallbackText: resolveArg('--fallback-text') || '这是本地字幕调试默认文本。',
        fixedHeadline: resolveArg('--headline'),
        fixedSubline: resolveArg('--subline'),
        videoFileArg: resolveArg('--video-file'),
        audioFileArg: resolveArg('--audio-file') || resolveArg('--file'),
        videoDirArg: resolveArg('--video-dir'),
        audioDirArg: resolveArg('--audio-dir'),
        videoCaseFileArg: resolveArg('--video-case-file'),
        subtitleFontSizeArg: asFiniteNumber(resolveArg('--subtitle-font-size')),
        subtitleMarginVArg: asFiniteNumber(resolveArg('--subtitle-margin-v')),
        subtitleMarginHArg: asFiniteNumber(resolveArg('--subtitle-margin-h')),
        headlineFontSizeArg: asFiniteNumber(resolveArg('--headline-font-size')),
        sublineFontSizeArg: asFiniteNumber(resolveArg('--subline-font-size')),
        topBandHeightArg: asFiniteNumber(resolveArg('--top-band-height')),
        stylePresetArg: String(resolveArg('--style-preset') || '').trim().toLowerCase(),
        sentenceMaxCharsArg: asFiniteNumber(resolveArg('--sentence-max-chars')),
        sentenceMaxDurationArg: asFiniteNumber(resolveArg('--sentence-max-duration')),
        sentenceGapBreakSecArg: asFiniteNumber(resolveArg('--sentence-gap-break-sec')),
        chunkMaxCharsArg: asFiniteNumber(resolveArg('--chunk-max-chars')),
        previewSecondsArg: asFiniteNumber(resolveArg('--preview-seconds')),
        subtitleMaxUnitsArg: asFiniteNumber(resolveArg('--subtitle-max-units')),
        subtitleOffsetMsArg: asFiniteNumber(resolveArg('--subtitle-offset')),
        resume: process.argv.includes('--resume'),
        youtubeUrl: resolveArg('--youtube-url')
    };
}

// Auto-detect orientation from video file when --style-preset is not specified.
// Returns 'vertical', 'square', or 'landscape' based on aspect ratio.
function autoDetectPreset(videoFile) {
    try {
        const { width, height } = probeVideoSize(videoFile);
        if (!width || !height) return 'landscape';
        const aspect = width / height;
        if (aspect > 0.88 && aspect < 1.12) return 'square';
        if (aspect < 0.8) return 'vertical';
        return 'landscape';
    } catch (_) {
        return 'landscape';
    }
}

const CHINESE_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function writePublishMd({ groups, commandHeadline, caseDir, engine, fileName, captionsCount, durationSec }) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const durStr = durationSec > 0
        ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')}`
        : '';
    const lines = [
        '# 宣发素材包',
        '',
        [
            `> 视频：${fileName}`,
            durStr ? `时长：${durStr}` : '',
            `引擎：${engine}`,
            `字幕：${captionsCount}条`,
            `生成：${dateStr}`
        ].filter(Boolean).join('  |  '),
        commandHeadline ? `> 命令标题（已烧录）：**${commandHeadline}**` : '',
        '',
        '---',
        ''
    ].filter((l) => l !== null);

    groups.forEach((group, idx) => {
        const num = CHINESE_NUMS[idx] || String(idx + 1);
        lines.push(`## 组${num}`);
        lines.push('');
        lines.push(`**标题：** ${group.title}`);
        lines.push('');
        lines.push('**简介（含话题标签）：**');
        lines.push('');
        lines.push(group.description);
        lines.push('');
        lines.push('---');
        lines.push('');
    });

    const outPath = path.join(caseDir, 'publish.md');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    return outPath;
}

// Style preset values are 1080p-reference sizes.
// In burnSubtitleVideo, subtitle values are scaled once by resScale = min(W,H)/1080.
// Headline/subline values are scaled once by resScale = shortEdge/1080.
function resolveStylePreset(name) {
    if (name === 'landscape') {
        // Landscape: subtitle ref=150, at 4K (resScale=2) scales to 300 but capped at 7% of shortEdge ≈ 151px
        // Longer sentences OK for horizontal reading — target 20 chars per line
        return {
            subtitleFontSize: 150,
            subtitleMarginV: 0,   // 0 = use percentage formula (6% of height)
            subtitleMarginH: 44,
            headlineFontSize: 58,
            sublineFontSize: 34,
            sentenceMaxChars: 20
        };
    }
    if (name === 'vertical') {
        // Vertical: ref=150, at 3K portrait (resScale=1.6) scales to 240 but capped at 9.5% of shortEdge ≈ 164px
        // Short sentences for fast mobile scrolling — target 12 chars per line
        return {
            subtitleFontSize: 150,
            subtitleMarginV: 0,   // 0 = use percentage formula (8% of height)
            subtitleMarginH: 40,
            headlineFontSize: 52,
            sublineFontSize: 32,
            topBandHeight: 270,
            sentenceMaxChars: 12
        };
    }
    if (name === 'square') {
        return {
            subtitleFontSize: 150,
            subtitleMarginV: 0,
            subtitleMarginH: 40,
            headlineFontSize: 54,
            sublineFontSize: 32,
            topBandHeight: 250,
            sentenceMaxChars: 14
        };
    }
    if (name === 'safe') {
        // Conservative preset, wider margins for safety
        return {
            subtitleFontSize: 150,
            subtitleMarginV: 0,
            subtitleMarginH: 52,
            headlineFontSize: 48,
            sublineFontSize: 30,
            topBandHeight: 240,
            sentenceMaxChars: 14
        };
    }
    return {};
}

function printHelp() {
    const lines = [
        'Usage: node scripts/run-video-cases.js [options]',
        '',
        '--engine=qwen3(默认)|mlx_hq|mlx|auto|whisperx|whisperx_hq|funasr|sensevoice',
        '--limit=0 (0 代表不限制)',
        '--recursive',
        '--concurrency=1',
        '--audio-file=/abs/path/demo.ogg',
        '--audio-dir=audio_inputs',
        '--video-file=/abs/path/demo.mp4',
        '--video-dir=video_inputs',
        '--video-case-file=testcases/video-cases.local.json',
        '--headline=固定标题',
        '--subline=固定副标题',
        '--fallback-text=静音时回退文本',
        '--headline-font-size=46',
        '--subline-font-size=28',
        '--subtitle-font-size=30',
        '--subtitle-margin-v=66',
        '--subtitle-margin-h=48',
        '--top-band-height=320',
        '--style-preset=landscape|vertical|square|safe',
        '--sentence-max-chars=16',
        '--sentence-max-duration=2.6',
        '--sentence-gap-break-sec=0.50',
        '--chunk-max-chars=14',
        '--preview-seconds=18',
        '--subtitle-max-units=14',
        '--youtube-url=https://youtube.com/watch?v=xxx',
        '',
        'video-case-file 格式: [{ "file":"video_inputs/a.mp4", "headline":"...", "subline":"...", "fallbackText":"..." }]',
        '支持绝对路径目录，例如 --video-dir=/Users/xxx/Videos --recursive --concurrency=2',
        '',
        'Best practices:',
        '横屏: node scripts/run-video-cases.js --engine=sensevoice --video-file=/abs/a.mp4 --style-preset=landscape --sentence-max-chars=16',
        '竖屏: node scripts/run-video-cases.js --engine=sensevoice --video-file=/abs/b.mp4 --style-preset=vertical --sentence-max-chars=12 --chunk-max-chars=10',
        '方屏: node scripts/run-video-cases.js --engine=sensevoice --video-file=/abs/c.mp4 --style-preset=square --subtitle-margin-h=72',
        '快速所见即所得: node scripts/run-video-cases.js --engine=sensevoice --video-file=/abs/a.mp4 --style-preset=safe --preview-seconds=18'
    ];
    console.log(lines.join('\n'));
}

function readVideoCaseFile(caseFilePath) {
    const resolved = toAbsPath(caseFilePath);
    if (!fs.existsSync(resolved)) return [];
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => {
        const fileRaw = String(item.file || item.videoFile || '').trim();
        const file = toAbsPath(fileRaw);
        return {
            id: item.id || `case_${index + 1}`,
            videoFile: file,
            headline: String(item.headline || '').trim(),
            subline: String(item.subline || '').trim(),
            fallbackText: String(item.fallbackText || item.fallback_text || '').trim()
        };
    }).filter((item) => item.videoFile);
}

function resolveInputCollections(args, videoCases) {
    const hasExplicitAudio = Boolean(args.audioFileArg || args.audioDirArg);
    const hasExplicitVideo = Boolean(args.videoFileArg || args.videoDirArg || videoCases.length);
    const shouldLoadAudio = hasExplicitAudio || !hasExplicitVideo;
    const shouldLoadVideo = hasExplicitVideo || !hasExplicitAudio;
    const audioFiles = shouldLoadAudio
        ? (args.audioFileArg
            ? [toAbsPath(args.audioFileArg)]
            : getMediaFiles(
                toAbsPath(args.audioDirArg || 'audio_inputs'),
                /\.(ogg|mp3|m4a|wav|aac|flac)$/i,
                args.recursive
            ))
        : [];
    const videoFiles = shouldLoadVideo
        ? (args.videoFileArg
            ? [toAbsPath(args.videoFileArg)]
            : (videoCases.length
                ? videoCases.map((item) => item.videoFile)
                : getMediaFiles(
                    toAbsPath(args.videoDirArg || 'video_inputs'),
                    /\.(mp4|mov|m4v|mkv|webm|avi)$/i,
                    args.recursive
                )))
        : [];
    const applyLimit = (items) => {
        if (!args.limit || args.limit <= 0) return items;
        return items.slice(0, args.limit);
    };
    const sortByMtimeDesc = (items) => (
        items.slice().sort((a, b) => {
            const aTime = fs.statSync(a).mtimeMs;
            const bTime = fs.statSync(b).mtimeMs;
            return bTime - aTime;
        })
    );
    // Case file and explicit --video-file: preserve the user-defined order (JSON order).
    // Directory scan: sort by mtime desc so newest files come first.
    const fromCaseFile = videoCases.length > 0;
    const fromExplicitVideoFile = Boolean(args.videoFileArg);
    const fromExplicitAudioFile = Boolean(args.audioFileArg);
    const finalAudioFiles = applyLimit(fromExplicitAudioFile ? audioFiles : sortByMtimeDesc(audioFiles));
    const finalVideoFiles = applyLimit((fromCaseFile || fromExplicitVideoFile) ? videoFiles : sortByMtimeDesc(videoFiles));
    const caseMap = new Map(videoCases.map((item) => [toAbsPath(item.videoFile), item]));
    return { audioFiles: finalAudioFiles, videoFiles: finalVideoFiles, caseMap };
}

async function buildMetadata(text, fallbackHeadline, fallbackSubline, config, warnings) {
    if (!text) return { headline: fallbackHeadline, subline: fallbackSubline };
    try {
        return await generateVideoMetadata(text, config);
    } catch (error) {
        warnings.push(`metadata_generate_failed:${String(error.message || error)}`);
        return { headline: fallbackHeadline, subline: fallbackSubline };
    }
}

// 从 brand 取兜底标题/副标题:优先 identity.title + identity.slogan,缺失退化到通用兜底
function pickBrandFallback() {
    try {
        const brand = loadBrand();
        const headline = (brand?.identity?.title || brand?.identity?.name || '').trim();
        const subline = (brand?.identity?.slogan
            || brand?.identity?.taglineZh
            || brand?.cta?.subtitle
            || '').trim();
        return { headline, subline };
    } catch (_e) {
        return { headline: '', subline: '' };
    }
}

async function renderAudioCase({
    audioFile,
    outputDir,
    engine,
    videoCaptionOptions,
    fixedHeadline,
    fixedSubline,
    config,
    warnings
}) {
    const fileName = path.basename(audioFile);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const caseDir = path.join(outputDir, `${engine}_${stem}`);
    ensureDir(caseDir);

    const { words, payload, fullText: rawFullText, transcribeMs, stderr, usedEngine, usedScript, usedModel } = await transcribeByEngine(audioFile, engine);
    const fullText = stripHallucinatedLoop(rawFullText || '');
    let captions = buildRobustCaptions(payload || { words }, fullText, videoCaptionOptions);
    try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[audio-case] caption correction skipped:', e.message); }
    const srtText = toSrt(captions);

    const preparedAudio = transcodeAudioToAacIfNeeded(audioFile, `${engine}_${stem}`);
    const audioSrc = copyAudioToPublic(preparedAudio, `${engine}_${stem}`);

    const brandFb = pickBrandFallback();
    // 末端兜底改空(避免 _default brand 用户在 LLM 失败时看到开发期 placeholder)
    const fbHeadline = fixedHeadline || brandFb.headline || '';
    const fbSubline = fixedSubline || brandFb.subline || '';
    const metadata = (!fixedHeadline || !fixedSubline)
        ? await buildMetadata(fullText, fbHeadline, fbSubline, config, warnings)
        : { headline: fixedHeadline, subline: fixedSubline };

    const inputProps = {
        headline: normalizeInlineText(metadata.headline || fbHeadline, 20) || fbHeadline,
        subline: normalizeInlineText(metadata.subline || fbSubline, 40) || fbSubline,
        audioSrc,
        captions
    };

    const { serveUrl } = await prepareBundle();
    const outputLocation = path.join(caseDir, `${engine}_${stem}.mp4`);
    await renderCaptionVideo({ serveUrl, outputLocation, inputProps });

    fs.writeFileSync(path.join(caseDir, 'transcript.json'), JSON.stringify({
        engine,
        used_engine: usedEngine || '',
        used_script: usedScript || '',
        used_model: usedModel || '',
        file: fileName,
        full_text: fullText,
        words_count: words.length,
        captions_count: captions.length,
        transcribe_ms: transcribeMs,
        stderr
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(caseDir, 'captions.json'), JSON.stringify(captions, null, 2), 'utf8');
    fs.writeFileSync(path.join(caseDir, 'captions.srt'), srtText, 'utf8');

    return {
        mode: 'audio',
        file: fileName,
        mp4: outputLocation,
        srt: path.join(caseDir, 'captions.srt'),
        captions: captions.length,
        words: words.length,
        transcribeMs
    };
}

async function renderVideoCase({
    videoFile,
    outputDir,
    engine,
    fallbackText,
    videoCaptionOptions,
    headlineOverride,
    sublineOverride,
    styleOptions = {},
    config,
    warnings,
    previewSeconds = 0
}) {
    const fileName = path.basename(videoFile);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const caseDir = path.join(outputDir, `${engine}_${stem}`);
    ensureDir(caseDir);

    // 预先计算可见步骤总数:让步骤编号 [n/total] 对用户可读
    // 顺序:音频 → 转写 → 切片(可选) → 爆点词(可选) → 字幕+元数据(LLM) → 烧字幕 → 封面+尾卡(条件) → 宣发(条件)
    const willCut = (process.env.ZDE_CUT_FILLERS === '1' || process.env.ZDE_CUT_SILENCE === '1') && !previewSeconds;
    const willEmphasis = process.env.ZDE_EMPHASIS_OFF !== '1';  // 粗略(真正条件在下面,但这里估算 UI 即可)
    const willPostProcess = !previewSeconds;
    const willPublishKit = previewSeconds <= 0;
    let totalSteps = 2;  // extract + transcribe 必有
    if (willCut) totalSteps += 1;
    if (willEmphasis) totalSteps += 1;
    totalSteps += 1;  // LLM 字幕/元数据(合并)
    totalSteps += 1;  // 烧字幕
    if (willPostProcess) totalSteps += 1;  // cover + post-process 合并
    if (willPublishKit) totalSteps += 1;
    if (process.env.ZDE_GOLDEN_HOOK === '1' && willPostProcess) totalSteps += 1;  // v0.10+ 黄金 3 秒钩子
    let step = 0;
    const timeline = new StepTimeline();

    step += 1;
    let spinner = new Spinner('extract audio', { step, total: totalSteps }).start();
    let extractedAudio;
    let videoDurationSec = 0;
    try {
        extractedAudio = await extractAudioFromVideo(videoFile, `local_video_${stem}`, previewSeconds);
        videoDurationSec = probeVideoDuration(videoFile);
        spinner.stop(videoDurationSec > 0 ? `(${Math.round(videoDurationSec)}s video)` : '');
        timeline.record('extract audio', spinner.elapsedMs);
    } catch (err) {
        spinner.fail();
        throw err;
    }

    // v0.17 ZDE_NO_SUBTITLE=1:剪映/Premiere 已剪好(字幕烧好或不需要),跳过 ASR
    // burn 仍跑顶部标题+品牌胶囊+封面+BGM+CTA+宣发包(brand 能力 100% 保留)
    const skipSubtitle = process.env.ZDE_NO_SUBTITLE === '1';

    // --reuse-captions(ZDE_REUSE_CAPTIONS):显式喂现成 captions.json,跳过转写 + LLM 纠错,
    // 用于同一视频换比例/样式/封面快速重渲染。文件可为 [{text,start,end}] 或 {captions:[...]}。
    const reuseCaptionsPath = String(process.env.ZDE_REUSE_CAPTIONS || '').trim();
    let reusedCaptions = null;
    if (reuseCaptionsPath && !skipSubtitle) {
        try {
            const raw = JSON.parse(fs.readFileSync(reuseCaptionsPath, 'utf8'));
            const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.captions) ? raw.captions : null);
            if (arr && arr.length) reusedCaptions = arr;
            else console.warn(`[reuse-captions] 文件无有效字幕,回退正常转写: ${reuseCaptionsPath}`);
        } catch (e) {
            console.warn(`[reuse-captions] 读取失败,回退正常转写: ${e.message}`);
        }
    }
    // ZDE_FRESH=1:强制重新转写,绕过转写缓存
    const freshTranscribe = process.env.ZDE_FRESH === '1';

    step += 1;
    let transcribeResult;
    if (skipSubtitle) {
        process.stdout.write(`[${step}/${totalSteps}] \x1b[36m⚡\x1b[0m skip subtitle (ZDE_NO_SUBTITLE=1)  跳 ASR / brand 能力全保留\n`);
        transcribeResult = { words: [], payload: { words: [] }, fullText: '', transcribeMs: 0, stderr: '', usedEngine: 'skip', usedScript: '', usedModel: '' };
        timeline.record('transcribe [skip]', 0, 'no-subtitle mode');
    } else if (reusedCaptions) {
        process.stdout.write(`[${step}/${totalSteps}] \x1b[36m⚡\x1b[0m reuse captions (${reusedCaptions.length} 段)  跳转写 + LLM 纠错\n`);
        const reuseText = reusedCaptions.map((c) => c.text || c.word || '').join('');
        transcribeResult = { words: [], payload: { words: [] }, fullText: reuseText, transcribeMs: 0, stderr: '', usedEngine: 'reuse', usedScript: '', usedModel: '' };
        timeline.record('transcribe [reuse]', 0, `${reusedCaptions.length} captions`);
    } else {
        spinner = new Spinner(`transcribe [${engine}]`, { step, total: totalSteps }).start();
        try {
            // 转写跨运行缓存:同一源视频(指纹不变)直接复用上次转写,跳过 ~17min。预览模式不缓存(音频是局部)。
            const cached = (!freshTranscribe && !previewSeconds) ? loadTranscriptCache(videoFile, engine, previewSeconds) : null;
            if (cached) {
                transcribeResult = cached;
                spinner.stop(`(${cached.words.length} words · \x1b[32m转写缓存命中,跳过转写\x1b[0m)`);
                timeline.record(`transcribe [${engine}]`, spinner.elapsedMs, `cache hit · ${cached.words.length} words`);
            } else {
                transcribeResult = await transcribeByEngine(extractedAudio, engine);
                if (!previewSeconds) saveTranscriptCache(videoFile, engine, previewSeconds, transcribeResult);
                const usedEng = transcribeResult.usedEngine || engine;
                const fallbackNote = usedEng !== engine && !engine.includes(usedEng) ? ` [fallback→${usedEng}]` : '';
                spinner.stop(`(${transcribeResult.words.length} words${fallbackNote})`);
                timeline.record(`transcribe [${engine}]`, spinner.elapsedMs, `${transcribeResult.words.length} words`);
            }
        } catch (err) {
            spinner.fail();
            throw err;
        }
    }
    const { words, payload, fullText, transcribeMs, stderr, usedEngine, usedScript, usedModel } = transcribeResult;
    const effectiveText = stripHallucinatedLoop(String(fullText || fallbackText || '').trim());

    // 无口播检测: ASR 转写内容极少时(< 10 个有效字),视为无人声视频,
    // 跳过字幕(Whisper 在无声段会幻觉出训练数据里的随机文字)
    const meaningfulChars = (effectiveText || '').replace(/[^\u4e00-\u9fff\w]/g, '').length;
    const isNoSpeech = skipSubtitle || (meaningfulChars < 10 && words.length < 15);
    if (isNoSpeech && !skipSubtitle) {
        process.stdout.write(`  \x1b[33m⚠ 检测到无口播(仅 ${meaningfulChars} 字),跳过字幕,仅保留品牌带+BGM+CTA\x1b[0m\n`);
    }

    // ZDE_CUT_FILLERS=1 → 视频轨道级 filler 切除(先切视频,再构建字幕);
    // 仅在完整模式(非 preview)下启用,因为 preview 是快速调试目的。
    let effectiveVideoFile = videoFile;
    let effectiveWords = words;
    let effectivePayload = payload;
    let cutReport = null;
    const cutSilence = process.env.ZDE_CUT_SILENCE === '1';
    const silenceThreshold = Number(process.env.ZDE_SILENCE_THRESHOLD || '2.5');
    const needCut = (process.env.ZDE_CUT_FILLERS === '1' || cutSilence) && !previewSeconds;
    if (needCut) {
        step += 1;
        const label = cutSilence && process.env.ZDE_CUT_FILLERS === '1'
            ? 'cut fillers + silence'
            : cutSilence ? 'cut silence' : 'cut fillers';
        // 先显示一行步骤标题,再在同一行打实时百分比进度条(ffmpeg concat+reencode)
        process.stdout.write(`[${step}/${totalSteps}] ${label}\n`);
        const cutStartMs = Date.now();
        const onProgress = makeProgressBar(28, { step, total: totalSteps, label: 'ffmpeg' });
        try {
            const result = await cutFillersFromVideo({
                inputVideoPath: videoFile,
                words,
                fillerWords: videoCaptionOptions.fillerWords || [],
                outputDir: caseDir,
                stem,
                options: {
                    cutFillersEnabled: process.env.ZDE_CUT_FILLERS === '1',
                    cutSilence,
                    silenceThreshold
                },
                onProgress
            });
            const cutMs = Date.now() - cutStartMs;
            if (result.skipped) {
                process.stdout.write(`[${step}/${totalSteps}] ✓ ${label}  ${formatDuration(cutMs)}  (no hits)\n`);
                timeline.record(label, cutMs, 'no hits');
            } else {
                effectiveVideoFile = result.trimmedVideoPath;
                effectiveWords = result.adjustedWords;
                effectivePayload = { ...(payload || {}), words: result.adjustedWords };
                cutReport = result;
                const beforeSec = result.durationBefore.toFixed(1);
                const afterSec = result.durationAfter.toFixed(1);
                const parts = [];
                if (result.fillerSpanCount) parts.push(`${result.fillerSpanCount} fillers`);
                if (result.silenceSpanCount) parts.push(`${result.silenceSpanCount} silences`);
                const note = `${result.cuts.length} cuts (${parts.join(' + ')}), ${beforeSec}s → ${afterSec}s`;
                process.stdout.write(`[${step}/${totalSteps}] ✓ ${label}  ${formatDuration(cutMs)}  ${note}\n`);
                timeline.record(label, cutMs, note);
            }
        } catch (err) {
            process.stdout.write(`[${step}/${totalSteps}] ✗ ${label}  failed\n`);
            throw err;
        }
    }

    // Auto-detect orientation when no preset is specified
    const effectivePresetName = styleOptions.stylePreset || autoDetectPreset(effectiveVideoFile);
    if (!styleOptions.stylePreset) console.log(`[video][auto-preset] detected: ${effectivePresetName} (${path.basename(videoFile)})`);
    const presetStyle = resolveStylePreset(effectivePresetName);
    // Merge preset sentenceMaxChars into caption options so segmentation honors orientation
    const effectiveCaptionOptions = {
        ...videoCaptionOptions,
        sentenceMaxChars: Number.isFinite(styleOptions.sentenceMaxChars) ? styleOptions.sentenceMaxChars
            : (Number.isFinite(presetStyle.sentenceMaxChars) ? presetStyle.sentenceMaxChars : videoCaptionOptions.sentenceMaxChars)
    };

    // LLM 动态爆点词发现:让字幕高亮真正对上这个视频的语境。
    // ZDE_KEEP_FILLERS 模式下也启用(不冲突,只是补强字典)。
    // 失败时 fallback 到 preset 静态 emphasisWords(已在 effectiveCaptionOptions.emphasisWords)。
    if (process.env.ZDE_EMPHASIS_OFF !== '1' && effectiveText && effectiveText.length >= 50) {
        step += 1;
        const eSpinner = new Spinner('discover emphasis (LLM)', { step, total: totalSteps }).start();
        try {
            const llmKeywords = await extractEmphasisKeywords(effectiveText, config);
            if (llmKeywords && llmKeywords.length) {
                const base = Array.isArray(effectiveCaptionOptions.emphasisWords) ? effectiveCaptionOptions.emphasisWords : [];
                const merged = [...new Set([...llmKeywords, ...base])];
                effectiveCaptionOptions.emphasisWords = merged;
                eSpinner.stop(`(${llmKeywords.length} llm + ${base.length} preset → ${merged.length})`);
                timeline.record('discover emphasis', eSpinner.elapsedMs, `${merged.length} keywords`);
            } else {
                eSpinner.stop('(LLM 返回空,沿用 preset)');
                timeline.record('discover emphasis', eSpinner.elapsedMs, 'LLM empty');
            }
        } catch (err) {
            eSpinner.fail();
            timeline.record('discover emphasis', eSpinner.elapsedMs, 'failed');
            console.error('[emphasis] 跳过:', err.message || err);
        }
    }

    // 把字幕对齐/纠错 + 元数据生成合并为一个 "LLM 字幕/元数据" 步骤,LLM 调用顺序执行
    step += 1;
    const llmSpinner = new Spinner('LLM 字幕/元数据', { step, total: totalSteps }).start();
    const rawCaptions = reusedCaptions ? reusedCaptions.slice()
        : (isNoSpeech ? [] : buildRobustCaptions(effectivePayload || { words: effectiveWords }, effectiveText, effectiveCaptionOptions));
    // ZDE_KEEP_FILLERS=1: CLI 层 --no-fillers,保留口水词
    // cutReport 已真删视频段,无需再做字幕级过滤(避免字幕 drift)
    const effectiveFillerWords = (process.env.ZDE_KEEP_FILLERS === '1' || cutReport)
        ? []
        : effectiveCaptionOptions.fillerWords;
    // reuse-captions:已是最终字幕,跳过 filler 过滤 + LLM 纠错(仍走下方品牌/技术词 sanitize,幂等)
    let captions = reusedCaptions ? reusedCaptions.slice() : applyFillerRemoval(rawCaptions, effectiveFillerWords);
    if (!reusedCaptions) {
        try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[video-case] caption correction skipped:', e.message); }
    }
    // ASR 同音字校正(brand.asrNameCorrections 配置):panel/多人对谈场景常把
    // 人名公司名识别成同音字(李标→李彪 / WUI.AI→We点AI 等),LLM 校正不知真名
    // 无法修复;brand 级精确替换层补这一刀。失败不影响主流程。
    try {
        const brandForSan = loadBrand();
        // 全局技术术语词库(Claude Code 等)+ 品牌人名校正,合并后一起精确替换。
        // 技术词在前、品牌词在后(品牌可覆盖);两者都失败不影响主流程。
        const corrections = [...getTechTermCorrections(), ...getBrandCorrections(brandForSan)];
        if (corrections.length > 0) {
            const captionsText = captions.map((c) => c.text || c.word || '').join(' ');
            const stats = countHits(captionsText, corrections);
            if (stats.totalHits > 0) {
                console.log(`[asr-name-sanitize] 命中 ${stats.totalHits} 处错别字(${corrections.length} 条规则),已校正`);
            }
            captions = sanitizeCaptions(captions, corrections);
        }
    } catch (e) {
        console.error('[asr-name-sanitize] skipped:', e.message);
    }
    const srtText = toSrt(captions);

    const brandFb = pickBrandFallback();
    // 末端 fallback 改为空字符串(此前 '本地视频字幕调试' 是开发期 placeholder,
    // _default brand 用户在 LLM 偶发失败时会看到这个)。空 headline → hideTitle 兜底,
    // 只剩品牌胶囊,用户感受比看到开发期文案好得多。
    const fbHeadline = headlineOverride || brandFb.headline || '';
    const fbSubline = sublineOverride || brandFb.subline || '';
    // 无口播视频(meaningfulChars<10 且 words<15)不调 LLM:LLM 拿到几个无意义字符
    // 会模板化输出"感谢观看 / 视频结束"。这种视频本来就没"内容标题"可言,
    // 标题置空 + 后面 hideTitle=true,只保留品牌胶囊和封面视觉。
    let metadata;
    if (skipSubtitle) {
        // skipSubtitle:用 CLI 传的 --headline/--subline 直接当 metadata,不调 LLM
        // (用户既然显式跳字幕,标题也应该自己定;effectiveText='' 让 LLM 编"感谢观看")
        metadata = { headline: fbHeadline, subline: fbSubline };
    } else if (isNoSpeech) {
        metadata = { headline: '', subline: '' };
    } else if (effectiveText && (!headlineOverride || !sublineOverride)) {
        metadata = await buildMetadata(effectiveText, fbHeadline, fbSubline, config, warnings);
    } else {
        metadata = { headline: fbHeadline, subline: fbSubline };
    }
    llmSpinner.stop(`(${captions.length} 字幕段)`);
    timeline.record('LLM 字幕/元数据', llmSpinner.elapsedMs, `${captions.length} 段`);
    const outputSuffix = previewSeconds > 0 ? '_preview.mp4' : '_burn.mp4';
    const outputLocation = path.join(caseDir, `${engine}_${stem}${outputSuffix}`);
    // 当 ZDE_PRESET_CONFIG 生效(CLI 传 --preset=douyin),让 DB config(通过 env 前置层)
    // 完全接管字号/边距等视觉字段,避免 presetStyle 硬编码的 0/150 覆盖 preset 的精确值。
    const usingPresetEnv = !!process.env.ZDE_PRESET_CONFIG;
    const effectiveStyleOptions = usingPresetEnv
        ? {
            // preset env 时,尺寸字段留空让 captionOptions 穿透,只接受 CLI 显式 --subtitle-font-size 等
            subtitleFontSize: Number.isFinite(styleOptions.subtitleFontSize) ? styleOptions.subtitleFontSize : undefined,
            subtitleMarginV: Number.isFinite(styleOptions.subtitleMarginV) ? styleOptions.subtitleMarginV : undefined,
            subtitleMarginH: Number.isFinite(styleOptions.subtitleMarginH) ? styleOptions.subtitleMarginH : undefined,
            headlineFontSize: Number.isFinite(styleOptions.headlineFontSize) ? styleOptions.headlineFontSize : undefined,
            sublineFontSize: Number.isFinite(styleOptions.sublineFontSize) ? styleOptions.sublineFontSize : undefined,
            topBandHeight: Number.isFinite(styleOptions.topBandHeight) ? styleOptions.topBandHeight : undefined
        }
        : {
            subtitleFontSize: Number.isFinite(styleOptions.subtitleFontSize) ? styleOptions.subtitleFontSize : presetStyle.subtitleFontSize,
            subtitleMarginV: Number.isFinite(styleOptions.subtitleMarginV) ? styleOptions.subtitleMarginV : presetStyle.subtitleMarginV,
            subtitleMarginH: Number.isFinite(styleOptions.subtitleMarginH) ? styleOptions.subtitleMarginH : presetStyle.subtitleMarginH,
            headlineFontSize: Number.isFinite(styleOptions.headlineFontSize) ? styleOptions.headlineFontSize : presetStyle.headlineFontSize,
            sublineFontSize: Number.isFinite(styleOptions.sublineFontSize) ? styleOptions.sublineFontSize : presetStyle.sublineFontSize,
            topBandHeight: Number.isFinite(styleOptions.topBandHeight) ? styleOptions.topBandHeight : presetStyle.topBandHeight
        };
    step += 1;
    const encodeLabel = previewSeconds > 0 ? `烧录字幕 preview (${previewSeconds}s)` : '烧录字幕';
    process.stdout.write(`[${step}/${totalSteps}] ${encodeLabel}\n`);
    const encodeStartMs = Date.now();
    const onEncodeProgress = makeProgressBar(28, { step, total: totalSteps, label: 'ffmpeg' });
    // 只 set 有值的 override 字段,避免 undefined 覆盖 captionOptions 里已有的值(常见坑)
    const burnStyleOptions = { ...effectiveCaptionOptions, sourceType: 'video' };
    // OBS 模式(--obs):顶部人脸+底部屏幕的录屏。压窄顶部品牌带、缩小标题放胶囊右侧,露出人脸。
    burnStyleOptions.obsMode = process.env.ZDE_OBS === '1';
    for (const key of ['subtitleFontSize', 'subtitleMarginV', 'subtitleMarginH', 'headlineFontSize', 'sublineFontSize', 'topBandHeight']) {
        if (effectiveStyleOptions[key] !== undefined && effectiveStyleOptions[key] !== null) {
            burnStyleOptions[key] = effectiveStyleOptions[key];
        }
    }
    if (Number.isFinite(styleOptions.subtitleMaxUnits)) {
        burnStyleOptions.subtitleMaxUnits = styleOptions.subtitleMaxUnits;
    }
    // --no-headline: 横屏或不想盖标题时,隐藏 headline/subline 绘制,品牌 tag 保留
    if (process.env.ZDE_NO_HEADLINE === '1') {
        burnStyleOptions.hideTitle = true;
    }
    // 无口播视频也强制 hideTitle:没有内容可标,只留品牌胶囊
    // 但 skipSubtitle 不应触发(用户显式跳字幕,标题应保留用户传的 --headline/--subline)
    if (isNoSpeech && !skipSubtitle) {
        burnStyleOptions.hideTitle = true;
    }
    // 品牌字段覆盖:brand 只覆盖"内容"(tag 文字和颜色),是否启用品牌带由 preset 决定
    try {
        const brand = loadBrand();
        if (brand?.visual?.brandTag) {
            burnStyleOptions.brandTagText = brand.visual.brandTag;
        }
        if (brand?.visual?.tagBgColor) burnStyleOptions.brandTagBgColor = brand.visual.tagBgColor;
        if (brand?.visual?.tagTextColor) burnStyleOptions.brandTagTextColor = brand.visual.tagTextColor;
    } catch (err) {
        console.warn('[brand] 加载失败,使用 preset/DB 默认:', err.message);
    }
    // isNoSpeech 时 metadata 已置空,封面/烧录都拿空字符串(避免 LLM 编"感谢观看"垃圾)
    // 但 skipSubtitle 不归 isNoSpeech:用户显式 --no-subtitle + 显式 --headline 时要保留
    const useNoSpeechBlank = isNoSpeech && !skipSubtitle;
    // headline/subline 长度限制:LLM 自动生成时 cap 20/40 防失控,
    // 用户显式 --headline 时(skipSubtitle 或 headlineOverride)放宽到 60/80
    // (字体会自动 fitTextFontSizeByWidth 缩小,长标题不会爆出画面)
    const headlineCap = (skipSubtitle || headlineOverride) ? 60 : 20;
    const sublineCap = (skipSubtitle || sublineOverride) ? 80 : 40;
    const finalHeadline = useNoSpeechBlank ? '' : (normalizeInlineText(metadata.headline || fbHeadline, headlineCap) || fbHeadline);
    const finalSubline = useNoSpeechBlank ? '' : (normalizeInlineText(metadata.subline || fbSubline, sublineCap) || fbSubline);
    // 空标题统一 hideTitle:防止 ffmpeg drawtext 画出 "''" 这种空占位
    if (!finalHeadline && !finalSubline) {
        burnStyleOptions.hideTitle = true;
    }
    await burnSubtitleVideo({
        inputVideoPath: effectiveVideoFile,
        outputVideoPath: outputLocation,
        captions,
        headline: finalHeadline,
        subline: finalSubline,
        styleOptions: burnStyleOptions,
        clipSeconds: previewSeconds,
        onProgress: onEncodeProgress
    });
    const encodeMs = Date.now() - encodeStartMs;
    timeline.record(encodeLabel, encodeMs, `${captions.length} 段`);

    // 自动生成统一品牌封面 jpg(和视频同目录)
    const coverPath = outputLocation.replace(/\.mp4$/i, '_cover.jpg');
    let coverReady = false;
    try {
        await generateCover({
            headline: finalHeadline,
            subline: finalSubline,
            outputPath: coverPath
        });
        coverReady = true;
        process.stdout.write(`  ✓ cover jpg -> ${path.basename(coverPath)}\n`);
    } catch (err) {
        console.warn('[cover] 生成失败(非致命):', String(err.message || err).slice(0, 120));
    }

    // Post-process: (可选)封面前置 + 末尾淡出 + CTA 尾卡 + BGM 混音
    // 竖屏(默认): cover 前置 + fadeOut + CTA + BGM
    // 横屏: 跳过 cover 前置(尺寸不匹配会黑边), 仍做 fadeOut + CTA + BGM
    const isLandscapeOutput = effectivePresetName === 'landscape';
    if (coverReady && !previewSeconds) {
        // BGM 优先级: env(CLI --bgm) > brand.bgm.defaultName > 硬兜底
        let currentBrand = null;
        try { currentBrand = loadBrand(); } catch (_) { /* ignore */ }
        const envBgmName = process.env.ZDE_BGM_NAME;
        const bgmName = (envBgmName != null && envBgmName !== '')
            ? envBgmName
            : (currentBrand?.bgm?.defaultName || '03-lofi-podcast');
        const envBgmVol = process.env.ZDE_BGM_VOLUME;
        const bgmVolume = (envBgmVol != null && envBgmVol !== '')
            ? Number(envBgmVol)
            : (Number(currentBrand?.bgm?.defaultVolume) || 0.08);
        let bgmPath = '';
        if (bgmName && bgmName !== 'none') {
            const candidate = path.resolve(process.cwd(), 'assets', 'bgm', bgmName.endsWith('.mp3') ? bgmName : `${bgmName}.mp3`);
            if (fs.existsSync(candidate)) bgmPath = candidate;
            else console.warn(`[bgm] 未找到 ${candidate},跳过 BGM 混音`);
        }
        // v0.10+ 黄金 3 秒钩子:LLM 找金句 + 从已烧字幕主视频切片 + concat 到最前
        //   触发: ZDE_GOLDEN_HOOK=1
        //   手动: ZDE_GOLDEN_START=<sec>(跳过 LLM)
        //   时长: ZDE_GOLDEN_DURATION=<sec>(默认 3.0)
        if (process.env.ZDE_GOLDEN_HOOK === '1' && !isNoSpeech && fs.existsSync(outputLocation)) {
            step += 1;
            const hookLabel = '黄金 3 秒钩子';
            process.stdout.write(`[${step}/${totalSteps}] ${hookLabel}\n`);
            const hookStartMs = Date.now();
            try {
                const { prependGoldenHook } = require('../src/video/goldenHook');
                const { probeVideoInfo } = require('../src/video/goldenHook');
                const probed = probeVideoInfo(outputLocation);
                const duration = Number(process.env.ZDE_GOLDEN_DURATION || 3.0);
                const manualStart = process.env.ZDE_GOLDEN_START ? Number(process.env.ZDE_GOLDEN_START) : null;
                const { moment } = await prependGoldenHook({
                    mainVideoPath: outputLocation,
                    words: effectiveWords,
                    fullText: effectiveText,
                    videoDuration: (probed && probed.duration) || 0,
                    targetDuration: duration,
                    manualStart,
                    options: {
                        ollamaUrl: config.ollamaUrl,
                        ollamaModel: config.ollamaModel,
                        ollamaTimeoutMs: 180000,
                        ollamaRetries: 1
                    },
                    onProgress: null
                });
                const hookMs = Date.now() - hookStartMs;
                const preview = (moment.text || '').slice(0, 40);
                const cutLabel = { sentence: '句子边界', word: 'word 边界', hard: '硬切' }[moment.truncationReason] || '直用';
                const durNote = moment.truncated
                    ? `${moment.duration.toFixed(1)}s(LLM 给 ${moment.rawDuration.toFixed(1)}s,${cutLabel})`
                    : `${moment.duration.toFixed(1)}s`;
                const typeNote = moment.type ? ` [${moment.type}]` : '';
                const note = `${moment.start.toFixed(1)}s起 · ${durNote}${typeNote} · "${preview}"`;
                process.stdout.write(`[${step}/${totalSteps}] ✓ ${hookLabel}  ${formatDuration(hookMs)}  (${note})\n`);
                if (moment.reason) process.stdout.write(`   reason: ${moment.reason}\n`);
                if (moment.truncated && moment.truncationReason !== 'sentence') {
                    process.stdout.write(`   ⚠ 未找到句子边界,用 ${cutLabel}截断 — 若钩子不完整,考虑 --golden-start <sec> 手动指定\n`);
                }
                timeline.record(hookLabel, hookMs, note);
            } catch (err) {
                console.warn(`[golden-hook] 失败(非致命,跳过):`, String(err.message || err).slice(0, 120));
                if (err.rawOutput) {
                    console.warn(`[golden-hook] LLM 原始输出末尾 200 字:\n${err.rawOutput.slice(-200)}\n`);
                }
            }
        }

        // 封面只在竖屏/方屏前置为第一帧(竖封面铺满当前画幅、自然);横屏不前置 ——
        // 竖封面塞进横屏第一帧既占用黄金前几秒(白等 ~1s)、左右虚化又显得怪。
        // 横屏的封面只单独产出 jpg(平台单独上传缩略图用),视频直接从正片开播。
        const shouldIncludeCover = !isLandscapeOutput;
        step += 1;
        const postLabel = '封面+尾卡+BGM';
        process.stdout.write(`[${step}/${totalSteps}] ${postLabel}\n`);
        const postStartMs = Date.now();
        const onPostProgress = makeProgressBar(28, { step, total: totalSteps, label: 'ffmpeg' });
        try {
            // 传入原始源码率,避免 postProcess 膨胀(burn 的 VBR 可能偏高)
            const sourceBitrateBps = (() => {
                try {
                    const { spawnSync: ss } = require('child_process');
                    const r = ss('ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', videoFile], { encoding: 'utf8', timeout: 10000 });
                    return Number(String(r.stdout || '').trim()) || 0;
                } catch (_) { return 0; }
            })();
            const targetBitrate = sourceBitrateBps > 0
                ? Math.max(1.5, Math.round(sourceBitrateBps / 1000000 * 1.5))
                : undefined;
            await attachCoverAndFadeOut({
                inputVideoPath: outputLocation,
                coverPath: shouldIncludeCover ? coverPath : '',
                includeCover: shouldIncludeCover,
                outputPath: outputLocation,
                bgmPath,
                bgmVolume,
                targetBitrate,
                onProgress: onPostProgress
            });
            const coverLabel = shouldIncludeCover ? 'cover + ' : '';
            const bgmLabel = bgmPath ? ` + bgm ${path.basename(bgmPath)} @${bgmVolume}` : '';
            const postMs = Date.now() - postStartMs;
            const note = `${coverLabel}fadeOut + cta${bgmLabel}`;
            process.stdout.write(`[${step}/${totalSteps}] ✓ ${postLabel}  ${formatDuration(postMs)}  (${note})\n`);
            timeline.record(postLabel, postMs, note);
            if (isLandscapeOutput) {
                process.stdout.write(`  · 横屏: 不前置封面,视频直接从正片开播(省黄金前几秒);封面 jpg 单独产出供平台上传\n`);
            }
        } catch (err) {
            console.warn('[postProcess] 失败(非致命):', String(err.message || err).slice(0, 120));
        }
    }

    fs.writeFileSync(path.join(caseDir, 'transcript.json'), JSON.stringify({
        engine,
        used_engine: usedEngine || '',
        used_script: usedScript || '',
        used_model: usedModel || '',
        mode: 'video',
        file: fileName,
        extracted_audio: extractedAudio,
        full_text: fullText,
        words_count: words.length,
        captions_count: captions.length,
        transcribe_ms: transcribeMs,
        stderr
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(caseDir, 'captions.json'), JSON.stringify(captions, null, 2), 'utf8');
    fs.writeFileSync(path.join(caseDir, 'captions.srt'), srtText, 'utf8');

    // Generate publish kit — 4 groups of title + description(with hashtags)
    // Skip for preview runs (they're just test renders, not final output)
    let publishPath = '';
    let publishGroups = [];
    if (previewSeconds <= 0 && effectiveText) {
        step += 1;
        const publishSpinner = new Spinner('宣发素材包 (LLM)', { step, total: totalSteps }).start();
        try {
            publishGroups = await generatePublishKit(effectiveText, headlineOverride, config);
            if (publishGroups.length > 0) {
                publishPath = writePublishMd({
                    groups: publishGroups,
                    commandHeadline: headlineOverride,
                    caseDir,
                    engine,
                    fileName,
                    captionsCount: captions.length,
                    durationSec: videoDurationSec
                });
                publishSpinner.stop(`(${publishGroups.length} 组) -> publish.md`);
                timeline.record('宣发素材包', publishSpinner.elapsedMs, `${publishGroups.length} 组`);
            } else {
                publishSpinner.fail('(无有效输出，跳过)');
                timeline.record('宣发素材包', publishSpinner.elapsedMs, '空输出');
            }
        } catch (err) {
            publishSpinner.fail(String(err.message || err).slice(0, 80));
            timeline.record('宣发素材包', publishSpinner.elapsedMs, 'failed');
        }
    }

    // 流水线耗时汇总
    process.stdout.write('\n' + timeline.summary() + '\n');

    // Save to DB so admin panel can display this entry
    let contentId = 0;
    if (previewSeconds <= 0) {
        try {
            const finalHeadline = isNoSpeech ? '' : (normalizeInlineText(metadata.headline || fbHeadline, 20) || fbHeadline);
            const finalSubline = isNoSpeech ? '' : (normalizeInlineText(metadata.subline || fbSubline, 40) || fbSubline);
            contentId = createContent({
                audioPath: extractedAudio || '',
                transcribeJsonPath: path.join(caseDir, 'transcript.json'),
                videoOutputPath: outputLocation,
                rawText: effectiveText,
                headline: finalHeadline,
                subline: finalSubline,
                publishKitJson: publishGroups.length > 0 ? JSON.stringify(publishGroups) : '[]',
                source: 'cli',
                status: 'reviewing',
                processTrace: `[CLI] engine=${engine} file=${fileName} captions=${captions.length}`
            });
        } catch (dbErr) {
            console.warn(`  [db] write failed: ${String(dbErr.message || dbErr).slice(0, 80)}`);
        }
    }

    return {
        mode: 'video',
        file: fileName,
        mp4: outputLocation,
        publish: publishPath,
        contentId,
        srt: path.join(caseDir, 'captions.srt'),
        captions: captions.length,
        words: words.length,
        transcribeMs
    };
}

async function main() {
    const args = parseArgs();
    if (args.showHelp) {
        printHelp();
        return;
    }
    // CLI video path (burn/highlights) never touches the Telegram bot, so don't
    // require TELEGRAM_BOT_TOKEN — a fresh local user shouldn't need a bot to burn.
    const config = getConfig({ requireTelegramToken: false });
    initDb(config.contentDbPath);
    ensureDefaultConfigs();
    const videoCaptionOptionsRaw = getVideoCaptionOptions(getConfigValue);
    const videoCaptionOptions = {
        ...videoCaptionOptionsRaw,
        sentenceMaxChars: Number.isFinite(args.sentenceMaxCharsArg) ? Math.max(8, Math.min(26, Math.floor(args.sentenceMaxCharsArg))) : videoCaptionOptionsRaw.sentenceMaxChars,
        sentenceMaxDuration: Number.isFinite(args.sentenceMaxDurationArg) ? Math.max(1.1, Math.min(4.5, Number(args.sentenceMaxDurationArg))) : videoCaptionOptionsRaw.sentenceMaxDuration,
        sentenceGapBreakSec: Number.isFinite(args.sentenceGapBreakSecArg) ? Math.max(0.08, Math.min(2.5, Number(args.sentenceGapBreakSecArg))) : videoCaptionOptionsRaw.sentenceGapBreakSec,
        chunkMaxChars: Number.isFinite(args.chunkMaxCharsArg) ? Math.max(6, Math.min(24, Math.floor(args.chunkMaxCharsArg))) : videoCaptionOptionsRaw.chunkMaxChars,
        subtitleOffsetMs: Number.isFinite(args.subtitleOffsetMsArg) ? Math.max(-2000, Math.min(2000, Math.round(args.subtitleOffsetMsArg))) : videoCaptionOptionsRaw.subtitleOffsetMs
    };
    // --- YouTube URL mode: download video to tmp/youtube/ then process as a regular video file ---
    if (args.youtubeUrl) {
        const youtubeDownloadDir = path.join(process.cwd(), 'tmp', 'youtube');
        console.log(`[youtube] downloading: ${args.youtubeUrl}`);
        console.log(`[youtube] destination: ${youtubeDownloadDir}`);
        const dlSpinner = new Spinner('yt-dlp download (may take a while)').start();
        let ytVideoPath = '';
        let ytInfo = {};
        try {
            const dlResult = await downloadYoutubeVideo(args.youtubeUrl, youtubeDownloadDir);
            ytVideoPath = dlResult.videoPath;
            ytInfo = dlResult.info || {};
            const sizeMb = (require('fs').statSync(ytVideoPath).size / 1024 / 1024).toFixed(1);
            dlSpinner.stop(`${sizeMb}MB${ytInfo.title ? ` | ${ytInfo.title.slice(0, 50)}` : ''}`);
        } catch (dlErr) {
            dlSpinner.fail(String(dlErr.message).slice(0, 100));
            throw dlErr;
        }

        if (ytInfo.duration && ytInfo.duration > 1800) {
            console.warn(`\n[youtube] WARNING: 视频时长 ${Math.floor(ytInfo.duration / 60)} 分钟 > 30 分钟，建议仅处理音频以避免超时`);
        }

        // Use YouTube title as headline override candidate (overridden by --headline flag)
        const headlineCandidate = args.fixedHeadline || (ytInfo.title ? ytInfo.title.slice(0, 30) : '');
        const runId = new Date().toISOString().replace(/[:.]/g, '-');
        const outputDir = path.join(process.cwd(), 'debug_outputs', 'video', runId);
        ensureDir(outputDir);
        console.log(`[youtube] engine=${args.engine} headline=${headlineCandidate || '(AI生成)'}`);
        const warnings = [];
        const startedAt = Date.now();
        try {
            const one = await renderVideoCase({
                videoFile: ytVideoPath,
                outputDir,
                engine: args.engine,
                fallbackText: args.fallbackText,
                videoCaptionOptions,
                headlineOverride: headlineCandidate,
                sublineOverride: args.fixedSubline,
                styleOptions: {
                    stylePreset: args.stylePresetArg,
                    subtitleFontSize: args.subtitleFontSizeArg,
                    subtitleMarginV: args.subtitleMarginVArg,
                    subtitleMarginH: args.subtitleMarginHArg,
                    headlineFontSize: args.headlineFontSizeArg,
                    sublineFontSize: args.sublineFontSizeArg,
                    topBandHeight: args.topBandHeightArg,
                    subtitleMaxUnits: args.subtitleMaxUnitsArg
                },
                config,
                warnings,
                previewSeconds: Number.isFinite(args.previewSecondsArg) ? Math.max(0, args.previewSecondsArg) : 0
            });
            const elapsedMs = Date.now() - startedAt;
            console.log(`\n[youtube] done in ${(elapsedMs / 1000).toFixed(1)}s`);
            console.log(`  video: ${one.mp4}`);
            if (one.publish) console.log(`  publish: ${one.publish}`);
            if (one.contentId) console.log(`  content_id: ${one.contentId}`);
        } catch (error) {
            console.error(`[youtube] failed: ${String(error.message || error).slice(0, 200)}`);
            process.exitCode = 2;
        }
        return;
    }
    // --- end YouTube URL mode ---

    const videoCases = args.videoCaseFileArg ? readVideoCaseFile(args.videoCaseFileArg) : [];
    const { audioFiles, videoFiles, caseMap } = resolveInputCollections(args, videoCases);
    if (!audioFiles.length && !videoFiles.length) {
        console.log('no audio/video files found');
        return;
    }

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(process.cwd(), 'debug_outputs', 'video', runId);
    ensureDir(outputDir);
    console.log(`[video] engine=${args.engine}`);
    console.log(`[video] recursive=${args.recursive ? '1' : '0'} concurrency=${args.concurrency} limit=${args.limit || 0}`);
    console.log(`[video] caption_style=${videoCaptionOptions.renderStyle}`);
    console.log(`[video] audio_count=${audioFiles.length} video_count=${videoFiles.length}`);

    const results = [];
    const warnings = [];
    const failures = [];
    for (const audioFile of audioFiles) {
        console.log(`\n[video][audio] start ${path.basename(audioFile)}`);
        const startedAt = Date.now();
        try {
            const one = await renderAudioCase({
                audioFile,
                outputDir,
                engine: args.engine,
                videoCaptionOptions,
                fixedHeadline: args.fixedHeadline,
                fixedSubline: args.fixedSubline,
                config,
                warnings
            });
            results.push({ ...one, elapsedMs: Date.now() - startedAt });
            console.log(`[video][audio] done ${one.file} -> ${one.mp4}`);
        } catch (error) {
            const reason = String(error.message || error);
            failures.push({ mode: 'audio', file: path.basename(audioFile), reason });
            console.log(`[video][audio] fail ${path.basename(audioFile)} -> ${reason}`);
        }
    }
    // --resume: skip videos that already completed in a previous run
    let filteredVideoFiles = videoFiles;
    if (args.resume) {
        const completedBasenames = loadCompletedPaths();
        const skipped = videoFiles.filter((f) => completedBasenames.has(path.basename(f)));
        filteredVideoFiles = videoFiles.filter((f) => !completedBasenames.has(path.basename(f)));
        if (skipped.length) {
            console.log(`\n[resume] 跳过已完成 ${skipped.length} 条，剩余 ${filteredVideoFiles.length} 条`);
            skipped.forEach((f) => console.log(`  ✓ 已跳过: ${path.basename(f)}`));
        } else {
            console.log('[resume] 未找到已完成记录，全量运行');
        }
    }
    const queue = filteredVideoFiles.slice();
    const totalVideos = filteredVideoFiles.length;
    let videoIndex = 0;
    if (args.concurrency > 1 && ['mlx', 'mlx_hq', 'qwen3'].includes(args.engine)) {
        console.warn(`\n⚠️  WARNING: --concurrency=${args.concurrency} with ${args.engine} — MLX/GPU 引擎单卡串行,并发会互拖甚至卡死(实测 iTerm 冻死)`);
        console.warn(`   Recommended: --concurrency=1(同机只跑一个 MLX/GPU 任务)`);
    }
    const workerCount = Math.max(1, Math.min(args.concurrency, queue.length || 1));
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) {
        workers.push((async () => {
            while (queue.length) {
                const videoFile = queue.shift();
                if (!videoFile) break;
                const thisIdx = ++videoIndex;
                console.log(`\n${'─'.repeat(50)}`);
                console.log(`[${thisIdx}/${totalVideos}] ${path.basename(videoFile)}`);
                checkMemory(args.engine);
                const startedAt = Date.now();
                const matchedCase = caseMap.get(toAbsPath(videoFile));
                try {
                    const one = await renderVideoCase({
                        videoFile,
                        outputDir,
                        engine: args.engine,
                        fallbackText: matchedCase?.fallbackText || args.fallbackText,
                        videoCaptionOptions,
                        headlineOverride: matchedCase?.headline || args.fixedHeadline,
                        sublineOverride: matchedCase?.subline || args.fixedSubline,
                        styleOptions: {
                            stylePreset: args.stylePresetArg,
                            subtitleFontSize: args.subtitleFontSizeArg,
                            subtitleMarginV: args.subtitleMarginVArg,
                            subtitleMarginH: args.subtitleMarginHArg,
                            headlineFontSize: args.headlineFontSizeArg,
                            sublineFontSize: args.sublineFontSizeArg,
                            topBandHeight: args.topBandHeightArg,
                            subtitleMaxUnits: args.subtitleMaxUnitsArg
                        },
                        config,
                        warnings,
                        previewSeconds: Number.isFinite(args.previewSecondsArg) ? Math.max(0, args.previewSecondsArg) : 0
                    });
                    const elapsedMs = Date.now() - startedAt;
                    results.push({ ...one, elapsedMs });
                    console.log(`  ✓ done in ${(elapsedMs / 1000).toFixed(1)}s -> ${path.basename(one.mp4)}`);
                } catch (error) {
                    const reason = String(error.message || error);
                    failures.push({ mode: 'video', file: path.basename(videoFile), reason });
                    console.log(`  ✗ failed: ${reason.slice(0, 120)}`);
                }
            }
        })());
    }
    await Promise.all(workers);

    const summaryPath = path.join(outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        runId,
        engine: args.engine,
        caption_style: videoCaptionOptions.renderStyle,
        audio_count: audioFiles.length,
        video_count: videoFiles.length,
        success_count: results.length,
        failure_count: failures.length,
        warnings: warnings.filter(Boolean),
        failures,
        results
    }, null, 2), 'utf8');
    console.log('\nvideo cases completed');
    console.log(`output: ${outputDir}`);
    console.log(`summary: ${summaryPath}`);
    if (failures.length) process.exitCode = 2;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
