const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 去除标点/空白以便词典精确匹配。whisper 经常输出 "对吧?" / "嗯," 这种带标点形式。
function normalizeWordText(raw) {
    return String(raw || '')
        .trim()
        .replace(/[,.。!?、;:""''「」『』()《》【】\s·—…]/g, '');
}

// 把配置里的 filler 词典解析为干净的数组,并按长度降序(长词优先命中)。
function parseFillerList(raw) {
    if (!Array.isArray(raw) && !raw) return [];
    const arr = Array.isArray(raw)
        ? raw
        : String(raw).split(/[\n,，、;|]/g);
    return arr
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i)
        .sort((a, b) => b.length - a.length);
}

// 在 ASR 词级数组上滑动窗口查找 filler:
// 单 word 精确匹配不够,"对吧" 常被拆成 "对"/"吧",需要合并相邻 k 个 word 拼字符串去比对。
function findFillerSpans(words, fillerWords, options = {}) {
    const maxLookahead = Math.max(1, options.maxLookahead || 6);
    const fillers = parseFillerList(fillerWords);
    if (!fillers.length || !Array.isArray(words) || !words.length) return [];

    const maxFillerChars = Math.max(...fillers.map((f) => f.length));
    const taken = new Array(words.length).fill(false);
    const spans = [];

    for (let i = 0; i < words.length; i += 1) {
        if (taken[i]) continue;
        let combined = '';
        let bestHit = '';
        let bestJ = -1;
        // 扫到 maxLookahead 或 combined 超出最大 filler 长度,记录所有命中,取最长的
        for (let j = i; j < words.length && j - i < maxLookahead; j += 1) {
            combined += normalizeWordText(words[j].word);
            if (!combined) break;
            if (combined.length > maxFillerChars) break;
            const hit = fillers.find((f) => combined === f);
            if (hit && hit.length > bestHit.length) {
                bestHit = hit;
                bestJ = j;
            }
        }
        if (bestHit) {
            const wStart = Number(words[i].start);
            const wEnd = Number(words[bestJ].end);
            if (Number.isFinite(wStart) && Number.isFinite(wEnd) && wEnd > wStart) {
                spans.push({
                    startIdx: i,
                    endIdx: bestJ,
                    start: wStart,
                    end: wEnd,
                    word: bestHit
                });
                for (let k = i; k <= bestJ; k += 1) taken[k] = true;
            }
        }
    }
    return spans;
}

// 检测相邻 word 之间 > threshold 的静默段(口播思考空档)
// 用 ASR words 时间戳的 gap,比 ffmpeg silencedetect 更准(whisper 已有词级时间)
function findSilenceSpans(words, options = {}) {
    const threshold = Math.max(0.8, Number(options.silenceThreshold) || 2.5);
    const padding = Number.isFinite(options.silencePadding) ? options.silencePadding : 0.3;
    if (!Array.isArray(words) || words.length < 2) return [];
    const spans = [];
    for (let i = 0; i < words.length - 1; i += 1) {
        const endA = Number(words[i].end ?? words[i].endSec ?? 0);
        const startB = Number(words[i + 1].start ?? words[i + 1].startSec ?? 0);
        if (!Number.isFinite(endA) || !Number.isFinite(startB)) continue;
        const gap = startB - endA;
        if (gap >= threshold) {
            // 保留前后 padding 秒作自然过渡,只切中间
            const start = endA + padding;
            const end = startB - padding;
            if (end > start) {
                spans.push({
                    startIdx: i,
                    endIdx: i + 1,
                    start,
                    end,
                    word: `[silence ${gap.toFixed(1)}s]`
                });
            }
        }
    }
    return spans;
}

// 把原始 spans 扩 padding + 合并过近的相邻 span + 过滤过短段
function buildCutIntervals(spans, options = {}) {
    const padding = Number.isFinite(options.padding) ? options.padding : 0.05;
    const minGap = Number.isFinite(options.minGap) ? options.minGap : 0.15;
    const minDuration = Number.isFinite(options.minDuration) ? options.minDuration : 0.12;
    if (!Array.isArray(spans) || !spans.length) return [];

    const padded = spans
        .map((s) => ({
            start: Math.max(0, s.start - padding),
            end: s.end + padding,
            reason: s.word
        }))
        .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const cut of padded) {
        const last = merged[merged.length - 1];
        if (last && cut.start <= last.end + minGap) {
            last.end = Math.max(last.end, cut.end);
            last.reason = `${last.reason}+${cut.reason}`;
        } else {
            merged.push({ ...cut });
        }
    }
    return merged.filter((c) => c.end - c.start >= minDuration);
}

// 由 cut intervals 反推出要保留的段:[0..cut1.start, cut1.end..cut2.start, ...]
function computeKeepIntervals(totalDuration, cuts) {
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];
    const result = [];
    let cursor = 0;
    for (const cut of (cuts || [])) {
        const cutStart = Math.max(0, Number(cut.start) || 0);
        const cutEnd = Math.min(totalDuration, Number(cut.end) || 0);
        if (cutEnd <= cursor) continue;
        if (cutStart > cursor) {
            result.push({ start: cursor, end: cutStart });
        }
        cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < totalDuration) {
        result.push({ start: cursor, end: totalDuration });
    }
    return result.filter((iv) => iv.end - iv.start > 0.08);
}

