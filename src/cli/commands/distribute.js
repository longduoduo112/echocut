'use strict';

/**
 * echocut distribute <file>
 *
 * 一次成片 → 六平台独立分发包(抖音/快手/小红书/视频号/公众号/Twitter)。
 * 每平台独立标题/描述/hashtag/发布建议/封面建议。
 *
 * 输入源优先级:
 *   --seg <id> + hls 缓存          从指定 seg 生成(推荐,语境完整)
 *   无 --seg (有 hls)              最高分 seg
 *   --transcript-file <path>       直接读转写(免 hls)
 *   --text "..."                   直接从纯文本
 *
 * 产出:
 *   --output-dir <dir>             默认 ./distribute_pack-<hash-or-timestamp>/
 *     ├─ douyin.md
 *     ├─ kuaishou.md
 *     ├─ xhs.md
 *     ├─ channel.md
 *     ├─ gzh.md
 *     ├─ twitter.md
 *     └─ pack.json                 机器可读结构
 */

const fs = require('fs');
const path = require('path');
const { Spinner, StepTimeline } = require('../../lib/cliUtils');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m'
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

module.exports = async function distribute(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    try { process.chdir(root); } catch (_) {}

    const { loadBrandFile } = require('../../services/brandLoader');
    const { generateDistributePack, renderPlatformMarkdown, PLATFORMS } = require('../../services/distributeGenerator');
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    let rawText = '';
    let context = {};
    let sourceLabel = '';
    let outputDirDefault = path.resolve(process.cwd(), `distribute_pack-${Date.now()}`);

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
            // 默认输出目录:和 hmk/afc 成片并列,放 products/<seg-id>/distribute/
            outputDirDefault = path.join(cache.getProductDir(dir, seg.id), 'distribute');
        } else {
            rawText = transcript.full_text || (transcript.words || []).map((w) => w.word || '').join('');
            sourceLabel = `${path.basename(abs)} · 全片`;
        }
    } else {
        console.error(`${C.red}✗${C.reset} 需要输入源: <file>(hls 缓存) / --transcript-file / --text`);
        process.exit(1);
    }

    if (!rawText || rawText.length < 100) {
        console.error(`${C.red}✗${C.reset} 文本太短(${rawText.length} 字),无法生成分发包`);
        process.exit(1);
    }
    const MAX_CHARS = 2500;
    if (rawText.length > MAX_CHARS) {
        const head = rawText.slice(0, Math.floor(MAX_CHARS * 0.6));
        const tail = rawText.slice(-Math.floor(MAX_CHARS * 0.35));
        rawText = `${head}\n...(中略)...\n${tail}`;
    }

    const brandId = opts.brand || process.env.ZDE_DEFAULT_BRAND || 'example';
    let brand = null;
    try { brand = loadBrandFile(brandId); } catch (err) {
        console.warn(`${C.yellow}⚠${C.reset} 品牌 ${brandId} 加载失败: ${err.message}`);
    }

    const modelOverride = opts.model && String(opts.model).trim();
    const ollamaModel = modelOverride || _config.ollamaModel;

    const outputDir = opts.outputDir ? path.resolve(process.cwd(), opts.outputDir) : outputDirDefault;

    console.log(`\n${C.bold}${C.magenta}📦 echocut distribute${C.reset}`);
    console.log(`   ${C.gray}输入${C.reset}    ${sourceLabel}`);
    console.log(`   ${C.gray}长度${C.reset}    ${rawText.length} 字`);
    if (brand) console.log(`   ${C.gray}品牌${C.reset}    ${C.green}${brand.id}${C.reset} — ${brand.displayName || brand.identity?.name || ''}`);
    console.log(`   ${C.gray}模型${C.reset}    ${ollamaModel}${modelOverride ? ' (手动指定)' : ''}`);
    console.log(`   ${C.gray}平台${C.reset}    ${PLATFORMS.map((p) => p.key).join(' / ')}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputDir}`);
    console.log('');

    // 先做 pillar 分类(启发式,瞬时),把结果作为加权提示喂给 LLM
    const { classifySeg, rankPlatforms, PILLAR_INFO } = require('../../lib/pillarClassifier');
    const preClass = classifySeg(context);
    const preRanking = rankPlatforms(preClass.pillar);
    const preTop = preRanking.slice(0, 2).map((r) => r.platform);
    const pillarHint = {
        pillar: preClass.pillar,
        pillarName: (PILLAR_INFO[preClass.pillar] || {}).name || '',
        topPlatforms: preTop,
        confidence: preClass.confidence
    };

    const timeline = new StepTimeline();
    const spinner = new Spinner(`一次 LLM 调用,生成 6 平台分发包(pillar ${preClass.pillar} · 主战场 ${preTop.join('/')})`).start();
    let result = null;
    try {
        result = await generateDistributePack({
            rawText,
            context,
            brand,
            pillarHint,
            options: {
                ollamaUrl: _config.ollamaUrl,
                ollamaModel,
                ollamaTimeoutMs: 420000,
                ollamaRetries: 1
            }
        });
        spinner.stop(`解析完成,${Object.keys(result.pack).length} 个平台`);
        timeline.record('distribute', spinner.elapsedMs, `${Object.keys(result.pack).length} 平台`);
    } catch (err) {
        spinner.fail(String(err.message || err).slice(0, 120));
        if (err.rawOutput) {
            // 完整 rawOutput dump 到 outputDir 供排查
            try {
                fs.mkdirSync(outputDir, { recursive: true });
                const dumpPath = path.join(outputDir, 'error-raw.txt');
                fs.writeFileSync(dumpPath, err.rawOutput, 'utf8');
                console.error(`${C.gray}—— 完整原始输出已存:${C.reset} ${dumpPath}  (${err.rawOutput.length} 字)`);
            } catch (_) {}
            console.error(`${C.gray}—— 原始输出末尾 300 字:${C.reset}\n${err.rawOutput.slice(-300)}\n`);
        }
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const { renderPillarMd } = require('../../lib/pillarClassifier');
    // 复用前面 pre-classify 的结果(避免重复计算和 require)
    const classification = preClass;
    const summaryLines = [];
    summaryLines.push(`# 分发包 · ${new Date().toISOString()}`);
    summaryLines.push('');
    summaryLines.push(`- 输入: ${sourceLabel}`);
    summaryLines.push(`- 品牌: ${brand?.id || 'unknown'}`);
    summaryLines.push(`- 模型: ${ollamaModel}`);
    if (context.hook_type) summaryLines.push(`- hook_type: ${context.hook_type}`);
    summaryLines.push('');
    summaryLines.push(renderPillarMd(classification));
    summaryLines.push('');
    summaryLines.push('## 各平台速查表(顶标)');
    summaryLines.push('');

    for (const p of PLATFORMS) {
        const data = result.pack[p.key];
        if (!data) continue;
        const mdPath = path.join(outputDir, `${p.key}.md`);
        fs.writeFileSync(mdPath, renderPlatformMarkdown(p.key, data), 'utf8');
        const firstTitle = (data.titles[0] || '(无标题)').slice(0, 40);
        summaryLines.push(`- **${p.name}** (\`${p.key}.md\`): ${firstTitle}`);
    }
    summaryLines.push('');

    // 机器可读 pack.json
    const packJson = {
        generated_at: new Date().toISOString(),
        source: sourceLabel,
        brand: brand?.id || null,
        model: ollamaModel,
        context,
        platforms: result.pack
    };
    fs.writeFileSync(path.join(outputDir, 'pack.json'), JSON.stringify(packJson, null, 2), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'README.md'), summaryLines.join('\n'), 'utf8');

    console.log('');
    // pillar 提示(复用前面 pre-classify 的变量,避免重新 require)
    const info = PILLAR_INFO[classification.pillar] || PILLAR_INFO.A;
    const ranking = preRanking;
    const topPlatforms = preTop.join('/');
    console.log(`${C.gray}内容支柱${C.reset}  ${info.emoji} ${C.bold}Pillar ${classification.pillar} · ${info.name}${C.reset}  ${C.gray}(${classification.reason}, 置信度 ${classification.confidence})${C.reset}`);
    console.log(`${C.gray}建议主战场${C.reset}  ${C.bold}${topPlatforms}${C.reset}  ${C.gray}(README.md 有完整优先级表)${C.reset}`);
    console.log('');
    for (const p of PLATFORMS) {
        const data = result.pack[p.key];
        if (!data) continue;
        const t = data.titles[0] || '(空)';
        const color = {
            douyin: C.red, kuaishou: C.yellow, xhs: C.magenta,
            channel: C.green, gzh: C.cyan, twitter: '\x1b[94m'
        }[p.key] || C.cyan;
        const isTop = ranking.slice(0, 2).some((r) => r.platform === p.key);
        const star = isTop ? ' ⭐' : '';
        console.log(`${color}● ${p.name}${C.reset}${star}  ${t.slice(0, 50)}${t.length > 50 ? '…' : ''}`);
    }
    console.log('');
    console.log(timeline.summary());
    console.log(`\n${C.green}✓${C.reset} distribute 完成。产出:`);
    console.log(`   ${C.cyan}${outputDir}/${C.reset}`);
    console.log(`   └─ ${PLATFORMS.map((p) => p.key + '.md').join(' / ')}\n`);
};
