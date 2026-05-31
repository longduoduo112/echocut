#!/usr/bin/env node
/**
 * 用 brand example 默认 template + 紧凑底部 lower-third 黑条重做 cover
 * 比默认 bandTopY=820 bandHeight=440(横穿中央)更适合"沙滩照横向人像"
 *
 * 调:bandTopY 820 → 1500(底部),bandHeight 440 → 320(紧凑)
 * 不挡 Bill 头像/上半身/手部动作,只占视频底部 17%
 *
 * 用法:node scripts/panel/regenerate_covers_compact_band.sh \
 *   <out-dir> "<idx>|<headline>|<subline>" "<idx>|<headline>|<subline>" ...
 */
const { generateCover } = require('../../src/video/coverGenerator');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('用法: node regenerate_covers_compact_band.sh <out-dir> "<idx>|<headline>|<subline>" ...');
    process.exit(2);
}
const outDir = args[0];
const items = args.slice(1).map((line) => {
    const [idx, headline, subline = ''] = line.split('|');
    return { idx, headline, subline };
});

(async () => {
    for (const it of items) {
        const out = path.join(outDir, `${it.idx}-cover.jpg`);
        try {
            await generateCover({
                outputPath: out,
                headline: it.headline,
                subline: it.subline,
                bandTopY: 1500,
                bandHeight: 320,
            });
            console.log(`  ✓ ${out}`);
        } catch (e) {
            console.error(`  ✗ ${it.idx}: ${e.message}`);
            process.exit(1);
        }
    }
})();
