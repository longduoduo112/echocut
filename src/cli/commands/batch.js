const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

function listVideos(dirPath, recursive) {
    if (!fs.existsSync(dirPath)) return [];
    const results = [];
    const queue = [dirPath];
    while (queue.length) {
        const current = queue.shift();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (recursive) queue.push(abs);
                continue;
            }
            if (entry.isFile() && VIDEO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
                results.push(abs);
            }
        }
    }
    return results.sort();
}

module.exports = async function batch(dir, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const absDir = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        console.error(`\x1b[31m✗\x1b[0m 目录不存在: ${absDir}`);
        process.exit(1);
    }

    const files = listVideos(absDir, Boolean(opts.recursive));
    if (!files.length) {
        console.error(`\x1b[31m✗\x1b[0m 目录下没找到视频文件(${VIDEO_EXTS.join(', ')}): ${absDir}`);
        process.exit(1);
    }

    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : files.length;
    const tasks = files.slice(0, limit);
    const action = opts.action || 'burn';

    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m' };
    console.log(`\n${C.bold}${C.cyan}🗂️  echocut batch${C.reset}`);
    console.log(`   ${C.gray}目录${C.reset}   ${absDir}`);
    console.log(`   ${C.gray}动作${C.reset}   ${action}`);
    console.log(`   ${C.gray}文件${C.reset}   ${files.length} 个${limit < files.length ? ` (处理前 ${limit})` : ''}`);
    console.log(`   ${C.gray}预设${C.reset}   ${opts.preset || 'douyin'}`);
    console.log('');

    // 构造转发参数(剔除 batch 专用的 flags)
    const forwardOptions = [];
    if (opts.preset) forwardOptions.push('--preset', opts.preset);
    if (opts.cutFillers) forwardOptions.push('--cut-fillers');
    if (opts.fillers === false) forwardOptions.push('--no-fillers');
    if (opts.engine) forwardOptions.push('--engine', opts.engine);
    if (opts.ratio) forwardOptions.push('--ratio', opts.ratio);
    if (opts.brand) forwardOptions.push('--brand', opts.brand);
    if (action === 'highlights') {
        if (opts.segments) forwardOptions.push('--segments', String(opts.segments));
        forwardOptions.push('--yes');
    }

    const results = [];
    for (let i = 0; i < tasks.length; i += 1) {
        const file = tasks[i];
        console.log(`${C.bold}[${i + 1}/${tasks.length}]${C.reset} ${path.basename(file)}`);
        const started = Date.now();
        const child = spawnSync('echocut', [action, file, ...forwardOptions], {
            stdio: 'inherit',
            cwd: root
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        if (child.status === 0) {
            console.log(`${C.green}  ✓ done in ${elapsed}s${C.reset}\n`);
            results.push({ file, status: 'ok', elapsed });
        } else {
            console.log(`${C.red}  ✗ failed (exit ${child.status})${C.reset}\n`);
            results.push({ file, status: 'fail', elapsed });
        }
    }

    const okCount = results.filter((r) => r.status === 'ok').length;
    console.log(`\n${C.bold}批量完成:${C.reset} ${okCount}/${results.length} 成功`);
    process.exit(okCount === results.length ? 0 : 1);
};
