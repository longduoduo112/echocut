'use strict';

/**
 * echocut music — MiniMax 音乐生成 CLI
 *
 * 三种用法:
 *   1. 单首 ad-hoc(任意 prompt)
 *      echocut music --prompt "uplifting piano jazz" --name my-song
 *   2. 预设批次(背景/独奏/创作者/DJ 精选)
 *      echocut music --set dj
 *      echocut music --list-sets   # 看有哪些预设
 *   3. 自定义 JSON 批量
 *      echocut music --file ./my-prompts.json
 *      // JSON: [{"name":"xxx","prompt":"..."}, ...]
 *
 * 友好错误处理:
 *   - MINIMAX_API_KEY 未设置 → 清晰提示如何配置
 *   - HTTP 401/403 → key 失效
 *   - HTTP 402/429 → 配额不足
 *   - 超时 / 网络错误 → 明确原因 + 建议重试
 */

const fs = require('fs');
const path = require('path');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', dim: '\x1b[2m'
};

function humanSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// ffprobe 不在脚本层依赖,直接解析 mp3 不可靠 — 退一步用 ffprobe 命令查时长(装了 ffmpeg 就有)
function probeDuration(filePath) {
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const sec = Number(String(out).trim());
        return Number.isFinite(sec) ? sec : null;
    } catch (_) { return null; }
}

function groupKey(fileName) {
    // 01-piano-calm.mp3 / 08-bossa-light.mp3 → background
    if (/^\d{2}-/.test(fileName)) return 'background';
    // solo-01-xxx / creator-05-xxx / dj-12-xxx
    const m = fileName.match(/^([a-z]+)-\d/);
    if (m) return m[1];
    return 'other';
}

