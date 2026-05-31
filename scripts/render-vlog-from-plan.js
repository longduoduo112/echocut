#!/usr/bin/env node
/**
 * render-vlog-from-plan.js — 根据 plan.json 渲染一条 vlog
 *
 * 用法:
 *   node scripts/render-vlog-from-plan.js <plan.json> <clips-dir> <output.mp4>
 *
 * 会在 <clips-dir> 里找 plan.segments[].clip_id 对应的文件,
 * 把 plan.cover.headline/subline 跑出封面,按 plan 参数渲染成片。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.error('usage: node render-vlog-from-plan.js <plan.json> <clips-dir> <output.mp4>');
        process.exit(1);
    }
    const [planPath, clipsDir, outputPath] = args;

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const projectRoot = path.resolve(__dirname, '..');
    process.env.ZDE_PROJECT_ROOT = projectRoot;

    // 1. 生成封面
    const workDir = path.join(path.dirname(outputPath), `work-${plan.id || 'vlog'}`);
    fs.mkdirSync(workDir, { recursive: true });
    const coverPath = path.join(workDir, 'cover.jpg');
    if (plan.cover) {
        console.log(`[cover] 生成 "${plan.cover.headline}" / "${plan.cover.subline}"...`);
        // 直接调用 coverGenerator(避免 CLI 开销)
        const { loadBrandFile, brandToEnvString } = require('../src/services/brandLoader');
        const brand = loadBrandFile(plan.brand || 'example');
        process.env.ZDE_BRAND_CONFIG = brandToEnvString(brand);
        process.env.ZDE_DEFAULT_BRAND = plan.brand || 'example';
        const { generateCover } = require('../src/video/coverGenerator');
        await generateCover({
            headline: plan.cover.headline,
            subline: plan.cover.subline,
            outputPath: coverPath,
            width: plan.width || 1080,
            height: plan.height || 1920
        });
    }

    // 2. 解析 segments 的 clip_file 绝对路径
    const segments = plan.segments.map((s) => {
        const filename = s.clip_id || s.clip_file;
        const clipFile = path.isAbsolute(filename) ? filename : path.join(clipsDir, filename);
        if (!fs.existsSync(clipFile)) {
            throw new Error(`clip 不存在: ${clipFile}`);
        }
        return { ...s, clip_file: clipFile };
    });

    // 3. BGM 路径
    const bgmPath = path.isAbsolute(plan.bgm_file || plan.bgm_path || '')
        ? (plan.bgm_file || plan.bgm_path)
        : path.resolve(projectRoot, plan.bgm_file || plan.bgm_path || 'assets/bgm/03-lofi-podcast.mp3');

    // 4. 渲染
    const { renderVlogFromPlan } = require('../src/video/vlogRenderer');
    const t0 = Date.now();
    const result = await renderVlogFromPlan({
        plan: {
            segments,
            bgm_path: bgmPath,
            bgm_volume: plan.bgm_volume || 0.25,
            cover_path: coverPath,
            cover_duration: plan.cover_duration || 0.8,
            width: plan.width || 1080,
            height: plan.height || 1920,
            output_path: outputPath
        },
        workDir,
        onStep: (s) => console.log(`[step] ${s}`),
        onFfmpegProgress: null
    });
    const elapsed = Date.now() - t0;

    const { probeVideo } = require('../src/video/vlogRenderer');
    const final = probeVideo(result.outputPath);
    console.log('');
    console.log(`✓ ${plan.title} 渲染完成`);
    console.log(`  耗时: ${(elapsed / 1000).toFixed(1)} s`);
    console.log(`  时长: ${final.duration.toFixed(1)} s`);
    console.log(`  尺寸: ${final.width}x${final.height} @ ${final.fps.toFixed(1)}fps`);
    console.log(`  大小: ${(fs.statSync(result.outputPath).size / 1e6).toFixed(1)} MB`);
    console.log(`  路径: ${result.outputPath}`);
}

main().catch((err) => {
    console.error('\n✗ 渲染失败:', err.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
