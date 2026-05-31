'use strict';

/**
 * Vlog Plan 生成器 (v0.11.4)
 *
 * 用户输入:主题 + 核心理念 → LLM 看 metadata + style + 品牌 + BGM 库 → 输出 N 个不同的 plan
 *
 * 核心洞察(来自用户 v0.11.3 反馈):
 *   "字幕要围绕我自己的核心理念发挥,不是 AI 凭空写"
 *
 * 设计原则:
 *   - 输入极简:theme + idea(其他都有默认)
 *   - 输出多样:N 个候选完全不同的叙事角度
 *   - 严格校验:clip_id 存在 + trim 在范围 + 段数合理
 *   - 品牌基调:自动读 example.json 的 taglineZh / cta.articleFooter / personaBase
 */

const fs = require('fs');
const path = require('path');
const { callChat } = require('./processor');
const { loadBrand } = require('./brandLoader');

// ────────────────────────────── 1. 加载 context ──────────────────────────────

/**
 * 从 metadata.json 加载素材摘要(供 LLM 看)
 */
function loadMaterialContext(ingestPath) {
    if (!fs.existsSync(ingestPath)) {
        throw new Error(`ingest metadata 不存在: ${ingestPath}. 请先跑 echocut ingest <dir>`);
    }
    const meta = JSON.parse(fs.readFileSync(ingestPath, 'utf8'));
    const clips = meta.clips || {};
    const materials = [];
    for (const [filename, info] of Object.entries(clips)) {
        if (info.error || !info.summary) continue;
        const probe = info.probe || {};
        const summary = info.summary || {};
        materials.push({
            filename,
            duration: probe.duration || 0,
            orientation: probe.orientation || 'unknown',
            scene: summary.scene || '',
            description: summary.description || '',
            tags: (summary.tags || []).slice(0, 6),
            mood: summary.mood || '',
            clip_type: summary.clip_type || ''
        });
    }
    return materials;
}

/**
 * 扫描 assets/bgm/ 下所有 mp3,交叉引用 musicPresets 拿描述
 */
