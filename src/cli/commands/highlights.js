const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadBrandFile, brandToEnvString } = require('../../services/brandLoader');
const { preflightCheck } = require('../../lib/preflight');
const { acquireLock } = require('../../lib/processLock');

function loadVisualPreset(root, name) {
    if (!name || name === 'none') return null;
    const presetPath = path.join(root, 'src/video/presets', `${name}.json`);
    if (!fs.existsSync(presetPath)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到视觉预设: ${name}`);
        process.exit(1);
    }
    try {
        return JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m 预设文件解析失败:`, err.message);
        process.exit(1);
    }
}

function probeRotation(filePath) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation:stream_tags=rotate -of default=nw=1:nk=1 "${filePath}"`,
            { encoding: 'utf8' }
        ).trim();
        for (const line of out.split(/\r?\n/)) {
            const n = parseInt(line, 10);
            if (Number.isFinite(n) && n !== 0) return n;
        }
    } catch { /* ignore */ }
    return 0;
}

function detectOrientation(filePath) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
            { encoding: 'utf8' }
        ).trim();
        let [w, h] = out.split(',').map(Number);
        if (!w || !h) return 'vertical';
        // 手机竖拍视频带 rotation=90/270，FFmpeg 自动旋转，需 swap
        const rotation = probeRotation(filePath);
        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
            [w, h] = [h, w];
        }
        const ratio = w / h;
        if (ratio < 0.9) return 'vertical';
        if (ratio > 1.5) return 'landscape';
        return 'square';
    } catch {
        return 'vertical';
    }
}

module.exports = async function highlights(file, opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);

    if (!fs.existsSync(abs)) {
        console.error(`\x1b[31m✗\x1b[0m 找不到文件: ${abs}`);
        process.exit(1);
    }

    // 跑前守门 + 进程锁(同 burn)
    preflightCheck(abs, { engine: opts.engine });
    try {
        acquireLock('highlights.lock', { allowWait: true });
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${err.message}`);
        process.exit(1);
    }

    const visualPreset = loadVisualPreset(root, opts.preset);
    const stylePreset = opts.stylePreset === 'auto' ? detectOrientation(abs) : opts.stylePreset;

    const args = [
        'scripts/clip-video.js',
        `--video-file=${abs}`,
        `--engine=${opts.engine || 'qwen3'}`,
        `--segments=${opts.segments || 4}`,
        `--style-preset=${stylePreset}`
    ];
    if (opts.outputDir) args.push(`--output-dir=${opts.outputDir}`);
    if (opts.yes) args.push('--yes');
    if (opts.publishKit === false) args.push('--no-publish-kit');

    const childEnv = { ...process.env };
    if (visualPreset && visualPreset.config && typeof visualPreset.config === 'object') {
        childEnv.ZDE_PRESET_CONFIG = JSON.stringify(visualPreset.config);
    }
    if (opts.fillers === false) {
        childEnv.ZDE_KEEP_FILLERS = '1';
    }
    if (opts.cutFillers) {
        childEnv.ZDE_CUT_FILLERS = '1';
    }
    if (opts.cutSilence) {
        childEnv.ZDE_CUT_SILENCE = '1';
        if (opts.silenceThreshold) {
            childEnv.ZDE_SILENCE_THRESHOLD = String(opts.silenceThreshold);
        }
    }
    if (opts.bgm && opts.bgm !== 'none') {
        childEnv.ZDE_BGM_NAME = String(opts.bgm);
    } else if (opts.bgm === 'none') {
        childEnv.ZDE_BGM_NAME = 'none';
    }
    if (opts.bgmVolume) {
        childEnv.ZDE_BGM_VOLUME = String(opts.bgmVolume);
    }
    // v0.10+ 黄金 3 秒钩子(clipper.js 会读 ZDE_GOLDEN_HOOK)
    if (opts.goldenHook) {
        childEnv.ZDE_GOLDEN_HOOK = '1';
        if (opts.goldenStart != null && opts.goldenStart !== '') {
            childEnv.ZDE_GOLDEN_START = String(opts.goldenStart);
        }
        if (opts.goldenDuration != null && opts.goldenDuration !== '') {
            childEnv.ZDE_GOLDEN_DURATION = String(opts.goldenDuration);
        }
    }
    // 品牌穿透
    const brandId = opts.brand || 'example';
    let brandLoaded = null;
    try {
        brandLoaded = loadBrandFile(brandId);
        childEnv.ZDE_BRAND_CONFIG = brandToEnvString(brandLoaded);
        childEnv.ZDE_DEFAULT_BRAND = brandId;
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m 品牌加载失败: ${err.message}`);
        process.exit(1);
    }

    const C = { gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m' };
    console.log(`\n${C.bold}${C.cyan}🎬 echocut highlights${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}   ${path.basename(abs)}`);
    console.log(`   ${C.gray}引擎${C.reset}   ${opts.engine || 'qwen3'}`);
    console.log(`   ${C.gray}目标${C.reset}   ${opts.segments || 4} 个精华片段`);
    console.log(`   ${C.gray}比例${C.reset}   ${stylePreset}`);
    if (visualPreset) {
        console.log(`   ${C.gray}预设${C.reset}   ${C.green}${visualPreset.name}${C.reset}`);
    }
    if (brandLoaded) {
        console.log(`   ${C.gray}品牌${C.reset}   ${C.green}${brandLoaded.id}${C.reset} — ${brandLoaded.displayName || brandLoaded.identity?.name || ''}`);
    }
    if (opts.cutFillers) console.log(`   ${C.gray}filler${C.reset} 视频轨道级切除 (质量优先)`);
    console.log('');

    const child = spawn('node', args, { stdio: 'inherit', cwd: root, env: childEnv });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', (err) => {
        console.error(`\x1b[31m✗\x1b[0m spawn 失败:`, err.message);
        process.exit(1);
    });
};
