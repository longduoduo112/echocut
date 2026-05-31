'use strict';

/**
 * clip-video.js — 长视频智能切片 CLI
 *
 * Usage:
 *   node scripts/clip-video.js \
 *     --video-file='/path/to/long-video.mp4' \
 *     --engine=mlx_hq \
 *     --segments=4 \
 *     --style-preset=vertical \
 *     --output-dir=debug_outputs/clips/
 *
 * Options:
 *   --video-file=<path>        源视频（必填）
 *   --engine=auto|mlx_hq|...  转写引擎（默认 auto）
 *   --segments=4               目标切片数量（2-8，默认 4）
 *   --style-preset=vertical|landscape|square|safe
 *   --output-dir=<path>        输出目录（默认 debug_outputs/clips/<runId>）
 *   --yes                      跳过确认，直接执行
 *   --no-publish-kit           跳过宣发素材包生成
 *   --sentence-max-chars=<n>   字幕每行最大字符数
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { Spinner, makeProgressBar, checkMemory } = require('../src/lib/cliUtils');
const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs, getConfigValue } = require('../src/db/configRepo');
const { transcribeByEngine } = require('../src/video/asrAdapters');
const { buildRobustCaptions, toSrt, applyFillerRemoval } = require('../src/video/captionUtils');
const { getVideoCaptionOptions } = require('../src/video/captionConfig');
const {
    ensureDir,
    burnSubtitleVideo,
    extractAudioFromVideo,
    probeVideoDuration
} = require('../src/video/remotionRunner');
const { generatePublishKit, stripHallucinatedLoop, correctCaptions, extractEmphasisKeywords } = require('../src/services/processor');
const { segmentTranscript, clipVideo } = require('../src/services/clipper');
const { cutFillersFromVideo } = require('../src/video/fillerCutter');

// ─── Arg parsing ────────────────────────────────────────────────────────────

function resolveArg(name) {
    const match = process.argv.find((x) => x.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : '';
}

function asPositiveInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.floor(n));
}

function asFiniteNumber(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function toAbsPath(rawPath) {
    if (!rawPath) return '';
    return path.resolve(process.cwd(), rawPath);
}

function parseArgs() {
    return {
        showHelp: process.argv.includes('--help') || process.argv.includes('-h'),
        videoFile: toAbsPath(resolveArg('--video-file')),
        engine: resolveArg('--engine') || 'auto',
        segments: asPositiveInt(resolveArg('--segments'), 4),
        stylePreset: String(resolveArg('--style-preset') || '').trim().toLowerCase(),
        outputDir: resolveArg('--output-dir'),
        yes: process.argv.includes('--yes'),
        noPublishKit: process.argv.includes('--no-publish-kit'),
        sentenceMaxChars: asFiniteNumber(resolveArg('--sentence-max-chars')),
        chunkMaxChars: asFiniteNumber(resolveArg('--chunk-max-chars'))
    };
}

// ─── Style preset (mirrors run-video-cases.js) ───────────────────────────────

function resolveStylePreset(name) {
    if (name === 'landscape') {
        return { subtitleFontSize: 150, subtitleMarginV: 0, subtitleMarginH: 44, headlineFontSize: 58, sublineFontSize: 34, sentenceMaxChars: 20 };
    }
    if (name === 'vertical') {
        return { subtitleFontSize: 150, subtitleMarginV: 0, subtitleMarginH: 40, headlineFontSize: 52, sublineFontSize: 32, topBandHeight: 270, sentenceMaxChars: 12 };
    }
    if (name === 'square') {
        return { subtitleFontSize: 150, subtitleMarginV: 0, subtitleMarginH: 40, headlineFontSize: 54, sublineFontSize: 32, topBandHeight: 250, sentenceMaxChars: 14 };
    }
    if (name === 'safe') {
        return { subtitleFontSize: 150, subtitleMarginV: 0, subtitleMarginH: 52, headlineFontSize: 48, sublineFontSize: 30, topBandHeight: 240, sentenceMaxChars: 14 };
    }
    return {};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHINESE_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function timeStr(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function writePublishMd(groups, clipDir, seg, engine, fileName) {
    if (!groups || !groups.length) return '';
    const dateStr = new Date().toISOString().slice(0, 10);
    const durStr = `${timeStr(seg.start)} → ${timeStr(seg.end)}`;
    const lines = [
        '# 宣发素材包',
        '',
        `> 源视频：${fileName}  |  片段：${durStr}  |  主题：${seg.theme}  |  引擎：${engine}  |  生成：${dateStr}`,
        `> 已烧录标题：**${seg.headline}**`,
        '',
        '---',
        ''
    ];
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
    const outPath = path.join(clipDir, 'publish.md');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    return outPath;
}

async function askConfirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (ans) => {
            rl.close();
            resolve(String(ans).trim().toLowerCase());
        });
    });
}

function printHelp() {
    console.log([
        'Usage: node scripts/clip-video.js [options]',
        '',
        '--video-file=<path>         源视频（必填）',
        '--engine=auto|mlx_hq|mlx|funasr|sensevoice|whisperx',
        '--segments=4                目标切片数量（2-8，默认 4）',
        '--style-preset=vertical|landscape|square|safe',
        '--output-dir=<path>         输出目录（默认 debug_outputs/clips/<runId>）',
        '--yes                       跳过确认，直接执行',
        '--no-publish-kit            跳过宣发素材包生成',
        '--sentence-max-chars=<n>    字幕每行最大字符数',
        '--chunk-max-chars=<n>       字幕块最大字符数',
        '',
        '示例:',
        '  node scripts/clip-video.js --video-file=/path/vlog.mp4 --engine=mlx_hq --segments=4 --style-preset=vertical',
        '  node scripts/clip-video.js --video-file=/path/talk.mp4 --engine=funasr --segments=3 --style-preset=landscape --yes'
    ].join('\n'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();

    if (args.showHelp) {
        printHelp();
        return;
    }

    if (!args.videoFile || !fs.existsSync(args.videoFile)) {
        console.error(`错误：--video-file 不存在或未指定: ${args.videoFile || '(空)'}`);
        process.exit(1);
    }

    // Init config & DB (no Telegram token required for CLI)
    const config = getConfig({ requireTelegramToken: false });
    initDb(config.contentDbPath);
    ensureDefaultConfigs();

    const videoCaptionOptionsRaw = getVideoCaptionOptions(getConfigValue);
    const presetStyle = resolveStylePreset(args.stylePreset);
    const videoCaptionOptions = {
        ...videoCaptionOptionsRaw,
        sentenceMaxChars: Number.isFinite(args.sentenceMaxChars)
            ? Math.max(8, Math.min(26, Math.floor(args.sentenceMaxChars)))
            : (Number.isFinite(presetStyle.sentenceMaxChars) ? presetStyle.sentenceMaxChars : videoCaptionOptionsRaw.sentenceMaxChars),
        chunkMaxChars: Number.isFinite(args.chunkMaxChars)
            ? Math.max(6, Math.min(24, Math.floor(args.chunkMaxChars)))
            : videoCaptionOptionsRaw.chunkMaxChars
    };

    const fileName = path.basename(args.videoFile);
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = args.outputDir
        ? toAbsPath(args.outputDir)
        : path.join(process.cwd(), 'debug_outputs', 'clips', runId);
    ensureDir(outputDir);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[clip-video] 源文件: ${fileName}`);
    console.log(`[clip-video] 引擎: ${args.engine}  目标切片: ${args.segments}  预设: ${args.stylePreset || 'auto'}`);
    console.log(`[clip-video] 输出目录: ${outputDir}`);
    console.log('─'.repeat(60));

    // ── Step 1: Extract audio ────────────────────────────────────────────────
    let spinner = new Spinner('提取音轨').start();
    let extractedAudio;
    let videoDuration = 0;
    try {
        extractedAudio = await extractAudioFromVideo(args.videoFile, `clip_${runId}`);
        videoDuration = probeVideoDuration(args.videoFile);
        spinner.stop(videoDuration > 0 ? `(${Math.round(videoDuration)}s)` : '');
    } catch (err) {
        spinner.fail(err.message);
        process.exit(1);
    }

    // ── Step 2: Transcribe ───────────────────────────────────────────────────
    checkMemory(args.engine);
    spinner = new Spinner(`转写 [${args.engine}]`).start();
    let transcribeResult;
    try {
        transcribeResult = await transcribeByEngine(extractedAudio, args.engine);
        spinner.stop(`(${transcribeResult.words.length} words, ${transcribeResult.usedEngine || args.engine})`);
    } catch (err) {
        spinner.fail(err.message);
        process.exit(1);
    }

    const { words: rawWords, payload, fullText: rawFullText } = transcribeResult;
    const fullText = stripHallucinatedLoop(String(rawFullText || '').trim());

    if (!fullText) {
        console.error('[clip-video] 转写内容为空，无法继续');
        process.exit(1);
    }

    // ── Step 2.5: (可选) 视频轨道级 filler 切除 ──────────────────────────────
    let effectiveVideoFile = args.videoFile;
    let words = rawWords;
    let effectiveFullText = fullText;
    let cutReport = null;
    const cutSilenceEnabled = process.env.ZDE_CUT_SILENCE === '1';
    const silenceThreshold = Number(process.env.ZDE_SILENCE_THRESHOLD || '2.5');
    if (process.env.ZDE_CUT_FILLERS === '1' || cutSilenceEnabled) {
        const label = cutSilenceEnabled && process.env.ZDE_CUT_FILLERS === '1'
            ? 'cut fillers + silence'
            : cutSilenceEnabled ? 'cut silence' : 'cut fillers';
        const cutSpinner = new Spinner(label).start();
        try {
            const result = await cutFillersFromVideo({
                inputVideoPath: args.videoFile,
                words: rawWords,
                fillerWords: videoCaptionOptions.fillerWords || [],
                outputDir,
                stem: `clip_source_${runId}`,
                options: {
                    cutFillersEnabled: process.env.ZDE_CUT_FILLERS === '1',
                    cutSilence: cutSilenceEnabled,
                    silenceThreshold
                }
            });
            if (result.skipped) {
                cutSpinner.stop('(no hits)');
            } else {
                effectiveVideoFile = result.trimmedVideoPath;
                words = result.adjustedWords;
                cutReport = result;
                effectiveFullText = words
                    .map((w) => String(w.word ?? '').trim())
                    .filter(Boolean)
                    .join('')
                    .replace(/\s+/g, '');
                const beforeSec = result.durationBefore.toFixed(1);
                const afterSec = result.durationAfter.toFixed(1);
                const parts = [];
                if (result.fillerSpanCount) parts.push(`${result.fillerSpanCount} fillers`);
                if (result.silenceSpanCount) parts.push(`${result.silenceSpanCount} silences`);
                cutSpinner.stop(`${result.cuts.length} cuts (${parts.join(' + ')}), ${beforeSec}s → ${afterSec}s`);
            }
        } catch (err) {
            cutSpinner.fail();
            throw err;
        }
    }

    // ── Step 2.6: LLM 动态爆点词发现 ──────────────────────────────────────
    if (process.env.ZDE_EMPHASIS_OFF !== '1' && effectiveFullText.length >= 50) {
        const eSpinner = new Spinner('discover emphasis').start();
        try {
            const llmKeywords = await extractEmphasisKeywords(effectiveFullText, config);
            if (llmKeywords && llmKeywords.length) {
                const base = Array.isArray(videoCaptionOptions.emphasisWords) ? videoCaptionOptions.emphasisWords : [];
                const merged = [...new Set([...llmKeywords, ...base])];
                videoCaptionOptions.emphasisWords = merged;
                eSpinner.stop(`(${llmKeywords.length} llm + ${base.length} preset → ${merged.length})`);
            } else {
                eSpinner.stop('(LLM 返回空,沿用 preset)');
            }
        } catch (err) {
            eSpinner.fail();
            console.error('[emphasis] 跳过:', err.message || err);
        }
    }

    // ── Step 3: LLM segment analysis ────────────────────────────────────────
    spinner = new Spinner(`LLM 分析切片方案 (目标 ${args.segments} 段)`).start();
    let segments;
    try {
        segments = await segmentTranscript(effectiveFullText, words, {
            ...config,
            segments: args.segments
        });
        spinner.stop(`(${segments.length} 段)`);
    } catch (err) {
        spinner.fail(err.message);
        process.exit(1);
    }

    // ── Step 4: Print plan & confirm ─────────────────────────────────────────
    console.log('\n切片方案:');
    console.log('─'.repeat(60));
    for (const seg of segments) {
        console.log(`  [${seg.index}] ${timeStr(seg.start)} → ${timeStr(seg.end)}  (${(seg.end - seg.start).toFixed(0)}s)`);
        console.log(`      主题: ${seg.theme}`);
        console.log(`      标题: ${seg.headline}`);
        console.log(`      副标题: ${seg.subline}`);
        console.log('');
    }
    console.log('─'.repeat(60));

    if (!args.yes) {
        const ans = await askConfirm('确认执行切片？(y/n, 默认 y): ');
        if (ans && ans !== 'y' && ans !== 'yes') {
            console.log('已取消');
            return;
        }
    }

    // ── Step 5: Clip + burn subtitles ────────────────────────────────────────
    console.log('\n开始切片 + 烧录字幕...');

    // 如果 CLI 传入 ZDE_PRESET_CONFIG(douyin 等视觉预设),让 DB config
    // (通过 env 前置层)完全接管字号/描边/颜色等视觉字段,不被硬编码的
    // resolveStylePreset 尺寸覆盖。否则保持旧行为。
    const usingVisualPresetEnv = !!process.env.ZDE_PRESET_CONFIG;
    const styleOptions = usingVisualPresetEnv
        ? { sourceType: 'video' }
        : { ...presetStyle, sourceType: 'video' };

    // 如果已经做了 cut-fillers,字幕级 filler removal 要 skip 避免重复
    const clipFillerRemoval = cutReport
        ? (captions) => captions
        : (captions, fillerWords) => applyFillerRemoval(captions, fillerWords);

    const results = await clipVideo(
        effectiveVideoFile,
        segments,
        outputDir,
        videoCaptionOptions,
        styleOptions,
        words,
        (payloadArg, text, opts) => buildRobustCaptions(payloadArg, text, opts),
        clipFillerRemoval,
        burnSubtitleVideo,
        makeProgressBar
    );

    // ── Step 6: Generate publish kits ────────────────────────────────────────
    const publishResults = [];
    if (!args.noPublishKit) {
        console.log('\n生成宣发素材包...');
        for (const result of results) {
            const seg = segments.find((s) => s.index === result.index);
            if (!seg) continue;

            const segText = words
                .filter((w) => {
                    const ws = Number(w.start ?? w.startSec ?? 0);
                    return ws >= seg.start && ws <= seg.end;
                })
                .map((w) => String(w.word ?? w.text ?? '').trim())
                .join('');

            if (!segText) { publishResults.push({ index: result.index, publishPath: '' }); continue; }

            const pubSpinner = new Spinner(`宣发素材包 [${result.index}] ${seg.theme}`).start();
            try {
                const groups = await generatePublishKit(segText, result.headline, config);
                if (groups.length > 0) {
                    const clipDir = path.dirname(result.outputPath);
                    const publishPath = writePublishMd(groups, clipDir, seg, args.engine, fileName);
                    publishResults.push({ index: result.index, publishPath, groups });
                    pubSpinner.stop(`(${groups.length} 组) -> ${path.basename(publishPath)}`);
                } else {
                    pubSpinner.fail('(无有效输出，跳过)');
                    publishResults.push({ index: result.index, publishPath: '' });
                }
            } catch (err) {
                pubSpinner.fail(String(err.message || err).slice(0, 80));
                publishResults.push({ index: result.index, publishPath: '' });
            }
        }
    }

    // ── Step 7: SRT files per clip ───────────────────────────────────────────
    for (const result of results) {
        const seg = segments.find((s) => s.index === result.index);
        if (!seg) continue;
        const { filterWordsForSegment: filterFn } = require('../src/services/clipper');
        const segWords = filterFn(words, seg.start, seg.end);
        const segText = segWords.map((w) => w.word).join('');
        const rawCaptions = buildRobustCaptions({ words: segWords }, segText, videoCaptionOptions);
        const captions = applyFillerRemoval(rawCaptions, videoCaptionOptions.fillerWords || []);
        const srtText = toSrt(captions);
        const srtPath = result.outputPath.replace(/\.mp4$/, '.srt');
        fs.writeFileSync(srtPath, srtText, 'utf8');
    }

    // ── Step 8: Summary ──────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`[clip-video] 完成！${results.length} 条视频`);
    console.log('─'.repeat(60));
    for (const r of results) {
        const seg = segments.find((s) => s.index === r.index);
        const pub = publishResults.find((p) => p.index === r.index);
        console.log(`\n  [${r.index}] ${r.theme}`);
        console.log(`  标题: ${r.headline}`);
        console.log(`  时长: ${timeStr(r.start)} → ${timeStr(r.end)}  (${r.duration.toFixed(0)}s)`);
        console.log(`  视频: ${r.outputPath}`);
        if (pub && pub.publishPath) console.log(`  宣发: ${pub.publishPath}`);
    }
    console.log('\n' + '─'.repeat(60));

    // Write summary JSON
    const summaryPath = path.join(outputDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        sourceVideo: args.videoFile,
        engine: args.engine,
        totalDuration: videoDuration,
        segments: results.map((r) => {
            const pub = publishResults.find((p) => p.index === r.index);
            return {
                ...r,
                publishPath: pub ? pub.publishPath : ''
            };
        })
    }, null, 2), 'utf8');
    console.log(`\n  summary: ${summaryPath}`);
}

main().catch((err) => {
    console.error('\n[clip-video] 致命错误:', err.message || err);
    process.exit(1);
});
