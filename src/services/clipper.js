'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { callChat } = require('./processor');
const { generateCover } = require('../video/coverGenerator');
const { attachCoverAndFadeOut } = require('../video/postProcess');

const execFileAsync = promisify(execFile);

// ─── LLM Segment Analysis ────────────────────────────────────────────────────

const SEGMENT_SYSTEM_PROMPT = `你是一位专业的短视频剪辑策划。
你的任务是分析一段长视频的完整转写文本，找出其中最有价值、最适合单独发布的精华片段。

选段标准:
1. 内容完整,有开头有结尾,逻辑自洽,不从句子中间开始
2. 有强烈的情绪/冲突/洞察/笑点/干货密度
3. 适合在抖音/视频号等短视频平台独立传播
4. **不同段的主题必须差异明显,分布在视频的不同时间段**,不要集中在开头

输出要求(严格 JSON,不含 markdown 标记):
[
  {
    "index": 1,
    "start_anchor": "(段开头 10-16 字的原文连续片段,必须是转写中真实存在的连续原话)",
    "end_anchor": "(段结尾 10-16 字的原文连续片段)",
    "theme": "(内容主题,10字内)",
    "headline": "(吸引眼球的标题,15字内)",
    "subline": "(补充说明副标题,20字内)"
  }
]

**关键**: start_anchor / end_anchor 必须是转写文本里**连续出现的原话**,
不能是拼凑或缩写,长度 10-16 字以便唯一定位。
每段时长 60-180 秒。`;

/**
 * 调用 LLM 分析转写文本，找出 3-5 个精华片段
 * @param {string} fullText - 完整转写文本
 * @param {Array<{word:string,start:number,end:number}>} words - 词级时间戳数组
 * @param {{segments?:number, ollamaUrl:string, ollamaModel:string}} options
 * @returns {Promise<Array<{index:number,start:number,end:number,theme:string,headline:string,subline:string}>>}
 */
