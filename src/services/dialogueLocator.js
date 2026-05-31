'use strict';

/**
 * dialogueLocator — panel/圆桌视频对话边界定位
 *
 * 输入:transcript(qwen3-ASR 词级时间戳)+ 名字字典(speaker / host / other_speakers)
 * 输出:speaker 在视频里的发言段时间戳数组
 *
 * 算法(基于 2026-05-24 OPC 红利 panel 实战):
 * 1. scanNameEvents — 全文扫描所有名字出现位置 + 上下文 + char→time 映射
 * 2. clusterEvents — 相邻 < 3s 的 hit 聚成一个 cluster(去重)
 * 3. scoreHostTrigger — 每个 cluster 看上下文是否是"主持人喊"
 *    (触发词:请/好,/谢谢,/那/接下来/帮我们分享/介绍一下)
 * 4. inferSpeakerSegments — 找 "host 喊 speaker" cluster 起,下次 "host 喊 other_speaker" 止
 *
 * 设计原则:
 * - 启发式不依赖 LLM(快、可解释、可测)
 * - 名字字典支持同音字数组(panel ASR 常见误识)
 * - 容错:扫不到任何段时返回 [] + warnings,不抛
 * - 暴露中间产物(events / clusters)便于 --dry-run 让用户人工校验
 */

// ─── 配置 ────────────────────────────────────────────────────────────────

const CLUSTER_GAP_SEC = 3;            // 相邻 < 3s 的 hit 算同一 cluster
const CONTEXT_CHARS = 30;             // 取每个事件前后 30 字作上下文
const HOST_TRIGGER_WINDOW = 25;       // 在事件前 25 字范围内找主持人触发词

// 主持人 START 触发词(请 X 讲 / 切到 X)— 这才是真正的"X 段开始"信号
// 注意:"谢谢 X" / "好的" 是 END 触发词(X 段结束),不能算 segment start
const HOST_START_TRIGGERS = [
    '请', '请那个', '请这个',
    '来,', '来,请', '来,请那个',
    '接下来', '下面',
    '帮我们分享', '介绍一下',
    '先从这个', '从这个', '先从',
    '那,', '那这个', '那么',
    '。那', ',那',     // 中文 panel 常见:"...。那 X 你说"(主持人句首切换)
    '说说', '聊聊',
];

// 主持人 END 触发词(感谢 / 收尾 X 当前发言)— 出现在前 5 字会**降低** start score
// 例:"OK,好的,谢谢李标,Dennis" 主持人结束 Bill + 切 Dennis 的话,Dennis cluster
// 上下文有 END 词,**不应**让 Bill 也被 start
const HOST_END_TRIGGERS = [
    '谢谢', '感谢', '好的', 'OK,', 'OK ', 'Ok,',
    '辛苦', '收尾',
];

// 嘉宾内部提及触发词(出现在前 25 字 → 大概率不是主持人在喊)
const PEER_MENTION_PATTERNS = [
    '像', '比如说', '同意', '顺着', '跟',
    '和', '与', '提到', '我和', '我跟',
];

// 兼容旧 API(已废弃,保留导出避免破坏外部依赖)
const HOST_TRIGGER_PATTERNS = HOST_START_TRIGGERS;

// ─── 工具函数 ────────────────────────────────────────────────────────────

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePunct(s) {
    // 跟 clipper.js / sanitizer 一致的去标点逻辑,用于 char-offset 匹配
    return String(s || '').replace(/[\s,.。！!?？、；;:：""''「」『』()（）《》【】·—…\-]+/g, '');
}

/**
 * 把 transcript 词级时间戳数组建成 char-offset → time 索引
 * 返回 lookup 函数 (pos: full_text 字符位置) → 时间(秒)
 */
function buildPosTimeIndex(text, words) {
    const ranges = [];
    let flatText = '';
    for (let i = 0; i < words.length; i += 1) {
        const w = words[i];
        const raw = String(w.word ?? w.text ?? '').trim();
        const norm = normalizePunct(raw);
        flatText += norm;
        ranges.push({
            endFlat: flatText.length,
            tStart: Number(w.start),
            tEnd: Number(w.end),
        });
    }
    return function mapPosToTime(pos, opts = {}) {
        const kind = opts.kind === 'end' ? 'tEnd' : 'tStart';
        const flatPos = normalizePunct(text.slice(0, pos)).length;
        for (const r of ranges) {
            if (flatPos < r.endFlat) return r[kind];
        }
        return ranges.length > 0 ? ranges[ranges.length - 1].tEnd : 0;
    };
}

