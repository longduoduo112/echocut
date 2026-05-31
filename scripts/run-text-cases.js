const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs } = require('../src/db/configRepo');
const { processOriginalThought } = require('../src/services/processor');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resolveArg(name) {
    const match = process.argv.find((x) => x.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : '';
}

async function main() {
    const config = getConfig();
    initDb(config.contentDbPath);
    ensureDefaultConfigs();
    const textArg = resolveArg('--text');
    const titleArg = resolveArg('--title') || 'inline';
    const caseFileArg = resolveArg('--case-file');
    const caseFile = path.resolve(process.cwd(), caseFileArg || path.join('testcases', 'text-cases.json'));
    const cases = textArg
        ? [{ id: `inline_${Date.now()}`, title: titleArg, input: textArg }]
        : JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(process.cwd(), 'debug_outputs', 'text', runId);
    ensureDir(outputDir);

    console.log(`text cases: ${cases.length}`);
    console.log(`model: ${config.ollamaModel}`);
    console.log(`output: ${outputDir}`);

    for (const item of cases) {
        const startedAt = Date.now();
        console.log(`\n[${item.id}] start`);
        const output = await processOriginalThought(item.input, config);
        const usedMs = Date.now() - startedAt;
        const result = {
            id: item.id,
            title: item.title,
            elapsed_ms: usedMs,
            input: item.input,
            output
        };
        fs.writeFileSync(
            path.join(outputDir, `${item.id}.json`),
            JSON.stringify(result, null, 2),
            'utf8'
        );
        console.log(`[${item.id}] done ${usedMs}ms`);
    }

    console.log('\ntext cases completed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
