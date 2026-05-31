'use strict';

/**
 * echocut translate <md-file-or-dir>
 *
 * 把中文 essay markdown 本地化翻译成英文(your-blog.com 风格)。
 * 不是逐字翻译,是 localization + rewrite,信达雅 + 符合英文博客阅读习惯。
 *
 * 用法:
 *   # 翻译单个文件 → 同目录 <原名>-en.md
 *   echocut translate docs/prompt-iterations/v05/essays/D-narrative.md
 *
 *   # 翻译整个 essays 目录的所有 .md(自动跳过已翻译的 -en.md)
 *   echocut translate debug_outputs/video/.../essays-v07/
 *
 *   # 强制重新翻译已存在的
 *   echocut translate <path> --rerun
 */

const fs = require('fs');
const path = require('path');
const { Spinner, formatDuration } = require('../../lib/cliUtils');
const { translateToEnglish } = require('../../services/translator');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m'
};

function fail(msg, hint = '') {
    console.error(`${C.red}✗${C.reset} ${msg}`);
    if (hint) console.error(`  ${C.gray}${hint}${C.reset}`);
    process.exit(1);
}

function expandPaths(input) {
    if (!input) fail('需要指定 md 文件或包含 md 的目录');
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) fail(`路径不存在: ${abs}`);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
        if (!abs.endsWith('.md')) fail(`期望 .md 文件,收到 ${abs}`);
        return [abs];
    }
    // 目录:扫所有 essay-*.md,跳过 -en.md
    return fs.readdirSync(abs)
        .filter((f) => f.endsWith('.md') && !f.endsWith('-en.md'))
        .map((f) => path.join(abs, f));
}

function targetEnPath(srcPath) {
    return srcPath.replace(/\.md$/, '-en.md');
}

function buildEnFrontMatter(srcFrontMatter, srcRelPath, elapsedMs, usage) {
    const lines = [];
    lines.push('---');
    lines.push('language: en');
    lines.push(`translation_of: "${srcRelPath}"`);
    lines.push(`translated_at: ${new Date().toISOString()}`);
    lines.push(`elapsed_ms: ${elapsedMs}`);
    lines.push(`elapsed_human: ${formatDuration(elapsedMs)}`);
    if (usage) {
        if (usage.prompt_tokens != null) lines.push(`tokens_prompt: ${usage.prompt_tokens}`);
        if (usage.completion_tokens != null) lines.push(`tokens_completion: ${usage.completion_tokens}`);
    }
    // 把原 front matter 关键字段也带过来,方便溯源
    if (srcFrontMatter) {
        const kvs = {};
        for (const line of srcFrontMatter.split('\n')) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
            kvs[k] = v;
        }
        for (const k of ['style', 'style_label', 'voice', 'model', 'source_title']) {
            if (kvs[k]) {
                const safe = String(kvs[k]).replace(/"/g, '\\"');
                lines.push(`source_${k}: "${safe}"`);
            }
        }
    }
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

module.exports = async function translate(input, opts) {
    const files = expandPaths(input);
    if (!files.length) fail('没找到要翻译的 md 文件');

    // 过滤已存在的(除非 --rerun)
    const todo = files.filter((f) => {
        const en = targetEnPath(f);
        if (!opts.rerun && fs.existsSync(en)) return false;
        return true;
    });

    console.log('');
    console.log(`${C.cyan}🌐 echocut translate${C.reset}  ${C.gray}(中→英 本地化翻译,your-blog.com 风格)${C.reset}`);
    console.log(`   ${C.gray}找到 .md${C.reset}    ${files.length}`);
    console.log(`   ${C.gray}待翻译${C.reset}      ${todo.length} ${todo.length < files.length ? C.gray + ' (' + (files.length - todo.length) + ' 篇已有 -en.md,加 --rerun 重翻)' + C.reset : ''}`);
    console.log(`   ${C.gray}模型${C.reset}        MiniMax-M2.7${opts.minimaxModel ? ` (覆盖 ${opts.minimaxModel})` : ''}`);
    console.log('');

    if (!todo.length) {
        console.log(`${C.green}✓${C.reset} 全部已翻译,无新任务`);
        return;
    }

    const summary = [];
    for (let i = 0; i < todo.length; i += 1) {
        const src = todo[i];
        const rel = path.relative(process.cwd(), src);
        const tag = `[${i + 1}/${todo.length}] ${path.basename(src)}`;
        const spinner = new Spinner(tag).start();
        try {
            const chinese = fs.readFileSync(src, 'utf8');
            const result = await translateToEnglish({
                chineseMd: chinese,
                minimaxModel: opts.minimaxModel
            });
            const enPath = targetEnPath(src);
            const fm = buildEnFrontMatter(result.frontMatter, rel, result.elapsedMs, result.usage);
            fs.writeFileSync(enPath, fm + result.english + '\n');
            const wordCount = result.english.split(/\s+/).filter(Boolean).length;
            spinner.stop(`${wordCount} words → ${path.basename(enPath)}`);
            summary.push({ src: rel, enPath, words: wordCount, elapsedMs: result.elapsedMs, ok: true });
        } catch (e) {
            spinner.fail(`${C.red}${e.message.slice(0, 100)}${C.reset}`);
            if (e.hint) console.error(`     ${C.gray}${e.hint}${C.reset}`);
            summary.push({ src: rel, ok: false, error: e.message });
        }
    }

    console.log('');
    console.log(`${C.gray}${'─'.repeat(70)}${C.reset}`);
    const okCount = summary.filter((s) => s.ok).length;
    console.log(`${C.green}✓${C.reset} 翻译完成 ${okCount}/${todo.length} 篇`);
    if (okCount > 0) {
        console.log('');
        for (const s of summary.filter((x) => x.ok)) {
            console.log(`  ${C.dim}${path.basename(s.src).padEnd(40)}${C.reset}  ${String(s.words).padStart(4)} words  ${formatDuration(s.elapsedMs)}`);
        }
    }
    const failed = summary.filter((s) => !s.ok);
    if (failed.length) {
        console.log('');
        console.log(`${C.yellow}⚠${C.reset}  ${failed.length} 篇失败:`);
        for (const f of failed) console.log(`   ${C.red}${path.basename(f.src)}${C.reset}: ${f.error.slice(0, 120)}`);
    }
    console.log('');
};
