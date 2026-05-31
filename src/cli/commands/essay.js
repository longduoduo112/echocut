'use strict';

/**
 * echocut essay — 从视频 transcript 生成公众号文章
 *
 * 单视频默认跑 3 风格 × 2 模型 = 6 篇,放在 transcript 同目录的 essays/ 下,
 * 文件名 essay-<style>-<model>.md,前置 front-matter 标注模型 / 风格 / 字数 / 耗时。
 *
 * 用法:
 *   echocut essay <transcript.json 或 视频目录>
 *   echocut essay <path> --style structured --model minimax    单 prompt × 单模型
 *   echocut essay <path> --style all --model ollama            3 风格 × 本地
 *   echocut essay <path> --style all --model both              3 × 2 = 6 篇(默认)
 *
 * 用户提的 12 篇任务:
 *   echocut essay <video-A 目录> --style all --model both     → 6 篇
 *   echocut essay <video-B 目录> --style all --model both     → 6 篇
 */

const fs = require('fs');
const path = require('path');
const { Spinner, formatDuration } = require('../../lib/cliUtils');
const { generateEssay, STYLES, MODELS, VOICES, PROMPTS } = require('../../services/essayGenerator');
const { translateToEnglish } = require('../../services/translator');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', dim: '\x1b[2m'
};

function fail(msg, hint = '') {
    console.error(`${C.red}✗${C.reset} ${msg}`);
    if (hint) console.error(`  ${C.gray}${hint}${C.reset}`);
    process.exit(1);
}

/**
 * 接受三种输入:
 *   1. transcript.json 绝对路径(视频处理产物)
 *   2. 包含 transcript.json 的目录(自动找,支持嵌套一层)
 *   3. **.txt 纯文本文件**(直接当 transcript,文章生成不依赖视频)
 *
 * @returns { sourcePath:string, kind:'json'|'txt' }
 */
function resolveSourcePath(input) {
    if (!input) fail('需要指定 transcript.json / 视频目录 / 纯文本 .txt 文件');
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) fail(`路径不存在: ${abs}`);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
        if (abs.endsWith('.json')) return { sourcePath: abs, kind: 'json' };
        if (abs.endsWith('.txt') || abs.endsWith('.md')) return { sourcePath: abs, kind: 'txt' };
        fail(`不支持的文件类型: ${abs}`, '支持 .json (transcript) / .txt (纯文本) / .md (纯文本)');
    }
    // 目录:找 transcript.json
    const direct = path.join(abs, 'transcript.json');
    if (fs.existsSync(direct)) return { sourcePath: direct, kind: 'json' };
    // 嵌套一层
    const entries = fs.readdirSync(abs).filter((e) => fs.statSync(path.join(abs, e)).isDirectory());
    for (const e of entries) {
        const nested = path.join(abs, e, 'transcript.json');
        if (fs.existsSync(nested)) return { sourcePath: nested, kind: 'json' };
    }
    fail(`目录里没找到 transcript.json: ${abs}`, '请检查是否是 echocut burn 的产物目录,或者直接给 .txt 文件');
    return null;
}

/**
 * 从 publish.md 抓 headline / subline / duration 作为 context
 * 只有 kind='json' 时(视频产物目录)才走这里
 */
function parsePublishContext(sourcePath, kind) {
    if (kind !== 'json') return {};
    const dir = path.dirname(sourcePath);
    const publishMd = path.join(dir, 'publish.md');
    if (!fs.existsSync(publishMd)) return {};
    const md = fs.readFileSync(publishMd, 'utf8');
    const ctx = {};
    const durMatch = md.match(/时长[::]\s*([0-9:]+)/);
    if (durMatch) ctx.duration = durMatch[1];
    const titleMatch = md.match(/命令标题(?:[(（][^)）]*[)）])?[::]\s*\*\*([^*]+)\*\*/);
    if (titleMatch) ctx.title = titleMatch[1].trim();
    if (!ctx.title) {
        const g1 = md.match(/##\s*组一[\s\S]*?\*\*标题[::]\*\*\s*([^\n]+)/);
        if (g1) ctx.title = g1[1].trim();
    }
    return ctx;
}

function readSource(sourcePath, kind) {
    if (kind === 'txt') {
        const text = fs.readFileSync(sourcePath, 'utf8').trim();
        if (!text) fail(`纯文本文件为空: ${sourcePath}`);
        return text;
    }
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const data = JSON.parse(raw);
    const text = String(data.full_text || '').trim();
    if (!text) fail(`transcript 为空: ${sourcePath}`);
    return text;
}

