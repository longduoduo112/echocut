'use strict';

/**
 * echocut ingest <dir>
 * 批量分析目录下所有视频素材,打 tag 存 metadata.json
 * 用于后续 vlog 自动编排(v0.11.1)
 */

const fs = require('fs');
const path = require('path');
const { ingestDirectory, listVideos, probeClip, DEFAULT_VISION_MODEL } = require('../../video/videoIngest');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m'
};

function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(0) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function humanDur(sec) {
    if (sec < 60) return sec.toFixed(0) + 's';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return `${m}m ${s}s`;
}

module.exports = async function ingest(dir, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        console.error(`${C.red}✗${C.reset} 目录不存在: ${abs}`);
        process.exit(1);
    }

    const videos = listVideos(abs);
    if (!videos.length) {
        console.error(`${C.red}✗${C.reset} 目录里没有视频文件(mp4/mov/m4v/avi/webm/mkv)`);
        process.exit(1);
    }

    // 探测大小统计
    let totalSize = 0;
    let totalDur = 0;
    const probes = videos.map((v) => {
        const info = probeClip(v);
        if (info) { totalSize += info.size; totalDur += info.duration; }
        return { file: v, info };
    });

    const model = opts.model || DEFAULT_VISION_MODEL;
    const rerun = !!opts.rerun;
    const limit = Number(opts.limit) || 0;

    console.log(`\n${C.bold}${C.magenta}🎬 echocut ingest${C.reset}`);
    console.log(`   ${C.gray}目录${C.reset}    ${abs}`);
    console.log(`   ${C.gray}视频${C.reset}    ${videos.length} 个 · ${humanSize(totalSize)} · 总时长 ${humanDur(totalDur)}`);
    console.log(`   ${C.gray}模型${C.reset}    ${model}`);
    console.log(`   ${C.gray}缓存${C.reset}    ${path.join(abs, '_metadata.json')}`);
    if (rerun) console.log(`   ${C.yellow}⚠ --rerun${C.reset} 忽略缓存,全部重跑`);
    if (limit > 0) console.log(`   ${C.yellow}⚠ --limit ${limit}${C.reset} 只跑前 ${limit} 个`);
    console.log('');

    const t0 = Date.now();
    const result = await ingestDirectory(abs, {
        model,
        rerun,
        limit,
        onClipStart: ({ index, total, fname, status }) => {
            if (status === 'cache') {
                process.stdout.write(`  [${index + 1}/${total}] ${C.gray}cache ${fname}${C.reset}\n`);
            } else {
                const probeInfo = probes[index] && probes[index].info;
                const orient = probeInfo ? (probeInfo.orientation === 'landscape' ? '横' : probeInfo.orientation === 'portrait' ? '竖' : '方') : '?';
                const dur = probeInfo ? humanDur(probeInfo.duration) : '?';
                process.stdout.write(`  [${index + 1}/${total}] ${C.cyan}${fname}${C.reset} ${C.gray}(${orient} · ${dur})${C.reset}`);
            }
        },
        onFrameDone: ({ index, total, parsed }) => {
            if (parsed && parsed.scene) {
                process.stdout.write(` ${C.gray}·${C.reset} f${index + 1}/${total}`);
            } else {
                process.stdout.write(` ${C.yellow}·${C.reset} f${index + 1}/${total}(解析失败)`);
            }
        },
        onClipDone: ({ fname, summary, error }) => {
            if (error) {
                process.stdout.write(`  ${C.red}✗${C.reset}\n`);
            } else if (summary) {
                const desc = (summary.description || '').slice(0, 40);
                const tags = (summary.tags || []).slice(0, 5).join('/');
                process.stdout.write(`  ${C.green}✓${C.reset} ${C.gray}${desc} [${tags}]${C.reset}\n`);
            } else {
                process.stdout.write(`  ${C.yellow}⚠ 无 summary${C.reset}\n`);
            }
        }
    });

    const elapsed = Date.now() - t0;
    console.log('');
    console.log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    console.log(`${C.green}✓ ingest 完成${C.reset}  ${humanDur(elapsed / 1000)}`);
    console.log(`  ${C.gray}总${C.reset} ${result.totalVideos} 个 / ${C.green}成功 ${result.processed}${C.reset} / ${C.gray}缓存命中 ${result.cached}${C.reset} / ${C.red}失败 ${result.failed}${C.reset}`);
    console.log(`  ${C.gray}metadata${C.reset}  ${result.cachePath}`);
    console.log('');
    console.log(`${C.gray}下一步${C.reset}`);
    console.log(`  查看:  ${C.cyan}cat ${result.cachePath} | jq '.clips | to_entries[:3]'${C.reset}`);
    console.log(`  Vlog:  ${C.cyan}echocut vlog <plan.json>${C.reset} (v0.11.2 待加,目前用内部剪辑脚本)`);
    console.log('');
};
