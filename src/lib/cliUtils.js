const os = require('os');

function formatDuration(ms) {
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
    const min = Math.floor(totalSec / 60);
    const sec = Math.round(totalSec - min * 60);
    return `${min}m ${String(sec).padStart(2, '0')}s`;
}

function stepPrefix(opts) {
    if (!opts) return '  ';
    const { step, total } = opts;
    if (step && total) return `[${step}/${total}]`;
    return '  ';
}

class Spinner {
    constructor(label, opts = null) {
        this.label = label;
        this.opts = opts;
        this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.idx = 0;
        this.startMs = Date.now();
        this.interval = null;
        this.elapsedMs = 0;
    }

    start() {
        this.interval = setInterval(() => {
            const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(0);
            const prefix = stepPrefix(this.opts);
            process.stdout.write(`\r${prefix} ${this.frames[this.idx % this.frames.length]} ${this.label}  ${elapsed}s `);
            this.idx += 1;
        }, 120);
        return this;
    }

    stop(suffix = '') {
        if (this.interval) { clearInterval(this.interval); this.interval = null; }
        this.elapsedMs = Date.now() - this.startMs;
        const elapsed = formatDuration(this.elapsedMs);
        const prefix = stepPrefix(this.opts);
        process.stdout.write(`\r${prefix} ✓ ${this.label}  ${elapsed}${suffix ? '  ' + suffix : ''}\n`);
    }

    fail(suffix = '') {
        if (this.interval) { clearInterval(this.interval); this.interval = null; }
        this.elapsedMs = Date.now() - this.startMs;
        const elapsed = formatDuration(this.elapsedMs);
        const prefix = stepPrefix(this.opts);
        process.stdout.write(`\r${prefix} ✗ ${this.label}  ${elapsed}${suffix ? '  ' + suffix : ''}\n`);
    }
}

function makeProgressBar(width = 28, opts = null) {
    let lastPct = -1;
    const startMs = Date.now();
    const prefix = stepPrefix(opts);
    const label = opts && opts.label ? opts.label : '';
    return function onProgress(pct) {
        if (pct === lastPct) return;
        lastPct = pct;
        const filled = Math.floor(pct / 100 * width);
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
        const labelStr = label ? `${label}  ` : '';
        process.stdout.write(`\r${prefix} ${labelStr}[${bar}] ${String(pct).padStart(3)}%  ${elapsed}s `);
        if (pct >= 100) process.stdout.write('\n');
    };
}

function checkMemory(engine) {
    // 用 preflight 同款 available 计算(macOS unified memory 下 os.freemem 永远偏小,
    // 真正可用 = free + inactive + purgeable + speculative)
    const { getAvailableMemoryGB } = require('./preflight');
    const availGb = getAvailableMemoryGB();
    const warnGb = Number(process.env.MEMORY_WARN_GB || 4);
    if (availGb < 2) {
        console.warn(`  ⚠️  CRITICAL: 可用内存仅 ${availGb.toFixed(1)}GB — 进程可能 crash`);
    } else if (availGb < warnGb && engine && engine.startsWith('mlx')) {
        console.warn(`  ⚠️  内存偏紧: 可用 ${availGb.toFixed(1)}GB(MLX 推荐 6-8GB)`);
    }
}

// 全流程耗时汇总,在最后打印每步耗时 + 总计。
class StepTimeline {
    constructor() {
        this.records = [];
        this.startMs = Date.now();
    }

    record(name, elapsedMs, note = '') {
        this.records.push({ name, elapsedMs, note });
    }

    summary() {
        const totalMs = Date.now() - this.startMs;
        const lines = [];
        lines.push('─'.repeat(60));
        for (const r of this.records) {
            const t = formatDuration(r.elapsedMs).padStart(8);
            const note = r.note ? `  ${r.note}` : '';
            lines.push(`  ${t}  ${r.name}${note}`);
        }
        lines.push('─'.repeat(60));
        lines.push(`  ${formatDuration(totalMs).padStart(8)}  总耗时`);
        return lines.join('\n');
    }
}

module.exports = { Spinner, makeProgressBar, checkMemory, formatDuration, StepTimeline };
