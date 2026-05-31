'use strict';

/**
 * asr-score-cer.js — 对 .echo-bench/out/ 里已保存的转写文本,按 GT 算 CER
 * 不重跑模型。GT 文件: .echo-bench/<seg>.gt.txt(去空白后比对)
 *
 * 用法: node scripts/asr-score-cer.js <seg-label> [seg-label2 ...]
 *   会扫 .echo-bench/out/<seg>__*.txt 全部引擎,逐一对 .echo-bench/<seg>.gt.txt 算 CER
 */

const fs = require('fs');
const path = require('path');

const R = path.resolve(__dirname, '..');
const OUT = path.join(R, '.echo-bench', 'out');
const BENCH = path.join(R, '.echo-bench');

function norm(s) {
    // 仅保留汉字 + 字母数字,去标点/空白(CER 标准做法,标点不计错)
    return String(s || '').replace(/^---[\s\S]*?---/, '')
        .replace(/[^一-鿿A-Za-z0-9]/g, '');
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i += 1) {
        cur[0] = i;
        for (let j = 1; j <= n; j += 1) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

const labels = process.argv.slice(2);
if (!labels.length) { console.error('用法: node scripts/asr-score-cer.js <seg-label> ...'); process.exit(1); }

for (const label of labels) {
    const gtPath = path.join(BENCH, `${label}.gt.txt`);
    if (!fs.existsSync(gtPath)) { console.log(`\n[${label}] 无 GT(${gtPath}),跳过`); continue; }
    const gt = norm(fs.readFileSync(gtPath, 'utf8'));
    const files = fs.readdirSync(OUT).filter((f) => f.startsWith(label + '__') && f.endsWith('.txt'));
    console.log(`\n## ${label}  (GT ${gt.length} 字)`);
    console.log('| 引擎 | CER | 编辑距离 | 转写字数 |');
    console.log('|---|---|---|---|');
    const res = [];
    for (const f of files) {
        const eng = f.slice(label.length + 2, -4);
        const hyp = norm(fs.readFileSync(path.join(OUT, f), 'utf8'));
        const dist = levenshtein(hyp, gt);
        const cer = +(dist / gt.length * 100).toFixed(2);
        res.push({ eng, cer, dist, len: hyp.length });
    }
    res.sort((a, b) => a.cer - b.cer);
    for (const r of res) console.log(`| ${r.eng} | **${r.cer}%** | ${r.dist} | ${r.len} |`);
}
