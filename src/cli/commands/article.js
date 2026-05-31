const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');

module.exports = async function article(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const args = ['scripts/generate-article.js'];

    if (opts.transcriptFile) args.push(`--transcript-file=${path.resolve(process.cwd(), opts.transcriptFile)}`);
    if (opts.videoFile) args.push(`--video-file=${path.resolve(process.cwd(), opts.videoFile)}`);
    if (opts.audioFile) args.push(`--audio-file=${path.resolve(process.cwd(), opts.audioFile)}`);
    if (opts.text) args.push(`--text=${opts.text}`);
    if (opts.mode) args.push(`--mode=${opts.mode}`);
    if (opts.output) args.push(`--output=${path.resolve(process.cwd(), opts.output)}`);
    if (opts.engine) args.push(`--engine=${opts.engine}`);

    if (!opts.transcriptFile && !opts.videoFile && !opts.audioFile && !opts.text) {
        console.error('\x1b[31m✗\x1b[0m 需要至少一个输入源: --transcript-file / --video-file / --audio-file / --text');
        process.exit(1);
    }

    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m' };
    console.log(`\n${C.bold}${C.cyan}📝 echocut article${C.reset}`);
    if (opts.videoFile) console.log(`   ${C.gray}视频${C.reset}   ${path.basename(opts.videoFile)}`);
    if (opts.audioFile) console.log(`   ${C.gray}音频${C.reset}   ${path.basename(opts.audioFile)}`);
    if (opts.transcriptFile) console.log(`   ${C.gray}转写${C.reset}   ${path.basename(opts.transcriptFile)}`);
    if (opts.text) console.log(`   ${C.gray}文本${C.reset}   ${String(opts.text).slice(0, 40)}...`);
    console.log(`   ${C.gray}模式${C.reset}   ${opts.mode || 'default'}`);
    if (opts.output) console.log(`   ${C.gray}输出${C.reset}   ${opts.output}`);

    // 品牌穿透
    const childEnv = { ...process.env };
    const brandId = opts.brand || 'example';
    let brandLoaded = null;
    try {
        brandLoaded = loadBrandFile(brandId);
        childEnv.ZDE_BRAND_CONFIG = brandToEnvString(brandLoaded);
        childEnv.ZDE_DEFAULT_BRAND = brandId;
        console.log(`   ${C.gray}品牌${C.reset}   \x1b[32m${brandLoaded.id}\x1b[0m — ${brandLoaded.displayName || brandLoaded.identity?.name || ''}`);
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m 品牌加载失败: ${err.message}`);
        process.exit(1);
    }
    // CTA 覆盖穿透(CLI --cta 支持 \n 转义)
    if (opts.cta) {
        childEnv.ZDE_CTA_OVERRIDE = String(opts.cta).replace(/\\n/g, '\n');
        console.log(`   ${C.gray}CTA${C.reset}    (手动覆盖)`);
    }
    console.log('');

    const child = spawn('node', args, { stdio: 'inherit', cwd: root, env: childEnv });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', (err) => {
        console.error(`\x1b[31m✗\x1b[0m spawn 失败:`, err.message);
        process.exit(1);
    });
};
