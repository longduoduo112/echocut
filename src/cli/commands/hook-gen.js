'use strict';

/**
 * echocut hook-gen <file>
 *
 * 生成 5 个风格不同的前 3 秒钩子候选。
 * 对应品牌方案第 6 节缺陷 1("钩子太软")。
 *
 * 输入源优先级:
 *   --seg <id> + hls 缓存                  → 从 seg 切片的 transcript 生成(推荐)
 *   --from-hls (无 --seg)                  → 拿 hls 最高分 seg
 *   --transcript-file <path>               → 直接读 transcript.json
 *   --text "..."                           → 直接用文本
 *
 * 输出:默认打印到终端;--output <path> 保存 md。
 */

const fs = require('fs');
const path = require('path');
const { Spinner, StepTimeline } = require('../../lib/cliUtils');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', magenta: '\x1b[35m'
};

function extractSegmentText(words, startSec, endSec) {
    const buf = [];
    for (const w of words) {
        const s = Number(w.start) || 0;
        const e = Number(w.end) || 0;
        if (e < startSec) continue;
        if (s > endSec) break;
        buf.push(String(w.word ?? w.text ?? '').trim());
    }
    return buf.join('').replace(/\s+/g, '');
}

function readTranscriptJsonText(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof raw === 'string') return raw;
    if (raw.full_text) return String(raw.full_text);
    if (Array.isArray(raw.words)) return raw.words.map((w) => w.word || '').join('');
    if (Array.isArray(raw.segments)) return raw.segments.map((s) => s.text || '').join('');
    return '';
}

