'use strict';

/**
 * echocut minimax <sub> — MiniMax 能力套件独立子命令
 *
 * 独立正交:不跟 burn/highlights/vlog 等其他子命令共享流程,纯 API 包装器。
 * 未来换供应商时改这里不动其他地方。
 *
 * 子命令:
 *   tts         文本转语音   (speech-2.6-hd)
 *   image       文生图       (image-01)
 *   video       文/图生视频  (MiniMax-Hailuo-2.3-Fast,异步 polling)
 *   music-cover 歌曲翻唱
 *   lyrics      歌词生成
 *   quota       提示如何在官网查看配额(API 没暴露 quota 查询)
 *
 * 注:BGM 音乐生成走独立的 `echocut music`(已稳定,不并入)。
 */

const fs = require('fs');
const path = require('path');

// minimax 子命令独立正交,不经 config 链路,需自己加载 .env
try {
    const root = process.env.ZDE_PROJECT_ROOT || path.resolve(__dirname, '../../..');
    require('dotenv').config({ path: path.join(root, '.env') });
} catch (_) { /* 没装 dotenv 或 .env 不存在 都不阻塞 */ }

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', dim: '\x1b[2m'
};

function humanSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
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

function resolveOut(cwdRel, fallback) {
    if (!cwdRel) return fallback;
    return path.isAbsolute(cwdRel) ? cwdRel : path.resolve(process.cwd(), cwdRel);
}

