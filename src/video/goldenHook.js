'use strict';

/**
 * 黄金 3 秒钩子 (Golden Hook)
 *
 * 短视频核心理论:前 3 秒决定完播率。做法:
 *   1. LLM 从 transcript 里找"最炸的一句话"(2-5 秒,独立可读,反常识/金句)
 *   2. 从**已烧字幕的主视频**里精确切出这段(字幕/画面/人声都是现成的)
 *   3. concat 到主视频最前面(字幕时间戳复位从 0 开始,无偏移问题)
 *   4. 交给 postProcess,BGM 会自然覆盖整个时长(包括钩子段)
 *
 * 关键点:
 *   - 从 main.mp4(已烧字幕)切,不是源视频 — 免去字幕重烧
 *   - 精确 seek = 输入端 -ss + 输出端 -ss(两阶段)
 *   - concat 用 filter(重编码),不用 demuxer(避免关键帧对不齐)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runFfmpegWithProgress } = require('../lib/ffmpegProgress');

// ───────────────────────────── LLM 找金句 ─────────────────────────────

/**
 * 让 LLM 从 transcript 里找最炸的一句话作为前 3 秒钩子。
 *
 * @param {object} params
 * @param {Array<{start,end,word}>} params.words - ASR word-level 时间戳
 * @param {string} params.fullText - 完整文本(LLM 看上下文用)
 * @param {number} params.videoDuration - 整段时长(秒)
 * @param {number} [params.targetDuration=3.0] - 目标钩子时长(秒)
 * @param {object} params.options - { ollamaUrl, ollamaModel, ... }
 * @returns {Promise<{start, end, text, reason}>}
 */
