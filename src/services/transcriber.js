const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { pipeline } = require('stream');
const axios = require('axios');

const pipelineAsync = promisify(pipeline);
const execFileAsync = promisify(execFile);

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

const NOISE_STDERR_RE = /Lightning automatically upgraded|upgrade_checkpoint|pytorch_model\.bin/;

function filterStderr(raw) {
    return String(raw || '').split('\n').filter((l) => !NOISE_STDERR_RE.test(l)).join('\n').trim();
}

function buildTranscribeJsonPath() {
    const tmpDir = path.resolve(process.cwd(), 'tmp');
    ensureDir(tmpDir);
    const fileName = `transcribe_${Date.now()}_${crypto.randomUUID()}.json`;
    return path.join(tmpDir, fileName);
}

async function downloadAudio(fileUrl, targetPath) {
    const retries = Math.max(0, Number(process.env.DOWNLOAD_RETRIES || 3));
    const timeoutMs = Math.max(10000, Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000));
    const retryDelayMs = Math.max(200, Number(process.env.DOWNLOAD_RETRY_DELAY_MS || 1200));
    const dir = path.dirname(targetPath);
    ensureDir(dir);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const tempPath = `${targetPath}.part`;
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            const response = await axios.get(fileUrl, {
                responseType: 'stream',
                timeout: timeoutMs,
                maxRedirects: 5
            });
            await pipelineAsync(response.data, fs.createWriteStream(tempPath));
            fs.renameSync(tempPath, targetPath);
            return targetPath;
        } catch (error) {
            lastError = error;
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (_) {}
            }
            const status = Number(error?.response?.status || 0);
            const code = String(error?.code || '');
            const retryableHttp = status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
            const retryableCode = ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code);
            const retryable = retryableHttp || retryableCode;
            if (!retryable || attempt >= retries) break;
            await delay(retryDelayMs * (attempt + 1));
        }
    }
    const status = Number(lastError?.response?.status || 0);
    const code = String(lastError?.code || '');
    const reason = lastError?.message || String(lastError || 'unknown');
    throw new Error(`下载失败(已重试${Math.max(0, Number(process.env.DOWNLOAD_RETRIES || 3))}次) status=${status || 'n/a'} code=${code || 'n/a'} reason=${reason}`);
}

