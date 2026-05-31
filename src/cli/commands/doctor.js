const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

function ok(msg) { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function fail(msg) { console.log(`  ${C.red}✗${C.reset} ${msg}`); }
function warn(msg) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); }
function info(msg) { console.log(`  ${C.gray}·${C.reset} ${msg}`); }
function section(title) { console.log(`\n${C.bold}${title}${C.reset}`); }

function fetchJson(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

module.exports = async function doctor(opts = {}) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    try {
        require('dotenv').config({ path: path.join(root, '.env') });
    } catch (_) { /* 允许 dotenv 缺失 */ }

    let issues = 0;
    let warnings = 0;

    console.log(`\n${C.bold}${C.cyan}🩺  echocut doctor${C.reset}  ${C.gray}(${root})${C.reset}`);

    section('Node.js');
    const [maj] = process.versions.node.split('.').map(Number);
    if (maj >= 18) ok(`Node ${process.versions.node}`);
    else { fail(`Node ${process.versions.node} 太旧,要求 ≥ 18`); issues++; }

    section('FFmpeg');
    try {
        const v = execSync('ffmpeg -version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n')[0];
        ok(v);
    } catch {
        fail('ffmpeg 未安装(brew install ffmpeg)');
        issues++;
    }

    section('Python 环境');
    const venv = path.join(root, '.venv/bin/python');
    if (fs.existsSync(venv)) {
        try {
            const v = execSync(`"${venv}" --version`, { encoding: 'utf8' }).trim();
            ok(`${v} @ .venv`);
        } catch {
            fail('.venv Python 不可执行');
            issues++;
        }
    } else {
        fail('.venv 不存在 — 运行 npm run setup:python');
        issues++;
    }

    section('Ollama');
    const tags = await fetchJson('http://127.0.0.1:11434/api/tags');
    if (tags && Array.isArray(tags.models)) {
        ok(`API 可达,已安装 ${tags.models.length} 个模型`);
        const need = (process.env.OLLAMA_MODEL || 'qwen3.5:9b').trim();
        const hit = tags.models.some((m) => m.name === need || m.model === need);
        if (hit) ok(`默认模型存在: ${need}`);
        else { warn(`默认模型未安装: ${need}(ollama pull ${need})`); warnings++; }
    } else {
        fail('Ollama API 不可达 — 启动 Ollama 或检查 NO_PROXY=127.0.0.1');
        issues++;
    }

    section('内存');
    const totalGb = os.totalmem() / 1024 / 1024 / 1024;
    // macOS 上 os.freemem() 不靠谱(只算完全空闲页),用 getAvailableMemoryGB 才对得上 Activity Monitor
    const { getAvailableMemoryGB } = require('../../lib/preflight');
    const availGb = getAvailableMemoryGB();
    info(`总内存 ${totalGb.toFixed(0)} GB / 可用 ${availGb.toFixed(1)} GB(含可回收 cache)`);
    if (availGb < 2) { warn('可用 < 2 GB,MLX HQ 可能 OOM — 关掉其他程序或用 --preview'); warnings++; }
    else if (availGb < 4) { warn('可用 < 4 GB,大文件建议先关几个占用大的进程'); warnings++; }
    else ok('内存充足');

    section('MiniMax');
    const key = process.env.MINIMAX_API_KEY;
    if (key) {
        ok(`MINIMAX_API_KEY 已设置(${key.slice(0, 8)}***${key.slice(-4)})`);
        if (opts.minimax) info('--minimax 探活待 issue #6 落地后实现');
    } else {
        info('MINIMAX_API_KEY 未设置(本地能力够用时非必需)');
    }

    section('目录');
    for (const d of ['debug_outputs', 'tmp', 'public/generated_videos']) {
        const abs = path.join(root, d);
        try {
            fs.mkdirSync(abs, { recursive: true });
            fs.accessSync(abs, fs.constants.W_OK);
            ok(`${d} 可写`);
        } catch {
            fail(`${d} 不可写`);
            issues++;
        }
    }

    console.log('');
    if (issues === 0 && warnings === 0) {
        console.log(`${C.green}${C.bold}✓ 所有检查通过${C.reset}\n`);
    } else if (issues === 0) {
        console.log(`${C.yellow}${C.bold}⚠ ${warnings} 条提示,可继续${C.reset}\n`);
    } else {
        console.log(`${C.red}${C.bold}✗ ${issues} 个问题需要处理(${warnings} 条提示)${C.reset}\n`);
        process.exit(1);
    }
};