async function findGoldenMoment({ words, fullText, videoDuration, targetDuration = 3.0, options }) {
    if (!Array.isArray(words) || !words.length) {
        throw new Error('findGoldenMoment: words 必须是非空数组');
    }
    const { callChat } = require('../services/processor');

    // 构造 LLM 看的"带时间戳的原稿"
    // 不直接给 raw words(太多),按每 ~10s 一段切块,每块标 [start-end]
    const snippets = [];
    let bucket = [];
    let bucketStart = words[0].start || 0;
    for (const w of words) {
        const s = Number(w.start) || 0;
        const e = Number(w.end) || 0;
        bucket.push(String(w.word || w.text || ''));
        if (e - bucketStart >= 8 || bucket === words[words.length - 1]) {
            snippets.push(`[${bucketStart.toFixed(1)}-${e.toFixed(1)}s] ${bucket.join('').trim()}`);
            bucket = [];
            bucketStart = e;
        }
    }
    if (bucket.length) {
        const last = words[words.length - 1];
        snippets.push(`[${bucketStart.toFixed(1)}-${(last.end || videoDuration).toFixed(1)}s] ${bucket.join('').trim()}`);
    }

    // v0.10.3:时长容忍放宽,换"句子完整"
    // 之前 3.3s 上限导致 LLM 返回 8s 段被切断,两句都不完整
    // 现在 3.8s 上限,配合句子边界截断,能容纳完整句子微超(3-3.5s 的句子很常见)
    const minDuration = Math.max(1.8, targetDuration * 0.7);   // 3.0s → 2.1s 下限(保持)
    const maxDuration = targetDuration * 1.27;                 // 3.0s → 3.8s 上限(放宽)
    const systemPrompt = [
        '你是短视频"前 3 秒钩子"策划师。任务:从中文视频的 transcript 中找出**最能抓住眼球的一段**,',
        '放在成片开头,让观众**停下划屏不划走**。',
        '',
        '**核心目标**:提升完播率。这 3 秒抽出来,单独看,还能让人想继续看下去。',
        '',
        `【硬性时长约束】(必须严格遵守)`,
        `- 严格目标: ${targetDuration.toFixed(1)} 秒`,
        `- 允许范围: ${minDuration.toFixed(1)} - ${maxDuration.toFixed(1)} 秒(容忍完整句子微超)`,
        `- **严禁超过 ${maxDuration.toFixed(1)} 秒** — 超过就说明你选错了段,重找`,
        '',
        '**最重要:返回的 [start, end] 必须是一个完整句子**',
        '- end 必须落在句号/问号/感叹号 或 说话自然停顿处(> 0.35 秒间隔)',
        '- **绝对不要**返回"跨 2-3 句话"的大区间 — 我们截断会把你选的毁掉',
        '- 如果找不到 3 秒内完整句,允许 3.5 秒,但必须是一句完整的',
        '- 宁可短到 2.5 秒的完整金句,也不要 4 秒的半句',
        '',
        '【好钩子的 7 种类型】(命中任意一条即可,不要强求某一种)',
        '1. **精华金句 / 核心论点**:视频里最有洞见、最有价值的一句总结 (例:"幸福不是拥有更多,是需要更少")',
        '2. **反差冲击**:挑战认知、对比强烈 (例:"在国内一本书几十块,国外 30 刀")',
        '3. **强画面场景**:具体地点/动作/物理细节,观众能脑补 (例:"曼谷街头,Grab 车停下,司机是个哑巴")',
        '4. **悬念钩子**:问句、未解之谜、留白 (例:"这一件事我做了 5 年,终于明白...")',
        '5. **身份标签**:独特经历、身份反差 (例:"从流水线工人到 HK 演讲")',
        '6. **情绪峰值**:最愤怒/感动/顿悟/冲动的那一秒 (例:"那一刻我突然就笑了")',
        '7. **具体数字/金额**:任何含具体数字的硬核信息 (例:"我烧了 50 万")',
        '',
        '【选段的核心判断】',
        '- 这 3 秒**单独拿出来**,不看前后文,还能让人"咦,想继续听"吗?',
        '- 内容有"料"吗(具体人/物/数字/场景/观点,不是空洞形容词)',
        '- 开头是不是**直接切入**,没有"嗯/然后/这个..." 的暖场',
        '',
        '【严禁选中】(命中任一就换段)',
        '- 开头/包含口水词: "嗯"、"呢"、"然后"、"接着"、"这个"、"那个"、"就是说"、"其实呢"、"然后呢"',
        '- 过渡句: "说到这个"、"我们再来聊"、"接下来"、"下一个话题"、"那么"',
        '- 叙述型开场: "今天我想聊聊..."、"大家好"、"首先..."',
        '- 中间有明显停顿/断句(word 间隔 > 0.5 秒的段)',
        '- 句子残缺(没主语/没谓语/半句话)',
        '- 空洞形容词堆砌: "真的非常有意思"、"特别棒"、"很不错"',
        '',
        '【正反示范】',
        '❌ 坏 8 秒: "这个事情吧,我觉得呢,其实挺有意思的,就是说..." (0 信息,全是口水)',
        '❌ 坏 5 秒: "然后我们再来看下一个话题 — 关于..." (过渡句,无冲击)',
        '❌ 坏 3 秒: "这个真的非常重要,特别棒" (空洞形容词)',
        '✓ 好 3 秒(反差型): "在国内一本书几十块钱,国外却要 30 刀"',
        '✓ 好 3 秒(金句型): "幸福不是拥有更多,是需要更少"',
        '✓ 好 3 秒(场景型): "曼谷街头,Grab 车停下,司机是个哑巴"',
        '✓ 好 3 秒(悬念型): "这一件事我做了 5 年,终于明白..."',
        '✓ 好 3 秒(情绪型): "那一刻我突然就哭了"',
        '✓ 好 2.5 秒(数字型): "我烧了 50 万才明白这一点"',
        '',
        '**不要强求反差**。视频里没反差就找金句/场景/悬念/情绪,任何一种能吸引眼球的都行。',
        '',
        '输出严格 JSON(不加任何说明):',
        '{"start": 数字(秒,保留 2 位小数), "end": 数字(秒), "text": "那几秒的原文", "type": "金句/反差/场景/悬念/身份/情绪/数字", "reason": "为什么能抓眼球(一句话 ≤ 20 字)"}'
    ].join('\n');

    const userPrompt = [
        `视频总时长: ${videoDuration.toFixed(1)} 秒`,
        `目标钩子时长: ${targetDuration.toFixed(1)} 秒`,
        '',
        'transcript(按时间分块):',
        snippets.join('\n'),
        '',
        '请输出最炸那一句的 JSON。'
    ].join('\n');

    const raw = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);

    const parsed = parseGoldenJson(raw);
    if (!parsed) {
        const err = new Error('LLM 输出未能解析出 JSON');
        err.rawOutput = raw;
        throw err;
    }

    // 校验时间戳
    const start = Number(parsed.start);
    let end = Number(parsed.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        const err = new Error(`LLM 返回的时间戳异常: start=${start}, end=${end}`);
        err.rawOutput = raw;
        throw err;
    }
    if (end > videoDuration + 1) {
        const err = new Error(`LLM 返回的 end=${end} 超出视频时长 ${videoDuration}`);
        err.rawOutput = raw;
        throw err;
    }

    // v0.10.3 三级截断:句子边界 → word 边界 → 硬切 idealEnd
    // 旧 v0.10.2 只按 word 边界,LLM 给 8s 包含两句时切到 3s 就切在句中央
    // 新策略:优先找 3.0±0.8s 内的句子结束点(标点/长停顿),保证句子完整
    const hardCap = targetDuration * 1.27;   // 3.8s 上限(放宽)
    let truncated = false;
    let truncationReason = '';
    const rawDuration = end - start;
    if (rawDuration > hardCap) {
        const idealEnd = start + targetDuration;
        // 1. 优先:句子边界(±0.8s,含标点/长停顿)
        const sentenceEnd = findSentenceBoundaryEnd(words, start, idealEnd, 0.8);
        if (sentenceEnd && sentenceEnd - start >= 2.0) {
            end = sentenceEnd;
            truncated = true;
            truncationReason = 'sentence';
        } else {
            // 2. 次选:word 边界(不把字切半)
            const wordBoundaryEnd = findWordBoundaryEnd(words, start, idealEnd);
            if (wordBoundaryEnd) {
                end = wordBoundaryEnd;
                truncated = true;
                truncationReason = 'word';
            } else {
                // 3. 兜底:硬切
                end = idealEnd;
                truncated = true;
                truncationReason = 'hard';
            }
        }
    }

    return {
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        duration: Number((end - start).toFixed(2)),
        rawDuration: Number(rawDuration.toFixed(2)),
        truncated,
        truncationReason,                              // sentence / word / hard
        text: String(parsed.text || '').trim(),
        type: String(parsed.type || '').trim(),        // 金句/反差/场景/悬念/身份/情绪/数字
        reason: String(parsed.reason || '').trim(),
        rawOutput: raw
    };
}

