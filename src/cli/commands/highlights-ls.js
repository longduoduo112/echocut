'use strict';

const fs = require('fs');
const path = require('path');
const { preflightCheck } = require('../../lib/preflight');
const { acquireLock } = require('../../lib/processLock');
const { Spinner, StepTimeline, formatDuration } = require('../../lib/cliUtils');
const cache = require('../../services/highlightsCache');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m'
};

function stars(score) {
    const full = Math.round(Math.max(0, Math.min(1, score || 0)) * 5);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDur(sec) {
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

function renderCandidates(candidates, opts = {}) {
    const minScore = Number(opts.minScore || 0);
    const filtered = candidates.filter((c) => (c.quality_score || 0) >= minScore);
    if (!filtered.length) {
        console.log(`\n${C.yellow}⚠${C.reset}  没有符合条件的候选片段 (minScore=${minScore})。`);
        return;
    }
    const totalDur = filtered.reduce((sum, c) => sum + (c.duration || 0), 0);
    console.log(`\n${C.bold}📋 候选精华片段${C.reset}  ${C.gray}(共 ${filtered.length} 个,总时长 ${fmtDur(totalDur)})${C.reset}`);
    console.log('');
    filtered
        .sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))
        .forEach((c, i) => {
            const scoreStars = stars(c.quality_score);
            const idLabel = C.dim + c.id + C.reset;
            const title = C.bold + c.title + C.reset;
            const time = `${fmtTime(c.start)} → ${fmtTime(c.end)}`;
            const dur = fmtDur(c.duration);
            console.log(`  ${idLabel}  ${C.yellow}${scoreStars}${C.reset} ${(c.quality_score || 0).toFixed(2)}  ${title}`);
            console.log(`       ${C.gray}${time}  ${dur}${C.reset}  ${C.cyan}${(c.tags || []).map((t) => '#' + t).join(' ')}${C.reset}`);
            if (c.context_note) console.log(`       ${C.gray}📍 ${c.context_note}${C.reset}`);
            if (c.narrative_arc) console.log(`       ${C.gray}🎬 ${c.narrative_arc}${C.reset}`);
            if (c.value_note) console.log(`       ${C.gray}💡 ${c.value_note}${C.reset}`);
            if (c.text_preview) console.log(`       ${C.dim}📝 ${c.text_preview}${C.reset}`);
            console.log('');
        });
}