// 把 words 数组按 cut intervals 的累积偏移平移到"切除后"时间轴;
// 完全落在 cut 内的 word 丢弃,跨 cut 边界的 word 也丢弃(安全起见)
function applyFillerCutsToWords(words, cuts) {
    if (!Array.isArray(words) || !words.length) return [];
    if (!Array.isArray(cuts) || !cuts.length) return words.slice();
    const sortedCuts = cuts.slice().sort((a, b) => a.start - b.start);
    const result = [];
    for (const w of words) {
        const wStart = Number(w.start);
        const wEnd = Number(w.end);
        if (!Number.isFinite(wStart) || !Number.isFinite(wEnd)) continue;
        let offset = 0;
        let dropped = false;
        for (const cut of sortedCuts) {
            if (wEnd <= cut.start) break;
            if (wStart >= cut.end) {
                offset += cut.end - cut.start;
                continue;
            }
            // 有重叠 → 丢弃
            dropped = true;
            break;
        }
        if (!dropped) {
            result.push({
                ...w,
                start: Math.max(0, wStart - offset),
                end: Math.max(0, wEnd - offset)
            });
        }
    }
    return result;
}

// 构造 ffmpeg filter_complex 参数,用 trim+atrim+concat 保留 keepIntervals 段
function buildTrimConcatArgs(inputPath, keepIntervals, outputPath) {
    if (!Array.isArray(keepIntervals) || !keepIntervals.length) {
        throw new Error('buildTrimConcatArgs: keepIntervals 不能为空');
    }
    const parts = [];
    keepIntervals.forEach((iv, i) => {
        // fps=30 强制恒定帧率,防止 trim 关键帧对齐导致视频段时长偏差;
        // aresample=async=1000 让音频自动重同步,消除累积偏移(字幕漂移根因)
        parts.push(`[0:v]trim=${iv.start.toFixed(3)}:${iv.end.toFixed(3)},setpts=PTS-STARTPTS,fps=30[v${i}]`);
        parts.push(`[0:a]atrim=${iv.start.toFixed(3)}:${iv.end.toFixed(3)},asetpts=PTS-STARTPTS,aresample=async=1000[a${i}]`);
    });
    const concatInputs = keepIntervals.map((_, i) => `[v${i}][a${i}]`).join('');
    parts.push(`${concatInputs}concat=n=${keepIntervals.length}:v=1:a=1[outv][outa]`);
    const filterComplex = parts.join(';');
    return [
        '-y',
        '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
    ];
}

// 调用 ffprobe 拿视频时长(秒)
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

// 顶层编排:给定原视频 + words + fillerWords → 输出切除 filler + 静默段的新视频 + 平移后的 words
//   options.cutSilence=true 时启用静默段切除(> silenceThreshold 秒的思考空档)
//   options.cutFillersEnabled=false 时跳过词语级切除(默认 true 兼容旧行为)
//   返回 { trimmedVideoPath, adjustedWords, cuts, keepIntervals, durationBefore, durationAfter, fillerSpanCount, silenceSpanCount }
async function cutFillersFromVideo({ inputVideoPath, words, fillerWords, outputDir, stem, options = {}, onProgress = null }) {
    const duration = probeVideoDurationSec(inputVideoPath);
    if (!duration) throw new Error(`ffprobe 无法获取 duration: ${inputVideoPath}`);

    const cutFillersEnabled = options.cutFillersEnabled !== false;
    const fillerSpans = cutFillersEnabled ? findFillerSpans(words, fillerWords, options) : [];
    const silenceSpans = options.cutSilence ? findSilenceSpans(words, options) : [];
    const allSpans = [...fillerSpans, ...silenceSpans];
    const cuts = buildCutIntervals(allSpans, options);
    if (!cuts.length) {
        return {
            trimmedVideoPath: inputVideoPath,
            adjustedWords: words,
            cuts: [],
            keepIntervals: [],
            durationBefore: duration,
            durationAfter: duration,
            skipped: true
        };
    }

    const keepIntervals = computeKeepIntervals(duration, cuts);
    if (!keepIntervals.length) {
        return {
            trimmedVideoPath: inputVideoPath,
            adjustedWords: words,
            cuts: [],
            keepIntervals: [],
            durationBefore: duration,
            durationAfter: duration,
            skipped: true
        };
    }

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const trimmedVideoPath = path.join(outputDir, `${stem}_cutfillers.mp4`);
    const args = buildTrimConcatArgs(inputVideoPath, keepIntervals, trimmedVideoPath);

    const timeoutMs = Math.max(60000, Number(options.ffmpegTimeoutMs || 600000));
    const started = Date.now();
    // ffmpeg 的 time= 进度是以**输出时间线**为参考的,keep 段总时长就是输出时长
    // keepIntervals 是 [{start, end}, ...] 对象数组
    const outputDurationSec = keepIntervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
    const { runFfmpegWithProgress } = require('../lib/ffmpegProgress');
    try {
        await runFfmpegWithProgress(args, {
            durationSec: outputDurationSec,
            onProgress,
            timeoutMs
        });
    } catch (err) {
        throw new Error(`ffmpeg trim+concat 失败: ${err.message}`);
    }

    const durationAfter = probeVideoDurationSec(trimmedVideoPath);
    const adjustedWords = applyFillerCutsToWords(words, cuts);

    return {
        trimmedVideoPath,
        adjustedWords,
        cuts,
        keepIntervals,
        durationBefore: duration,
        durationAfter: durationAfter || duration,
        fillerSpanCount: fillerSpans.length,
        silenceSpanCount: silenceSpans.length,
        elapsedMs: Date.now() - started,
        skipped: false
    };
}

module.exports = {
    normalizeWordText,
    parseFillerList,
    findFillerSpans,
    findSilenceSpans,
    buildCutIntervals,
    computeKeepIntervals,
    applyFillerCutsToWords,
    buildTrimConcatArgs,
    probeVideoDurationSec,
    cutFillersFromVideo
};