// 按 word-level 时间戳找最接近 idealEnd 的 word 边界(不把字切半)
// 返回落在 [idealEnd - 0.3, idealEnd + 0.3] 区间内最靠前的 word.end
function findWordBoundaryEnd(words, start, idealEnd) {
    if (!Array.isArray(words) || !words.length) return idealEnd;
    let best = null;
    for (const w of words) {
        const wEnd = Number(w.end) || 0;
        if (wEnd < start) continue;
        if (wEnd > idealEnd + 0.3) break;
        // 选落在 idealEnd ±0.3 内最接近的 word.end
        if (wEnd >= idealEnd - 0.3) {
            if (!best || Math.abs(wEnd - idealEnd) < Math.abs(best - idealEnd)) {
                best = wEnd;
            }
        }
    }
    return best;  // 可能是 null,外层会 fallback
}

// 在 [idealEnd - radius, idealEnd + radius] 窗口里找最接近 idealEnd 的"句子结束点"。
// 优先级:标点 > 长停顿 > filler 尾字 + 停顿 > null (上层 fallback 到 word 边界)
// 解决 v0.10.2 "两句话都没说完"的根因:之前按 word 边界截,不管句子完整性。
// @returns {number|null} word.end 秒数,null 表示窗口内没找到合适的句子边界
function findSentenceBoundaryEnd(words, start, idealEnd, searchRadius = 0.8) {
    if (!Array.isArray(words) || !words.length) return null;
    const minEnd = Math.max(start + 1.5, idealEnd - searchRadius);
    const maxEnd = idealEnd + searchRadius;
    const candidates = [];

    for (let i = 0; i < words.length; i += 1) {
        const w = words[i];
        const wEnd = Number(w.end) || 0;
        if (wEnd < minEnd) continue;
        if (wEnd > maxEnd) break;

        const wordText = String(w.word ?? w.text ?? '');
        const next = words[i + 1];
        // 最后一个 word 没有"下一个",不应该获得停顿加分(结尾≠句子停顿)
        const hasNext = !!next;
        const gapToNext = hasNext ? ((Number(next.start) || 0) - wEnd) : 0;

        // 句子信号检测(只在 hasNext 时才检测停顿)
        const hasEndPunct = /[。!?！？.]/.test(wordText);           // 中英文句末标点
        const hasCommaPause = /[,;,;]/.test(wordText) && hasNext && gapToNext > 0.3;  // 逗号+停顿(次优)
        const hasFillerEnd = /[呢吧啊嘛哦嘞哈啦]$/.test(wordText);   // 语气词结尾
        const isLongPause = hasNext && gapToNext > 0.5;              // 0.5s+ 强停顿
        const isMediumPause = hasNext && gapToNext > 0.35;           // 0.35s+ 中停顿

        let score = 0;
        if (hasEndPunct) score += 100;          // 标点最优
        if (isLongPause) score += 60;           // 长停顿次优
        if (hasFillerEnd && isMediumPause) score += 45;  // 语气词+停顿
        if (isMediumPause && !hasEndPunct) score += 25;  // 中停顿
        if (hasCommaPause) score += 15;         // 逗号+停顿

        // 距离 ideal 越近越好(每秒差扣 8 分)
        score -= Math.abs(wEnd - idealEnd) * 8;

        if (score > 0) candidates.push({ end: wEnd, score, reason: buildReason({ hasEndPunct, isLongPause, isMediumPause, hasFillerEnd }) });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return Number(candidates[0].end.toFixed(2));
}

function buildReason({ hasEndPunct, isLongPause, isMediumPause, hasFillerEnd }) {
    if (hasEndPunct) return 'punct';
    if (isLongPause) return 'long_pause';
    if (hasFillerEnd && isMediumPause) return 'filler+pause';
    if (isMediumPause) return 'medium_pause';
    return 'unknown';
}

function parseGoldenJson(raw) {
    if (!raw) return null;
    const text = String(raw);
    // fence
    const fence = text.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
    if (fence) {
        try { return JSON.parse(fence[1]); } catch (_) {}
    }
    // 第一个 { 到最后一个 }
    const f = text.indexOf('{');
    const l = text.lastIndexOf('}');
    if (f >= 0 && l > f) {
        // 去掉 trailing comma
        const body = text.slice(f, l + 1).replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(body); } catch (_) {}
    }
    return null;
}