module.exports = async function highlightsLs(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`${C.red}✗${C.reset} 找不到文件: ${abs}`);
        process.exit(1);
    }
    // 关键:切到项目根,否则 transcriber 解析 python/transcribe_mlx.py 会找错位置
    // (burn/V1 highlights 是 spawn 子进程 + cwd:root,V2 hls/hmk 是主进程直跑,必须 chdir)
    try { process.chdir(root); } catch (_) {}

    console.log(`\n${C.bold}${C.cyan}🎬 echocut highlights ls${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}   ${path.basename(abs)}`);

    // 检查缓存
    const { hash, dir } = cache.getCacheDir(abs, root);
    const fresh = !opts.rerun && cache.isCacheFresh(abs, dir);
    if (fresh) {
        const meta = cache.readMeta(dir);
        const candidates = (cache.readCandidates(dir) || {}).candidates || [];
        console.log(`   ${C.gray}缓存${C.reset}   ${C.green}命中${C.reset} ${dir}`);
        console.log(`   ${C.gray}分析于${C.reset} ${meta.analyzed_at || '?'}  ${C.gray}引擎${C.reset} ${meta.engine}/${meta.llm_model}`);
        renderCandidates(candidates, opts);
        console.log(`${C.gray}💡 产出指定片段:${C.reset}  ${C.cyan}echocut highlights make ${path.basename(abs)} --seg seg-01${C.reset}`);
        console.log(`${C.gray}   重新分析:${C.reset}      ${C.cyan}echocut highlights ls ${path.basename(abs)} --rerun${C.reset}\n`);
        return;
    }

    // 跑前守门
    preflightCheck(abs, { engine: opts.engine || 'mlx_hq' });
    try {
        acquireLock('highlights.lock', { allowWait: true });
    } catch (err) {
        console.error(`${C.red}✗${C.reset} ${err.message}`);
        process.exit(1);
    }

    // 延迟加载依赖(避免冷启动)
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const { transcribeByEngine } = require('../../video/asrAdapters');
    const { extractAudioFromVideo } = require('../../video/remotionRunner');
    const { stripHallucinatedLoop } = require('../../services/processor');
    const { segmentTranscriptV2 } = require('../../services/clipper');

    // 初始化 DB + 默认配置(callChat 需要,老命令 scripts/run-video-cases.js 做了)
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    // 检测部分缓存:transcript 已存在但 candidates 没有(上次 LLM 失败),跳过 extract+transcribe
    const partialTranscript = !opts.rerun && cache.readTranscript(dir);
    const hasFullCandidates = !opts.rerun && cache.readCandidates(dir);
    const skipTranscribe = !!partialTranscript && !hasFullCandidates && Array.isArray(partialTranscript.words) && partialTranscript.words.length > 50;
    const cacheStatus = opts.rerun ? '强制重跑'
        : skipTranscribe ? '部分命中(复用转写,重跑 LLM)'
        : '未命中';
    console.log(`   ${C.gray}缓存${C.reset}   ${cacheStatus} → 开始分析\n`);

    const timeline = new StepTimeline();
    const totalSteps = skipTranscribe ? 1 : 3;
    let step = 0;

    let words, fullText;
    const engine = opts.engine || 'mlx_hq';
    // spinner 在整函数作用域共用,避免 step 3 引用 block-scoped 变量崩
    let spinner;

    if (skipTranscribe) {
        words = partialTranscript.words;
        fullText = partialTranscript.fullText || '';
        console.log(`${C.gray}   [skip] extract + transcribe(复用上次缓存 ${words.length} words)${C.reset}\n`);
    } else {
        // Step 1: extract audio
        step += 1;
        spinner = new Spinner('extract audio', { step, total: totalSteps }).start();
        let audioPath;
        try {
            audioPath = await extractAudioFromVideo(abs, `highlights_ls_${hash}`, 0);
            spinner.stop();
            timeline.record('extract audio', spinner.elapsedMs);
        } catch (err) {
            spinner.fail();
            console.error(err.message);
            process.exit(1);
        }

        // Step 2: transcribe
        step += 1;
        spinner = new Spinner(`transcribe [${engine}]`, { step, total: totalSteps }).start();
        let transcribeResult;
        try {
            transcribeResult = await transcribeByEngine(audioPath, engine);
            spinner.stop(`(${transcribeResult.words.length} words)`);
            timeline.record(`transcribe [${engine}]`, spinner.elapsedMs, `${transcribeResult.words.length} words`);
        } catch (err) {
            spinner.fail();
            console.error(err.message);
            process.exit(1);
        }
        words = transcribeResult.words;
        fullText = stripHallucinatedLoop(String(transcribeResult.fullText || '').trim());
        if (!fullText || words.length < 50) {
            console.error(`${C.red}✗${C.reset} 转写内容太短(${words.length} words),不适合切片分析。`);
            process.exit(1);
        }
        // 立刻写转写缓存(哪怕后面 LLM 失败,下次也能复用 35s+50s 的转写成本)
        try {
            cache.writeTranscript(dir, { words, fullText, engine });
        } catch (cacheErr) {
            console.warn(`${C.yellow}⚠${C.reset} 转写缓存写入失败(不阻塞): ${cacheErr.message}`);
        }
    }

    // Step 3: LLM 自适应分段
    step += 1;
    spinner = new Spinner('LLM 话题边界识别 + 质量评分', { step, total: totalSteps }).start();
    let v2Result;
    try {
        v2Result = await segmentTranscriptV2(fullText, words, {
            ollamaUrl: _config.ollamaUrl,
            ollamaModel: _config.ollamaModel,
            ollamaTimeoutMs: 300000,  // v2.4 prompt 较长 + 内存紧时 Ollama 慢,3 分钟 timeout
            ollamaRetries: 1,  // 超时自动重试 1 次
            maxTextChars: 20000
        });
        spinner.stop(`(识别 ${v2Result.candidates.length} 个候选)`);
        timeline.record('LLM 分段', spinner.elapsedMs, `${v2Result.candidates.length} 候选`);
    } catch (err) {
        spinner.fail();
        console.error(`${C.red}✗${C.reset} LLM 分段失败: ${err.message}`);
        console.error(`${C.gray}   转写已缓存(下次 hls 会跳过转写直接重跑 LLM)${C.reset}`);
        process.exit(1);
    }

    // 写候选 + meta(原子写:tmp → rename)
    const durationSec = words.length ? (Number(words[words.length - 1].end) || 0) : 0;
    const meta = {
        schema_version: cache.SCHEMA_VERSION,
        prompt_version: cache.PROMPT_VERSION,
        video_path: abs,
        video_hash: hash,
        video_duration_sec: durationSec,
        analyzed_at: new Date().toISOString(),
        engine,
        llm_model: _config.ollamaModel,
        llm_reasoning: v2Result.reasoning
    };
    try {
        cache.writeMeta(dir, meta);
        cache.writeCandidates(dir, { candidates: v2Result.candidates });
    } catch (cacheErr) {
        console.warn(`${C.yellow}⚠${C.reset} 候选缓存写入失败: ${cacheErr.message}`);
    }

    // 时间线 + 候选列表
    console.log('\n' + timeline.summary());
    if (v2Result.reasoning) {
        console.log(`\n${C.gray}💭 LLM 推理:${C.reset} ${v2Result.reasoning}`);
    }
    renderCandidates(v2Result.candidates, opts);
    console.log(`${C.gray}💡 产出指定片段:${C.reset}  ${C.cyan}echocut highlights make ${path.basename(abs)} --seg seg-01${C.reset}`);
    console.log(`${C.gray}   产出 Top N:${C.reset}      ${C.cyan}echocut highlights make ${path.basename(abs)} --min-score 0.8${C.reset}`);
    console.log(`${C.gray}   缓存位置:${C.reset}         ${dir}\n`);
};