// ─── scanNameEvents ──────────────────────────────────────────────────────

/**
 * @param {string} text  qwen3-ASR full_text
 * @param {Array} words  qwen3-ASR words(词级时间戳)
 * @param {Object} namesDict  { speaker: ['李标','李彪'], host: ['薛俪','Amber'], others: ['Dennis',...] }
 * @returns {Array} events  [{ t, pos, role, kw, ctx }] 按 t 升序
 */
function scanNameEvents(text, words, namesDict) {
    if (!text || typeof text !== 'string') return [];
    if (!Array.isArray(words) || words.length === 0) return [];
    if (!namesDict || typeof namesDict !== 'object') return [];
    const mapPosToTime = buildPosTimeIndex(text, words);
    const events = [];
    for (const role of Object.keys(namesDict)) {
        const kws = Array.isArray(namesDict[role]) ? namesDict[role] : [];
        for (const kw of kws) {
            if (typeof kw !== 'string' || !kw.trim()) continue;
            const re = new RegExp(escapeRegex(kw), 'g');
            let m;
            while ((m = re.exec(text)) !== null) {
                const pos = m.index;
                const ctxStart = Math.max(0, pos - CONTEXT_CHARS);
                const ctxEnd = Math.min(text.length, pos + CONTEXT_CHARS);
                events.push({
                    t: mapPosToTime(pos),
                    pos,
                    role,
                    kw,
                    ctx: text.slice(ctxStart, ctxEnd),
                });
            }
        }
    }
    events.sort((a, b) => a.t - b.t || a.pos - b.pos);
    return events;
}

// ─── clusterEvents ──────────────────────────────────────────────────────

/**
 * 相邻 < CLUSTER_GAP_SEC 的事件聚类(去重相同位置的多关键词命中)
 * cluster 的 role 取该 cluster 里出现最多次的 role
 *
 * @param {Array} events  from scanNameEvents
 * @returns {Array} clusters  [{ t, pos, primaryRole, hits: [{role,kw}], ctx }]
 */
function clusterEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const clusters = [];
    for (const e of events) {
        const last = clusters[clusters.length - 1];
        if (last && (e.t - last.t) < CLUSTER_GAP_SEC) {
            last.hits.push({ role: e.role, kw: e.kw });
        } else {
            clusters.push({
                t: e.t,
                pos: e.pos,
                hits: [{ role: e.role, kw: e.kw }],
                ctx: e.ctx,
            });
        }
    }
    // 给每个 cluster 算 primaryRole(出现最多次的 role)
    for (const c of clusters) {
        const counts = {};
        for (const h of c.hits) counts[h.role] = (counts[h.role] || 0) + 1;
        let max = -1;
        let primary = c.hits[0].role;
        for (const r of Object.keys(counts)) {
            if (counts[r] > max) { max = counts[r]; primary = r; }
        }
        c.primaryRole = primary;
    }
    return clusters;
}

// ─── scoreHostTrigger ───────────────────────────────────────────────────

/**
 * 给 cluster 上下文打分:是不是主持人在"喊"这个名字?
 * 看 cluster 时间点之前的 25 字范围(text 里 pos 之前)是否含主持人触发词
 *
 * @returns {{ score: number, hits: string[] }}  score 0-1
 */
