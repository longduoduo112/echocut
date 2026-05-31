'use strict';

const fs = require('fs');
const path = require('path');
const { orchestratePanelClip } = require('../../services/panelOrchestrator');
const { loadBrandFile } = require('../../services/brandLoader');
const { acquireLock } = require('../../lib/processLock');

function parseCsv(v) {
    if (!v) return [];
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = async function panelClip(file, opts) {
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到文件: ${abs}`);
        process.exit(1);
    }

    // 锁(防并发跑两个 panel-clip 抢 GPU/MLX)
    try { acquireLock('panel-clip.lock', { allowWait: true }); }
    catch (err) { console.error(`\x1b[31m✗\x1b[0m ${err.message}`); process.exit(1); }

    // brand 校验
    const brandId = opts.brand || 'example';
    try { loadBrandFile(brandId); }
    catch (err) {
        console.error(`\x1b[31m✗\x1b[0m brand 加载失败: ${err.message}`);
        process.exit(1);
    }

    // 名字字典:speaker 必需,others 必需(否则段切不出来),host 可选
    const speakerNames = parseCsv(opts.speakerNames);
    const otherSpeakers = parseCsv(opts.otherSpeakers);
    const hostNames = parseCsv(opts.hostNames);
    if (speakerNames.length === 0) {
        console.error(`\x1b[31m✗\x1b[0m --speaker-names 必填(例:"李标,李彪,Pan Hunt")`);
        process.exit(2);
    }
    if (otherSpeakers.length === 0) {
        console.error(`\x1b[31m✗\x1b[0m --other-speakers 必填(其他嘉宾名字,用来识别段切换;例:"Dennis,张拼拼,陈慧")`);
        process.exit(2);
    }

    const outDir = opts.outDir
        ? path.resolve(opts.outDir)
        : path.join(path.dirname(abs), `${path.basename(abs, path.extname(abs))}_panel`);

    // 每段标题(--headlines "T1,T2,T3" / --sublines "S1,S2,S3")
    const headlinePerSeg = parseCsv(opts.headlines);
    const sublinePerSeg = parseCsv(opts.sublines);

    try {
        await orchestratePanelClip(abs, {
            speakerNames,
            hostNames,
            otherSpeakers,
            brand: brandId,
            bgm: opts.bgm || '02-guzheng-zen',
            autoPad: opts.autoPad !== false,  // 默认开
            stripTop: Number(opts.stripTop) || 0,
            outDir,
            dryRun: !!opts.dryRun,
            compilationOnly: !!opts.compilationOnly,
            skipBurn: !!opts.skipBurn,
            minDurationSec: Number(opts.minDuration) || 60,
            maxDurationSec: Number(opts.maxDuration) || 900,
            startBufferSec: Number(opts.startBuffer) || 0,
            hostTriggerThreshold: Number.isFinite(Number(opts.hostThreshold)) ? Number(opts.hostThreshold) : 0.5,
            headlinePerSeg,
            sublinePerSeg,
            compilationHeadline: opts.compilationHeadline,
            compilationSubline: opts.compilationSubline,
        });
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m panel-clip 失败: ${err.message}`);
        process.exit(1);
    }
};