function loadBgmLibrary(projectRoot) {
    const bgmDir = path.join(projectRoot, 'assets', 'bgm');
    if (!fs.existsSync(bgmDir)) return [];
    const files = fs.readdirSync(bgmDir).filter((f) => f.endsWith('.mp3'));
    const presets = require('./musicPresets');
    // 倒查 prompt
    const byName = {};
    for (const [setName, prompts] of Object.entries(presets)) {
        for (const p of prompts) byName[p.name] = { setName, prompt: p.prompt };
    }
    return files.map((f) => {
        const name = f.replace(/\.mp3$/, '');
        const match = byName[name];
        const stat = fs.statSync(path.join(bgmDir, f));
        return {
            file: `assets/bgm/${f}`,
            name,
            set: match?.setName || 'unknown',
            mood: match?.prompt || '',
            sizeMB: Number((stat.size / 1e6).toFixed(1))
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function loadStyles(projectRoot) {
    const styleFile = path.join(projectRoot, 'configs', 'vlog-styles.json');
    if (!fs.existsSync(styleFile)) return null;
    return JSON.parse(fs.readFileSync(styleFile, 'utf8'));
}

// ────────────────────────────── 2. 构造 LLM Prompt ──────────────────────────────

function buildSystemPrompt({ brand, styles, targetToneFilter }) {
    const taglineZh = brand?.identity?.taglineZh || '';
    const personaShort = brand?.identity?.description || '';

    const styleLines = (styles?.styles || []).map((s) => `- **${s.id}** ${s.emoji} ${s.name}: ${s.description}`).join('\n');

    const positive = targetToneFilter?.positive?.slice(0, 10).join(' / ') || '';
    const weaken = targetToneFilter?.weaken?.join(' / ') || '';

    return [
        '你是一位顶尖的 Vlog 导演 + 剪辑大师 + 品牌内容策划人。',
        '任务:根据用户给的【主题】和【核心理念】,从素材库里设计 N 个完全不同的 vlog plan。',
        '',
        `## 品牌人格(必须贴合)`,
        `- ${personaShort}`,
        `- 品牌调性(中文 tagline): ${taglineZh}`,
        '',
        `## 用户希望的基调`,
        positive ? `- ✅ 强化: ${positive}` : '',
        weaken ? `- ⚠️ 弱化/避开: ${weaken}` : '',
        '',
        `## 8 种风格类型(参考)`,
        styleLines,
        '',
        `## 核心使命`,
        '**所有字幕必须围绕用户的【核心理念】发挥。**',
        '不要写你(LLM)想说的话,要写用户内心想表达的话。',
        '字幕每段 6-20 个汉字,短促有力,移动端呼吸感。',
        '禁止空洞形容词堆砌,禁止 "非常/真的/很" 这类虚词。',
        '',
        `## 输出规则(严格遵守)`,
        '1. 输出严格 JSON,不加任何 markdown 代码块外的说明文字',
        '2. clip_id 必须完全匹配素材库里的文件名(严禁编造)',
        '3. trim_start / trim_end 必须在 clip 实际时长范围内',
        '4. 每段 trim 时长 2-5 秒(太短看不清,太长拖沓)',
        '5. 每个 plan 4-10 段',
        '6. N 个 plan 必须**完全不同的叙事角度**:不同 style / 不同素材组合 / 不同情绪起落',
        '7. 字幕用 \\\\n 分行,每行 ≤ 10 字',
        '8. cover.headline ≤ 10 字,cover.subline ≤ 15 字',
        '9. BGM 必须从【BGM 库】里选,填完整 file 路径',
        '',
        '## JSON Schema',
        '```json',
        '{"plans": [',
        '  {',
        '    "id": "plan-01", "title": "...", "style": "startup-journey|...",',
        '    "duration_target": 45,',
        '    "bgm_file": "assets/bgm/creator-XX-xxx.mp3",',
        '    "cover": {"headline": "...", "subline": "..."},',
        '    "segments": [',
        '      {"clip_id": "DJI_xxx.MP4", "trim_start": 1.5, "trim_end": 4.5, "subtitle": "..."}',
        '    ],',
        '    "rationale": "这个 plan 的核心叙事一句话"',
        '  }',
        ']}',
        '```'
    ].filter(Boolean).join('\n');
}

function buildUserPrompt({ theme, idea, duration, style, bgmHint, count, materials, bgmLib, stylesDoc }) {
    const lines = [];
    lines.push(`## 本次用户输入`);
    lines.push(`- 主题: **${theme}**`);
    lines.push(`- 核心理念: **${idea}**`);
    if (duration) lines.push(`- 目标时长(秒): ${duration}`);
    else lines.push(`- 目标时长: 自由选择,25-90 秒之间`);
    if (style) lines.push(`- 强制风格: ${style}`);
    else lines.push(`- 风格: 你从 8 种里挑最合适的(N 个 plan 可各自不同)`);
    if (bgmHint) lines.push(`- BGM 指定: ${bgmHint}`);
    lines.push(`- 输出数量: **${count} 个完全不同的 plan**`);
    lines.push('');
    lines.push(`## 素材库(共 ${materials.length} 个 clip)`);
    lines.push('格式: 文件名 | 时长s | 方向 | 场景 | 描述 | 标签');
    for (const m of materials) {
        const o = m.orientation === 'landscape' ? '横' : m.orientation === 'portrait' ? '竖' : '方';
        lines.push(`- ${m.filename} | ${m.duration.toFixed(0)}s | ${o} | ${m.scene} | ${m.description.slice(0, 50)} | [${m.tags.join(',')}]`);
    }
    lines.push('');
    lines.push(`## BGM 库(共 ${bgmLib.length} 首,选其中一首填到 bgm_file)`);
    for (const b of bgmLib) {
        lines.push(`- ${b.file} | ${b.mood.slice(0, 50)}`);
    }
    lines.push('');
    lines.push(`## 请输出 ${count} 个 plan 的完整 JSON。字幕**紧贴核心理念**:${idea}`);
    return lines.join('\n');
}

// ────────────────────────────── 3. 解析 + 校验 ──────────────────────────────

function extractJson(raw) {
    if (!raw) return null;
    const text = String(raw);
    const fence = text.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
    const body = fence ? fence[1] : null;
    if (body) {
        try { return JSON.parse(body); } catch (_) {}
    }
    const f = text.indexOf('{');
    const l = text.lastIndexOf('}');
    if (f >= 0 && l > f) {
        let candidate = text.slice(f, l + 1).replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(candidate); } catch (_) {}
    }
    return null;
}

/**
 * 校验 + 清洗一个 plan:
 * - clip_id 必须在 materials 里存在
 * - trim 必须在 [0, duration-0.3]
 * - 段数 3-12
 * 不符合的 segment 会被丢弃,如果剩余 < 3 段则返回 null
 */
function validateAndCleanPlan(plan, materials, bgmLib) {
    if (!plan || typeof plan !== 'object') return null;
    const byFile = {};
    for (const m of materials) byFile[m.filename] = m;

    const segments = Array.isArray(plan.segments) ? plan.segments : [];
    const cleaned = [];
    for (const seg of segments) {
        const cid = String(seg.clip_id || seg.clip_file || '').trim();
        const mat = byFile[cid];
        if (!mat) continue;  // 编造的 clip_id,丢弃
        const trimStart = Math.max(0, Math.min(mat.duration - 0.5, Number(seg.trim_start) || 0));
        const trimEnd = Math.max(trimStart + 1, Math.min(mat.duration - 0.1, Number(seg.trim_end) || trimStart + 3));
        const dur = trimEnd - trimStart;
        if (dur < 1.5 || dur > 7) continue;
        cleaned.push({
            clip_id: cid,
            trim_start: Number(trimStart.toFixed(2)),
            trim_end: Number(trimEnd.toFixed(2)),
            subtitle: String(seg.subtitle || '').trim()
        });
    }
    if (cleaned.length < 3) return null;

    // BGM 校验 / fallback
    const bgmFile = String(plan.bgm_file || '');
    const bgmMatch = bgmLib.find((b) => b.file === bgmFile || b.file.endsWith(path.basename(bgmFile)));
    const finalBgm = bgmMatch ? bgmMatch.file : (bgmLib[0]?.file || 'assets/bgm/03-lofi-podcast.mp3');

    return {
        id: String(plan.id || 'plan').trim(),
        title: String(plan.title || 'Vlog').trim(),
        style: String(plan.style || '').trim(),
        duration_target: Number(plan.duration_target) || null,
        bgm_file: finalBgm,
        bgm_volume: 0.3,
        cover: {
            headline: String(plan.cover?.headline || plan.title || 'Vlog').trim().slice(0, 20),
            subline: String(plan.cover?.subline || '').trim().slice(0, 30)
        },
        cta: {
            title: plan.cta?.title || '关注 @example',
            subtitle: plan.cta?.subtitle || ''
        },
        width: 1080,
        height: 1920,
        segments: cleaned,
        rationale: String(plan.rationale || '').trim()
    };
}

// ────────────────────────────── 4. 主入口 ──────────────────────────────

/**
 * 主生成函数
 * @returns {Promise<{ plans, rawOutput, materialCount, bgmCount }>}
 */
async function generatePlans({
    ingestPath,           // metadata.json 绝对路径
    theme,                // 用户主题
    idea,                 // 核心理念
    count = 3,
    duration = null,      // 目标总时长(秒),null = AI 自选
    style = null,         // 8 种风格之一,null = AI 选
    bgmHint = null,       // 指定 BGM 名(可选)
    projectRoot,
    options,              // { ollamaUrl, ollamaModel, ollamaTimeoutMs, ollamaRetries }
    onProgress
}) {
    if (!theme || !idea) throw new Error('theme 和 idea 必填');
    if (!ingestPath) throw new Error('ingestPath 必填');
    if (!projectRoot) throw new Error('projectRoot 必填');

    // 加载 context
    const materials = loadMaterialContext(ingestPath);
    if (!materials.length) throw new Error(`素材库为空(${ingestPath} 里没有可用 clip),请先跑 ingest`);

    const bgmLib = loadBgmLibrary(projectRoot);
    if (!bgmLib.length) throw new Error(`BGM 库为空(assets/bgm/ 下没有 mp3)`);

    const styles = loadStyles(projectRoot);
    let brand = null;
    try { brand = loadBrand(); } catch (_) { /* fallback 到 hardcode 默认 */ }

    const targetToneFilter = styles?.user_tone_filters?.[brand?.id || 'example']
        || styles?.user_tone_filters?.example
        || null;

    // 构造 prompt
    const systemPrompt = buildSystemPrompt({ brand, styles, targetToneFilter });
    const userPrompt = buildUserPrompt({
        theme, idea, duration, style, bgmHint, count,
        materials, bgmLib, stylesDoc: styles
    });

    if (onProgress) onProgress({ stage: 'llm_start', promptChars: systemPrompt.length + userPrompt.length });

    // 调 LLM
    const rawOutput = await callChat(options, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);

    if (onProgress) onProgress({ stage: 'llm_done', rawChars: rawOutput.length });

    // 解析
    const parsed = extractJson(rawOutput);
    if (!parsed) {
        const err = new Error('LLM 未能解析出 JSON');
        err.rawOutput = rawOutput;
        throw err;
    }

    const rawPlans = Array.isArray(parsed.plans) ? parsed.plans
        : (Array.isArray(parsed) ? parsed : null);
    if (!rawPlans) {
        const err = new Error('LLM 输出结构异常,没有 plans 数组');
        err.rawOutput = rawOutput;
        throw err;
    }

    // 校验 + 清洗
    const plans = [];
    for (let i = 0; i < rawPlans.length; i += 1) {
        const cleaned = validateAndCleanPlan(rawPlans[i], materials, bgmLib);
        if (cleaned) {
            cleaned.id = cleaned.id || `plan-${String(i + 1).padStart(2, '0')}`;
            plans.push(cleaned);
        }
    }

    if (!plans.length) {
        const err = new Error(`LLM 生成了 ${rawPlans.length} 个 plan 但全部校验失败(clip_id 不存在 / trim 超界 / 段数不足)`);
        err.rawOutput = rawOutput;
        err.rawPlans = rawPlans;
        throw err;
    }

    if (onProgress) onProgress({ stage: 'validated', plansGenerated: plans.length, rawCount: rawPlans.length });

    return {
        plans,
        rawOutput,
        materialCount: materials.length,
        bgmCount: bgmLib.length,
        rawCount: rawPlans.length
    };
}

module.exports = {
    generatePlans,
    loadMaterialContext,
    loadBgmLibrary,
    loadStyles,
    validateAndCleanPlan,
    extractJson
};