async function segmentTranscript(fullText, words, options) {
    const targetSegments = Math.max(2, Math.min(8, Number(options.segments || 4)));
    const truncatedText = String(fullText || '').slice(0, 6000);
    if (!truncatedText.trim()) throw new Error('[clipper] fullText is empty');

    const userMsg = `请从以下转写文本中找出 ${targetSegments} 个最精华的片段，返回 JSON 数组：\n\n${truncatedText}`;

    const rawResponse = await callChat(options, [
        { role: 'system', content: SEGMENT_SYSTEM_PROMPT },
        { role: 'user', content: userMsg }
    ]);

    let rawSegments;
    try {
        const cleaned = String(rawResponse || '').replace(/```json/g, '').replace(/```/g, '').trim();
        rawSegments = JSON.parse(cleaned);
        if (!Array.isArray(rawSegments)) throw new Error('not an array');
    } catch (e) {
        throw new Error(`[clipper] LLM 返回 JSON 解析失败: ${e.message}\nraw: ${String(rawResponse || '').slice(0, 300)}`);
    }

    // Map start_anchor/end_anchor to timestamps via char-offset on normalized fullText
    // 先把 words 平铺成不含标点/空白的连续字符串,并预计算每个 word 对应的 [charStart, charEnd]
    const normalizePunct = (s) => String(s || '').replace(/[,.。!?、;:""''「」『』()（）《》【】\s·—…]/g, '');
    const wordCharRanges = [];
    let flatText = '';
    for (let i = 0; i < words.length; i += 1) {
        const raw = String(words[i].word ?? words[i].text ?? '').trim();
        const norm = normalizePunct(raw);
        const start = flatText.length;
        flatText += norm;
        wordCharRanges.push({ start, end: flatText.length, wordIdx: i });
    }
    const charOffsetToWordIdx = (offset) => {
        if (!wordCharRanges.length) return -1;
        if (offset <= 0) return 0;
        for (let i = 0; i < wordCharRanges.length; i += 1) {
            if (offset < wordCharRanges[i].end) return i;
        }
        return wordCharRanges.length - 1;
    };

    // Fuzzy 子串匹配:当严格 indexOf 失败,从 anchor 里取任意连续 w 字符 (6→3) 子串搜索
    // LLM 经常"美化"或"改写" anchor,这个兜底让定位不失败
    const fuzzyFindOffset = (anchor, fromOffset) => {
        for (let w = 6; w >= 3; w -= 1) {
            if (anchor.length < w) continue;
            for (let s = 0; s + w <= anchor.length; s += 1) {
                const substr = anchor.slice(s, s + w);
                const hit = flatText.indexOf(substr, fromOffset);
                if (hit >= 0) return { offset: hit, matched: substr };
            }
        }
        return null;
    };

    // 视频总时长(用最后一个 word 的 end 估算)
    const lastWord = words[words.length - 1] || {};
    const totalDurationApprox = Number(lastWord.end ?? lastWord.endSec ?? 0);
    // 根据时间秒数找最近的 word index -> char offset(用于 per-seg 时间兜底)
    const timeToCharOffset = (targetSec) => {
        for (let wi = 0; wi < words.length; wi += 1) {
            const wStart = Number(words[wi].start ?? words[wi].startSec ?? 0);
            if (wStart >= targetSec) return (wordCharRanges[wi] && wordCharRanges[wi].start) || 0;
        }
        return 0;
    };

    const segments = [];
    let lastEndCharOffset = 0;
    for (let segIdx = 0; segIdx < rawSegments.length; segIdx += 1) {
        const seg = rawSegments[segIdx];
        // 兼容新旧字段名
        const startAnchorRaw = String(seg.start_anchor || seg.start_word || '').trim();
        const endAnchorRaw = String(seg.end_anchor || seg.end_word || '').trim();
        if (!startAnchorRaw || !endAnchorRaw) continue;
        const startAnchor = normalizePunct(startAnchorRaw);
        const endAnchor = normalizePunct(endAnchorRaw);
        if (!startAnchor || !endAnchor) continue;

        // 从上一段结束后的 char offset 之后开始搜索,保证段之间时间递增
        let startCharOffset = flatText.indexOf(startAnchor, lastEndCharOffset);
        if (startCharOffset < 0) {
            const fuzzy = fuzzyFindOffset(startAnchor, lastEndCharOffset);
            if (fuzzy) {
                console.warn(`[clipper] 片段 ${seg.index} fuzzy "${fuzzy.matched}" 定位 start`);
                startCharOffset = fuzzy.offset;
            }
        }
        // Fallback 3: 时间均分兜底(LLM anchor 完全虚构时)
        if (startCharOffset < 0 && totalDurationApprox >= 60) {
            const estStartTime = totalDurationApprox * 0.08 + segIdx * (totalDurationApprox * 0.84 / rawSegments.length);
            startCharOffset = timeToCharOffset(estStartTime);
            console.warn(`[clipper] 片段 ${seg.index} 用时间均分兜底 start=${estStartTime.toFixed(1)}s`);
        }
        if (startCharOffset < 0) {
            console.warn(`[clipper] 片段 ${seg.index} start_anchor "${startAnchorRaw.slice(0, 20)}" 所有 fallback 失败,跳过`);
            continue;
        }
        const endSearchFrom = startCharOffset + startAnchor.length;
        let endCharHit = flatText.indexOf(endAnchor, endSearchFrom);
        // Fallback 1: 用 end_anchor 前 6 字做 loose 匹配
        if (endCharHit < 0 && endAnchor.length >= 6) {
            endCharHit = flatText.indexOf(endAnchor.slice(0, 6), endSearchFrom);
        }
        // Fallback 1.5: fuzzy 子串匹配
        if (endCharHit < 0) {
            const fuzzy = fuzzyFindOffset(endAnchor, endSearchFrom);
            if (fuzzy) endCharHit = fuzzy.offset;
        }
        const startIdx = charOffsetToWordIdx(startCharOffset);
        let endIdx;
        if (endCharHit < 0) {
            // Fallback 2: end 定位失败,用 start_word + 90s 时长兜底
            console.warn(`[clipper] 片段 ${seg.index} end_anchor 未找到,用 start + 90s 兜底`);
            const startTime = Number(words[startIdx].start ?? words[startIdx].startSec ?? 0);
            const fallbackEndTime = startTime + 90;
            let idx = startIdx;
            while (idx < words.length - 1) {
                const wEnd = Number(words[idx + 1].end ?? words[idx + 1].endSec ?? words[idx + 1].start ?? 0);
                if (wEnd >= fallbackEndTime) break;
                idx += 1;
            }
            endIdx = idx;
            lastEndCharOffset = (wordCharRanges[endIdx] && wordCharRanges[endIdx].end) || lastEndCharOffset;
        } else {
            const endCharOffset = endCharHit + endAnchor.length - 1;
            endIdx = charOffsetToWordIdx(endCharOffset);
            lastEndCharOffset = endCharHit + endAnchor.length;
        }

        if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
            console.warn(`[clipper] 无法映射片段 ${seg.index}: start="${startAnchor}" end="${endAnchor}",跳过`);
            continue;
        }

        const rawStart = Number(words[startIdx].start ?? words[startIdx].startSec ?? 0);
        const rawEnd = Number(words[endIdx].end ?? words[endIdx].endSec ?? words[endIdx].start ?? rawStart);

        // Apply 1s buffer on each side
        let segStart = Math.max(0, rawStart - 1);
        let segEnd = rawEnd + 1;
        let duration = segEnd - segStart;

        // 时长 < 45s 时自动扩展到 60s(质量优先,不丢弃精华片段)
        if (duration < 45) {
            const extendedEnd = segStart + 60;
            console.warn(`[clipper] 片段 ${seg.index} 时长 ${duration.toFixed(1)}s < 45s,扩展到 60s`);
            segEnd = extendedEnd;
            duration = segEnd - segStart;
        }
        if (duration > 180) {
            console.warn(`[clipper] 片段 ${seg.index} 时长 ${duration.toFixed(1)}s > 180s，截断`);
        }

        const clampedEnd = Math.min(segEnd, segStart + 180);

        segments.push({
            index: Number(seg.index || segments.length + 1),
            start: segStart,
            end: clampedEnd,
            theme: String(seg.theme || ''),
            headline: String(seg.headline || '精华片段'),
            subline: String(seg.subline || '')
        });
    }

    // 最后兜底:如果所有 anchor 都定位失败,用时间均分产出段(标题用 LLM 给的)
    if (segments.length === 0 && rawSegments.length > 0) {
        console.warn('[clipper] 所有 anchor 定位失败,用时间均分兜底');
        const lastWord = words[words.length - 1] || {};
        const totalDuration = Number(lastWord.end ?? lastWord.endSec ?? 0);
        if (totalDuration < 60) {
            throw new Error('[clipper] LLM 未能映射,且视频过短(<60s),无法均分兜底');
        }
        // 留 10% 开头和结尾作为 buffer,剩下 80% 均分给 N 段
        const usableStart = totalDuration * 0.08;
        const usableEnd = totalDuration * 0.92;
        const segDuration = (usableEnd - usableStart) / rawSegments.length;
        // 每段不超过 120s 也不少于 60s
        const clampedSegDuration = Math.max(60, Math.min(120, segDuration));
        for (let i = 0; i < rawSegments.length; i += 1) {
            const seg = rawSegments[i];
            const start = usableStart + i * segDuration;
            const end = Math.min(totalDuration, start + clampedSegDuration);
            if (end - start < 30) continue;
            segments.push({
                index: Number(seg.index || i + 1),
                start,
                end,
                theme: String(seg.theme || ''),
                headline: String(seg.headline || '精华片段'),
                subline: String(seg.subline || '')
            });
        }
    }

    if (segments.length === 0) {
        throw new Error('[clipper] LLM 未能映射出任何有效片段，请检查转写质量');
    }

    // 段时间多样性检查:两段 start 间隔 < 30s 视为重叠/重复,丢弃后者
    const unique = [];
    const minStartGap = 30;
    for (const seg of segments) {
        const tooClose = unique.some((u) => Math.abs(u.start - seg.start) < minStartGap);
        if (tooClose) {
            console.warn(`[clipper] 片段 ${seg.index} start=${seg.start.toFixed(1)}s 与已有段过近,丢弃`);
            continue;
        }
        unique.push(seg);
    }
    return unique;
}

