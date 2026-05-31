'use strict';

/**
 * panelOrchestrator — panel/圆桌视频一键流水线编排
 *
 * 把今晚手工 6 步流程(转写→关键词扫描→推断段→切片→重构图→burn)打包成可调用 API。
 * CLI 入口在 src/cli/commands/panelClip.js。
 *
 * 步骤可选跳过(--skip-* flag),便于增量调试:
 *   1. extractAudio  ffmpeg 提音轨 + loudnorm
 *   2. transcribe    qwen3-ASR 全量转写(产 transcript.json)
 *   3. locate        scan name events + cluster + infer segments(产 segments.json)
 *   4. cut           ffmpeg 切片每段(精确 seek + 重编码 + dynaudnorm)
 *   5. concat        拼合成 compilation_raw.mp4
 *   6. burn          串行调 echocut burn(每段 + 合集),自动 --auto-pad
 *
 * 设计:
 * - 每步前 print 步骤名 + 计时
 * - 每步 try/catch,失败时清晰报告卡在哪步,可恢复
 * - 中间产物全落 outDir/,可重入(已存在 transcript.json 时跳过 transcribe)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    scanNameEvents,
    clusterEvents,
    inferSpeakerSegments,
} = require('./dialogueLocator');

// ─── 工具 ────────────────────────────────────────────────────────────────

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function probeDuration(filePath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
    ], { encoding: 'utf8', timeout: 15000 });
    const d = parseFloat(String(r.stdout || '').trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
}

function probeSize(filePath) {
    const r = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0', filePath,
    ], { encoding: 'utf8', timeout: 10000 });
    const line = String(r.stdout || '').trim();
    const parts = line.split(',').map((s) => parseInt(s.trim(), 10));
    return { width: parts[0] || 0, height: parts[1] || 0 };
}

function writeJsonAtomic(p, obj) {
    ensureDir(path.dirname(p));
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
}

function resolvePythonBin() {
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
    const local = path.join(process.cwd(), '.venv', 'bin', 'python');
    if (fs.existsSync(local)) return local;
    return 'python3';
}

function colorLog(msg, color = 'cyan') {
    const C = { cyan: 36, green: 32, gray: 90, red: 31, yellow: 33 };
    process.stdout.write(`\x1b[${C[color]}m${msg}\x1b[0m\n`);
}

// ─── Step 1: extract audio ─────────────────────────────────────────────

function extractAudio(input, outAudio) {
    if (fs.existsSync(outAudio)) {
        colorLog(`  [audio] 已存在,跳过 → ${outAudio}`, 'gray');
        return;
    }
    const r = spawnSync('ffmpeg', [
        '-y', '-i', input,
        '-vn', '-ac', '1', '-ar', '16000',
        '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11',
        outAudio,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`extractAudio failed: ${(r.stderr || '').slice(-200)}`);
}

// ─── Step 2: transcribe ─────────────────────────────────────────────────

function transcribe(audio, outJson) {
    if (fs.existsSync(outJson) && fs.statSync(outJson).size > 0) {
        colorLog(`  [transcribe] 已存在,跳过 → ${outJson}`, 'gray');
        return JSON.parse(fs.readFileSync(outJson, 'utf8'));
    }
    const py = resolvePythonBin();
    const script = path.join(process.cwd(), 'python', 'transcribe_qwen3.py');
    if (!fs.existsSync(script)) throw new Error(`transcribe script missing: ${script}`);
    const r = spawnSync(py, [script, audio, outJson], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`transcribe failed: ${(r.stderr || '').slice(-300)}`);
    return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

// ─── Step 3: locate segments ───────────────────────────────────────────

function locate(transcript, namesDict, options) {
    const events = scanNameEvents(transcript.full_text, transcript.words, namesDict);
    const clusters = clusterEvents(events);
    const duration = transcript.words.length > 0 ? transcript.words[transcript.words.length - 1].end : 0;
    const { segments, debug } = inferSpeakerSegments(clusters, transcript.full_text, {
        speakerRole: 'speaker',
        otherSpeakerRoles: ['others'],
        minDurationSec: options.minDurationSec,
        maxDurationSec: options.maxDurationSec,
        startBufferSec: options.startBufferSec,
        hostTriggerThreshold: options.hostTriggerThreshold,
        transcriptDurationSec: duration,
    });
    return { events, clusters, segments, debug };
}

// ─── Step 4: cut segments ──────────────────────────────────────────────

function cutSegment(input, outDir, seg) {
    ensureDir(outDir);
    const outFile = path.join(outDir, `${seg.id}.mp4`);
    if (fs.existsSync(outFile)) {
        colorLog(`  [cut] ${seg.id} 已存在,跳过`, 'gray');
        return outFile;
    }
    const preSs = Math.max(0, seg.startSec - 2);
    const offset = seg.startSec - preSs;
    const r = spawnSync('ffmpeg', [
        '-y',
        '-ss', String(preSs), '-i', input,
        '-ss', String(offset), '-t', String(seg.durationSec),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-af', 'highpass=f=80,dynaudnorm=p=0.95:m=10,loudnorm=I=-16:TP=-1.5:LRA=11',
        outFile,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cut ${seg.id} failed: ${(r.stderr || '').slice(-200)}`);
    return outFile;
}

// ─── Step 5: concat compilation ───────────────────────────────────────

function concat(segFiles, outFile) {
    if (fs.existsSync(outFile)) {
        colorLog(`  [concat] 已存在,跳过`, 'gray');
        return outFile;
    }
    const listPath = `${outFile}.concat.txt`;
    fs.writeFileSync(listPath, segFiles.map((f) => `file '${f}'`).join('\n'));
    const r = spawnSync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outFile,
    ], { encoding: 'utf8' });
    fs.unlinkSync(listPath);
    if (r.status !== 0) throw new Error(`concat failed: ${(r.stderr || '').slice(-200)}`);
    return outFile;
}

// ─── Step 6: burn ──────────────────────────────────────────────────────

function burnOne(input, opts) {
    const args = [
        path.join(process.cwd(), 'bin', 'echocut.js'), 'burn', input,
        '--brand', opts.brand,
        '--bgm', opts.bgm,
    ];
    if (opts.autoPad) args.push('--auto-pad');
    if (Number(opts.stripTop) > 0) args.push('--strip-top', String(opts.stripTop));
    if (opts.headline) args.push('--headline', opts.headline);
    if (opts.subline) args.push('--subline', opts.subline);
    const r = spawnSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) {
        throw new Error(`burn failed: ${(r.stderr || r.stdout || '').slice(-500)}`);
    }
    // 从 stdout 找输出 mp4
    const match = String(r.stdout || '').match(/output:\s*([^\s]+)/);
    return match ? match[1] : null;
}

// ─── Main orchestrator ────────────────────────────────────────────────

/**
 * @param {string} input  视频文件绝对路径
 * @param {Object} opts
 *   - speakerNames: string[]
 *   - hostNames: string[]
 *   - otherSpeakers: string[]
 *   - brand: string (default 'example')
 *   - bgm: string (default '02-guzheng-zen')
 *   - autoPad: boolean (default true)
 *   - stripTop: number (default 80,0 表示不裁)
 *   - outDir: string (中间产物 + 成片目录)
 *   - dryRun: boolean (只跑到 locate 输出 segments.json 就停)
 *   - compilationOnly: boolean (跳过单段 burn)
 *   - skipBurn: boolean (产 cut + concat 就停)
 *   - minDurationSec / maxDurationSec / startBufferSec / hostTriggerThreshold
 *   - headlinePerSeg / sublinePerSeg: string[] (每段标题)
 *   - compilationHeadline / compilationSubline: string
 * @returns {Promise<Object>}  { transcript, segments, products }
 */
