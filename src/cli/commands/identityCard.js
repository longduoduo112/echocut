'use strict';

const fs = require('fs');
const path = require('path');
const { applyIdentityCard } = require('../../video/identityCard');
const { loadBrandFile } = require('../../services/brandLoader');

module.exports = async function identityCard(file, opts) {
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到文件: ${abs}`);
        process.exit(1);
    }

    // brand 提取默认 name/title(如果 CLI 没传)
    let defaultName = '';
    let defaultTitle = '';
    if (opts.brand) {
        try {
            const brand = loadBrandFile(opts.brand);
            defaultName = brand?.identity?.name || '';
            defaultTitle = brand?.identity?.title || brand?.identity?.subtitle || '';
        } catch (_) { /* brand 没找到也不阻塞 */ }
    }

    const name = opts.name || defaultName;
    const title = opts.title || defaultTitle;
    if (!name) {
        console.error(`\x1b[31m✗\x1b[0m --name 必填(或从 --brand 提取 identity.name)`);
        console.error(`   例:echocut identity-card x.mp4 --name "李标 Bill" --title "echocut CEO"`);
        process.exit(2);
    }

    const out = opts.out || abs.replace(/\.mp4$/i, '_identity.mp4');
    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m' };
    console.log(`\n${C.cyan}🪪 identity-card${C.reset}`);
    console.log(`   ${C.gray}输入${C.reset}   ${path.basename(abs)}`);
    console.log(`   ${C.gray}姓名${C.reset}   ${name}`);
    if (title) console.log(`   ${C.gray}头衔${C.reset}   ${title}`);
    console.log(`   ${C.gray}位置${C.reset}   ${opts.position || 'bottom-left'}`);
    console.log(`   ${C.gray}输出${C.reset}   ${path.relative(process.cwd(), out)}`);
    console.log('');

    try {
        const t0 = Date.now();
        const r = applyIdentityCard(abs, out, {
            name,
            title,
            position: opts.position || 'bottom-left',
            nameFontSize: Number(opts.nameFontSize) || undefined,
            titleFontSize: Number(opts.titleFontSize) || undefined,
            nameColor: opts.nameColor,
            titleColor: opts.titleColor,
            boxColor: opts.boxColor,
            fontFile: opts.fontFile,
            crf: opts.crf,
            preset: opts.preset,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`${C.green}✓ 完成 ${dt}s${C.reset}  → ${r.outputPath}`);
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err.message}`);
        process.exit(1);
    }
};