// 在 words 数组里用滑动窗口拼接,精确查找 anchor(8-16 字的原文片段)
// 返回第一个匹配位置的 startIdx。找不到返回 -1。
function findWordIndex(words, anchor, fromIdx = 0) {
    const target = String(anchor || '').trim().replace(/\s+/g, '');
    if (!target || target.length < 2) return -1;
    const maxWindow = Math.min(20, target.length + 6);
    for (let i = Math.max(0, fromIdx); i < words.length; i += 1) {
        let combined = '';
        for (let j = i; j < words.length && j - i < maxWindow; j += 1) {
            const w = String(words[j].word ?? words[j].text ?? '').trim().replace(/\s+/g, '');
            combined += w;
            if (!combined) break;
            if (combined.length >= target.length) {
                if (combined.startsWith(target) || target.startsWith(combined.slice(0, target.length))) {
                    return i;
                }
                // 容错:去除常见标点后再比
                const norm = combined.replace(/[,。!?、;:""''()（）《》\s]/g, '');
                if (norm.startsWith(target) || norm === target) return i;
                break; // 长度够但不匹配,跳到下一个 i
            }
        }
    }
    // Fallback: 找 anchor 的前 4 字(如果 ≥4 字)作为 loose match
    if (target.length >= 4) {
        const loose = target.slice(0, 4);
        for (let i = Math.max(0, fromIdx); i < words.length; i += 1) {
            let combined = '';
            for (let j = i; j < words.length && j - i < 6; j += 1) {
                combined += String(words[j].word ?? words[j].text ?? '').trim().replace(/\s+/g, '');
                if (combined.length >= 4 && combined.startsWith(loose)) return i;
                if (combined.length >= 4) break;
            }
        }
    }
    return -1;
}

// 向前查找版本 — 对称,从 afterIdx 之后开始
function findWordIndexReverse(words, anchor, afterIdx = 0) {
    return findWordIndex(words, anchor, afterIdx);
}

// ─── FFmpeg Clip ─────────────────────────────────────────────────────────────

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function getFfmpegTimeoutMs(defaultMs) {
    const n = Number(process.env.FFMPEG_TIMEOUT_MS || defaultMs);
    return Number.isFinite(n) && n > 0 ? Math.max(15000, Math.floor(n)) : defaultMs;
}