module.exports = async function hookGen(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    try { process.chdir(root); } catch (_) {}

    const { loadBrandFile } = require('../../services/brandLoader');
    const { generateHooks, generateHooksMultiRound } = require('../../services/hookGenerator');
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    // 解析输入源:text > transcript-file > file(hls cache)
    let rawText = '';
    let context = {};
    let sourceLabel = '';

    if (opts.text) {
        rawText = String(opts.text).trim();
        sourceLabel = 'text';
    } else if (opts.transcriptFile) {
        const abs = path.resolve(process.cwd(), opts.transcriptFile);
        if (!fs.existsSync(abs)) {
            console.error(`${C.red}✗${C.reset} transcript 文件不存在: ${abs}`);
            process.exit(1);
        }
        rawText = readTranscriptJsonText(abs);
        sourceLabel = path.basename(abs);
    } else if (file) {
        const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
        if (!fs.existsSync(abs)) {
            console.error(`${C.red}✗${C.reset} 找不到文件: ${abs}`);
            process.exit(1);
        }
        const cache = require('../../services/highlightsCache');
        const { dir } = cache.getCacheDir(abs, root);
        const transcript = cache.readTranscript(dir);
        const candidates = (cache.readCandidates(dir) || {}).candidates || [];
        if (!transcript) {
            console.error(`${C.red}✗${C.reset} 没有 hls 缓存。先跑:`);
            console.error(`   ${C.cyan}echocut hls ${path.basename(abs)}${C.reset}`);
            console.error(`   (或者用 --transcript-file <path> / --text "...")\n`);
            process.exit(1);
        }

        let seg = null;
        if (opts.seg) {
            const wanted = /^\d+$/.test(opts.seg) ? `seg-${String(opts.seg).padStart(2, '0')}` : opts.seg;
            seg = candidates.find((c) => c.id === wanted);
            if (!seg) {
                console.error(`${C.red}✗${C.reset} 候选不存在: ${wanted}`);
                console.error(`   可选: ${candidates.map((c) => c.id).join(', ')}\n`);
                process.exit(1);
            }
        } else if (candidates.length) {
            // 最高分
            seg = [...candidates].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
        }

        if (seg) {
            rawText = extractSegmentText(transcript.words, seg.start, seg.end);
            context = {
                title: seg.title || seg.suggested_headline,
                context_note: seg.context_note,
                value_note: seg.value_note,
                hook_type: seg.hook_type,
                tags: seg.tags
            };
            sourceLabel = `${path.basename(abs)} · ${seg.id}`;
        } else {
            // 没有 seg,用全文
            rawText = transcript.full_text || (transcript.words || []).map((w) => w.word || '').join('');
            sourceLabel = `${path.basename(abs)} · 全片`;
        }
    } else {
        console.error(`${C.red}✗${C.reset} 需要输入源: <file>(hls 缓存) / --transcript-file / --text`);
        process.exit(1);
    }

    if (!rawText || rawText.length < 50) {
        console.error(`${C.red}✗${C.reset} 文本太短(${rawText.length} 字),无法生成钩子`);
        process.exit(1);
    }

    // 太长裁剪(避免 LLM 超时);钩子只需要看前中后即可
    const MAX_CHARS = 2500;
    if (rawText.length > MAX_CHARS) {
        const head = rawText.slice(0, Math.floor(MAX_CHARS * 0.6));
        const tail = rawText.slice(-Math.floor(MAX_CHARS * 0.35));
        rawText = `${head}\n...(中略)...\n${tail}`;
    }

    // brand 加载(用于 persona,hookGenerator 内部会 loadBrand)
    const brandId = opts.brand || process.env.ZDE_DEFAULT_BRAND || 'example';
    let brand = null;
    try { brand = loadBrandFile(brandId); } catch (err) {
        console.warn(`${C.yellow}⚠${C.reset} 品牌 ${brandId} 加载失败: ${err.message}`);
    }

    const modelOverride = opts.model && String(opts.model).trim();
    const ollamaModel = modelOverride || _config.ollamaModel;

    console.log(`\n${C.bold}${C.magenta}🎣 echocut hook-gen${C.reset}`);
    console.log(`   ${C.gray}输入${C.reset}    ${sourceLabel}`);
    console.log(`   ${C.gray}长度${C.reset}    ${rawText.length} 字`);
    if (brand) console.log(`   ${C.gray}品牌${C.reset}    ${C.green}${brand.id}${C.reset} — ${brand.displayName || brand.identity?.name || ''}`);
    console.log(`   ${C.gray}模型${C.reset}    ${ollamaModel}${modelOverride ? ' (手动指定)' : ''}`);
    if (context.hook_type) console.log(`   ${C.gray}语境${C.reset}    hook=${context.hook_type}  ${context.context_note || ''}`);
    console.log('');

    const timeline = new StepTimeline();
    const rounds = Math.max(1, Number(opts.rounds || 1));
    const spinner = new Spinner(
        rounds === 1 ? '生成钩子候选' : `A/B 模式 · ${rounds} 轮 × 5 候选,去重取 Top 5`
    ).start();
    let result = null;
    try {
        if (rounds > 1) {
            result = await generateHooksMultiRound({
                rawText,
                context,
                options: {
                    ollamaUrl: _config.ollamaUrl,
                    ollamaModel,
                    ollamaTimeoutMs: 300000,
                    ollamaRetries: 1
                },
                rounds,
                topK: 5,
                onRoundDone: (r, n, total) => {
                    // 更新 spinner 副文 — 通过直接 log 一行(Spinner 无原生接口)
                    // 不打断主 spinner,这里省略
                }
            });
            spinner.stop(`${result.hooks.length} 个去重后 Top 5(从 ${result.allHooks.length} 个原始候选里挑)`);
        } else {
            result = await generateHooks({
                rawText,
                context,
                options: {
                    ollamaUrl: _config.ollamaUrl,
                    ollamaModel,
                    ollamaTimeoutMs: 300000,
                    ollamaRetries: 1
                }
            });
            spinner.stop(`${result.hooks.length} 个候选`);
        }
        timeline.record(rounds > 1 ? `hook-gen ×${rounds}` : 'hook-gen', spinner.elapsedMs, `${result.hooks.length} 个`);
    } catch (err) {
        spinner.fail(String(err.message || err).slice(0, 120));
        process.exit(1);
    }

    if (!result.hooks.length) {
        console.error(`${C.red}✗${C.reset} LLM 输出未能解析出任何候选。原始输出:\n${result.rawOutput}\n`);
        process.exit(1);
    }

    console.log('');
    const mdParts = [];
    mdParts.push(`# 钩子候选 · ${new Date().toISOString()}`);
    mdParts.push('');
    mdParts.push(`- 输入: ${sourceLabel}`);
    mdParts.push(`- 品牌: ${brand?.id || 'unknown'}`);
    mdParts.push(`- 模型: ${ollamaModel}`);
    if (context.hook_type) mdParts.push(`- seg.hook_type: ${context.hook_type}`);
    mdParts.push('');

    for (const h of result.hooks) {
        console.log(`${C.bold}━━━ 候选 #${h.idx} · ${h.name} ━━━${C.reset}`);
        console.log(`   ${C.cyan}${h.text}${C.reset}`);
        console.log('');
        mdParts.push(`## #${h.idx} ${h.name}`);
        mdParts.push('');
        mdParts.push(h.text);
        mdParts.push('');
    }

    console.log(`${C.gray}使用:${C.reset}`);
    console.log(`   echocut burn xxx.mp4 --headline "<选中的钩子>"`);
    console.log(`   echocut afc xxx.mp4 --cta "<选中的钩子>"`);
    console.log('');
    console.log(timeline.summary());

    if (opts.output) {
        const outPath = path.resolve(process.cwd(), opts.output);
        fs.writeFileSync(outPath, mdParts.join('\n'), 'utf8');
        console.log(`\n${C.green}✓${C.reset} 保存到: ${outPath}`);
    }
};