function listLocalBgm({ root, filter }) {
    const path = require('path');
    const fs = require('fs');
    const bgmDir = path.join(root, 'assets', 'bgm');
    if (!fs.existsSync(bgmDir)) {
        console.error(`${C.red}✗${C.reset} BGM 目录不存在: ${bgmDir}`);
        process.exit(1);
    }

    const allFiles = fs.readdirSync(bgmDir)
        .filter((f) => f.endsWith('.mp3'))
        .filter((f) => !filter || f.toLowerCase().includes(String(filter).toLowerCase()))
        .sort();

    if (!allFiles.length) {
        console.log(`\n${C.yellow}⚠${C.reset} ${bgmDir} ${filter ? `没有匹配 "${filter}" 的 mp3` : '没有 mp3'}\n`);
        return;
    }

    // manifest.json 里有 prompt 描述,读一下用作展示
    let manifest = {};
    const manifestPath = path.join(bgmDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
        catch (_) { /* 坏的 manifest 不阻塞 */ }
    }
    // manifest 可能是 {items: [{name, prompt}]} 或 {name: prompt}
    const manifestLookup = {};
    if (Array.isArray(manifest)) {
        manifest.forEach((x) => { if (x && x.name) manifestLookup[x.name] = x.prompt || ''; });
    } else if (manifest.items && Array.isArray(manifest.items)) {
        manifest.items.forEach((x) => { if (x && x.name) manifestLookup[x.name] = x.prompt || ''; });
    } else if (typeof manifest === 'object') {
        Object.assign(manifestLookup, manifest);
    }

    // 按 set 分组
    const groups = new Map();
    let totalSize = 0, totalDur = 0, missingDur = 0;

    for (const f of allFiles) {
        const fp = path.join(bgmDir, f);
        const stat = fs.statSync(fp);
        const dur = probeDuration(fp);
        const key = groupKey(f);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({
            name: f.replace(/\.mp3$/, ''),
            size: stat.size,
            duration: dur,
            prompt: manifestLookup[f.replace(/\.mp3$/, '')] || ''
        });
        totalSize += stat.size;
        if (dur) totalDur += dur;
        else missingDur += 1;
    }

    // 渲染
    console.log(`\n${C.bold}${C.magenta}🎵 BGM 本地库${C.reset}  ${C.gray}${bgmDir}${C.reset}`);
    console.log(`   ${C.gray}共 ${allFiles.length} 首 · ${humanSize(totalSize)} · ${totalDur > 0 ? Math.round(totalDur / 60) + ' 分钟' : '时长未知'}${filter ? `  (过滤: "${filter}")` : ''}${C.reset}`);
    console.log('');

    // 分组优先级
    const order = ['background', 'solo', 'creator', 'dj', 'other'];
    const sortedKeys = [...groups.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    for (const key of sortedKeys) {
        const items = groups.get(key).sort((a, b) => a.name.localeCompare(b.name));
        const label = {
            background: '背景音 (background)',
            solo: '独奏 (solo)',
            creator: '创作者向 (creator)',
            dj: 'DJ 大师混合 (dj)',
            other: '其他'
        }[key] || key;
        console.log(`${C.bold}${label}${C.reset}  ${C.gray}(${items.length} 首)${C.reset}`);
        for (const it of items) {
            const durStr = it.duration ? `${it.duration.toFixed(0)}s`.padStart(4) : '  ? ';
            const sizeStr = humanSize(it.size).padStart(7);
            console.log(`  ${C.cyan}${it.name.padEnd(40)}${C.reset} ${C.gray}${durStr}  ${sizeStr}${C.reset}  ${C.dim}${String(it.prompt).slice(0, 48)}${C.reset}`);
        }
        console.log('');
    }

    if (missingDur > 0) {
        console.log(`${C.gray}提示: ${missingDur} 首无法探测时长(ffprobe 不可用?),大小和文件都正常${C.reset}`);
    }
    console.log(`${C.gray}用法示例:${C.reset}`);
    console.log(`  ${C.cyan}echocut burn <video> --bgm creator-05-acoustic-warm${C.reset}`);
    console.log(`  ${C.cyan}echocut music --list --filter sitar${C.reset}       只看含 sitar 的`);
    console.log(`  ${C.cyan}echocut music --set dj${C.reset}                     补齐 DJ 批次(已有会跳过)`);
    console.log('');
}

function printError(err) {
    console.error('');
    console.error(`${C.red}✗ ${err.message}${C.reset}`);
    if (err.kind) console.error(`  ${C.gray}kind: ${err.kind}${C.reset}`);
    if (err.status) console.error(`  ${C.gray}http: ${err.status}${C.reset}`);
    if (err.hint) console.error(`  ${C.yellow}💡 ${err.hint}${C.reset}`);
    if (err.payload) console.error(`  ${C.gray}payload:${C.reset} ${JSON.stringify(err.payload).slice(0, 200)}`);
    console.error('');
}

module.exports = async function music(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const { generateMusic, generateBatch, checkApiKey, loadPresetSet, listPresetNames, MusicApiError, DEFAULT_MODEL } = require('../../services/musicGenerator');

    // --list:扫描本地 assets/bgm/ 分组列出(不调 API,不需要 key)
    if (opts.list) {
        return listLocalBgm({ root, filter: opts.filter });
    }

    // --list-sets:列预设然后退出
    if (opts.listSets) {
        const sets = listPresetNames();
        console.log(`\n${C.bold}${C.magenta}🎵 可用预设批次${C.reset}`);
        const presets = require('../../services/musicPresets');
        for (const name of sets) {
            const n = presets[name].length;
            console.log(`  ${C.cyan}${name}${C.reset}  ${C.gray}${n} 首${C.reset}`);
            // 列出前 3 个样例
            presets[name].slice(0, 3).forEach((p) => {
                console.log(`    ${C.gray}·${C.reset} ${p.name}: ${(p.prompt || '').slice(0, 60)}…`);
            });
            if (presets[name].length > 3) {
                console.log(`    ${C.gray}... 还有 ${presets[name].length - 3} 首${C.reset}`);
            }
        }
        console.log('');
        console.log(`${C.gray}用法${C.reset}`);
        console.log(`  echocut music --set <name>     批量跑一个预设`);
        console.log(`  echocut music --prompt "..." --name my-song    单首 ad-hoc`);
        console.log(`  echocut music --file prompts.json    自定义 JSON 批量`);
        console.log('');
        return;
    }

    // 提前检查 API key(友好失败)
    try { checkApiKey(); } catch (err) {
        printError(err);
        process.exit(1);
    }

    const outputDir = opts.outDir
        ? path.resolve(process.cwd(), opts.outDir)
        : path.resolve(root, 'assets', 'bgm');
    const model = opts.model || DEFAULT_MODEL;
    const timeoutMs = Math.max(30000, Number(opts.timeout) * 1000 || 240000);
    const skipExisting = !opts.overwrite;

    // ───── 路径 1:--prompt 单首 ad-hoc ─────
    if (opts.prompt) {
        const name = opts.name || `music-adhoc-${Date.now()}`;
        console.log(`\n${C.bold}${C.magenta}🎵 单首生成${C.reset}`);
        console.log(`   ${C.gray}prompt${C.reset}  ${opts.prompt.slice(0, 80)}${opts.prompt.length > 80 ? '…' : ''}`);
        console.log(`   ${C.gray}name${C.reset}    ${name}`);
        console.log(`   ${C.gray}输出${C.reset}    ${outputDir}/${name}.mp3`);
        console.log(`   ${C.gray}模型${C.reset}    ${model}`);
        console.log('');
        try {
            const result = await generateMusic({
                prompt: opts.prompt,
                name,
                outputDir,
                model,
                timeoutMs,
                skipExisting
            });
            if (result.skipped) {
                console.log(`${C.yellow}⏭${C.reset}  已存在(用 --overwrite 强制重跑): ${result.outputPath}`);
            } else {
                console.log(`${C.green}✓${C.reset} ${result.outputPath}`);
                console.log(`   ${humanSize(result.sizeBytes)} · ${result.duration ? result.duration.toFixed(1) + 's' : '?'} · ${(result.elapsedMs / 1000).toFixed(1)}s`);
            }
            return;
        } catch (err) {
            printError(err);
            process.exit(1);
        }
    }

    // ───── 路径 2:--file 自定义 JSON ─────
    let prompts = null;
    let label = '';

    if (opts.file) {
        const abs = path.resolve(process.cwd(), opts.file);
        if (!fs.existsSync(abs)) {
            console.error(`${C.red}✗${C.reset} 文件不存在: ${abs}`);
            process.exit(1);
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
            prompts = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.prompts) ? parsed.prompts : null);
        } catch (err) {
            console.error(`${C.red}✗${C.reset} JSON 解析失败: ${err.message}`);
            process.exit(1);
        }
        if (!prompts || !prompts.length) {
            console.error(`${C.red}✗${C.reset} 文件里没有有效的 prompts(需要 [{name,prompt},...] 或 {prompts:[...]})`);
            process.exit(1);
        }
        label = `文件: ${path.basename(abs)}`;
    }

    // ───── 路径 3:--set 预设批次 ─────
    if (opts.set && !prompts) {
        prompts = loadPresetSet(opts.set);
        if (!prompts) {
            console.error(`${C.red}✗${C.reset} 未知预设: ${opts.set}`);
            console.error(`   可选: ${listPresetNames().join(' / ')}`);
            process.exit(1);
        }
        label = `预设: ${opts.set}`;
    }

    if (!prompts) {
        console.error(`${C.red}✗${C.reset} 必须指定以下之一: --prompt / --set / --file / --list-sets`);
        console.error(`   帮助: ${C.cyan}echocut music --help${C.reset}`);
        process.exit(1);
    }

    // ───── 批量执行 ─────
    console.log(`\n${C.bold}${C.magenta}🎵 批量生成${C.reset}`);
    console.log(`   ${C.gray}${label}${C.reset}`);
    console.log(`   ${C.gray}数量${C.reset}    ${prompts.length} 首`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputDir}`);
    console.log(`   ${C.gray}模型${C.reset}    ${model}`);
    if (skipExisting) console.log(`   ${C.gray}已存在${C.reset}  跳过(--overwrite 强制重跑)`);
    console.log('');

    const t0 = Date.now();
    let result;
    try {
        result = await generateBatch({
            prompts,
            outputDir,
            model,
            timeoutMs,
            skipExisting,
            onItemStart: ({ index, total, item }) => {
                const preview = (item.prompt || '').slice(0, 55);
                process.stdout.write(`  [${index + 1}/${total}] ${C.cyan}${item.name}${C.reset} ${C.gray}${preview}…${C.reset}\n`);
            },
            onItemDone: ({ item, result, error }) => {
                if (error) {
                    process.stdout.write(`    ${C.red}✗${C.reset} ${error.message.slice(0, 100)}\n`);
                    if (error.hint) process.stdout.write(`      ${C.yellow}💡 ${error.hint}${C.reset}\n`);
                } else if (result.skipped) {
                    process.stdout.write(`    ${C.yellow}⏭${C.reset} 已存在,跳过 (${humanSize(result.sizeBytes)})\n`);
                } else {
                    process.stdout.write(`    ${C.green}✓${C.reset} ${humanSize(result.sizeBytes)} · ${result.duration ? result.duration.toFixed(1) + 's' : '?'} · ${(result.elapsedMs / 1000).toFixed(1)}s\n`);
                }
            }
        });
    } catch (err) {
        printError(err);
        process.exit(1);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log('');
    console.log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    const statusLine = result.aborted
        ? `${C.red}⚠ 中止(API 认证/配额异常)${C.reset}`
        : `${C.green}✓ 批次完成${C.reset}`;
    console.log(`${statusLine}  ${elapsed}s 总耗时`);
    console.log(`  ${C.gray}总${C.reset} ${result.total} / ${C.green}成功 ${result.ok}${C.reset} / ${C.yellow}跳过 ${result.skipped}${C.reset} / ${C.red}失败 ${result.failed}${C.reset}`);
    console.log('');
    if (result.failed > 0) {
        console.log(`${C.yellow}失败列表:${C.reset}`);
        result.items.filter((x) => x.status === 'failed').forEach((x) => {
            console.log(`  ${C.red}✗${C.reset} ${x.name}  ${C.gray}${x.error}${C.reset}`);
            if (x.hint) console.log(`    ${C.yellow}💡 ${x.hint}${C.reset}`);
        });
        console.log('');
    }
};