function scoreHostTrigger(cluster, text) {
    if (!cluster || !text) return { score: 0, hits: [], kind: 'none' };
    const pos = cluster.pos;
    const winStart = Math.max(0, pos - HOST_TRIGGER_WINDOW);
    const window = text.slice(winStart, pos);
    let startHits = 0;
    const matchedStarts = [];
    for (const trig of HOST_START_TRIGGERS) {
        if (window.includes(trig)) {
            startHits += 1;
            matchedStarts.push(trig);
        }
    }
    let endHits = 0;
    const matchedEnds = [];
    for (const trig of HOST_END_TRIGGERS) {
        if (window.includes(trig)) {
            endHits += 1;
            matchedEnds.push(trig);
        }
    }
    let peerHits = 0;
    for (const trig of PEER_MENTION_PATTERNS) {
        if (window.includes(trig)) peerHits += 1;
    }
    // 启发式:
    // - START 强信号 +0.6,END 弱信号 +0.2(虽然是切换,但当前 cluster 不是被请的人)
    // - START + END 同时出现(如"好的,谢谢 X 介绍"含 END "好的/谢谢" 但下半句是 START):
    //   仍计 START kind,但稍微 -0.2(模糊)
    // - 嘉宾互相提及 -0.3
    // 输出 kind = 'start' / 'end' / 'none'
    let kind = 'none';
    let raw = 0;
    if (startHits > 0 && endHits === 0) {
        kind = 'start';
        raw = 0.6 + 0.2 * (startHits - 1);
    } else if (startHits === 0 && endHits > 0) {
        kind = 'end';
        raw = 0.5;
    } else if (startHits > 0 && endHits > 0) {
        // 模糊:start + end 同时出现,看哪个紧贴 pos 前 15 字
        // 例如 cluster "好的,那我们再回来,呃,请那个李彪" — END "好的" 在远窗,
        // START "请那个" 在近窗(15 字内)→ 这是 start 不是 end
        const near = text.slice(Math.max(0, pos - 15), pos);
        const nearStart = HOST_START_TRIGGERS.some((t) => near.includes(t));
        const nearEnd = HOST_END_TRIGGERS.some((t) => near.includes(t));
        if (nearStart) {
            // START 在近窗 → 是 start;再看 END 是否也在近窗(轻微减信心)
            kind = 'start';
            raw = nearEnd ? 0.55 : 0.7;
        } else {
            // START 只在远窗,END 在近窗 → 大概率是 end("好的,谢谢 X")
            kind = 'end';
            raw = 0.5;
        }
    }
    raw -= peerHits * 0.3;
    const score = Math.max(0, Math.min(1, raw));
    return { score, hits: matchedStarts, endHits: matchedEnds, kind };
}

// ─── inferSpeakerSegments ───────────────────────────────────────────────

/**
 * 推断 speaker 在 panel 里的发言段
 *
 * 算法:
 * 1. 过 clusters 找所有"主持人在喊 speaker"的事件(role=speaker + hostTriggerScore >= threshold)
 *    → 这些是 segment_start
 * 2. 每个 segment_start 的 end = 下一个"主持人在喊 other_speaker"的事件 t
 *    (没有下一个 → end = transcript 结束时间)
 * 3. 过滤:duration < minDurationSec 的段丢弃(误判)
 * 4. 每段加 startBufferSec 秒(把主持人提问也包进段,完整对话感)
 *
 * @param {Array} clusters
 * @param {string} text
 * @param {Object} options
 *   - speakerRole (string, default 'speaker')
 *   - otherSpeakerRoles (string[], default ['others'])
 *   - minDurationSec (default 60)
 *   - maxDurationSec (default 900)
 *   - startBufferSec (default 0,正数表示把主持人提问段包进 speaker 段开头)
 *   - hostTriggerThreshold (default 0.5)
 *   - transcriptDurationSec (number,最后一段的 fallback end)
 * @returns {{segments: Array, debug: Object}}
 */
