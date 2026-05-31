'use strict';

/**
 * asr-benchmark.js — 多引擎中文 ASR 基准评测
 *
 * 用法:
 *   node scripts/asr-benchmark.js \
 *     --segments .echo-bench/seg-clean-demo.wav:clean,.echo-bench/seg-hard-meeting.wav:hard \
 *     --engines mlx_hq,mlx,funasr,sensevoice,qwen3
 *
 * 设计:
 *  - 内置引擎走 transcribeByEngine;qwen3 走 mlx-qwen3-asr CLI(json+timestamps)
 *  - 无人工 ground-truth 时也能给客观信号:
 *      幻觉重复率 / 外语串码(日韩) / Whisper 字幕组伪词 / 语速合理性 / 领域词召回
 *  - 有 .gt.txt 同名参考时,额外算 CER
 *  - 产物:.echo-bench/out/<seg>__<engine>.txt + docs/ASR-BENCHMARK-RESULTS.md
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const R = path.resolve(__dirname, '..');
const { initDb } = require(R + '/src/db');
const { ensureDefaultConfigs } = require(R + '/src/db/configRepo');
const { transcribeByEngine } = require(R + '/src/video/asrAdapters');
const { getConfig } = require(R + '/src/config');

const OUT = path.join(R, '.echo-bench', 'out');
const VENV_PY = path.join(R, '.venv', 'bin', 'python');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : def;
}

function audioDuration(wav) {
    const s = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', wav], { encoding: 'utf8' }).trim();
    return Number(s) || 0;
}

// ---- 客观指标(无需 ground truth) ----

// 日文假名 + 韩文谚文(中文 ASR 不该出现)
const FOREIGN_RE = /[ぁ-ゟァ-ヿ가-힣]/g;
// Whisper 训练集泄漏的字幕组伪词
const WHISPER_ARTIFACTS = ['字幕志愿者', '李宗盛', '请订阅', '谢谢观看', '謝謝觀看', '请不吝点赞',
    '明镜与点点栏目', 'Amara.org', '字幕由', '感谢观看', '下次再见', '中文字幕'];

function repetitionScore(text) {
    // 最长「单字/双字立即重复」占比:抓 容容容容 / 午安午安 这类解码死循环
    const t = text.replace(/\s/g, '');
    if (t.length < 10) return 0;
    let worst = 0;
    for (const unit of [1, 2, 3, 4]) {
        let i = 0;
        while (i < t.length - unit) {
            const tok = t.slice(i, i + unit);
            let run = 1;
            while (t.slice(i + run * unit, i + run * unit + unit) === tok) run += 1;
            if (run >= 3) worst = Math.max(worst, (run * unit) / t.length);
            i += Math.max(1, run * unit);
        }
    }
    return worst; // 0~1,越高越像幻觉
}

function metrics(text, audioSec, domainTerms) {
    const chars = text.replace(/\s/g, '').length;
    const foreign = (text.match(FOREIGN_RE) || []).length;
    const artifacts = WHISPER_ARTIFACTS.filter((a) => text.includes(a));
    const rep = repetitionScore(text);
    const charRate = audioSec ? +(chars / audioSec).toFixed(2) : 0; // 中文口播正常 3.5~6 字/s
    const m = { chars, charRate, foreign, repetition: +(rep * 100).toFixed(1) + '%',
        artifacts: artifacts.length ? artifacts.join('/') : '无' };
    if (domainTerms && domainTerms.length) {
        const hit = domainTerms.filter((w) => text.includes(w));
        m.domainRecall = `${hit.length}/${domainTerms.length}`;
        m._domainHit = hit;
    }
    // 综合健康分(越高越好):无幻觉无外语串码、语速合理
    let health = 100;
    health -= Math.min(60, rep * 200);
    health -= Math.min(25, foreign * 2);
    health -= artifacts.length * 15;
    if (charRate && (charRate < 1.5 || charRate > 9)) health -= 20;
    m.health = Math.max(0, Math.round(health));
    return m;
}

// ---- 引擎调度 ----

async function runEngine(engine, wav) {
    const t0 = Date.now();
    if (engine === 'mimo' || engine === 'mimo-4bit') {
        // MiMo-V2.5-ASR(8B,小米,原生 MLX),走 python runner;8bit 主测 / 4bit 提速对比
        const mdir = engine === 'mimo-4bit' ? 'MiMo-V2.5-ASR-MLX-4bit' : 'MiMo-V2.5-ASR-MLX-8bit';
        const out = execFileSync(VENV_PY, [path.join(R, 'scripts', 'run_mimo_asr.py'), wav,
            path.join(R, 'models', mdir),
            path.join(R, 'models', 'MiMo-Audio-Tokenizer'), 'zh'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
        const jline = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
        const d = JSON.parse(jline);
        if (d.error) throw new Error(d.error);
        return { fullText: (d.text || '').trim(), words: [], ms: d.elapsed_ms || (Date.now() - t0) };
    }
    if (engine === 'qwen3' || engine === 'qwen3-06b' || engine === 'qwen3-bf16') {
        const model = engine === 'qwen3-06b' ? 'Qwen/Qwen3-ASR-0.6B'
            : engine === 'qwen3-bf16' ? 'mlx-community/Qwen3-ASR-1.7B-bf16'
                : 'Qwen/Qwen3-ASR-1.7B';
        const od = path.join(OUT, '_qwen_tmp');
        fs.mkdirSync(od, { recursive: true });
        execFileSync(VENV_PY, ['-m', 'mlx_qwen3_asr', wav, '--model', model, '--language', 'zh',
            '--output-dir', od, '--output-format', 'json', '--timestamps', '--no-progress', '--quiet'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
        const jf = fs.readdirSync(od).filter((f) => f.endsWith('.json'))
            .map((f) => path.join(od, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const d = JSON.parse(fs.readFileSync(jf, 'utf8'));
        const segs = d.segments || [];
        const fullText = (d.text || segs.map((s) => s.text).join('')).trim();
        const words = d.words || segs.flatMap((s) => s.words || []);
        return { fullText, words: words || [], ms: Date.now() - t0 };
    }
    const r = await transcribeByEngine(wav, engine);
    return { fullText: (r.fullText || '').trim(), words: r.words || [], ms: r.transcribeMs || (Date.now() - t0) };
}

// 演示视频领域词(DocuMind 智能文档汇编系统)
const DOMAIN_TERMS = ['文档', '系统', '知识库', '汇编', '智能', '上传', '解析', '检索',
    '问答', '模型', '演示', '功能', '数据', '生成', '管理', '用户'];

async function main() {
    const cfg = getConfig();
    initDb(cfg.contentDbPath);
    ensureDefaultConfigs();
    fs.mkdirSync(OUT, { recursive: true });

    const segs = arg('segments').split(',').map((s) => {
        const [p, label] = s.split(':');
        const wav = path.resolve(p);
        const gt = wav.replace(/\.wav$/i, '.gt.txt');
        return { wav, label: label || path.basename(p), dur: audioDuration(wav),
            gt: fs.existsSync(gt) ? fs.readFileSync(gt, 'utf8').replace(/\s/g, '') : null };
    });
    const engines = arg('engines', 'mlx_hq,mlx,funasr,sensevoice,qwen3').split(',');

    const benchT0 = Date.now();
    const rows = [];
    for (const seg of segs) {
        // 领域词召回只对 DocuMind 屏幕演示段有意义(已知词表),其它场景无固定词表
        const useDomain = /demo|screen/i.test(seg.label);
        console.log(`\n### 段 [${seg.label}] ${seg.dur.toFixed(0)}s ${seg.gt ? '(有GT)' : '(无GT)'}`);
        for (const eng of engines) {
            process.stdout.write(`  ${eng} ... `);
            try {
                const { fullText, words, ms } = await runEngine(eng, seg.wav);
                const m = metrics(fullText, seg.dur, useDomain ? DOMAIN_TERMS : null);
                const rtf = +(ms / 1000 / seg.dur).toFixed(3);
                let cer = null;
                if (seg.gt) cer = +(levenshtein(fullText.replace(/\s/g, ''), seg.gt) / seg.gt.length * 100).toFixed(2);
                fs.writeFileSync(path.join(OUT, `${seg.label}__${eng}.txt`), fullText + '\n');
                const row = { seg: seg.label, eng, rtf, sec: +(ms / 1000).toFixed(0), cer, ...m };
                rows.push(row);
                console.log(`✓ ${m.chars}字 RTF=${rtf} 健康=${m.health}${cer != null ? ' CER=' + cer + '%' : ''} 重复=${m.repetition} 外语=${m.foreign}`);
            } catch (e) {
                console.log(`✗ ${String(e.message || e).slice(0, 120)}`);
                rows.push({ seg: seg.label, eng, error: String(e.message || e).slice(0, 80) });
            }
        }
    }

    // ---- 报告 ----
    const md = [];
    const benchMin = ((Date.now() - benchT0) / 60000).toFixed(1);
    md.push('# ASR 多引擎基准评测结果');
    md.push('');
    md.push(`> 生成: ${new Date().toISOString()} · 机器: M4 Pro 48GB · 本轮总耗时 ${benchMin} 分钟`);
    md.push('');
    md.push('## 指标含义(先读这个)');
    md.push('');
    md.push('| 指标 | 含义 | 怎么看 |');
    md.push('|---|---|---|');
    md.push('| **RTF** | Real-Time Factor = 转写耗时 ÷ 音频时长 | 越低越快。0.1 = 比实时快 10 倍;1.0 = 与音频等长 |');
    md.push('| **耗时s** | 该段实际墙钟耗时(秒) | 直观速度,含模型推理 |');
    md.push('| **健康分** | 0-100 综合鲁棒性分(无 GT 也能算) | 越高越好。扣分项:幻觉重复 / 外语串码 / 字幕组伪词 / 语速异常 |');
    md.push('| **CER** | Character Error Rate 字错率(需人工 GT) | 越低越准。8%≈每百字错8个;>15% 基本不可用 |');
    md.push('| **字数** | 去空白后汉字数 | 配合语速判断是否漏转(太少)或幻觉(太多) |');
    md.push('| **语速字/s** | 字数 ÷ 音频秒 | 中文口播正常 3.5~6;<1.5 漏听严重;>9 多半幻觉灌水 |');
    md.push('| **重复率** | 最长立即重复片段占全文比例 | 抓「容容容容」「午安午安」解码死循环;>10% 即异常 |');
    md.push('| **外语串** | 误输出的日文假名/韩文字数 | 中文素材不该出现;>0 = 语种误判 |');
    md.push('| **字幕伪词** | Whisper 训练集泄漏的字幕组套话(如「字幕志愿者/李宗盛」) | 出现=幻觉,该段不可信 |');
    md.push('| **领域词** | DocuMind 演示段专有词命中数(仅屏幕录屏段) | 召回越高越准,衡量专业术语识别 |');
    md.push('');
    md.push('> 选型主依据 = 场景 A(大疆拍摄)+ 场景 B(屏幕录屏)两类**真实高频场景**;远场会议/嘈杂多人为**鲁棒性压测**(选型加分项,非主依据)。');
    md.push('');
    for (const seg of segs) {
        md.push(`## 段:${seg.label}(${seg.dur.toFixed(0)}s${seg.gt ? ',有人工GT' : ',无GT—看健康分'})`);
        md.push('');
        md.push('| 引擎 | RTF | 耗时s | 健康分 | CER | 字数 | 语速字/s | 重复率 | 外语串 | 字幕伪词 | 领域词 |');
        md.push('|---|---|---|---|---|---|---|---|---|---|---|');
        for (const r of rows.filter((x) => x.seg === seg.label)) {
            if (r.error) { md.push(`| **${r.eng}** | — | — | ❌ | — | — | — | — | — | — | ${r.error} |`); continue; }
            md.push(`| **${r.eng}** | ${r.rtf} | ${r.sec} | ${r.health} | ${r.cer != null ? r.cer + '%' : '—'} | ${r.chars} | ${r.charRate} | ${r.repetition} | ${r.foreign} | ${r.artifacts} | ${r.domainRecall || '—'} |`);
        }
        md.push('');
    }
    md.push('## 产物');
    md.push('每段每引擎的完整转写文本在 `.echo-bench/out/<段>__<引擎>.txt`,可人工比对。');
    md.push('');
    const rep = path.join(R, 'docs', 'ASR-BENCHMARK-RESULTS.md');
    fs.writeFileSync(rep, md.join('\n') + '\n');
    console.log(`\n报告: ${rep}`);
    console.log(`文本: ${OUT}/`);
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i += 1) {
        cur[0] = i;
        for (let j = 1; j <= n; j += 1) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
