const fs = require('fs');
const path = require('path');
const { transcribeByEngine } = require('../src/video/asrAdapters');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
}

function overlapScore(a, b) {
    const x = normalizeText(a);
    const y = normalizeText(b);
    if (!x.length || !y.length) return 0;
    const set = new Set(x.split(''));
    let hit = 0;
    for (const ch of y) if (set.has(ch)) hit += 1;
    return Number((hit / y.length).toFixed(4));
}

async function runOnce(engine, audioFile) {
    const startedAt = Date.now();
    const { words, fullText, transcribeMs, stderr, usedEngine, usedScript, usedModel } = await transcribeByEngine(audioFile, engine);
    return {
        engine,
        usedEngine,
        usedScript,
        usedModel,
        elapsedMs: Date.now() - startedAt,
        transcribeMs,
        words: words.length,
        chars: fullText.length,
        fullText,
        stderr
    };
}

function parseEngineList() {
    const engineArg = process.argv.find((x) => x.startsWith('--engines='));
    const raw = engineArg ? engineArg.slice('--engines='.length) : 'whisperx,mlx,funasr';
    const candidates = raw.split(',').map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
    const normalized = candidates.map((item) => (item === 'sensevoice' ? 'sensevoice' : item));
    const unique = [];
    for (const item of normalized) {
        if (!unique.includes(item)) unique.push(item);
    }
    return unique.length ? unique : ['whisperx', 'mlx', 'funasr'];
}

async function main() {
    const fileArg = process.argv.find((x) => x.startsWith('--file='));
    if (!fileArg) {
        throw new Error('请传入 --file=/absolute/or/relative/audio/path');
    }
    const audioFile = path.resolve(process.cwd(), fileArg.slice('--file='.length));
    if (!fs.existsSync(audioFile)) {
        throw new Error(`音频文件不存在: ${audioFile}`);
    }

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(process.cwd(), 'debug_outputs', 'benchmark', runId);
    ensureDir(outputDir);

    console.log(`benchmark audio: ${audioFile}`);
    const engines = parseEngineList();
    console.log(`benchmark engines: ${engines.join(', ')}`);
    const runs = [];
    const failures = [];
    for (const engine of engines) {
        try {
            const one = await runOnce(engine, audioFile);
            runs.push(one);
            fs.writeFileSync(path.join(outputDir, `${engine}.json`), JSON.stringify(one, null, 2), 'utf8');
        } catch (error) {
            failures.push({ engine, reason: String(error.message || error) });
        }
    }
    if (!runs.length) {
        throw new Error(`所有引擎执行失败: ${failures.map((x) => `${x.engine}:${x.reason}`).join(' | ')}`);
    }
    const winner = runs.slice().sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
    const overlapWithBest = Object.fromEntries(
        runs.map((run) => [run.engine, overlapScore(winner.fullText, run.fullText)])
    );
    const result = {
        audioFile,
        runId,
        engines,
        runs: runs.map((run) => ({
            engine: run.engine,
            usedEngine: run.usedEngine,
            usedScript: run.usedScript,
            usedModel: run.usedModel,
            elapsedMs: run.elapsedMs,
            transcribeMs: run.transcribeMs,
            words: run.words,
            chars: run.chars
        })),
        overlapWithLatencyWinner: overlapWithBest,
        winnerByLatency: winner.engine,
        failures
    };

    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

    console.log(JSON.stringify(result, null, 2));
    console.log(`output: ${outputDir}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