function inferSpeakerSegments(clusters, text, options = {}) {
    const speakerRole = options.speakerRole || 'speaker';
    const otherSpeakerRoles = Array.isArray(options.otherSpeakerRoles) ? options.otherSpeakerRoles : ['others'];
    const minDur = Number(options.minDurationSec) > 0 ? Number(options.minDurationSec) : 60;
    const maxDur = Number(options.maxDurationSec) > 0 ? Number(options.maxDurationSec) : 900;
    const startBufferSec = Number(options.startBufferSec) || 0;
    const threshold = Number.isFinite(options.hostTriggerThreshold) ? Number(options.hostTriggerThreshold) : 0.5;
    const fallbackEnd = Number(options.transcriptDurationSec) > 0 ? Number(options.transcriptDurationSec) : Infinity;

    if (!Array.isArray(clusters) || clusters.length === 0) {
        return { segments: [], debug: { reason: 'no_clusters' } };
    }

    // 给每个 cluster 算 host trigger score + kind(start / end / none)
    const scored = clusters.map((c) => ({
        ...c,
        hostTrigger: scoreHostTrigger(c, text),
    }));

    // 候选 segment_start:role=speaker 且 hostTrigger 是 START 且 score >= threshold
    // (排除 END kind — "谢谢 X" 是切换出 X 段,不是 X 段起)
    const starts = scored.filter((c) =>
        c.primaryRole === speakerRole
        && c.hostTrigger.kind === 'start'
        && c.hostTrigger.score >= threshold
    );
    // 候选 next_other_speaker 切换点(START kind,主持人请其他嘉宾)
    const others = scored.filter((c) =>
        otherSpeakerRoles.includes(c.primaryRole)
        && c.hostTrigger.kind === 'start'
        && c.hostTrigger.score >= threshold
    );

    const segments = [];
    const warnings = [];
    for (let i = 0; i < starts.length; i += 1) {
        const s = starts[i];
        // 找下一个 "host 喊 other" 事件(必须在 s.t 之后)
        const nextOther = others.find((o) => o.t > s.t);
        let endT = nextOther ? nextOther.t : Math.min(fallbackEnd, s.t + maxDur);
        // 截 maxDur
        if (endT - s.t > maxDur) endT = s.t + maxDur;
        const startT = Math.max(0, s.t - startBufferSec);
        const dur = endT - startT;
        if (dur < minDur) {
            warnings.push(`seg too short (${dur.toFixed(1)}s < ${minDur}s),skip: t=${s.t.toFixed(1)}s ctx="${s.ctx.replace(/\s+/g, ' ')}"`);
            continue;
        }
        segments.push({
            id: `seg-${String(segments.length + 1).padStart(2, '0')}`,
            startSec: Number(startT.toFixed(2)),
            endSec: Number(endT.toFixed(2)),
            durationSec: Number(dur.toFixed(2)),
            speakerRole,
            startCluster: { t: s.t, ctx: s.ctx, hostTriggerHits: s.hostTrigger.hits },
            endCluster: nextOther ? { t: nextOther.t, ctx: nextOther.ctx, primaryRole: nextOther.primaryRole } : null,
        });
    }
    // 合并相邻重叠段(同一个 speaker 段被两个 start trigger 拆开 — 开场介绍 + Bill 自我介绍)
    // gap < mergeGapSec 视为同段,取较早 start + 较晚 end
    const mergeGapSec = Number.isFinite(options.mergeGapSec) ? Number(options.mergeGapSec) : 30;
    const merged = mergeOverlappingSegments(segments, mergeGapSec);

    return {
        segments: merged,
        debug: {
            totalClusters: clusters.length,
            scoredClusters: scored.length,
            starts: starts.length,
            others: others.length,
            preMergeSegments: segments.length,
            postMergeSegments: merged.length,
            warnings,
        },
    };
}

/**
 * 合并相邻 / 重叠 speaker 段
 * 规则:相邻段 startB <= endA + gapTolerance → 合并为 [startA, max(endA, endB)]
 * id 重命名为 seg-01, seg-02, ...
 */
function mergeOverlappingSegments(segments, gapTolerance = 30) {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const sorted = segments.slice().sort((a, b) => a.startSec - b.startSec);
    const out = [];
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && s.startSec <= last.endSec + gapTolerance) {
            // 合并:end 取更晚的
            last.endSec = Math.max(last.endSec, s.endSec);
            last.durationSec = Number((last.endSec - last.startSec).toFixed(2));
            // 记录被合并的 cluster(便于诊断)
            last.mergedFrom = last.mergedFrom || [{ t: last.startCluster.t, ctx: last.startCluster.ctx.slice(0, 30) }];
            last.mergedFrom.push({ t: s.startCluster.t, ctx: s.startCluster.ctx.slice(0, 30) });
        } else {
            out.push({ ...s });
        }
    }
    // 重新编号
    return out.map((s, i) => ({ ...s, id: `seg-${String(i + 1).padStart(2, '0')}` }));
}

module.exports = {
    scanNameEvents,
    clusterEvents,
    scoreHostTrigger,
    inferSpeakerSegments,
    mergeOverlappingSegments,
    buildPosTimeIndex,
    // 暴露常量(便于测试 / 调优)
    CLUSTER_GAP_SEC,
    HOST_START_TRIGGERS,
    HOST_END_TRIGGERS,
    HOST_TRIGGER_PATTERNS,
    PEER_MENTION_PATTERNS,
};
