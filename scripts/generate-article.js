/**
 * generate-article.js — 从视频/音频/文本生成公众号文章
 *
 * 用法:
 *   node scripts/generate-article.js --transcript-file=debug_outputs/video/.../transcript.json
 *   node scripts/generate-article.js --text="口述内容..."
 *   node scripts/generate-article.js --audio-file=/abs/path/audio.m4a --engine=mlx_hq
 *   node scripts/generate-article.js --video-file=/abs/path/video.MP4 --engine=mlx_hq
 *
 * 可选参数:
 *   --mode=default|hardcore|soul|action  文章风格
 *   --output=article.md                  保存到文件（默认打印到终端）
 *   --engine=mlx_hq                      转写引擎（仅 --audio-file/--video-file 时需要）
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs, getConfigValue } = require('../src/db/configRepo');
const { generateContentBundle, generateXiaohongshu, generateDouyinDesc } = require('../src/services/processor');
const { transcribeByEngine } = require('../src/video/asrAdapters');
const { extractAudioFromVideo } = require('../src/video/remotionRunner');
const { loadBrand } = require('../src/services/brandLoader');
const { composeArticleCta, composeShortCta } = require('../src/lib/ctaComposer');

function resolveArg(key) {
    const prefix = `${key}=`;
    const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
}

function toAbsPath(p) {
    if (!p) return '';
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function readTranscriptFile(filePath) {
    const abs = toAbsPath(filePath);
    if (!fs.existsSync(abs)) throw new Error(`transcript file not found: ${abs}`);
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    // Support: { full_text: "..." } or { segments: [{text}] } or plain string
    if (typeof raw === 'string') return raw;
    if (raw.full_text) return String(raw.full_text);
    if (Array.isArray(raw.segments)) return raw.segments.map((s) => s.text || '').join('');
    if (Array.isArray(raw.words)) return raw.words.map((w) => w.word || '').join('');
    return '';
}

async function main() {
    const showHelp = process.argv.includes('--help') || process.argv.includes('-h');
    if (showHelp) {
        console.log(`
generate-article.js — 生成公众号文章

用法:
  node scripts/generate-article.js --transcript-file=<path>   从转写 JSON 生成
  node scripts/generate-article.js --text="口述内容..."        从文本直接生成
  node scripts/generate-article.js --audio-file=<path>        从音频转写后生成
  node scripts/generate-article.js --video-file=<path>        从视频提取音频转写后生成

参数:
  --mode=default|hardcore|soul|action    文章模式（默认 default）
    default   综合标准（推荐，公众号通用）
    hardcore  硬核拆解（商业/技术深度分析）
    soul      走心复盘（个人感悟/读书笔记）
    action    行动指南（产品介绍/方法论落地）
  --engine=mlx_hq|mlx|funasr             转写引擎（音视频输入时使用，默认 mlx_hq）
  --output=article.md                     输出到文件（不指定则打印到终端）

示例:
  # 从刚刚跑的视频转写结果生成文章
  node scripts/generate-article.js \\
    --transcript-file=debug_outputs/video/2026-.../mlx_hq_video.../transcript.json \\
    --mode=hardcore

  # 从本地视频一键生成文章
  node scripts/generate-article.js \\
    --video-file='/Users/xxx/video.MP4' \\
    --engine=mlx_hq \\
    --mode=default \\
    --output=my_article.md
`);
        return;
    }

    const config = getConfig({ requireTelegramToken: false });
    initDb(config.contentDbPath);
    ensureDefaultConfigs();

    const textArg = resolveArg('--text');
    const transcriptFileArg = resolveArg('--transcript-file');
    const audioFileArg = resolveArg('--audio-file');
    const videoFileArg = resolveArg('--video-file');
    const mode = resolveArg('--mode') || 'default';
    const engine = resolveArg('--engine') || 'mlx_hq';
    const outputArg = resolveArg('--output');

    let rawText = '';

    if (textArg) {
        rawText = textArg;
    } else if (transcriptFileArg) {
        console.log(`📄 读取转写文件: ${transcriptFileArg}`);
        rawText = readTranscriptFile(transcriptFileArg);
    } else if (audioFileArg || videoFileArg) {
        let audioFile = audioFileArg ? toAbsPath(audioFileArg) : '';
        if (videoFileArg) {
            const videoAbs = toAbsPath(videoFileArg);
            console.log(`🎬 提取视频音频: ${path.basename(videoAbs)}`);
            audioFile = await extractAudioFromVideo(videoAbs, 'article_gen');
        }
        console.log(`🎙️ 转写中 (${engine})...`);
        const { fullText } = await transcribeByEngine(audioFile, engine);
        rawText = fullText;
        console.log(`✅ 转写完成，共 ${rawText.length} 字`);
    } else {
        console.error('错误：请提供 --text、--transcript-file、--audio-file 或 --video-file');
        process.exit(1);
    }

    if (!rawText.trim()) {
        console.error('错误：未获取到有效文本内容');
        process.exit(1);
    }

    console.log(`\n✍️ 正在生成文章 (mode=${mode}, model=${getConfigValue('ollama_model') || config.ollamaModel})...`);
    const [{ draftArticle, hookMoment }, xhsResult, douyinResult] = await Promise.all([
        generateContentBundle(rawText, config, mode),
        generateXiaohongshu(rawText, config).catch((e) => { console.error('小红书生成失败:', e.message); return null; }),
        generateDouyinDesc(rawText, config).catch((e) => { console.error('抖音生成失败:', e.message); return null; })
    ]);

    // 品牌 CTA 注入:ZDE_CTA_OVERRIDE > brand.cta.articleFooter > brand.cta.title+subtitle
    let brand = null;
    try { brand = loadBrand(); } catch (_) { /* 无 brand 不影响生成 */ }
    const cliCta = process.env.ZDE_CTA_OVERRIDE || '';
    const articleCta = composeArticleCta({ brand, cliCta });
    const shortCta = composeShortCta({ brand, cliCta });
    const draftWithCta = articleCta ? (draftArticle.trim() + articleCta) : draftArticle;
    const hookWithCta = (hookMoment || '') + (shortCta || '');

    const parts = [
        '═'.repeat(60),
        `【公众号文章】mode=${mode}`,
        '═'.repeat(60),
        draftWithCta,
        '',
        '─'.repeat(60),
        '【朋友圈文案】',
        '─'.repeat(60),
        hookWithCta || '（朋友圈文案生成失败）'
    ];

    if (xhsResult) {
        const tagLine = Array.isArray(xhsResult.tags) ? xhsResult.tags.join(' ') : '';
        parts.push('', '─'.repeat(60), '【小红书版本】', '─'.repeat(60));
        parts.push(`标题：${xhsResult.title}`, '', xhsResult.body, '', tagLine);
    }

    if (douyinResult) {
        const tagLine = Array.isArray(douyinResult.tags) ? douyinResult.tags.join(' ') : '';
        parts.push('', '─'.repeat(60), '【抖音/视频号】', '─'.repeat(60));
        parts.push(douyinResult.desc, '', tagLine);
    }

    const output = parts.join('\n');

    if (outputArg) {
        const outPath = toAbsPath(outputArg);
        fs.writeFileSync(outPath, output, 'utf8');
        console.log(`\n💾 已保存到: ${outPath}`);
    } else {
        console.log('\n' + output);
    }
}

main().catch((err) => {
    console.error('generate-article 失败:', err.message || err);
    process.exit(1);
});