async function transcribeAudio(localFilePath, options) {
    const startedAt = Date.now();
    const nltkDataPath = path.resolve(process.cwd(), '.nltk_data');
    ensureDir(nltkDataPath);
    const resultJsonPath = buildTranscribeJsonPath();
    const engine = String(options.transcribeEngine || 'auto').toLowerCase();
    const requestedEngine = String(options.requestedEngine || engine || 'auto').toLowerCase();
    const whisperxPath = path.resolve(process.cwd(), options.transcribeScriptPath);
    const mlxPath = path.resolve(process.cwd(), options.transcribeMlxScriptPath || 'python/transcribe_mlx.py');
    const funasrPath = path.resolve(process.cwd(), options.transcribeFunasrScriptPath || 'python/transcribe_funasr.py');
    const qwen3Path = path.resolve(process.cwd(), options.transcribeQwen3ScriptPath || 'python/transcribe_qwen3.py');
    const baseEngine = engine === 'funasr' ? 'funasr'
        : engine === 'qwen3' ? 'qwen3'
        : engine.includes('mlx') ? 'mlx'
        : (engine.includes('whisperx') ? 'whisperx' : engine);
    // mlx_hq:用户显式要求最高准确度,严格禁止降级到 whisperx(字号时间戳不一致会让字幕和声音对不上)
    // ⚠️ 必须用 requestedEngine 判断:asrAdapters.js 会把 'mlx_hq' 转成 transcribeEngine='mlx',
    //   所以这里 engine 永远是 'mlx',要看上游传过来的 requestedEngine 才能知道用户原意。
    const strictMlx = requestedEngine === 'mlx_hq' || process.env.ZDE_STRICT_MLX === '1';
    const candidateScripts = baseEngine === 'qwen3'
        ? [qwen3Path]
        : baseEngine === 'funasr'
            ? [funasrPath, mlxPath]
            : baseEngine === 'mlx'
                ? (strictMlx ? [mlxPath] : [mlxPath, whisperxPath])
            : (baseEngine === 'whisperx'
                ? [whisperxPath]
                : (process.platform === 'darwin' ? [mlxPath, whisperxPath] : [whisperxPath, mlxPath]));
    const scripts = candidateScripts.filter((script, index) => script && candidateScripts.indexOf(script) === index && fs.existsSync(script));
    if (!scripts.length) throw new Error('未找到可用转录脚本');

    let stderr = '';
    let execError = null;
    let usedScriptPath = '';
    let usedEngine = '';
    const errorHistory = []; // 累积所有尝试的 stderr,失败时一并抛出,避免被最后一个 fallback 的错误覆盖真凶
    const totalMemGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2));
    // 两种 lowMemory 触发条件:
    //   a) 机器总内存 < 3GB(树莓派/2GB 云主机)
    //   b) 当前可用内存 < 3GB(48GB Mac 也可能临时紧张)
    // 触发时 whisperx 自动 small 模型 + disable_align,牺牲精度换稳定
    let availMemGb = Infinity;
    try {
        const { getAvailableMemoryGB } = require('../lib/preflight');
        availMemGb = getAvailableMemoryGB();
    } catch (_) { /* 静默 fallback */ }
    const lowMemory = (totalMemGb > 0 && totalMemGb < 3) || availMemGb < 3;

    // 转写超时按音频时长自适应(此前写死 15min,48 分钟视频跑 ~18min 被 SIGTERM 杀,
    // stderr 空 + 2 次重试共 30min 全废 —— 就是这次失败的直接原因)。
    // 保守 RTF 下界 1.5x realtime(实测 qwen3 ~2.7x)+ 模型加载/抖动余量 180s。
    // TRANSCRIBE_TIMEOUT_MS 显式设置时优先。
    const { transcribeLongAudio, probeDurationSec, LONG_THRESHOLD_SEC } = require('./transcribeLong');
    let audioDurationSec = 0;
    try { audioDurationSec = probeDurationSec(localFilePath); } catch (_) { /* 探测失败退化到默认超时 */ }
    const timeoutMs = (() => {
        const envOverride = Number(process.env.TRANSCRIBE_TIMEOUT_MS);
        if (Number.isFinite(envOverride) && envOverride > 0) return Math.max(120000, envOverride);
        const scaled = audioDurationSec > 0 ? Math.round((audioDurationSec / 1.5) * 1000) + 180000 : 0;
        return Math.max(900000, scaled);
    })();

    let succeeded = false;

    // 长音频(qwen3)走分块转写 + 断点续跑:每块时长有界 → 超时有界,中途挂了重跑只补失败块。
    // 严格契约:分块失败不静默降级,直接抛出(已转写的块已缓存,重跑可续)。
    if (baseEngine === 'qwen3' && audioDurationSec > LONG_THRESHOLD_SEC) {
        try {
            const transcribeEnv = {
                ...process.env,
                NLTK_DATA: nltkDataPath,
                ...(options.transcribeEnvOverrides || {})
            };
            console.log(`[transcriber] 长音频 ${Math.round(audioDurationSec)}s > ${LONG_THRESHOLD_SEC}s,启用分块转写 + 断点续跑`);
            const t0 = Date.now();
            const res = await transcribeLongAudio(localFilePath, {
                pythonBin: options.pythonBin,
                scriptPath: qwen3Path,
                env: transcribeEnv,
                onProgress: (idx, total, info) => {
                    const tag = info.cached ? '复用缓存' : '转写中';
                    console.log(`[transcriber][chunk ${idx}/${total}] ${tag} ${Math.round(info.start)}s-${Math.round(info.end)}s`);
                }
            });
            const payloadOut = { words: res.words, full_text: res.full_text, used_model: res.used_model };
            const tmp = `${resultJsonPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(payloadOut), 'utf8');
            fs.renameSync(tmp, resultJsonPath);
            succeeded = true;
            usedScriptPath = qwen3Path;
            usedEngine = 'qwen3';
            stderr = `[transcriber] chunked qwen3: ${res.chunks} 块(复用 ${res.reusedChunks}),耗时 ${Math.round((Date.now() - t0) / 1000)}s`;
            console.log(stderr);
        } catch (err) {
            throw new Error(`[transcriber] 长音频分块转写失败(已转写的块已缓存到 .echo-cache/transcribe/,重跑可续): ${String(err.message || err).slice(0, 300)}`);
        }
    }

    for (let s = 0; s < scripts.length && !succeeded; s += 1) {
        const scriptPath = scripts[s];
        // mlx_hq 严格模式:失败重试更多次(MLX 首次加载偶发 crash,不换引擎,只重试本脚本)
        const retries = strictMlx && scriptPath === mlxPath ? 2 : 1;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const transcribeEnv = {
                    ...process.env,
                    NLTK_DATA: nltkDataPath,
                    ...(options.transcribeEnvOverrides || {})
                };
                if (!process.env.WHISPERX_LOW_MEMORY && lowMemory) transcribeEnv.WHISPERX_LOW_MEMORY = '1';
                if (!process.env.WHISPERX_BATCH_SIZE && lowMemory) transcribeEnv.WHISPERX_BATCH_SIZE = '1';
                if (!process.env.WHISPERX_MODEL && lowMemory) transcribeEnv.WHISPERX_MODEL = 'small';
                if (!process.env.WHISPERX_DISABLE_ALIGN && lowMemory) transcribeEnv.WHISPERX_DISABLE_ALIGN = '1';
                const execResult = await execFileAsync(options.pythonBin, [scriptPath, localFilePath, resultJsonPath], {
                    maxBuffer: 20 * 1024 * 1024,
                    timeout: timeoutMs,
                    env: transcribeEnv
                });
                // 过滤 Lightning/PyTorch checkpoint 升级提示（无害，每次运行都会打印）
                stderr = `${filterStderr(execResult.stderr)}\n[transcriber] script=${path.basename(scriptPath)}`
                    .trim();
                execError = null;
                usedScriptPath = scriptPath;
                usedEngine = scriptPath.endsWith('transcribe_funasr.py') ? 'funasr'
                    : scriptPath.endsWith('transcribe_qwen3.py') ? 'qwen3'
                        : scriptPath.endsWith('transcribe_mlx.py') ? 'mlx' : 'whisperx';
                succeeded = true;
                break;
            } catch (error) {
                execError = error;
                const filteredErr = filterStderr(error.stderr);
                stderr = `${filteredErr}\n[transcriber] script=${path.basename(scriptPath)} attempt=${attempt + 1} failed`
                    .trim();
                errorHistory.push({
                    script: path.basename(scriptPath),
                    attempt: attempt + 1,
                    message: String(error.message || '').slice(0, 240),
                    stderrTail: String(filteredErr || '').split('\n').slice(-6).join('\n')
                });
                if (attempt >= retries) {
                    // 当前脚本彻底失败,把 stderr 尾巴打出来,而不是只截 120 字 message(常常被截在 "Command failed: ..." 里看不到根因)
                    const tail = String(filteredErr || '').split('\n').filter(Boolean).slice(-4).join('\n  ');
                    if (s + 1 < scripts.length) {
                        console.warn(`[transcriber] ${path.basename(scriptPath)} 失败(${attempt + 1} 次重试),换下一个引擎试试。stderr 末尾:\n  ${tail || '<空>'}`);
                    } else {
                        console.warn(`[transcriber] ${path.basename(scriptPath)} 失败(${attempt + 1} 次重试),已无候补。stderr 末尾:\n  ${tail || '<空>'}`);
                    }
                    break;
                }
                // 重试间隔随次数指数退避(2s/4s),内存压力下让 GC 有时间释放
                await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }
    if (execError) {
        if (execError.stderr) execError.stderr = filterStderr(execError.stderr);
        // 把全链路尝试记录附到 error 上,便于上游聚合输出真凶
        if (errorHistory.length) {
            const summary = errorHistory
                .map((h) => `  ${h.script}#${h.attempt}: ${h.message}${h.stderrTail ? `\n    └ ${h.stderrTail.replace(/\n/g, '\n    ')}` : ''}`)
                .join('\n');
            execError.message = `${execError.message}\n[transcriber 完整尝试链]\n${summary}`;
        }
        throw execError;
    }
    const endedAt = Date.now();
    if (!fs.existsSync(resultJsonPath)) throw new Error(`转写结果文件不存在: ${resultJsonPath}`);
    const raw = fs.readFileSync(resultJsonPath, 'utf8');
    const payload = JSON.parse(raw);
    const words = Array.isArray(payload.words) ? payload.words : [];
    const fullText = String(payload.full_text || '').trim();

    // 成功读完后立刻删 tmp JSON,防止 tmp/transcribe_*.json 无限累积(之前攒了 388 个占 1.4GB)
    // ZDE_KEEP_TRANSCRIBE_JSON=1 保留(调试场景)
    if (process.env.ZDE_KEEP_TRANSCRIBE_JSON !== '1') {
        try { fs.unlinkSync(resultJsonPath); } catch (_) {}
    }

    return {
        words,
        fullText,
        payload,
        resultJsonPath,
        stderr: (stderr || '').trim(),
        transcribeMs: endedAt - startedAt,
        requestedEngine,
        usedEngine,
        usedScript: usedScriptPath ? path.basename(usedScriptPath) : '',
        usedModel: String(payload.used_model || '').trim()
    };
}

module.exports = { downloadAudio, transcribeAudio };