function getExecFileOptions(timeoutMs) {
    return { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' };
}

/**
 * 用 FFmpeg 按时间戳裁剪视频片段（快速 stream copy 模式）
 * @param {string} inputPath
 * @param {number} start - 秒
 * @param {number} end - 秒
 * @param {string} outputPath
 */
async function ffmpegClip(inputPath, start, end, outputPath) {
    const timeout = getFfmpegTimeoutMs(15 * 60 * 1000);
    // 精确 seek + 重编码:不能用 -c copy,否则 -ss 会对齐到最近 keyframe
    // 造成起点偏差 1-3 秒,字幕时间戳和画面严重不同步。
    // 质量优先:用 h264_videotoolbox 硬编,失败 fallback libx264。
    const baseArgs = [
        '-y',
        '-ss', String(start),
        '-to', String(end),
        '-i', inputPath,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero'
    ];
    const hwArgs = ['-c:v', 'h264_videotoolbox', '-b:v', '10M'];
    const swArgs = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];
    try {
        await execFileAsync('ffmpeg', [...baseArgs, ...hwArgs, outputPath], getExecFileOptions(timeout));
    } catch (err) {
        console.warn('[clipper] h264_videotoolbox 失败,fallback libx264:', String(err.message || '').slice(0, 100));
        await execFileAsync('ffmpeg', [...baseArgs, ...swArgs, outputPath], getExecFileOptions(timeout));
    }
    if (!fs.existsSync(outputPath)) {
        throw new Error(`[clipper] FFmpeg 裁剪失败，输出文件不存在: ${outputPath}`);
    }
}

/**
 * 从完整 words 数组中按时间范围过滤，并调整时间戳为相对于片段起点
 * @param {Array} words
 * @param {number} segStart
 * @param {number} segEnd
 * @returns {Array<{word:string,start:number,end:number}>}
 */
function filterWordsForSegment(words, segStart, segEnd) {
    return words
        .filter((w) => {
            const wStart = Number(w.start ?? w.startSec ?? 0);
            const wEnd = Number(w.end ?? w.endSec ?? wStart);
            return wStart >= segStart && wEnd <= segEnd;
        })
        .map((w) => ({
            word: String(w.word ?? w.text ?? '').trim(),
            start: Math.max(0, Number(w.start ?? w.startSec ?? 0) - segStart),
            end: Math.max(0, Number(w.end ?? w.endSec ?? w.start ?? 0) - segStart)
        }))
        .filter((w) => w.word);
}

/**
 * 裁剪长视频为多个片段，每段独立烧录字幕
 *
 * @param {string} videoPath - 源视频绝对路径
 * @param {Array<{index,start,end,headline,subline}>} segments
 * @param {string} outputDir - 输出目录（绝对路径）
 * @param {object} captionOptions - 来自 captionConfig.getVideoCaptionOptions
 * @param {object} styleOptions - 来自 resolveStylePreset 合并覆盖
 * @param {Array} words - 全量词级时间戳
 * @param {Function} buildRobustCaptionsFn - captionUtils.buildRobustCaptions
 * @param {Function} applyFillerRemovalFn - captionUtils.applyFillerRemoval
 * @param {Function} burnSubtitleVideoFn - remotionRunner.burnSubtitleVideo
 * @param {Function} makeProgressBarFn - cliUtils.makeProgressBar
 * @returns {Promise<Array<{index,outputPath,headline,subline,theme,start,end,duration,words}>>}
 */