// ───────────────────────────── FFmpeg 切 hook ─────────────────────────────

function probeVideoInfo(videoPath) {
    try {
        const r = spawnSync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate',
            '-show_entries', 'format=duration,bit_rate',
            '-of', 'json', videoPath
        ], { encoding: 'utf8', timeout: 10000 });
        if (r.status !== 0) return null;
        const info = JSON.parse(r.stdout || '{}');
        const stream = (info.streams || [])[0] || {};
        const format = info.format || {};
        const fps = (() => {
            const rf = String(stream.r_frame_rate || '30/1').split('/');
            return Number(rf[0]) / Number(rf[1] || 1) || 30;
        })();
        return {
            width: Number(stream.width) || 0,
            height: Number(stream.height) || 0,
            fps,
            duration: Number(format.duration) || 0,
            bitrate: Number(format.bit_rate) || 0
        };
    } catch (_) { return null; }
}

/**
 * 从已烧字幕的主视频切出钩子片段。
 * 用输入端 -ss + 输出端 -ss 的两阶段精确 seek(FFmpeg 社区最佳实践)。
 */
async function extractHookClip({ mainVideoPath, start, duration, outputPath, onProgress }) {
    if (!fs.existsSync(mainVideoPath)) throw new Error(`[goldenHook] 主视频不存在: ${mainVideoPath}`);

    const info = probeVideoInfo(mainVideoPath);
    if (!info || !info.width) throw new Error(`[goldenHook] 无法探测视频信息: ${mainVideoPath}`);

    // 两阶段 seek:粗略到 start-0.5,然后精确往前 0.5(更准)
    const coarseSeek = Math.max(0, start - 0.5);
    const fineSeek = start - coarseSeek;

    // 码率用主视频的 1.2 倍(轻微降码,避免钩子段过大)
    const targetMbps = Math.max(2, (info.bitrate || 0) / 1_000_000);

    const args = [
        '-y', '-ss', String(coarseSeek),
        '-i', mainVideoPath,
        '-ss', String(fineSeek),
        '-t', String(duration),
        '-c:v', 'h264_videotoolbox', '-b:v', `${targetMbps.toFixed(1)}M`,
        '-pix_fmt', 'yuv420p',
        '-r', String(info.fps),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
    ];
    try {
        await runFfmpegWithProgress(args, { durationSec: duration, onProgress });
    } catch (err) {
        // videotoolbox 失败回退 libx264
        const swArgs = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const idxB = swArgs.indexOf('-b:v');
        if (idxB > 0) { swArgs.splice(idxB, 2, '-preset', 'fast', '-crf', '20'); }
        await runFfmpegWithProgress(swArgs, { durationSec: duration, onProgress });
    }
    return outputPath;
}

/**
 * 把 hook 段拼接到主视频前面。
 * concat filter 重编码,保证参数一致 + 字幕/音频连续。
 */
