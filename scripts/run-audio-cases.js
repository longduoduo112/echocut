const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs } = require('../src/db/configRepo');
const { transcribeAudio } = require('../src/services/transcriber');
const { processOriginalThought } = require('../src/services/processor');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function getAudioFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    const files = fs.readdirSync(dirPath);
    return files
        .filter((name) => /\.(ogg|mp3|m4a|wav)$/i.test(name))
        .map((name) => path.join(dirPath, name));
}

function resolveArg(name) {
    const match = process.argv.find((x) => x.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : '';
}

function asPositiveInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.floor(n));
}

async function main() {
    const config = getConfig();
    initDb(config.contentDbPath);
    ensureDefaultConfigs();
    const withLlm = process.argv.includes('--with-llm');
    const fileArg = resolveArg('--file');
    const dirArg = resolveArg('--dir');
    const limit = asPositiveInt(resolveArg('--limit'), 200);
    const audioDir = path.resolve(process.cwd(), dirArg || 'audio_inputs');
    const files = fileArg
        ? [path.resolve(process.cwd(), fileArg)]
        : getAudioFiles(audioDir).slice(0, limit);
    if (!files.length) {
        console.log('no audio files found');
        return;
    }

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(process.cwd(), 'debug_outputs', 'audio', runId);
    ensureDir(outputDir);

    console.log(`audio files: ${files.length}`);
    console.log(`with llm: ${withLlm ? 'yes' : 'no'}`);
    console.log(`output: ${outputDir}`);

    for (const fullPath of files) {
        const fileName = path.basename(fullPath);
        const startedAt = Date.now();
        console.log(`\n[${fileName}] transcribe start`);
        const { words, fullText, stderr, transcribeMs } = await transcribeAudio(fullPath, config);
        const result = {
            file: fileName,
            elapsed_ms: Date.now() - startedAt,
            transcribe_ms: transcribeMs,
            words_count: words.length,
            char_count: fullText.length,
            stderr: stderr || '',
            transcript_preview: fullText.slice(0, 500),
            transcript: fullText
        };

        if (withLlm && fullText) {
            console.log(`[${fileName}] llm start`);
            const generated = await processOriginalThought(fullText, config);
            result.generated = generated;
            console.log(`[${fileName}] llm done`);
        }

        fs.writeFileSync(
            path.join(outputDir, `${fileName}.json`),
            JSON.stringify(result, null, 2),
            'utf8'
        );
        console.log(`[${fileName}] done ${result.elapsed_ms}ms`);
    }

    console.log('\naudio cases completed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