async function clipVideo(videoPath, segments, outputDir, captionOptions, styleOptions, words, buildRobustCaptionsFn, applyFillerRemovalFn, burnSubtitleVideoFn, makeProgressBarFn) {
    ensureDir(outputDir);

    const tmpClipDir = path.join(process.cwd(), 'tmp', 'video_clips');
    ensureDir(tmpClipDir);

    // 拿到母片真实 duration,用于夹紧 seg.end 不超界
    let sourceDuration = 0;
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
            { encoding: 'utf8' }
        ).trim();
        sourceDuration = Number(out) || 0;
    } catch (_) { /* 不可得时不夹紧 */ }

    const results = [];

    for (const seg of segments) {
        // 夹紧 end 不超过母片 duration(seg 扩展 +60 或 +90 时可能超界导致切片异常)
        if (sourceDuration > 0 && seg.end > sourceDuration) {
            seg.end = sourceDuration;
        }
        if (seg.end - seg.start < 10) {
            console.warn(`[clipper] 片段 ${seg.index} 夹紧后时长 ${(seg.end - seg.start).toFixed(1)}s < 10s,跳过`);
            continue;
        }
        const idx = seg.index;
        const segLabel = `seg${String(idx).padStart(2, '0')}`;
        const rawClipPath = path.join(tmpClipDir, `clip_${Date.now()}_${segLabel}.mp4`);
        const outputPath = path.join(outputDir, `${segLabel}_${sanitizeFilename(seg.headline)}.mp4`);

        process.stdout.write(`\n  [${idx}/${segments.length}] ${seg.theme} | ${seg.headline}\n`);
        process.stdout.write(`  ${timeStr(seg.start)} → ${timeStr(seg.end)} (${(seg.end - seg.start).toFixed(0)}s)\n`);

        // Step 1: FFmpeg clip
        process.stdout.write('  FFmpeg clip...\n');
        await ffmpegClip(videoPath, seg.start, seg.end, rawClipPath);

        // Step 2: Build captions from filtered words
        const segWords = filterWordsForSegment(words, seg.start, seg.end);
        const segFullText = segWords.map((w) => w.word).join('');
        const rawCaptions = buildRobustCaptionsFn({ words: segWords }, segFullText, captionOptions);
        const captions = applyFillerRemovalFn(rawCaptions, captionOptions.fillerWords || []);

        // Step 3: Burn subtitle
        process.stdout.write(`  encode (${captions.length} captions)...\n`);
        const onProgress = makeProgressBarFn ? makeProgressBarFn(28) : null;
        await burnSubtitleVideoFn({
            inputVideoPath: rawClipPath,
            outputVideoPath: outputPath,
            captions,
            headline: seg.headline,
            subline: seg.subline,
            styleOptions: {
                ...captionOptions,
                ...styleOptions,
                sourceType: 'video'
            },
            clipSeconds: 0,
            onProgress
        });

        // Cleanup temp clip
        try { fs.unlinkSync(rawClipPath); } catch (_) {}

        // 自动生成统一品牌封面 jpg
        const coverPath = outputPath.replace(/\.mp4$/i, '_cover.jpg');
        let coverReady = false;
        try {
            await generateCover({
                headline: seg.headline,
                subline: seg.subline,
                outputPath: coverPath
            });
            coverReady = true;
        } catch (err) {
            console.warn(`[cover] seg${idx} 封面生成失败:`, String(err.message || err).slice(0, 80));
        }

        // v0.10+ 黄金 3 秒钩子:在 postProcess 前注入
        //   seg 内部的 words 时间戳是全片时间,但 outputPath 已经是 seg clip(时长 = seg.end-seg.start)。
        //   要让 LLM 在 seg clip 的相对时间线里找金句,先把 segWords 的时间戳"归零"。
        if (process.env.ZDE_GOLDEN_HOOK === '1' && segWords.length > 0 && fs.existsSync(outputPath)) {
            try {
                const { prependGoldenHook, probeVideoInfo } = require('../video/goldenHook');
                const probed = probeVideoInfo(outputPath);
                // 归零时间戳(seg 开头作为 clip 的 0 点)
                const zeroBase = segWords[0].start || 0;
                const relWords = segWords.map((w) => ({
                    word: w.word || w.text || '',
                    start: Math.max(0, (Number(w.start) || 0) - zeroBase),
                    end: Math.max(0, (Number(w.end) || 0) - zeroBase)
                }));
                const duration = Number(process.env.ZDE_GOLDEN_DURATION || 3.0);
                const manualStart = process.env.ZDE_GOLDEN_START ? Number(process.env.ZDE_GOLDEN_START) : null;
                const { moment } = await prependGoldenHook({
                    mainVideoPath: outputPath,
                    words: relWords,
                    fullText: segFullText,
                    videoDuration: (probed && probed.duration) || (seg.end - seg.start),
                    targetDuration: duration,
                    manualStart,
                    options: {
                        ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
                        ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:9b',
                        ollamaTimeoutMs: 180000,
                        ollamaRetries: 1
                    }
                });
                console.log(`  ✓ 黄金钩子  seg${idx}  ${moment.start.toFixed(1)}-${moment.end.toFixed(1)}s  "${(moment.text || '').slice(0, 30)}"`);
            } catch (err) {
                console.warn(`[golden-hook] seg${idx} 失败(跳过,非致命):`, String(err.message || err).slice(0, 100));
            }
        }

        // Post-process: 封面作为第一帧 + 末尾淡出 + CTA 尾卡 + BGM 混音
        if (coverReady) {
            const bgmName = process.env.ZDE_BGM_NAME;
            const bgmVolume = Number(process.env.ZDE_BGM_VOLUME || '0.15');
            let bgmPath = '';
            if (bgmName && bgmName !== 'none') {
                const candidate = path.resolve(process.cwd(), 'assets', 'bgm', bgmName.endsWith('.mp3') ? bgmName : `${bgmName}.mp3`);
                if (fs.existsSync(candidate)) bgmPath = candidate;
            }
            try {
                await attachCoverAndFadeOut({
                    inputVideoPath: outputPath,
                    coverPath,
                    outputPath,
                    bgmPath,
                    bgmVolume
                });
            } catch (err) {
                console.warn(`[postProcess] seg${idx} 失败:`, String(err.message || err).slice(0, 80));
            }
        }

        results.push({
            index: idx,
            outputPath,
            coverPath: fs.existsSync(coverPath) ? coverPath : '',
            headline: seg.headline,
            subline: seg.subline,
            theme: seg.theme,
            start: seg.start,
            end: seg.end,
            duration: seg.end - seg.start,
            wordsCount: segWords.length,
            captionsCount: captions.length
        });

        process.stdout.write(`  -> ${outputPath}\n`);
    }

    return results;
}

function sanitizeFilename(text) {
    return String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9\-_]/g, '_').slice(0, 30) || 'clip';
}