function buildFrontMatter({ style, model, voice, sourcePath, sourceKind, context, elapsedMs, usage, charCount, prompt }) {
    const lines = [];
    lines.push('---');
    lines.push(`style: ${style}`);
    lines.push(`style_label: ${prompt.label}`);
    lines.push(`voice: ${voice}`);
    lines.push(`model: ${model}`);
    lines.push(`generated: ${new Date().toISOString()}`);
    lines.push(`elapsed_ms: ${elapsedMs}`);
    lines.push(`elapsed_human: ${formatDuration(elapsedMs)}`);
    lines.push(`char_count: ${charCount}`);
    lines.push(`target_char_count: "${prompt.targetCharCount}"`);
    if (context.title) lines.push(`source_title: "${String(context.title).replace(/"/g, '\\"')}"`);
    if (context.duration) lines.push(`source_duration: ${context.duration}`);
    lines.push(`source_kind: ${sourceKind}`);
    lines.push(`source_path: "${path.relative(process.cwd(), sourcePath)}"`);
    if (usage) {
        if (usage.prompt_tokens != null) lines.push(`tokens_prompt: ${usage.prompt_tokens}`);
        if (usage.completion_tokens != null) lines.push(`tokens_completion: ${usage.completion_tokens}`);
    }
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

module.exports = async function essay(input, opts) {
    const { sourcePath, kind: sourceKind } = resolveSourcePath(input);
    const transcript = readSource(sourcePath, sourceKind);
    const context = parsePublishContext(sourcePath, sourceKind);
    // .txt 输入允许用户用 --title 显式指定主题
    if (!context.title && opts.title) context.title = opts.title;

    // 决定要跑的 (style, model, voice) 组合
    let styles;
    if (!opts.style || opts.style === 'all') styles = [...STYLES];
    else if (STYLES.includes(opts.style)) styles = [opts.style];
    else fail(`--style 必须是 ${STYLES.join(' / ')} / all,收到 "${opts.style}"`);

    let models;
    if (!opts.model || opts.model === 'both') models = [...MODELS];
    else if (MODELS.includes(opts.model)) models = [opts.model];
    else fail(`--model 必须是 ${MODELS.join(' / ')} / both,收到 "${opts.model}"`);

    let voices;
    if (!opts.voice || opts.voice === 'first') voices = ['first'];
    else if (opts.voice === 'third') voices = ['third'];
    else if (opts.voice === 'both') voices = ['first', 'third'];
    else fail(`--voice 必须是 first / third / both,收到 "${opts.voice}"`);

    // 产出目录:json 输入默认在视频目录下;txt 输入默认在同级 essays/<txt 文件名>/
    const outDir = opts.outDir
        ? path.resolve(opts.outDir)
        : sourceKind === 'txt'
            ? path.join(path.dirname(sourcePath), 'essays-' + path.basename(sourcePath, path.extname(sourcePath)))
            : path.join(path.dirname(sourcePath), 'essays');
    fs.mkdirSync(outDir, { recursive: true });

    // 顶部信息
    console.log('');
    console.log(`${C.cyan}📝 echocut essay${C.reset}  ${sourceKind === 'txt' ? `${C.gray}(纯文本模式)${C.reset}` : ''}`);
    console.log(`   ${C.gray}输入${C.reset}        ${path.relative(process.cwd(), sourcePath)}`);
    console.log(`   ${C.gray}主题${C.reset}        ${context.title || '(让 LLM 自己提炼)'}`);
    console.log(`   ${C.gray}原文字数${C.reset}    ${transcript.length}`);
    console.log(`   ${C.gray}风格${C.reset}        ${styles.join(', ')}`);
    console.log(`   ${C.gray}模型${C.reset}        ${models.join(', ')}`);
    console.log(`   ${C.gray}口吻${C.reset}        ${voices.map((v) => v === 'first' ? '第一人称(我=Example)' : '第三人称(旁观讲Example)').join(', ')}`);
    console.log(`   ${C.gray}产出目录${C.reset}    ${path.relative(process.cwd(), outDir)}/`);
    console.log('');

    const total = styles.length * models.length * voices.length;
    let idx = 0;
    const summary = [];

    for (const style of styles) {
        for (const model of models) {
            for (const voice of voices) {
                idx += 1;
                const tag = `[${idx}/${total}] ${style} × ${model} × ${voice}`;
                const spinner = new Spinner(tag).start();
                try {
                    const result = await generateEssay({
                        transcript,
                        context,
                        style,
                        model,
                        voice,
                        ollamaModel: opts.ollamaModel,
                        minimaxModel: opts.minimaxModel
                    });
                    const charCount = result.markdown.replace(/\s+/g, '').length;
                    // voice=first 时文件名跟旧版兼容,不加 voice 后缀;voice=third 加后缀
                    const filename = voice === 'first'
                        ? `essay-${style}-${model}.md`
                        : `essay-${style}-${model}-${voice}.md`;
                    const filePath = path.join(outDir, filename);
                    const frontMatter = buildFrontMatter({
                        style, model, voice, sourcePath, sourceKind, context,
                        elapsedMs: result.elapsedMs,
                        usage: result.usage,
                        charCount,
                        prompt: PROMPTS[style]
                    });
                    fs.writeFileSync(filePath, frontMatter + result.markdown + '\n');
                    spinner.stop(`${charCount} 字 → ${filename}`);
                    summary.push({ style, model, voice, charCount, elapsedMs: result.elapsedMs, file: filename, ok: true });
                } catch (e) {
                    spinner.fail(`${C.red}${e.message.slice(0, 100)}${C.reset}`);
                    if (e.hint) console.error(`     ${C.gray}${e.hint}${C.reset}`);
                    summary.push({ style, model, voice, ok: false, error: e.message });
                }
            }
        }
    }

    // 总结
    console.log('');
    console.log(`${C.gray}${'─'.repeat(70)}${C.reset}`);
    const okCount = summary.filter((s) => s.ok).length;
    console.log(`${C.green}✓${C.reset} 完成 ${okCount}/${total} 篇,放在 ${C.cyan}${path.relative(process.cwd(), outDir)}/${C.reset}`);
    if (okCount > 0) {
        console.log('');
        for (const s of summary.filter((x) => x.ok)) {
            console.log(`  ${C.dim}${s.style.padEnd(11)}${C.reset} ${s.model.padEnd(8)} ${s.voice.padEnd(6)} ${String(s.charCount).padStart(5)} 字  ${formatDuration(s.elapsedMs)}  ${s.file}`);
        }
    }
    const failed = summary.filter((s) => !s.ok);
    if (failed.length) {
        console.log('');
        console.log(`${C.yellow}⚠${C.reset}  ${failed.length} 篇失败:`);
        for (const f of failed) console.log(`   ${C.red}${f.style} × ${f.model} × ${f.voice}${C.reset}: ${f.error.slice(0, 120)}`);
    }

    // ─── --translate:跑完中文立即翻译每篇成英文 ─────────────────────────────
    if (opts.translate && okCount > 0) {
        console.log('');
        console.log(`${C.cyan}🌐 自动翻译成英文(your-blog.com 风格,作者名 Bill)${C.reset}`);
        console.log('');

        const okEssays = summary.filter((s) => s.ok);
        const transSummary = [];
        for (let i = 0; i < okEssays.length; i += 1) {
            const item = okEssays[i];
            const cnPath = path.join(outDir, item.file);
            const enPath = cnPath.replace(/\.md$/, '-en.md');
            const tag = `[${i + 1}/${okEssays.length}] 翻译 ${item.file}`;
            const spinner = new Spinner(tag).start();
            try {
                const cnRaw = fs.readFileSync(cnPath, 'utf8');
                const t = await translateToEnglish({
                    chineseMd: cnRaw,
                    minimaxModel: opts.minimaxModel
                });
                // 简易 front matter:复用中文 front matter 关键字段
                const fmLines = [
                    '---',
                    'language: en',
                    `translation_of: "${path.relative(process.cwd(), cnPath)}"`,
                    `translated_at: ${new Date().toISOString()}`,
                    `elapsed_ms: ${t.elapsedMs}`,
                    `elapsed_human: ${formatDuration(t.elapsedMs)}`,
                    `source_style: ${item.style}`,
                    `source_voice: ${item.voice}`,
                    'source_author_cn: Example',
                    'author_en: Bill',
                    '---',
                    ''
                ];
                fs.writeFileSync(enPath, fmLines.join('\n') + t.english + '\n');
                const wordCount = t.english.split(/\s+/).filter(Boolean).length;
                spinner.stop(`${wordCount} words → ${path.basename(enPath)}`);
                transSummary.push({ ok: true, cn: item.file, en: path.basename(enPath), words: wordCount, elapsedMs: t.elapsedMs });
            } catch (e) {
                spinner.fail(`${C.red}${(e.message || '').slice(0, 100)}${C.reset}`);
                transSummary.push({ ok: false, cn: item.file, error: e.message });
            }
        }

        console.log('');
        const okTrans = transSummary.filter((x) => x.ok).length;
        console.log(`${C.gray}${'─'.repeat(70)}${C.reset}`);
        console.log(`${C.green}✓${C.reset} 翻译完成 ${okTrans}/${okEssays.length} 篇`);
        if (okTrans > 0) {
            console.log('');
            for (const t of transSummary.filter((x) => x.ok)) {
                console.log(`  ${C.dim}${t.cn.padEnd(38)}${C.reset} → ${t.en}  ${String(t.words).padStart(4)} words  ${formatDuration(t.elapsedMs)}`);
            }
        }
        const transFailed = transSummary.filter((x) => !x.ok);
        if (transFailed.length) {
            console.log('');
            console.log(`${C.yellow}⚠${C.reset}  ${transFailed.length} 篇翻译失败(可手动 echocut translate 重试):`);
            for (const f of transFailed) console.log(`   ${C.red}${f.cn}${C.reset}: ${(f.error || '').slice(0, 120)}`);
        }
    }
    console.log('');
};
