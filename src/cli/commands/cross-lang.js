'use strict';

/**
 * echocut cross-lang <file>
 *
 * 中文视频/seg → 英文 Twitter thread + 英文文章 + 英文钩子(品牌方案 7.3)
 *
 * 输入源:同 afc / distribute / hook-gen
 * 产出:<seg-dir>/crosslang/en-hooks.md / en-twitter-thread.md / en-article.md / bundle.json
 */

const fs = require('fs');
const path = require('path');
const { Spinner, StepTimeline } = require('../../lib/cliUtils');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[94m', magenta: '\x1b[35m'
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

module.exports = async function crossLang(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    try { process.chdir(root); } catch (_) {}

    const { loadBrandFile } = require('../../services/brandLoader');
    const { generateCrossLangBundle, renderHooksMd, renderThreadMd, renderArticleMd } = require('../../services/crossLangGenerator');
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    let rawText = '';
    let context = {};
    let sourceLabel = '';
    let outputDirDefault = path.resolve(process.cwd(), `crosslang-${Date.now()}`);

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
            seg = [...candidates].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))[0];
        }

        if (seg) {
            rawText = extractSegmentText(transcript.words, seg.start, seg.end);
            context = {
                title: seg.title || seg.suggested_headline,
                context_note: seg.context_note,
                value_note: seg.value_note,
                hook_type: seg.hook_type,
                narrative_arc: seg.narrative_arc,
                tags: seg.tags
            };
            sourceLabel = `${path.basename(abs)} · ${seg.id}`;
            outputDirDefault = path.join(cache.getProductDir(dir, seg.id), 'crosslang');
        } else {
            rawText = transcript.full_text || (transcript.words || []).map((w) => w.word || '').join('');
            sourceLabel = `${path.basename(abs)} · full`;
        }
    } else {
        console.error(`${C.red}✗${C.reset} 需要输入源: <file>(hls 缓存) / --transcript-file / --text`);
        process.exit(1);
    }

    if (!rawText || rawText.length < 100) {
        console.error(`${C.red}✗${C.reset} 文本太短(${rawText.length} 字),cross-lang 需要 >= 100 字`);
        process.exit(1);
    }
    const MAX_CHARS = 2500;
    if (rawText.length > MAX_CHARS) {
        const head = rawText.slice(0, Math.floor(MAX_CHARS * 0.6));
        const tail = rawText.slice(-Math.floor(MAX_CHARS * 0.35));
        rawText = `${head}\n...(mid略)...\n${tail}`;
    }

    const brandId = opts.brand || process.env.ZDE_DEFAULT_BRAND || 'example';
    let brand = null;
    try { brand = loadBrandFile(brandId); } catch (err) {
        console.warn(`${C.yellow}⚠${C.reset} 品牌 ${brandId} 加载失败: ${err.message}`);
    }

    const { LANG_PROFILES, getLangProfile } = require('../../services/crossLangGenerator');
    const targetLang = String(opts.targetLang || 'en').toLowerCase();
    if (!LANG_PROFILES[targetLang]) {
        console.error(`${C.red}✗${C.reset} 不支持的目标语言: ${targetLang}(当前支持: ${Object.keys(LANG_PROFILES).join(', ')})`);
        process.exit(1);
    }
    const langProfile = getLangProfile(targetLang);
    const modelOverride = opts.model && String(opts.model).trim();
    const ollamaModel = modelOverride || _config.ollamaModel;
    // 默认目录带上语言后缀,避免多语种互相覆盖
    if (!opts.outputDir && targetLang !== 'en') {
        outputDirDefault = outputDirDefault.replace(/\/crosslang$/, `/crosslang-${targetLang}`);
    }
    const outputDir = opts.outputDir ? path.resolve(process.cwd(), opts.outputDir) : outputDirDefault;

    const brandTagline = brand?.identity?.[langProfile.taglineKey] || langProfile.taglineFallback;

    console.log(`\n${C.bold}${C.blue}🌍 echocut cross-lang  (中 → ${langProfile.name})${C.reset}`);
    console.log(`   ${C.gray}输入${C.reset}    ${sourceLabel}`);
    console.log(`   ${C.gray}长度${C.reset}    ${rawText.length} 字`);
    console.log(`   ${C.gray}目标${C.reset}    ${C.cyan}${langProfile.name}${C.reset} (${targetLang})`);
    if (brand) console.log(`   ${C.gray}品牌${C.reset}    ${C.green}${brand.id}${C.reset} — tagline: ${brandTagline}`);
    console.log(`   ${C.gray}模型${C.reset}    ${ollamaModel}${modelOverride ? ' (手动指定)' : ''}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputDir}`);
    console.log('');

    const timeline = new StepTimeline();
    let spinner = new Spinner(`Stage 1 翻译中文 → ${langProfile.name}(避免小模型 bias 回中文)`).start();
    let result = null;
    try {
        result = await generateCrossLangBundle({
            rawText,
            context,
            brand,
            targetLang,
            options: {
                ollamaUrl: _config.ollamaUrl,
                ollamaModel,
                ollamaTimeoutMs: 420000,
                ollamaRetries: 1
            },
            onProgress: (stage) => {
                if (stage === 'stage2:bundle') {
                    spinner.stop(`翻译完成(${result && result.targetSource ? result.targetSource.length : '?'} chars source)`);
                    timeline.record('stage1 translate', spinner.elapsedMs, `${targetLang}-source`);
                    spinner = new Spinner(`Stage 2 基于 ${langProfile.name} 原稿生成 bundle`).start();
                }
            }
        });
        const bundle = result.bundle;
        spinner.stop(`hooks ${bundle.hooks.length} · thread ${bundle.twitter_thread.length} 条 · article ${bundle.article.length} chars`);
        timeline.record('stage2 bundle', spinner.elapsedMs, `${bundle.hooks.length}+${bundle.twitter_thread.length}`);
    } catch (err) {
        spinner.fail(String(err.message || err).slice(0, 120));
        if (err.rawOutput) {
            try {
                fs.mkdirSync(outputDir, { recursive: true });
                const dumpPath = path.join(outputDir, 'error-raw.txt');
                fs.writeFileSync(dumpPath, err.rawOutput, 'utf8');
                console.error(`${C.gray}—— 完整原始输出已存:${C.reset} ${dumpPath}`);
            } catch (_) {}
            console.error(`${C.gray}—— 末尾 300 字:${C.reset}\n${err.rawOutput.slice(-300)}\n`);
        }
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const bundle = result.bundle;
    const prefix = targetLang; // en / ja / es
    fs.writeFileSync(path.join(outputDir, `${prefix}-hooks.md`), renderHooksMd(bundle, context), 'utf8');
    fs.writeFileSync(path.join(outputDir, `${prefix}-twitter-thread.md`), renderThreadMd(bundle, context), 'utf8');
    fs.writeFileSync(path.join(outputDir, `${prefix}-article.md`), renderArticleMd(bundle, context), 'utf8');
    if (result.targetSource) {
        fs.writeFileSync(path.join(outputDir, `${prefix}-source.md`),
            `# ${langProfile.name} Source (Stage 1 translation)\n\n${result.targetSource}\n`, 'utf8');
    }

    const bundleJson = {
        generated_at: new Date().toISOString(),
        source: sourceLabel,
        brand: brand?.id || null,
        model: ollamaModel,
        language: targetLang,
        context,
        bundle
    };
    fs.writeFileSync(path.join(outputDir, 'bundle.json'), JSON.stringify(bundleJson, null, 2), 'utf8');

    console.log('');
    console.log(`${C.bold}━━━ ${langProfile.name} Hooks ━━━${C.reset}`);
    bundle.hooks.forEach((h, i) => console.log(`  #${i + 1}  ${C.cyan}${h}${C.reset}`));
    console.log('');
    console.log(`${C.bold}━━━ Twitter Thread 第 1 条 ━━━${C.reset}`);
    console.log(`  ${bundle.twitter_thread[0] || '(empty)'}`);
    console.log('');
    console.log(timeline.summary());
    console.log(`\n${C.green}✓${C.reset} cross-lang (→ ${langProfile.name}) 完成。产出:`);
    console.log(`   ${C.cyan}${outputDir}/${C.reset}`);
    console.log(`   └─ ${prefix}-hooks.md / ${prefix}-twitter-thread.md / ${prefix}-article.md / bundle.json\n`);
};