function timeStr(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// ─── V2: 自适应数量 + 质量评分(highlights ls/make 两阶段命令用) ──────────────────

const SEGMENT_SYSTEM_PROMPT_V2 = `你是一位顶级的短视频剪辑策划师。

【任务】给你一段长视频的完整转写,找出其中所有【可作为独立短视频发布】的精华片段。
**必须至少返回 3 个候选**,除非视频总长 < 2 分钟或完全没有可用内容。

【🔥 每段必须是【完整叙事弧】(核心质量门槛,最重要)】
每个候选必须包含以下三个部分,缺一不可:
1. **背景/场景**(前 5-15 秒):点明地点/人物/时间,让观众 2 秒内知道"在哪、谁、干什么"
   - 例:"我跟我妻子在泰国曼谷打车那次..."而不是从"有一次打车"开始
2. **核心故事或观察**(中段):具体事件/观察/观点本身
3. **升华或结论**(最后 10-20 秒):"这让我..."/"所以..."/"这就是为什么..."/"核心是..."
   - 没有升华段的故事 = 有头没尾,**坚决不要切出来**

【❌ 严禁的切法(用户反馈过的真实问题)】
- 只切到故事开头,后面的观点/启发被扔掉 → 典型"有头没尾"
- 看到"然后他就..."(故事还在进行中)就把 end_anchor 放那里 → 腰斩
- end_anchor 选在过渡句(比如"对吧?")而不是真正的句子结束
- 切出来的片段让观众看完不知道"在哪、谁、为什么重要" → 上下文缺失

【切片参数】
- 时长 60-480 秒(2-8 分钟),**宁长勿短**,完整比短更重要
- 一个 20 分钟视频通常能切出 3-6 段(不要强凑,但也别漏掉好内容)
- 如果一段故事自然讲了 6 分钟,就整段作为一个候选

【品质评分 0-1】
- 0.9+: 完整叙事弧 + 反常识结论,单发爆款
- 0.8-0.9: 完整故事 + 温度感升华
- 0.7-0.8: 完整观察/建议,有头有尾
- 0.5-0.7: 可发但力度一般
- < 0.5: 不完整或价值低,**不要放进候选**

【严禁】
- 返回空 candidates 数组(除非视频 < 2 分钟)
- 只给 reasoning 不给 candidates

【句子边界】
start_anchor = 完整句子的**开头**(不是半句话中间)
end_anchor = 完整句子的**结尾**(最好以"。！？"结尾,且在升华句之后)

【suggested_subline 特殊要求(让观众一眼知道情境)】
18 字内必须交代场景(地点/人物/情境),不能只是抽象描述:
  ✓ "泰国曼谷残障司机的尊严经济学"(有地点+有核心)
  ✓ "小国夹缝,李光耀的平衡术"(有人物+有核心)
  ✗ "商业的温度"(太抽象,观众不知道在说啥)
  ✗ "令人深思的故事"(废话,观众不知道故事在哪里)

【输出(严格 JSON,**不含** markdown 代码块标记)】
{
  "reasoning": "说明切了 N 段的理由,每段为什么是完整叙事弧",
  "candidates": [
    {
      "start_anchor": "片段开头 10-16 字**原文连续**片段(转写里真实出现的原话)",
      "end_anchor": "片段结尾 10-16 字**原文连续**片段(必须在升华段之后)",
      "title": "≤12 字有张力的片段名",
      "tags": ["标签1", "标签2", "标签3"],
      "hook_type": "反常识|故事|实用|观点|提问|地理见闻",
      "quality_score": 0.8,
      "value_note": "30 字内:为什么值得单发",
      "context_note": "15 字内:场景/地点/人物(给观众的背景信息)",
      "narrative_arc": "简述背景→故事→升华三段结构",
      "suggested_headline": "≤10 字,营销标题",
      "suggested_subline": "≤18 字,必须含场景/地点"
    }
  ]
}

**关键提醒**: start_anchor / end_anchor 必须是转写里**连续出现的原话**,便于精确定位。
至少 3 个候选,每段必须是完整叙事弧。`;

async function segmentTranscriptV2(fullText, words, options) {
    const maxChars = Math.max(6000, Math.min(24000, Number(options.maxTextChars || 18000)));
    const truncatedText = String(fullText || '').slice(0, maxChars);
    if (!truncatedText.trim()) throw new Error('[clipper v2] fullText is empty');

    const durationSec = Array.isArray(words) && words.length
        ? Math.max(0, Number(words[words.length - 1].end) || 0)
        : 0;
    const durationMin = (durationSec / 60).toFixed(1);
    const userMsg = `完整转写(${durationMin} 分钟,${truncatedText.length} 字):\n\n${truncatedText}`;

    const rawResponse = await callChat(options, [
        { role: 'system', content: SEGMENT_SYSTEM_PROMPT_V2 },
        { role: 'user', content: userMsg }
    ]);

    let parsed;
    try {
        const cleaned = String(rawResponse || '').replace(/```json/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`[clipper v2] LLM JSON 解析失败: ${e.message}\nraw: ${String(rawResponse || '').slice(0, 300)}`);
    }
    if (!parsed || !Array.isArray(parsed.candidates)) {
        throw new Error(`[clipper v2] LLM 返回缺 candidates 数组: ${JSON.stringify(parsed).slice(0, 300)}`);
    }

    // 用 v1 同款 anchor 定位逻辑(复用现有三层 fallback,不改)
    const normalizePunct = (s) => String(s || '').replace(/[,.。!?、;:""''「」『』()（）《》【】\s·—…]/g, '');
    const wordCharRanges = [];
    let flatText = '';
    for (let i = 0; i < words.length; i += 1) {
        const raw = String(words[i].word ?? words[i].text ?? '').trim();
        const norm = normalizePunct(raw);
        const start = flatText.length;
        flatText += norm;
        wordCharRanges.push({ start, end: flatText.length, wordIdx: i });
    }
    const charOffsetToWordIdx = (offset) => {
        for (const range of wordCharRanges) {
            if (offset >= range.start && offset < range.end) return range.wordIdx;
        }
        return -1;
    };
    const fuzzyFindOffset = (anchor, fromOffset) => {
        for (let w = 6; w >= 3; w -= 1) {
            if (anchor.length < w) continue;
            for (let s = 0; s + w <= anchor.length; s += 1) {
                const substr = anchor.slice(s, s + w);
                const found = flatText.indexOf(substr, fromOffset);
                if (found >= 0) return found;
            }
        }
        return -1;
    };

    const candidates = [];
    let searchCursor = 0;
    for (let i = 0; i < parsed.candidates.length; i += 1) {
        const c = parsed.candidates[i];
        const startAnchor = normalizePunct(String(c.start_anchor || '').trim());
        const endAnchor = normalizePunct(String(c.end_anchor || '').trim());
        if (!startAnchor || !endAnchor) continue;

        let startOffset = flatText.indexOf(startAnchor, searchCursor);
        if (startOffset < 0) startOffset = fuzzyFindOffset(startAnchor, searchCursor);
        if (startOffset < 0) {
            // 最后 fallback: 按总数均分,给出等分时间段
            const totalDur = durationSec || 60;
            const estSegDur = Math.max(60, totalDur / parsed.candidates.length);
            const startSec = (i * estSegDur) % totalDur;
            candidates.push({
                id: `seg-${String(i + 1).padStart(2, '0')}`,
                title: String(c.title || `片段 ${i + 1}`).slice(0, 20),
                start: startSec,
                end: Math.min(totalDur, startSec + Math.min(180, estSegDur)),
                duration: Math.min(180, estSegDur),
                tags: Array.isArray(c.tags) ? c.tags.slice(0, 5) : [],
                hook_type: String(c.hook_type || '').slice(0, 12),
                quality_score: Math.max(0, Math.min(1, Number(c.quality_score) || 0.6)),
                value_note: String(c.value_note || '').slice(0, 80),
                suggested_headline: String(c.suggested_headline || c.title || '').slice(0, 20),
                suggested_subline: String(c.suggested_subline || '').slice(0, 40),
                start_anchor: String(c.start_anchor || ''),
                end_anchor: String(c.end_anchor || ''),
                text_preview: '',
                locate_method: 'fallback_even_split'
            });
            continue;
        }

        let endOffset = flatText.indexOf(endAnchor, startOffset + startAnchor.length);
        if (endOffset < 0) endOffset = fuzzyFindOffset(endAnchor, startOffset + startAnchor.length);
        if (endOffset < 0) {
            endOffset = Math.min(flatText.length, startOffset + 600);  // 默认 600 字
        }
        const endOffsetClose = endOffset + endAnchor.length;

        let startWordIdx = charOffsetToWordIdx(startOffset);
        let endWordIdx = charOffsetToWordIdx(Math.min(endOffsetClose, flatText.length - 1));
        if (startWordIdx < 0 || endWordIdx < 0 || endWordIdx <= startWordIdx) continue;

        // 句子边界对齐:确保切片从完整句子开始、到完整句子结束
        // LLM 的 anchor 经常落在半句话中间,向前/向后扩展到最近的句尾标点
        const SENTENCE_END_RE = /[。！？.!?]/;
        // 向前找句首:最多回看 15 个 word
        for (let back = 1; back <= 15 && startWordIdx - back >= 0; back += 1) {
            const prevWord = String(words[startWordIdx - back].word ?? words[startWordIdx - back].text ?? '');
            if (SENTENCE_END_RE.test(prevWord)) {
                startWordIdx = startWordIdx - back + 1;
                break;
            }
        }
        // 向后找句尾:最多前看 30 个 word(放宽原来的 15,避免切太紧)
        for (let fwd = 0; fwd <= 30 && endWordIdx + fwd < words.length; fwd += 1) {
            const w = String(words[endWordIdx + fwd].word ?? words[endWordIdx + fwd].text ?? '');
            if (SENTENCE_END_RE.test(w)) {
                endWordIdx = endWordIdx + fwd;
                break;
            }
        }
        // 升华段探测 v2.4:MLX HQ 中文转写经常完全无标点(整段只是 word 序列),
        // 所以不能靠 "。！？" 分句。改用 **词间停顿 ≥ 0.35s 或 ≥ 20 字** 作为软分句,
        // 向后扫 90 秒,找到**最后一个含升华词的"呼吸句"**延伸到那里。
        // 这解决:残障司机故事后"所以我就会觉得说商业这些平台带给人们的好处对吧非常大
        // ...作为一个真正为社会创造价值..."这 80+ 秒升华段被丢弃的问题。
        const endTimeNow = Number(words[endWordIdx].end) || 0;
        const LOOKAHEAD_SEC = 90;
        const SUBLIMATION_RE = /所以|因此|这就是|这让|这给|这种|这样|核心是|本质|归根|总之|其实|最终|真的是|我认为|多么|应该|至于|这意味|这恰恰|反过来|言之|你会发|这正是|那么从|我就会|我就觉|这样你就/;
        const MIN_PAUSE_SEC = 0.35;
        const MAX_SENT_CHARS = 40;
        let charBuf = '';
        let lastEndTime = endTimeNow;
        let tentativeSentences = [];
        for (let look = 1; look <= 300 && endWordIdx + look < words.length; look += 1) {
            const w = words[endWordIdx + look];
            const wStart = Number(w.start) || 0;
            const wEnd = Number(w.end) || 0;
            if (wStart - endTimeNow > LOOKAHEAD_SEC) break;
            const text = String(w.word ?? w.text ?? '');
            const gapFromPrev = wStart - lastEndTime;
            // 软分句:遇到停顿(>0.35s) 或 累积够长(>40字) 或 标点
            const isStrongPunct = /[。！？.!?]/.test(text);
            const isSoftBoundary = (gapFromPrev >= MIN_PAUSE_SEC && charBuf.length >= 8) || charBuf.length >= MAX_SENT_CHARS;
            charBuf += text;
            if (isStrongPunct || isSoftBoundary) {
                tentativeSentences.push({ text: charBuf, lastWordIdx: endWordIdx + look });
                charBuf = '';
            }
            lastEndTime = wEnd;
        }
        // 找最后一个含升华词的句子,延伸到那里(不 break,覆盖连续多句升华)
        let extendedEnd = endWordIdx;
        for (const sent of tentativeSentences) {
            if (SUBLIMATION_RE.test(sent.text)) {
                extendedEnd = sent.lastWordIdx;
            }
        }
        if (extendedEnd > endWordIdx) {
            endWordIdx = extendedEnd;
        }

        let startSec = Number(words[startWordIdx].start) || 0;
        let endSec = Number(words[endWordIdx].end) || 0;
        // 前后各留 0.3s 呼吸(避免 ffmpeg 精确切片时切到音节)
        startSec = Math.max(0, startSec - 0.3);
        endSec = endSec + 0.4;
        // 时长软约束:< 30s 丢弃(太短没内容),> 900s 截断到 900s(保留完整弧的前 15 分钟)
        if (endSec - startSec < 30) {
            console.warn(`[clipper v2] 候选 ${i + 1} 太短 ${(endSec - startSec).toFixed(1)}s,跳过`);
            continue;
        }
        if (endSec - startSec > 900) {
            console.warn(`[clipper v2] 候选 ${i + 1} 过长 ${(endSec - startSec).toFixed(1)}s,截断到 900s`);
            endSec = startSec + 900;
            // 重新找最近句尾避免切到半句话
            const targetTime = endSec;
            for (let k = 0; k < words.length; k += 1) {
                const wEnd = Number(words[k].end) || 0;
                if (wEnd >= targetTime) {
                    for (let fwd = 0; fwd < 20 && k + fwd < words.length; fwd += 1) {
                        const w = String(words[k + fwd].word ?? words[k + fwd].text ?? '');
                        if (/[。！？.!?]/.test(w)) {
                            endWordIdx = k + fwd;
                            endSec = Number(words[endWordIdx].end) || endSec;
                            break;
                        }
                    }
                    break;
                }
            }
        }

        const previewWords = words.slice(startWordIdx, Math.min(endWordIdx + 1, startWordIdx + 40));
        const textPreview = previewWords.map((w) => String(w.word ?? w.text ?? '')).join('').slice(0, 120);

        candidates.push({
            id: `seg-${String(candidates.length + 1).padStart(2, '0')}`,
            title: String(c.title || `片段 ${i + 1}`).slice(0, 20),
            start: startSec,
            end: endSec,
            duration: endSec - startSec,
            tags: Array.isArray(c.tags) ? c.tags.slice(0, 5) : [],
            hook_type: String(c.hook_type || '').slice(0, 12),
            quality_score: Math.max(0, Math.min(1, Number(c.quality_score) || 0.6)),
            value_note: String(c.value_note || '').slice(0, 80),
            context_note: String(c.context_note || '').slice(0, 30),
            narrative_arc: String(c.narrative_arc || '').slice(0, 120),
            suggested_headline: String(c.suggested_headline || c.title || '').slice(0, 20),
            suggested_subline: String(c.suggested_subline || '').slice(0, 40),
            start_anchor: String(c.start_anchor || ''),
            end_anchor: String(c.end_anchor || ''),
            text_preview: textPreview,
            locate_method: 'anchor_exact'
        });
        searchCursor = endOffsetClose;
    }

    // 时间多样性检查:两段 start 间隔 < 30s 视为重叠/重复
    const unique = [];
    const minStartGap = 30;
    for (const seg of candidates) {
        const tooClose = unique.some((u) => Math.abs(u.start - seg.start) < minStartGap);
        if (tooClose) continue;
        unique.push(seg);
    }

    return {
        reasoning: String(parsed.reasoning || '').slice(0, 300),
        candidates: unique
    };
}

module.exports = { segmentTranscript, segmentTranscriptV2, clipVideo, filterWordsForSegment };