async function orchestratePanelClip(input, opts) {
    if (!input || !fs.existsSync(input)) throw new Error(`input not exists: ${input}`);
    const outDir = opts.outDir || path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_panel`);
    ensureDir(outDir);

    const t0 = Date.now();
    colorLog(`\n📺 panel-clip 流水线开始 — ${path.basename(input)}`, 'cyan');
    colorLog(`   输出目录: ${outDir}`, 'gray');

    // Step 1: extract audio
    const audioPath = path.join(outDir, 'audio.wav');
    colorLog(`\n[1/6] 提取音轨`, 'cyan');
    const t1 = Date.now();
    extractAudio(input, audioPath);
    colorLog(`  ✓ ${((Date.now() - t1) / 1000).toFixed(1)}s`, 'green');

    // Step 2: transcribe
    const transcriptPath = path.join(outDir, 'transcript.json');
    colorLog(`\n[2/6] qwen3-ASR 转写(50min 视频约 5-8min)`, 'cyan');
    const t2 = Date.now();
    const transcript = transcribe(audioPath, transcriptPath);
    colorLog(`  ✓ ${((Date.now() - t2) / 1000).toFixed(1)}s — ${transcript.words.length} segments, ${transcript.full_text.length} chars`, 'green');

    // Step 3: locate segments
    colorLog(`\n[3/6] 关键词扫描 + 段推断`, 'cyan');
    const t3 = Date.now();
    const namesDict = {
        speaker: opts.speakerNames || [],
        host: opts.hostNames || [],
        others: opts.otherSpeakers || [],
    };
    const located = locate(transcript, namesDict, {
        minDurationSec: opts.minDurationSec,
        maxDurationSec: opts.maxDurationSec,
        startBufferSec: opts.startBufferSec,
        hostTriggerThreshold: opts.hostTriggerThreshold,
    });
    writeJsonAtomic(path.join(outDir, 'name_events.json'), { events: located.events, clusters: located.clusters });
    writeJsonAtomic(path.join(outDir, 'segments.json'), { segments: located.segments, debug: located.debug });
    colorLog(`  ✓ ${((Date.now() - t3) / 1000).toFixed(1)}s — ${located.events.length} events, ${located.clusters.length} clusters, ${located.segments.length} segments 推断`, 'green');
    for (const s of located.segments) {
        const mm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
        colorLog(`    ${s.id}  ${mm(s.startSec)}-${mm(s.endSec)}  ${s.durationSec.toFixed(0)}s  起:"${s.startCluster.ctx.slice(0, 30).replace(/\s+/g, ' ')}..."`, 'gray');
    }

    if (opts.dryRun) {
        colorLog(`\n[dry-run] 跳过切片 + burn,见 segments.json`, 'yellow');
        return { transcript, located, products: null, totalSec: (Date.now() - t0) / 1000 };
    }

    if (located.segments.length === 0) {
        throw new Error('未推断出任何 speaker 段;检查 --speaker-names / --other-speakers 是否正确,或加 --dry-run 看 name_events.json');
    }

    // Step 4: cut
    colorLog(`\n[4/6] 切片(精确 seek + 重编码 + dynaudnorm)`, 'cyan');
    const t4 = Date.now();
    const segDir = path.join(outDir, 'segments');
    const segFiles = [];
    for (const s of located.segments) {
        const f = cutSegment(input, segDir, s);
        segFiles.push(f);
        colorLog(`  ✓ ${s.id} → ${path.relative(outDir, f)}`, 'gray');
    }
    colorLog(`  ✓ ${((Date.now() - t4) / 1000).toFixed(1)}s`, 'green');

    // Step 5: concat compilation
    let compilationFile = null;
    if (segFiles.length > 1) {
        colorLog(`\n[5/6] 拼合 ${segFiles.length} 段成合集`, 'cyan');
        const t5 = Date.now();
        compilationFile = path.join(outDir, 'compilation_raw.mp4');
        concat(segFiles, compilationFile);
        colorLog(`  ✓ ${((Date.now() - t5) / 1000).toFixed(1)}s → ${path.relative(outDir, compilationFile)}`, 'green');
    } else {
        colorLog(`\n[5/6] 只有 1 段,跳过 concat`, 'gray');
    }

    if (opts.skipBurn) {
        colorLog(`\n[skip-burn] 切片完成,跳过 burn`, 'yellow');
        return { transcript, located, products: { segFiles, compilationFile }, totalSec: (Date.now() - t0) / 1000 };
    }

    // Step 6: burn each + compilation
    colorLog(`\n[6/6] 串行 burn(每段 + 合集)`, 'cyan');
    const t6 = Date.now();
    const burnedSegs = [];
    if (!opts.compilationOnly) {
        for (let i = 0; i < segFiles.length; i += 1) {
            const seg = located.segments[i];
            const headline = (opts.headlinePerSeg && opts.headlinePerSeg[i]) || `${seg.id} · ${opts.brand}`;
            const subline = (opts.sublinePerSeg && opts.sublinePerSeg[i]) || '';
            colorLog(`  [burn ${i + 1}/${segFiles.length}] ${seg.id}  headline="${headline}"`, 'cyan');
            const out = burnOne(segFiles[i], {
                brand: opts.brand,
                bgm: opts.bgm,
                autoPad: opts.autoPad !== false,
                stripTop: opts.stripTop,
                headline,
                subline,
            });
            burnedSegs.push(out);
        }
    }
    let burnedCompilation = null;
    if (compilationFile) {
        colorLog(`  [burn compilation]  headline="${opts.compilationHeadline || '合集'}"`, 'cyan');
        burnedCompilation = burnOne(compilationFile, {
            brand: opts.brand,
            bgm: opts.bgm,
            autoPad: opts.autoPad !== false,
            stripTop: opts.stripTop,
            headline: opts.compilationHeadline || `${opts.brand} 圆桌精华合集`,
            subline: opts.compilationSubline || '',
        });
    }
    colorLog(`  ✓ ${((Date.now() - t6) / 1000).toFixed(1)}s`, 'green');

    const totalSec = (Date.now() - t0) / 1000;
    colorLog(`\n✓ panel-clip 完成 总耗时 ${totalSec.toFixed(0)}s (${Math.floor(totalSec / 60)}m${Math.floor(totalSec % 60)}s)`, 'green');
    colorLog(`  产物目录: ${outDir}`, 'gray');

    return {
        transcript,
        located,
        products: {
            segFiles,
            compilationFile,
            burnedSegs,
            burnedCompilation,
            outDir,
        },
        totalSec,
    };
}

module.exports = {
    orchestratePanelClip,
    // 暴露子步骤便于测试 / 自定义
    extractAudio,
    transcribe,
    locate,
    cutSegment,
    concat,
    burnOne,
    probeDuration,
    probeSize,
};