// ────────────────── tts ──────────────────
async function cmdTts(opts) {
    const { textToSpeech, checkApiKey } = require('../../services/minimaxClient');
    try { checkApiKey(); } catch (err) { printError(err); process.exit(1); }

    let text = opts.text;
    if (!text && opts.file) {
        const abs = resolveOut(opts.file, opts.file);
        if (!fs.existsSync(abs)) { console.error(`${C.red}✗${C.reset} 文件不存在: ${abs}`); process.exit(1); }
        text = fs.readFileSync(abs, 'utf8');
    }
    if (!text || !text.trim()) {
        console.error(`${C.red}✗${C.reset} 需要 --text "..." 或 --file <path>`);
        process.exit(1);
    }

    const outputPath = opts.output
        ? resolveOut(opts.output)
        : path.resolve(process.cwd(), `tts-${Date.now()}.${opts.format || 'mp3'}`);

    console.log(`\n${C.bold}${C.magenta}🔊 MiniMax TTS${C.reset}`);
    console.log(`   ${C.gray}模型${C.reset}    ${opts.model || 'speech-2.6-hd'}`);
    console.log(`   ${C.gray}音色${C.reset}    ${opts.voice || 'male-qn-qingse'}`);
    console.log(`   ${C.gray}文本${C.reset}    ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}${C.gray}(${text.length} 字)${C.reset}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputPath}`);
    console.log('');

    try {
        const r = await textToSpeech({
            text,
            voiceId: opts.voice,
            model: opts.model,
            outputPath,
            format: opts.format || 'mp3',
            speed: opts.speed !== undefined ? Number(opts.speed) : undefined,
            vol: opts.vol !== undefined ? Number(opts.vol) : undefined,
            pitch: opts.pitch !== undefined ? Number(opts.pitch) : undefined,
            emotion: opts.emotion,
            sampleRate: opts.sampleRate ? Number(opts.sampleRate) : undefined,
            bitrate: opts.bitrate ? Number(opts.bitrate) : undefined
        });
        console.log(`${C.green}✓${C.reset} ${r.outputPath}`);
        console.log(`   ${humanSize(r.sizeBytes)} · ${r.audioLengthMs ? (r.audioLengthMs / 1000).toFixed(1) + 's' : '?'} · ${(r.elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) { printError(err); process.exit(1); }
}

// ────────────────── image ──────────────────
async function cmdImage(opts) {
    const { generateImage, checkApiKey } = require('../../services/minimaxClient');
    try { checkApiKey(); } catch (err) { printError(err); process.exit(1); }

    if (!opts.prompt) { console.error(`${C.red}✗${C.reset} --prompt 必填`); process.exit(1); }
    const outputDir = opts.outputDir ? resolveOut(opts.outputDir) : process.cwd();
    const n = Number(opts.n) || 1;

    console.log(`\n${C.bold}${C.magenta}🖼  MiniMax Image${C.reset}`);
    console.log(`   ${C.gray}模型${C.reset}    ${opts.model || 'image-01'}`);
    console.log(`   ${C.gray}prompt${C.reset}  ${opts.prompt.slice(0, 80)}${opts.prompt.length > 80 ? '…' : ''}`);
    console.log(`   ${C.gray}比例${C.reset}    ${opts.ratio || '9:16'}`);
    console.log(`   ${C.gray}张数${C.reset}    ${n}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputDir}`);
    console.log('');

    try {
        const r = await generateImage({
            prompt: opts.prompt,
            aspectRatio: opts.ratio,
            n,
            outputDir,
            name: opts.name,
            model: opts.model,
            promptOptimizer: opts.noOptimizer ? false : true
        });
        console.log(`${C.green}✓${C.reset} ${r.outputPaths.length} 张 · ${(r.elapsedMs / 1000).toFixed(1)}s`);
        r.outputPaths.forEach((p) => console.log(`   ${p}`));
    } catch (err) { printError(err); process.exit(1); }
}

// ────────────────── video ──────────────────
async function cmdVideo(opts) {
    const { generateVideoBlocking, checkApiKey } = require('../../services/minimaxClient');
    try { checkApiKey(); } catch (err) { printError(err); process.exit(1); }

    if (!opts.prompt) { console.error(`${C.red}✗${C.reset} --prompt 必填`); process.exit(1); }
    const outputPath = opts.output
        ? resolveOut(opts.output)
        : path.resolve(process.cwd(), `minimax-video-${Date.now()}.mp4`);

    console.log(`\n${C.bold}${C.magenta}🎬 MiniMax Video${C.reset} ${C.gray}(Hailuo,异步约 1-3 分钟)${C.reset}`);
    console.log(`   ${C.gray}模型${C.reset}    ${opts.model || 'MiniMax-Hailuo-2.3-Fast'}`);
    console.log(`   ${C.gray}prompt${C.reset}  ${opts.prompt.slice(0, 80)}${opts.prompt.length > 80 ? '…' : ''}`);
    if (opts.firstFrame) console.log(`   ${C.gray}首帧${C.reset}    ${opts.firstFrame}`);
    if (opts.duration)   console.log(`   ${C.gray}时长${C.reset}    ${opts.duration}s`);
    if (opts.resolution) console.log(`   ${C.gray}分辨率${C.reset}  ${opts.resolution}`);
    console.log(`   ${C.gray}输出${C.reset}    ${outputPath}`);
    console.log('');

    let lastStatus = '';
    try {
        const r = await generateVideoBlocking({
            prompt: opts.prompt,
            firstFrameImage: opts.firstFrame,
            model: opts.model,
            duration: opts.duration ? Number(opts.duration) : undefined,
            resolution: opts.resolution,
            outputPath,
            pollIntervalMs: Number(opts.pollInterval) * 1000 || 6000,
            maxWaitMs: Number(opts.maxWait) * 1000 || 600000,
            onStatus: ({ status, elapsedMs }) => {
                if (status !== lastStatus) {
                    lastStatus = status;
                    process.stdout.write(`   ${C.gray}[${(elapsedMs / 1000).toFixed(0)}s]${C.reset} status: ${C.cyan}${status}${C.reset}\n`);
                } else {
                    process.stdout.write(`   ${C.gray}[${(elapsedMs / 1000).toFixed(0)}s]${C.reset} ${C.gray}${status}…${C.reset}\n`);
                }
            }
        });
        console.log('');
        console.log(`${C.green}✓${C.reset} ${r.outputPath}`);
        console.log(`   ${humanSize(r.sizeBytes)} · ${(r.elapsedMs / 1000).toFixed(0)}s · task_id=${r.taskId}`);
    } catch (err) { printError(err); process.exit(1); }
}

// ────────────────── music-cover(占位,待官方 doc) ──────────────────
function cmdMusicCover() {
    console.log(`\n${C.bold}${C.magenta}🎤 MiniMax Music-Cover${C.reset} ${C.gray}(占位,等待官方 doc 补完)${C.reset}\n`);
    console.log(`  ${C.yellow}现状${C.reset}`);
    console.log(`    · 实测走 POST /v1/music_generation,body 至少需要 { model, refer_audio, lyrics }`);
    console.log(`    · refer_audio 需先调 /v1/music_upload(multipart 上传音频)拿 file_id`);
    console.log(`    · 完整 body spec 未公开,暂不做假实现以免误导`);
    console.log('');
    console.log(`  ${C.cyan}变通方案${C.reset}`);
    console.log(`    · 如需翻唱,先去 platform.minimaxi.com 网页版实验,确认 spec 后告诉我来补完`);
    console.log(`    · 或用 echocut music --prompt "cover version of <描述>" 走纯生成不带参考音频`);
    console.log('');
    process.exit(2);
}

// ────────────────── lyrics(占位,待官方 doc) ──────────────────
function cmdLyrics() {
    console.log(`\n${C.bold}${C.magenta}📝 MiniMax Lyrics${C.reset} ${C.gray}(占位,等待官方 doc 补完)${C.reset}\n`);
    console.log(`  ${C.yellow}现状${C.reset}`);
    console.log(`    · 实测 POST /v1/lyrics_generation 存在(任意 body 返回 base_resp 2013 invalid_params)`);
    console.log(`    · body 字段名需官方 doc 确认(prompt/desc/theme/topic 均未命中)`);
    console.log('');
    console.log(`  ${C.cyan}变通方案${C.reset}`);
    console.log(`    · 本地 Ollama 写歌词(一条命令即可):`);
    console.log(`      ${C.gray}ollama run qwen3.5:9b "写一段 pop 风格励志歌词,主题:春天 专注 创业者"${C.reset}`);
    console.log(`    · 官方 doc 就位后在 minimaxClient.generateLyrics 补 body 即可`);
    console.log('');
    process.exit(2);
}

// ────────────────── quota ──────────────────
function cmdQuota() {
    const key = process.env.MINIMAX_API_KEY;
    console.log(`\n${C.bold}${C.magenta}📊 MiniMax 配额查询${C.reset}\n`);
    if (key) {
        console.log(`  ${C.green}✓${C.reset} MINIMAX_API_KEY 已设置(${key.slice(0, 8)}***${key.slice(-4)})`);
    } else {
        console.log(`  ${C.red}✗${C.reset} MINIMAX_API_KEY 未设置`);
    }
    console.log('');
    console.log(`  ${C.gray}MiniMax 官方 API 没有开放配额查询 endpoint,请到用户中心查看:${C.reset}`);
    console.log(`  ${C.cyan}https://platform.minimaxi.com/user-center/basic-information/interface-key${C.reset}`);
    console.log('');
    console.log(`  ${C.gray}典型额度(按套餐):${C.reset}`);
    console.log(`    ${C.gray}TTS (speech-2.6-hd)${C.reset}     11000 字/天`);
    console.log(`    ${C.gray}Image (image-01)${C.reset}        120 次/天`);
    console.log(`    ${C.gray}Video (Hailuo-2.3-Fast)${C.reset} 2 次/天(高级)`);
    console.log(`    ${C.gray}Music (music-2.6)${C.reset}       100 次/天`);
    console.log(`    ${C.gray}Music-Cover${C.reset}             100 次/天`);
    console.log(`    ${C.gray}Lyrics${C.reset}                  100 次/天`);
    console.log('');
}

// ────────────────── 分发 ──────────────────

module.exports = function minimax(sub, opts) {
    const dispatch = {
        tts: cmdTts,
        image: cmdImage,
        video: cmdVideo,
        'music-cover': cmdMusicCover,
        lyrics: cmdLyrics,
        quota: cmdQuota
    };
    const fn = dispatch[sub];
    if (!fn) {
        console.error(`${C.red}✗${C.reset} 未知子命令: ${sub}`);
        console.error(`   可选: ${Object.keys(dispatch).join(' / ')}`);
        console.error(`   帮助: ${C.cyan}echocut minimax --help${C.reset}\n`);
        process.exit(1);
    }
    return fn(opts || {});
};

module.exports.registerSubcommands = function registerSubcommands(parent) {
    parent
        .command('tts')
        .description('文本转语音(speech-2.6-hd)→ mp3')
        .option('--text <text>', '要转的文本(和 --file 二选一)')
        .option('--file <path>', '从文件读文本')
        .option('--voice <id>', '音色 id(默认 male-qn-qingse)', 'male-qn-qingse')
        .option('--model <name>', '模型', 'speech-2.6-hd')
        .option('--output <path>', '输出 mp3 路径(默认 ./tts-<时间>.mp3)')
        .option('--format <fmt>', 'mp3 | pcm | wav | flac', 'mp3')
        .option('--speed <n>', '语速 0.5-2.0,默认 1.0')
        .option('--vol <n>', '音量 0-10,默认 1.0')
        .option('--pitch <n>', '音调 -12~12,默认 0')
        .option('--emotion <name>', 'happy / sad / angry / fearful / disgusted / surprised / neutral')
        .option('--sample-rate <n>', '采样率 default 32000')
        .option('--bitrate <n>', '比特率 default 128000')
        .action((opts) => cmdTts(opts));

    parent
        .command('image')
        .description('文生图(image-01)')
        .option('--prompt <text>', '图片描述(必填)')
        .option('--ratio <r>', '比例 1:1 | 16:9 | 9:16 | 4:3 | 3:4', '9:16')
        .option('-n, --n <n>', '张数 1-9', '1')
        .option('--output-dir <dir>', '输出目录(默认当前)')
        .option('--name <prefix>', '文件名前缀(默认 image-<时间>)')
        .option('--model <name>', '模型', 'image-01')
        .option('--no-optimizer', '关闭 prompt_optimizer(默认开)')
        .action((opts) => cmdImage(opts));

    parent
        .command('video')
        .description('文/图生视频(Hailuo 异步,轮询到完成自动下载)')
        .option('--prompt <text>', '视频描述(必填)')
        .option('--first-frame <path|url>', '首帧图(图生视频)')
        .option('--model <name>', '模型', 'MiniMax-Hailuo-2.3-Fast')
        .option('--duration <sec>', '时长(秒,通常 6/10)')
        .option('--resolution <r>', '分辨率 512P | 768P | 1080P')
        .option('--output <path>', '输出 mp4 路径(默认 ./minimax-video-<时间>.mp4)')
        .option('--poll-interval <sec>', '轮询间隔,默认 6', '6')
        .option('--max-wait <sec>', '最长等待,默认 600', '600')
        .action((opts) => cmdVideo(opts));

    parent
        .command('music-cover')
        .description('(占位)歌曲翻唱 — endpoint 已探到但 body spec 未公开,打印现状后退出')
        .action(() => cmdMusicCover());

    parent
        .command('lyrics')
        .description('(占位)歌词生成 — endpoint 存在但 body 字段未知,打印现状后退出')
        .action(() => cmdLyrics());

    parent
        .command('quota')
        .description('查看配额状态(MiniMax 官方没暴露查询接口,跳到用户中心链接)')
        .action(() => cmdQuota());
};