async function prependHookToMain({ hookPath, mainPath, outputPath, onProgress }) {
    const mainInfo = probeVideoInfo(mainPath);
    const hookInfo = probeVideoInfo(hookPath);
    if (!mainInfo || !hookInfo) throw new Error('[goldenHook] 无法探测 hook/main 视频信息');
    const targetMbps = Math.max(2, (mainInfo.bitrate || 0) / 1_000_000);
    const totalDur = (mainInfo.duration || 0) + (hookInfo.duration || 0);

    // 统一规格(保险起见):scale + setsar,给 concat filter
    const filter = [
        `[0:v]scale=${mainInfo.width}:${mainInfo.height}:force_original_aspect_ratio=decrease,pad=${mainInfo.width}:${mainInfo.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${mainInfo.fps}[hv]`,
        `[1:v]scale=${mainInfo.width}:${mainInfo.height}:force_original_aspect_ratio=decrease,pad=${mainInfo.width}:${mainInfo.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${mainInfo.fps}[mv]`,
        `[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ha]`,
        `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ma]`,
        `[hv][ha][mv][ma]concat=n=2:v=1:a=1[v][a]`
    ].join(';');

    const args = [
        '-y',
        '-i', hookPath,
        '-i', mainPath,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'h264_videotoolbox', '-b:v', `${targetMbps.toFixed(1)}M`,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
    ];
    try {
        await runFfmpegWithProgress(args, { durationSec: totalDur, onProgress });
    } catch (err) {
        const swArgs = args.map((a) => a === 'h264_videotoolbox' ? 'libx264' : a);
        const idxB = swArgs.indexOf('-b:v');
        if (idxB > 0) { swArgs.splice(idxB, 2, '-preset', 'fast', '-crf', '20'); }
        await runFfmpegWithProgress(swArgs, { durationSec: totalDur, onProgress });
    }
    return outputPath;
}

// ───────────────────────────── 一站式组装 ─────────────────────────────

/**
 * 给已烧字幕的主视频前插入 3 秒金钩。
 *
 * @param {object} params
 * @param {string} params.mainVideoPath - 已烧字幕的主视频(无 BGM,无封面)
 * @param {Array} params.words - ASR word-level
 * @param {string} params.fullText
 * @param {number} params.videoDuration
 * @param {object} params.options - { ollamaUrl, ollamaModel, ... }
 * @param {number} [params.targetDuration=3.0]
 * @param {number} [params.manualStart] - 手动指定起点,跳过 LLM
 * @param {function} [params.onProgress]
 * @returns {Promise<{outputPath, moment}>}  outputPath 是"已前置钩子"的新视频路径
 */
async function prependGoldenHook({
    mainVideoPath, words, fullText, videoDuration,
    options, targetDuration = 3.0, manualStart = null, onProgress
}) {
    if (!fs.existsSync(mainVideoPath)) throw new Error(`[goldenHook] 主视频不存在: ${mainVideoPath}`);

    // 1. 决定 3 秒起点
    let moment;
    if (manualStart != null && Number.isFinite(Number(manualStart))) {
        const s = Math.max(0, Number(manualStart));
        const e = Math.min(videoDuration, s + targetDuration);
        moment = { start: s, end: e, duration: e - s, text: '(手动指定)', reason: `--golden-start=${s}` };
    } else {
        moment = await findGoldenMoment({ words, fullText, videoDuration, targetDuration, options });
    }

    // 2. 从主视频切 hook 片段
    const workDir = path.dirname(mainVideoPath);
    const hookPath = path.join(workDir, '_golden_hook.mp4');
    await extractHookClip({
        mainVideoPath,
        start: moment.start,
        duration: moment.duration || targetDuration,
        outputPath: hookPath,
        onProgress: (p) => onProgress && onProgress({ stage: 'extract', percent: p })
    });

    // 3. 拼到主视频前面,生成 prepended
    const prependedPath = path.join(workDir, '_prepended_' + path.basename(mainVideoPath));
    await prependHookToMain({
        hookPath,
        mainPath: mainVideoPath,
        outputPath: prependedPath,
        onProgress: (p) => onProgress && onProgress({ stage: 'concat', percent: p })
    });

    // 4. 用 prepended 覆盖原 main(保持下游接口不变)
    fs.renameSync(prependedPath, mainVideoPath);
    // 5. 清理 hook 临时文件
    try { fs.unlinkSync(hookPath); } catch (_) {}

    return { outputPath: mainVideoPath, moment };
}

module.exports = {
    findGoldenMoment,
    extractHookClip,
    prependHookToMain,
    prependGoldenHook,
    probeVideoInfo,
    parseGoldenJson,
    findWordBoundaryEnd,
    findSentenceBoundaryEnd
};
