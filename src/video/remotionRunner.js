const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const { promisify } = require('util');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const { getConfigValue, DEFAULT_CONFIGS } = require('../db/configRepo');
const { stripEmoji } = require('../lib/stripEmoji');

const execFileAsync = promisify(execFile);

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeUnlink(filePath) {
    if (!filePath) return;
    if (!fs.existsSync(filePath)) return;
    try {
        fs.unlinkSync(filePath);
    } catch (_) {}
}

function getFfmpegTimeoutMs(defaultMs) {
    const n = Number(process.env.FFMPEG_TIMEOUT_MS || defaultMs);
    if (!Number.isFinite(n) || n <= 0) return defaultMs;
    return Math.max(15000, Math.floor(n));
}

function getExecFileOptions(timeoutMs) {
    return {
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL'
    };
}

async function prepareBundle() {
    const entryPoint = path.join(process.cwd(), 'video_lab', 'remotion', 'index.jsx');
    const serveUrl = await bundle({ entryPoint, webpackOverride: (config) => config });
    return { serveUrl };
}

function copyAudioToPublic(audioFile, stem) {
    const publicAudioDir = path.join(process.cwd(), 'public', 'video_audio');
    ensureDir(publicAudioDir);
    const publicAudioName = `${stem}_${Date.now()}${path.extname(audioFile)}`;
    const copiedAudioPath = path.join(publicAudioDir, publicAudioName);
    fs.copyFileSync(audioFile, copiedAudioPath);
    return `video_audio/${publicAudioName}`;
}

function transcodeAudioToAacIfNeeded(audioFile, stem) {
    const ext = path.extname(audioFile).toLowerCase();
    if (ext !== '.ogg' && ext !== '.oga') return audioFile;
    const spawnTimeout = getFfmpegTimeoutMs(120000);
    const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: spawnTimeout });
    if (ffmpegCheck.status !== 0) return audioFile;
    const outputDir = path.join(process.cwd(), 'tmp', 'audio_cache');
    ensureDir(outputDir);
    const outputFile = path.join(outputDir, `${stem}_${Date.now()}.m4a`);
    const transcode = spawnSync('ffmpeg', ['-y', '-i', audioFile, '-c:a', 'aac', '-b:a', '192k', outputFile], { stdio: 'ignore', timeout: spawnTimeout });
    if (transcode.status !== 0 || !fs.existsSync(outputFile)) return audioFile;
    return outputFile;
}

function toSrtTimestamp(seconds) {
    const safe = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
    const hh = Math.floor(safe / 3600);
    const mm = Math.floor((safe % 3600) / 60);
    const ss = Math.floor(safe % 60);
    const ms = Math.floor((safe - Math.floor(safe)) * 1000);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function normalizeCaptionSegments(captions) {
    if (!Array.isArray(captions)) return [];
    return captions
        .map((item) => {
            const start = Number(item.start ?? item.startSec ?? 0);
            const end = Number(item.end ?? item.endSec ?? start + 0.8);
            const text = String(item.text ?? item.word ?? '').replace(/\s+/g, ' ').replace(/[{}]/g, '').trim();
            return { start, end: end > start ? end : start + 0.8, text };
        })
        .filter((item) => item.text);
}

function normalizeHexColor(color, fallback = '#FFD54F') {
    const raw = String(color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
    return fallback;
}

function parseConfigBoolean(raw, fallback = false) {
    const val = String(raw ?? '').trim().toLowerCase();
    if (!val) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(val)) return true;
    if (['0', 'false', 'no', 'off'].includes(val)) return false;
    return fallback;
}

function hexToAssBgr(hex, fallback = '&H00F7F7F7&') {
    const normalized = normalizeHexColor(hex, '').replace('#', '');
    if (!normalized || normalized.length !== 6) return fallback;
    const rr = normalized.slice(0, 2);
    const gg = normalized.slice(2, 4);
    const bb = normalized.slice(4, 6);
    return `&H00${bb}${gg}${rr}&`;
}

function splitKeywordList(input) {
    if (Array.isArray(input)) {
        return input.map((x) => String(x || '').trim()).filter(Boolean);
    }
    return String(input || '')
        .split(/[\n,，、;；|]/g)
        .map((x) => x.trim())
        .filter(Boolean);
}

function applyKeywordEmphasis(text, styleOptions = {}) {
    const source = String(text || '').trim();
    if (!source) return '';
    if (styleOptions.emphasisEnabled === false) return source;
    const keywords = splitKeywordList(styleOptions.emphasisWords).sort((a, b) => b.length - a.length);
    if (!keywords.length) return source;
    const hit = keywords.find((w) => source.includes(w));
    if (!hit) return source;
    const color = normalizeHexColor(styleOptions.highlightColor, '#FFD54F');
    return source.replace(hit, `<font color="${color}"><b>${hit}</b></font>`);
}

function writeSrtFile(captions, srtPath, styleOptions = {}) {
    const rows = normalizeCaptionSegments(captions).map((item, index) => (
        `${index + 1}\n${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}\n${applyKeywordEmphasis(item.text, styleOptions)}\n`
    ));
    fs.writeFileSync(srtPath, rows.join('\n'), 'utf8');
}

function toAssTimestamp(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const cs = Math.round((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text) {
    return String(text || '').replace(/\\/g, '').replace(/\{/g, '').replace(/\}/g, '').replace(/\n/g, '\\N');
}

function applyKeywordEmphasisAss(text, styleOptions = {}) {
    const source = String(text || '').trim();
    if (!source || styleOptions.emphasisEnabled === false) return escapeAssText(source);
    const keywords = splitKeywordList(styleOptions.emphasisWords).sort((a, b) => b.length - a.length);
    if (!keywords.length) return escapeAssText(source);

    // 扫描所有非重叠命中(长词优先,先占位防止短词覆盖长词的子串)
    const taken = new Array(source.length).fill(false);
    const hits = [];
    for (const word of keywords) {
        if (!word) continue;
        let idx = 0;
        while ((idx = source.indexOf(word, idx)) !== -1) {
            let overlap = false;
            for (let i = idx; i < idx + word.length; i += 1) {
                if (taken[i]) { overlap = true; break; }
            }
            if (!overlap) {
                hits.push({ start: idx, end: idx + word.length, word });
                for (let i = idx; i < idx + word.length; i += 1) taken[i] = true;
            }
            idx += word.length;
        }
    }
    if (!hits.length) return escapeAssText(source);

    hits.sort((a, b) => a.start - b.start);
    const colorAss = hexToAssBgr(styleOptions.highlightColor, '&H0040CFFF&');
    let result = '';
    let cursor = 0;
    for (const hit of hits) {
        result += escapeAssText(source.slice(cursor, hit.start));
        // \b1 粗体 + 颜色 + \fscx/\fscy 放大 15%,给爆点词强观感
        result += `{\\c${colorAss}\\b1\\fscx115\\fscy115}` + escapeAssText(hit.word) + '{\\r}';
        cursor = hit.end;
    }
    result += escapeAssText(source.slice(cursor));
    return result;
}

// Write ASS file with explicit PlayRes matching video dimensions.
// This bypasses the unreliable SRT→ASS conversion in libass which uses a different default PlayRes
// (typically 288 or 480) and then applies a massive scale factor when original_size is set.
function writeAssFile(captions, assPath, { playResX, playResY, fontFamily, fontSize, primaryColorAss, outlineColorAss, outline, shadow, marginL, marginR, marginV, alignCode, styleOptions }) {
    const header = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${playResX}`,
        `PlayResY: ${playResY}`,
        'ScaledBorderAndShadow: no',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Default,${fontFamily},${fontSize},${primaryColorAss},&H000000FF,${outlineColorAss},&H00000000,1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignCode},${marginL},${marginR},${marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ].join('\n');
    const rows = normalizeCaptionSegments(captions).map((item) => {
        const text = applyKeywordEmphasisAss(item.text, styleOptions);
        return `Dialogue: 0,${toAssTimestamp(item.start)},${toAssTimestamp(item.end)},Default,,0,0,0,,${text}`;
    });
    fs.writeFileSync(assPath, `${header}\n${rows.join('\n')}\n`, 'utf8');
}

function escapeSubtitlePath(absPath) {
    return absPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function normalizeDisplayText(text, maxLen = 80) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    let cleaned = source.replace(/[\u0000-\u001F\u007F]/g, '');
    try {
        cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '');
    } catch (_) {}
    return cleaned.slice(0, Math.max(0, maxLen));
}

function weightedTextUnits(text) {
    let units = 0;
    for (const ch of String(text || '')) {
        if (!ch.trim()) continue;
        units += /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch) ? 1 : 0.58;
    }
    return units;
}

function splitTextByUnits(text, maxUnits) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return [];
    const phrases = source.split(/([，。！？；：、,.!?;:])/).reduce((acc, part, idx, arr) => {
        if (!part) return acc;
        if (idx % 2 === 0) {
            const tail = arr[idx + 1] || '';
            acc.push(`${part}${tail}`.trim());
        }
        return acc;
    }, []).filter(Boolean);
    const chunks = [];
    const pushByChar = (phrase) => {
        let cursor = '';
        for (const ch of phrase) {
            const next = `${cursor}${ch}`;
            if (weightedTextUnits(next) > maxUnits && cursor) {
                chunks.push(cursor.trim());
                cursor = ch;
                continue;
            }
            cursor = next;
        }
        if (cursor.trim()) chunks.push(cursor.trim());
    };
    for (const phrase of (phrases.length ? phrases : [source])) {
        if (weightedTextUnits(phrase) <= maxUnits) {
            chunks.push(phrase);
            continue;
        }
        pushByChar(phrase);
    }
    return chunks.filter(Boolean);
}

function rebalanceCaptionSegments(captions, maxUnits) {
    const normalized = normalizeCaptionSegments(captions);
    const output = [];
    for (const item of normalized) {
        const parts = splitTextByUnits(item.text, maxUnits);
        if (parts.length <= 1) {
            output.push(item);
            continue;
        }
        const totalUnits = Math.max(0.001, parts.reduce((acc, part) => acc + weightedTextUnits(part), 0));
        const totalDur = Math.max(0.35, item.end - item.start);
        let cursor = item.start;
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            const ratio = weightedTextUnits(part) / totalUnits;
            const isLast = i === parts.length - 1;
            const nextEnd = isLast ? item.end : Math.min(item.end, cursor + Math.max(0.12, totalDur * ratio));
            output.push({
                start: cursor,
                end: Math.max(cursor + 0.1, nextEnd),
                text: part
            });
            cursor = nextEnd;
        }
    }
    return output.filter((item) => item.text);
}

function fitTextFontSizeByWidth(text, currentSize, maxWidthPx, minSize = 14) {
    const units = Math.max(1, weightedTextUnits(text));
    const fitSize = Math.floor((maxWidthPx / units) * 0.92);
    return Math.max(minSize, Math.min(currentSize, fitSize));
}

function pickBestCjkFont() {
    const fromEnv = String(process.env.CAPTION_FONT_FILE || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const candidates = [
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
        '/System/Library/Fonts/Supplemental/Songti.ttc',
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/STHeiti Light.ttc',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/Library/Fonts/Arial Unicode.ttf'
    ];
    return candidates.find((f) => fs.existsSync(f)) || '';
}

function pickBestTitleFont() {
    const fromEnv = String(process.env.VIDEO_TITLE_FONT_FILE || process.env.CAPTION_FONT_FILE || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const candidates = [
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf'),
        path.join(process.cwd(), 'src', '..', 'assets', 'fonts', 'NotoSansSC-Regular.otf')
    ];
    const hit = candidates.find((f) => fs.existsSync(f));
    if (hit) return hit;
    return pickBestCjkFont();
}

function getAssFontFamily(fontPath) {
    if (!fontPath) return 'Arial';
    if (fontPath.includes('NotoSansSC')) return 'Noto Sans SC';
    if (fontPath.includes('PingFang')) return 'PingFang SC';
    if (fontPath.includes('Hiragino')) return 'Hiragino Sans GB';
    if (fontPath.includes('Songti')) return 'Songti SC';
    if (fontPath.includes('NotoSansCJK')) return 'Noto Sans CJK SC';
    if (fontPath.includes('STHeiti')) return 'STHeiti';
    return 'Arial Unicode MS';
}

function probeVideoRotation(videoPath, timeoutMs) {
    try {
        // 尝试从 side_data 和 stream tags 两处读取 rotation
        const result = spawnSync('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream_side_data=rotation:stream_tags=rotate',
            '-of', 'default=nw=1:nk=1',
            videoPath
        ], { encoding: 'utf8', timeout: timeoutMs });
        const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            const n = parseInt(line, 10);
            if (Number.isFinite(n) && n !== 0) return n;
        }
    } catch (_) { /* ignore */ }
    return 0;
}

function probeVideoSize(videoPath) {
    const ffprobeTimeout = getFfmpegTimeoutMs(30000);
    const ffprobeCheck = spawnSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: ffprobeTimeout });
    if (ffprobeCheck.status !== 0) return { width: 0, height: 0 };
    const result = spawnSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=s=x:p=0',
        videoPath
    ], { encoding: 'utf8', timeout: ffprobeTimeout });
    const raw = String(result.stdout || '').trim();
    let [w, h] = raw.split('x').map((x) => Number(x));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { width: 0, height: 0 };
    // 手机竖拍视频带 rotation=90/270 元数据，FFmpeg 编码时自动旋转，需 swap
    const rotation = probeVideoRotation(videoPath, ffprobeTimeout);
    if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
        [w, h] = [h, w];
    }
    return { width: Math.max(0, Math.floor(w)), height: Math.max(0, Math.floor(h)) };
}

function probeVideoDuration(videoPath) {
    const ffprobeTimeout = getFfmpegTimeoutMs(30000);
    const result = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        videoPath
    ], { encoding: 'utf8', timeout: ffprobeTimeout });
    const raw = String(result.stdout || '').trim();
    const dur = parseFloat(raw);
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

function probeVideoBitrate(videoPath) {
    try {
        const result = spawnSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=bit_rate',
            '-of', 'csv=p=0',
            videoPath
        ], { encoding: 'utf8', timeout: 15000 });
        const raw = Number(String(result.stdout || '').trim());
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    } catch (_) {
        return 0;
    }
}

function getPreferredVideoCodec() {
    const fromEnv = String(process.env.FFMPEG_VIDEO_CODEC || '').trim();
    if (fromEnv) return fromEnv;
    if (process.platform === 'darwin') return 'h264_videotoolbox';
    return 'libx264';
}

function getFfmpegThreads() {
    const n = Number(process.env.FFMPEG_THREADS || 0);
    if (!Number.isFinite(n) || n <= 0) return [];
    return ['-threads', String(Math.max(1, Math.floor(n)))];
}

function buildVideoCodecArgs(codec, { width = 0, height = 0 } = {}) {
    const longEdge = Math.max(width, height, 1);
    if (codec === 'libx264') {
        const preset = String(process.env.FFMPEG_X264_PRESET || 'veryfast').trim() || 'veryfast';
        const crf = String(process.env.FFMPEG_X264_CRF || '22').trim() || '22';
        return ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p', ...getFfmpegThreads()];
    }
    if (codec === 'h264_videotoolbox') {
        // Auto-scale bitrate by resolution to preserve quality for 4K/3K Pocket3 footage.
        // Override with FFMPEG_VT_BITRATE / FFMPEG_VT_MAXRATE env vars if needed.
        const autoBitrate = longEdge >= 3500 ? '25M' : longEdge >= 2800 ? '18M' : longEdge >= 1800 ? '10M' : '6M';
        const autoMaxrate = longEdge >= 3500 ? '35M' : longEdge >= 2800 ? '25M' : longEdge >= 1800 ? '15M' : '10M';
        const bitrate = String(process.env.FFMPEG_VT_BITRATE || autoBitrate);
        const maxrate = String(process.env.FFMPEG_VT_MAXRATE || autoMaxrate);
        return ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-maxrate', maxrate, '-bufsize', '32M', '-pix_fmt', 'yuv420p', ...getFfmpegThreads()];
    }
    return ['-c:v', codec, '-pix_fmt', 'yuv420p', ...getFfmpegThreads()];
}

// Spawn FFmpeg and stream stderr to parse time= progress updates.
// Calls onProgress(pct) where pct is 0-100.
function runFfmpegWithProgress(ffmpegArgs, { durationSec = 0, onProgress = null, timeoutMs = 15 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrBuf = '';
        let timer = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (_) {}
                reject(new Error(`ffmpeg timeout after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
        }
        const timeRe = /time=(\d+):(\d+):(\d+\.?\d*)/;
        proc.stderr.on('data', (chunk) => {
            const line = chunk.toString();
            stderrBuf += line;
            if (onProgress && durationSec > 0) {
                const m = line.match(timeRe);
                if (m) {
                    const elapsed = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                    const pct = Math.min(99, Math.floor(elapsed / durationSec * 100));
                    onProgress(pct);
                }
            }
        });
        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (code === 0) {
                if (onProgress) onProgress(100);
                resolve({ stderr: stderrBuf });
            } else {
                reject(new Error(`ffmpeg exited with code ${code}\n${stderrBuf.slice(-2000)}`));
            }
        });
        proc.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });
    });
}

async function burnSubtitleVideo({ inputVideoPath, outputVideoPath, captions, headline = '', subline = '', styleOptions = {}, clipSeconds = 0, onProgress = null }) {
    const ffmpegTimeout = getFfmpegTimeoutMs(15 * 60 * 1000);
    const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: ffmpegTimeout });
    if (ffmpegCheck.status !== 0) throw new Error('ffmpeg 不可用，无法处理视频字幕');
    if (!fs.existsSync(inputVideoPath)) throw new Error(`源视频不存在: ${inputVideoPath}`);

    const tmpDir = path.join(process.cwd(), 'tmp', 'video_subtitles');
    ensureDir(tmpDir);
    ensureDir(path.dirname(outputVideoPath));
    const subtitleTs = Date.now();
    const assFilePath = path.join(tmpDir, `subtitle_${subtitleTs}.ass`);

    // 先剥 emoji 再规范化:品牌字体无 emoji 字形,标题里的 emoji 会渲染成口字型豆腐块
    const safeHeadline = normalizeDisplayText(stripEmoji(headline), 48);
    const safeSubline = normalizeDisplayText(stripEmoji(subline), 64);
    const headlineTextPath = path.join(tmpDir, `headline_${subtitleTs}.txt`);
    const sublineTextPath = path.join(tmpDir, `subline_${subtitleTs}.txt`);
    fs.writeFileSync(headlineTextPath, `${safeHeadline}\n`, 'utf8');
    fs.writeFileSync(sublineTextPath, `${safeSubline}\n`, 'utf8');
    const escapedHeadlineTextPath = escapeSubtitlePath(headlineTextPath);
    const escapedSublineTextPath = escapeSubtitlePath(sublineTextPath);
    const escapedAssPath = escapeSubtitlePath(assFilePath);
    const cjkFontPath = pickBestCjkFont();
    const titleFontPath = pickBestTitleFont();
    const escapedCjkFontPath = cjkFontPath ? escapeSubtitlePath(cjkFontPath) : '';
    const escapedTitleFontPath = titleFontPath ? escapeSubtitlePath(titleFontPath) : escapedCjkFontPath;
    const cjkFontFamily = getAssFontFamily(cjkFontPath);
    const sourceType = String(styleOptions.sourceType || '').trim();
    const { width: inputWidth, height: inputHeight } = probeVideoSize(inputVideoPath);
    const isVideoNoteLike = Boolean(styleOptions.isVideoNoteLike);
    const inputAspect = inputWidth > 0 && inputHeight > 0 ? (inputWidth / inputHeight) : 0;
    const isLikelySquare = inputAspect > 0.88 && inputAspect < 1.12;
    const squareAsNote = parseConfigBoolean(getConfigValue('video_layout_treat_square_as_video_note', DEFAULT_CONFIGS.video_layout_treat_square_as_video_note), true);
    const verticalAsNote = parseConfigBoolean(getConfigValue('video_layout_treat_vertical_as_video_note', DEFAULT_CONFIGS.video_layout_treat_vertical_as_video_note), false);
    const isVertical = inputAspect > 0 && inputAspect < 0.72;
    const isVideoNote = sourceType === 'video_note' || isVideoNoteLike || (squareAsNote && isLikelySquare) || (verticalAsNote && isVertical);
    
    // Load configurations
    const confTargetW = Number(getConfigValue('video_layout_target_w', DEFAULT_CONFIGS.video_layout_target_w));
    const confTargetH = Number(getConfigValue('video_layout_target_h', DEFAULT_CONFIGS.video_layout_target_h));
    const confCropScale = Number(getConfigValue('video_layout_crop_scale', DEFAULT_CONFIGS.video_layout_crop_scale));
    const confCropOffsetY = Number(getConfigValue('video_layout_crop_offset_y', DEFAULT_CONFIGS.video_layout_crop_offset_y));
    const confTopRatio = Number(getConfigValue('video_layout_top_band_ratio', DEFAULT_CONFIGS.video_layout_top_band_ratio));
    const confBottomRatio = Number(getConfigValue('video_layout_bottom_band_ratio', DEFAULT_CONFIGS.video_layout_bottom_band_ratio));
    const confHeadlineSize = Number(getConfigValue('video_layout_headline_font_size', DEFAULT_CONFIGS.video_layout_headline_font_size));
    const confSublineSize = Number(getConfigValue('video_layout_subline_font_size', DEFAULT_CONFIGS.video_layout_subline_font_size));
    const confSubtitleSize = Number(getConfigValue('video_layout_subtitle_font_size', DEFAULT_CONFIGS.video_layout_subtitle_font_size));

    const targetW = isVideoNote ? confTargetW : Math.max(2, inputWidth || confTargetW);
    const targetH = isVideoNote ? confTargetH : Math.max(2, inputHeight || confTargetH);
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

    // Resolution-proportional scaling: reference is 1080px width
    const refEdge = 1080;
    const shortEdge = Math.max(540, Math.min(targetW, targetH));
    const resScale = Math.max(1, shortEdge / refEdge);

    // 品牌带相关常量(前置声明,因为 topBandH 和 headlineY 计算都会引用)
    const brandBandEnabled = Boolean(styleOptions.brandBandEnabled);
    const brandTagText = String(styleOptions.brandTagText || '').trim();
    const brandBandOpacity = Number.isFinite(Number(styleOptions.brandBandOpacity)) ? Number(styleOptions.brandBandOpacity) : 0.92;
    const toFfmpegColor = (hex) => {
        const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
        return m ? `0x${m[1].toUpperCase()}` : '0x000000';
    };
    const brandTagBgFf = toFfmpegColor(styleOptions.brandTagBgColor || '#FFD54F');
    const brandTagFgFf = toFfmpegColor(styleOptions.brandTagTextColor || '#0B0F1A');
    const brandTagFontSizeRef = Number(styleOptions.brandTagFontSize || 48);
    const brandTagFontSize = Math.floor(clamp(brandTagFontSizeRef * resScale, 24, 160));
    const brandTagPad = Math.floor(clamp(20 * resScale, 16, 48));
    const brandTagX = Math.floor(clamp(44 * resScale, 28, 120));
    const brandTagY = Math.floor(clamp(36 * resScale, 24, 120));

    const rawTopBandH = Number(styleOptions.topBandHeight || 0);
    // OBS 模式:顶部人脸 + 底部屏幕的录屏。默认竖屏顶带 0.22*H(此例 563px)会把人脸盖住。
    // OBS 模式把顶带压成"刚好放下胶囊 + 一行小标题"的窄条,贴顶,露出下方人脸。
    const obsMode = Boolean(styleOptions.obsMode);
    const obsCapsuleH = brandTagFontSize + brandTagPad * 2;
    // OBS 胶囊下移 brandTagPad,使胶囊视觉中心 = 右侧两行小标题块的中心(默认胶囊偏高约一个 pad)
    const obsBrandTagY = brandTagY + brandTagPad;
    const obsTopBandH = Math.floor(clamp(brandTagY + obsCapsuleH + Math.floor(22 * resScale), 120, Math.floor(targetH * 0.16)));
    // 品牌带只在竖屏启用(横屏黑带 22% 会盖住内容,降级到普通浮动标题)
    const brandBandPreRatio = (brandBandEnabled && isVertical) ? 0.22 : 0.14;
    const topBandH = (obsMode && brandBandEnabled && isVertical)
        ? obsTopBandH
        : (Number.isFinite(rawTopBandH) && rawTopBandH > 0
            ? Math.floor(clamp(rawTopBandH, isVideoNote ? 240 : 160, isVideoNote ? 520 : Math.floor(targetH * 0.32)))
            : (isVideoNote ? Math.max(360, Math.floor(targetH * confTopRatio)) : Math.max(180, Math.floor(targetH * brandBandPreRatio))));
    const rawBottomBandH = Number(styleOptions.bottomBandHeight || 0);
    const bottomBandH = isVideoNote
        ? (
            Number.isFinite(rawBottomBandH) && rawBottomBandH > 0
                ? Math.floor(clamp(rawBottomBandH, 280, 620))
                : Math.floor(clamp(targetH * confBottomRatio, 420, 600))
        )
        : 0;
    const contentFrameH = isVideoNote
        ? Math.max(360, targetH - topBandH - bottomBandH)
        : Math.max(360, targetH - topBandH);

    // Title font sizes — reference at 1080p base, scaled linearly with resScale (single multiplication)
    const titleSafeMargin = Math.max(40, Math.floor(targetW * 0.06));
    const titleMaxWidth = Math.max(280, targetW - titleSafeMargin * 2);
    const headlineRefSize = Number(styleOptions.headlineFontSize || 0) || confHeadlineSize;
    const sublineRefSize = Number(styleOptions.sublineFontSize || 0) || confSublineSize;
    const headlineRaw = isVideoNote ? headlineRefSize : Math.floor(headlineRefSize * resScale);
    const sublineRaw = isVideoNote ? sublineRefSize : Math.floor(sublineRefSize * resScale);
    // Cap reference is a 1080p-base value that scales linearly with resScale (same as font size).
    // Defaults picked conservatively so that existing videos don't regress; preset 可通过 config 放大。
    const defaultHeadlineCapRef = isVertical ? 72 : 88;
    const defaultSublineCapRef = isVertical ? 46 : 58;
    const confHeadlineCapRef = Number(getConfigValue('video_layout_headline_max_cap_ref', String(defaultHeadlineCapRef)));
    const confSublineCapRef = Number(getConfigValue('video_layout_subline_max_cap_ref', String(defaultSublineCapRef)));
    const headlineCapRef = Number.isFinite(confHeadlineCapRef) ? clamp(confHeadlineCapRef, 40, 160) : defaultHeadlineCapRef;
    const sublineCapRef = Number.isFinite(confSublineCapRef) ? clamp(confSublineCapRef, 24, 120) : defaultSublineCapRef;
    const headlineCap = isVideoNote ? 108 : Math.floor(headlineCapRef * resScale);
    const sublineCap = isVideoNote ? 68 : Math.floor(sublineCapRef * resScale);
    const headlineFontSizeBase = fitTextFontSizeByWidth(headline, clamp(headlineRaw, 16, headlineCap), titleMaxWidth, 16);
    const sublineFontSizeBase = fitTextFontSizeByWidth(subline, clamp(sublineRaw, 14, sublineCap), titleMaxWidth, 14);
    // OBS 模式标题缩小到胶囊量级(放胶囊右侧的窄条里),不放大已有字号
    const headlineFontSize = obsMode ? Math.round(clamp(brandTagFontSize * 0.82, 20, headlineFontSizeBase)) : headlineFontSizeBase;
    const sublineFontSize = obsMode ? Math.round(clamp(brandTagFontSize * 0.60, 16, sublineFontSizeBase)) : sublineFontSizeBase;

    // Subtitle font — shortEdge-based percentage, no double-scaling.
    // confSubtitleSize is the reference size in 1080p pixels; scaling by resScale gives video pixels.
    // styleOptions.subtitleFontSize is a 1080p-reference override, also scaled once.
    const subFontRef = Number(styleOptions.subtitleFontSize || 0) || confSubtitleSize;
    const subFontScaled = isVideoNote ? subFontRef : Math.round(subFontRef * resScale);
    const subFontMin = 14;
    // Orientation-aware cap: portrait uses more width → allow larger font.
    // 默认 vertical/videoNote 9.5%、landscape 7%,通过 config 覆盖,preset 可突破到抖音大字幕(最高 22%)。
    // 横屏录屏(非 video_note)场景字幕应小而克制,避免盖演示内容 → 硬上限 0.10。
    const defaultMaxRatio = (isVertical || isVideoNote) ? 0.095 : 0.07;
    const confMaxRatio = Number(getConfigValue('video_layout_subtitle_max_short_edge_ratio', String(defaultMaxRatio)));
    const isLandscapeShape = !isVertical && !isVideoNote && !isLikelySquare;
    const landscapeRatioCap = 0.10;
    const subFontMaxRatio = Number.isFinite(confMaxRatio)
        ? (isLandscapeShape ? Math.min(clamp(confMaxRatio, 0.05, 0.22), landscapeRatioCap) : clamp(confMaxRatio, 0.05, 0.22))
        : defaultMaxRatio;
    const subFontMax = Math.round(shortEdge * subFontMaxRatio);
    const safeSubtitleFontSize = Math.round(clamp(subFontScaled, subFontMin, subFontMax));

    // MarginV (distance from bottom) — percentage of height, in video pixels (= ASS coordinates)
    // 上限放宽到 targetH * 0.22 (之前 0.15) 让 preset 能把字幕推到更上方避开平台 UI
    const marginVRef = Number(styleOptions.subtitleMarginV || 0);
    const subtitleMarginV = isVideoNote
        ? Math.round(clamp(marginVRef > 0 ? marginVRef : bottomBandH * 0.35, 22, Math.max(36, bottomBandH - 24)))
        : Math.round(clamp(marginVRef > 0 ? marginVRef * resScale : (isVertical ? targetH * 0.08 : targetH * 0.06), 12, Math.round(targetH * 0.22)));

    // MarginH (side margin) — percentage of width, in video pixels
    const marginHRef = Number(styleOptions.subtitleMarginH || 0);
    const subtitleMarginH = Math.round(clamp(marginHRef > 0 ? marginHRef * resScale : targetW * 0.04, 12, Math.round(targetW * 0.10)));

    // Outline and shadow — absolute pixels in video space (ScaledBorderAndShadow: no in ASS)
    // Use explicit null check so that 0 values from config are honored (not collapsed to fallback)
    const subtitleOutlineRef = (styleOptions.subtitleOutline != null && styleOptions.subtitleOutline !== '') ? Number(styleOptions.subtitleOutline) : 3.0;
    const subtitleShadowRef = (styleOptions.subtitleShadow != null && styleOptions.subtitleShadow !== '') ? Number(styleOptions.subtitleShadow) : 0.8;
    const outlineMin = subtitleOutlineRef <= 0 ? 0 : 1.5;
    const safeSubtitleOutline = parseFloat(clamp(subtitleOutlineRef * resScale * 0.5, outlineMin, 7).toFixed(1));
    // Shadow scales linearly with resolution; no *0.5 factor — reference value is already in 1080p pixels
    const safeSubtitleShadow = parseFloat(clamp(subtitleShadowRef * resScale, 0, 8).toFixed(1));

    // Max chars per subtitle line — derived from available width at given font size
    const textMaxUnitsRaw = Number(styleOptions.subtitleMaxUnits || 0);
    const estimatedMaxUnits = Math.floor((targetW - subtitleMarginH * 2) / Math.max(8, safeSubtitleFontSize * 0.95));
    const subtitleMaxUnits = textMaxUnitsRaw > 0
        ? clamp(Math.floor(textMaxUnitsRaw), 6, 36)
        : clamp(estimatedMaxUnits, 6, 30);

    const adaptedCaptions = rebalanceCaptionSegments(captions, subtitleMaxUnits);

    const subtitleAlignRaw = String(styleOptions.subtitleAlign || 'center').trim().toLowerCase();
    const subtitleAlignCode = subtitleAlignRaw === 'left' ? 1 : (subtitleAlignRaw === 'right' ? 3 : 2);
    const titleColor = normalizeHexColor(styleOptions.titleColor || styleOptions.highlightColor, '#FFCF40');
    const subtitleColorAss = hexToAssBgr(styleOptions.subtitleColor, '&H00F2F4F8&');
    const subtitleOutlineColorAss = hexToAssBgr(styleOptions.subtitleOutlineColor, '&H000F172A&');

    // Write ASS file with PlayRes matching video dimensions — values are in video pixels, no implicit scaling.
    writeAssFile(adaptedCaptions, assFilePath, {
        playResX: targetW,
        playResY: targetH,
        fontFamily: cjkFontFamily,
        fontSize: safeSubtitleFontSize,
        primaryColorAss: subtitleColorAss,
        outlineColorAss: subtitleOutlineColorAss,
        outline: safeSubtitleOutline,
        shadow: safeSubtitleShadow,
        marginL: subtitleMarginH,
        marginR: subtitleMarginH,
        marginV: subtitleMarginV,
        alignCode: subtitleAlignCode,
        styleOptions
    });
    const titleOffsetY = Number(styleOptions.titleOffsetY || 0);
    const titleLineGap = Math.floor(clamp(8 * resScale, 6, 40));
    if (isVideoNote) {
        // Video note: titles inside the black top band
        const titleTopPadding = Math.floor(clamp(topBandH * 0.28, 40, 200));
        const headlineYRaw = titleTopPadding + (Number.isFinite(titleOffsetY) ? titleOffsetY : 0);
        var headlineY = Math.floor(clamp(headlineYRaw, 12, Math.max(12, topBandH - headlineFontSize - 24)));
        const minSublineY = headlineY + headlineFontSize + titleLineGap;
        const maxSublineY = Math.max(minSublineY, topBandH - sublineFontSize - 16);
        var sublineY = Math.floor(clamp(headlineY + headlineFontSize + titleLineGap, minSublineY, maxSublineY));
    } else if (obsMode && brandBandEnabled && isVertical) {
        // OBS 模式:小标题放胶囊右侧,与胶囊垂直居中(窄顶带内,不占下方人脸)
        const blockH = headlineFontSize + Math.floor(titleLineGap * 0.6) + sublineFontSize;
        var headlineY = Math.floor(brandTagY + Math.max(0, (obsCapsuleH - blockH) / 2));
        var sublineY = headlineY + headlineFontSize + Math.floor(titleLineGap * 0.6);
    } else if (brandBandEnabled && isVertical) {
        // Brand band (仅竖屏): headline/subline 紧凑布局在胶囊下方,黑带内
        const tagBottom = brandTagY + brandTagFontSize + brandTagPad * 2;
        const safeTop = tagBottom + 16;
        const safeBottom = topBandH - 14;
        const groupH = headlineFontSize + Math.floor(titleLineGap * 0.7) + sublineFontSize;
        const groupTop = safeTop + Math.floor((safeBottom - safeTop - groupH) * 0.35) + (Number.isFinite(titleOffsetY) ? titleOffsetY : 0);
        var headlineY = Math.floor(clamp(groupTop, safeTop, Math.max(safeTop, safeBottom - groupH)));
        var sublineY = headlineY + headlineFontSize + Math.floor(titleLineGap * 0.7);
    } else {
        // Normal video: titles overlaid at top with text shadow, no band constraint
        const titleTopPercent = 0.025; // 2.5% from top
        var headlineY = Math.floor(targetH * titleTopPercent) + (Number.isFinite(titleOffsetY) ? titleOffsetY : 0);
        headlineY = Math.floor(clamp(headlineY, 12, Math.floor(targetH * 0.15)));
        var sublineY = headlineY + headlineFontSize + titleLineGap;
    }
    // Use ASS file directly — PlayRes matches video size, no original_size needed, no force_style ambiguity.
    const subtitleFilter = [
        `subtitles='${escapedAssPath}'`,
        'charenc=UTF-8',
        cjkFontPath ? `fontsdir='${escapeSubtitlePath(path.dirname(cjkFontPath))}'` : ''
    ].filter(Boolean).join(':');
    
    // For Video Note: Scale up by cropScale to crop out edges/watermarks, then crop to content frame
    // Use top-weighted crop (offset cropOffsetY from top) to preserve faces
    const baseFilters = isVideoNote
        ? [
            `scale=${Math.floor(targetW * confCropScale)}:-2`,
            `crop=${targetW}:${contentFrameH}:(iw-ow)/2:(ih-oh)*${confCropOffsetY}`,
            'setsar=1',
            `pad=${targetW}:${targetH}:0:${topBandH}:black`
        ]
        : [];
    // Title text shadow for readability (replaces semi-transparent black band for non-video-note)
    const titleShadowX = Math.floor(2 * resScale);
    const titleShadowY = Math.floor(2 * resScale);
    const titleBorderW = Math.floor(Math.max(2, 3 * resScale));
    // OBS 模式标题左对齐放在胶囊右侧(估算胶囊宽度 = 文字宽 + 边框);否则水平居中
    const obsCapsuleW = Math.round(brandTagText.length * brandTagFontSize * 0.95 + brandTagPad * 2);
    const titleXExpr = obsMode ? String(brandTagX + obsCapsuleW + Math.floor(24 * resScale)) : '(w-text_w)/2';
    const headlineDrawtext = `drawtext=textfile='${escapedHeadlineTextPath}':fontcolor=${titleColor}:fontsize=${headlineFontSize}:line_spacing=2:x=${titleXExpr}:y=${headlineY}:shadowcolor=black@0.7:shadowx=${titleShadowX}:shadowy=${titleShadowY}:borderw=${titleBorderW}:bordercolor=black@0.45${escapedTitleFontPath ? `:fontfile='${escapedTitleFontPath}'` : ''}`;
    const sublineDrawtext = `drawtext=textfile='${escapedSublineTextPath}':fontcolor=${titleColor}:fontsize=${sublineFontSize}:line_spacing=1:x=${titleXExpr}:y=${sublineY}:shadowcolor=black@0.7:shadowx=${titleShadowX}:shadowy=${titleShadowY}:borderw=${titleBorderW}:bordercolor=black@0.45${escapedTitleFontPath ? `:fontfile='${escapedTitleFontPath}'` : ''}`;
    // 品牌带 filter strings(常量已在前面声明)
    const brandTagYEff = obsMode ? obsBrandTagY : brandTagY;
    const brandTagDrawtext = (brandBandEnabled && brandTagText)
        ? `drawtext=text='${brandTagText.replace(/'/g, "\\'")}':fontcolor=${brandTagFgFf}:fontsize=${brandTagFontSize}:box=1:boxcolor=${brandTagBgFf}:boxborderw=${brandTagPad}:x=${brandTagX}:y=${brandTagYEff}${escapedTitleFontPath ? `:fontfile='${escapedTitleFontPath}'` : ''}`
        : '';
    // 顶部黑带仅竖屏启用(横屏会压主画面),横屏保留胶囊 drawtext 但不画黑带
    const brandBandTopBox = (brandBandEnabled && !isVideoNote && isVertical)
        ? `drawbox=x=0:y=0:w=iw:h=${topBandH}:color=0x000000@${brandBandOpacity.toFixed(2)}:t=fill`
        : '';

    const hideTitle = Boolean(styleOptions.hideTitle);
    const overlayFilters = [
        isVideoNote ? `drawbox=x=0:y=0:w=iw:h=${topBandH}:color=black@0.42:t=fill` : '',
        isVideoNote ? `drawbox=x=0:y=${targetH - bottomBandH}:w=iw:h=${bottomBandH}:color=black@0.5:t=fill` : '',
        brandBandTopBox,
        brandTagDrawtext,
        hideTitle ? '' : headlineDrawtext,
        hideTitle ? '' : sublineDrawtext,
        subtitleFilter
    ].filter(Boolean);
    const vf = [...baseFilters, ...overlayFilters].join(',');
    const longEdge = Math.max(targetW, targetH, 1);
    const resBitrateMbps = longEdge >= 3500 ? 25 : longEdge >= 2800 ? 18 : longEdge >= 1800 ? 10 : 6;
    // 智能码率:不超过源视频码率的 1.5 倍,避免低码率源被膨胀编码(20MB→200MB 问题)
    const sourceBitrate = probeVideoBitrate(inputVideoPath);
    const sourceBitrateMbps = sourceBitrate > 0 ? sourceBitrate / 1000000 : 0;
    const cappedMbps = sourceBitrateMbps > 0
        ? Math.min(resBitrateMbps, Math.max(1.5, sourceBitrateMbps * 1.5))
        : resBitrateMbps;
    const autoBitrate = `${Math.round(cappedMbps)}M`;
    const effectiveBitrate = String(process.env.FFMPEG_VT_BITRATE || autoBitrate);
    console.log(`[burn] ${targetW}x${targetH} resScale=${resScale.toFixed(2)} isVideoNote=${isVideoNote} isVertical=${isVertical}`);
    console.log(`[burn] headline=${headlineFontSize}px subline=${sublineFontSize}px subtitle=${safeSubtitleFontSize}px maxUnits=${subtitleMaxUnits}`);
    console.log(`[burn] outline=${safeSubtitleOutline} shadow=${safeSubtitleShadow} marginV=${subtitleMarginV} marginH=${subtitleMarginH}`);
    console.log(`[burn] codec=${getPreferredVideoCodec()} bitrate=${effectiveBitrate}${sourceBitrateMbps > 0 ? ` (source=${sourceBitrateMbps.toFixed(1)}Mbps, cap=${cappedMbps.toFixed(1)}Mbps)` : ''} (original framerate preserved)`);
    console.log(`[burn] headlineY=${headlineY} sublineY=${sublineY} topBandH=${topBandH} titleBorderW=${titleBorderW}`);
    if (brandBandEnabled && brandTagText) console.log(`[burn] brand tag="${brandTagText}" band=${topBandH}px`);

    const preferredCodec = getPreferredVideoCodec();
    // Probe duration for progress tracking (only when onProgress callback is provided)
    const durationSec = onProgress
        ? (Number.isFinite(clipSeconds) && clipSeconds > 0 ? clipSeconds : probeVideoDuration(inputVideoPath))
        : 0;
    const buildFfmpegArgs = (codec) => [
        '-y',
        // 硬件解码:仅在 videotoolbox 编码路径挂 -hwaccel(解码也走 Media Engine,长视频提速明显);
        // 若 HW 路径失败,下面 libx264 回退路径不带 hwaccel,纯软件解码兜底,最稳。
        ...(codec === 'h264_videotoolbox' ? ['-hwaccel', 'videotoolbox'] : []),
        '-i', inputVideoPath,
        ...(Number.isFinite(clipSeconds) && clipSeconds > 0 ? ['-t', String(Math.max(1, clipSeconds))] : []),
        '-vf', vf,
        ...buildVideoCodecArgs(codec, { width: targetW, height: targetH }),
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
        outputVideoPath
    ];
    const runEncode = (codec, progressCb) => runFfmpegWithProgress(buildFfmpegArgs(codec), {
        durationSec,
        onProgress: progressCb,
        timeoutMs: ffmpegTimeout
    });

    try {
        try {
            await runEncode(preferredCodec, onProgress);
        } catch (error) {
            if (preferredCodec === 'libx264') throw error;
            console.warn('\n[burn] hardware encoder failed, retrying with libx264...');
            await runEncode('libx264', onProgress);
        }
        if (!fs.existsSync(outputVideoPath)) throw new Error(`字幕视频生成失败: ${outputVideoPath}`);
        return outputVideoPath;
    } finally {
        safeUnlink(assFilePath);
        safeUnlink(headlineTextPath);
        safeUnlink(sublineTextPath);
    }
}

async function extractAudioFromVideo(videoPath, stem = 'video_audio', clipSeconds = 0) {
    const ffmpegTimeout = getFfmpegTimeoutMs(10 * 60 * 1000);
    const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: ffmpegTimeout });
    if (ffmpegCheck.status !== 0) throw new Error('ffmpeg 不可用，无法提取视频音频');
    if (!fs.existsSync(videoPath)) throw new Error(`源视频不存在: ${videoPath}`);
    const outputDir = path.join(process.cwd(), 'tmp', 'video_audio_extract');
    ensureDir(outputDir);
    const outputFile = path.join(outputDir, `${stem}_${Date.now()}.m4a`);

    // 音频前置增强:远距离/户外录音做 highpass 切风噪 + loudnorm 响度归一,
    // 显著提升 ASR 对弱人声的识别率(不影响最终成片,因为后处理用原视频音轨)。
    // 关闭:ZDE_AUDIO_ENHANCE=0
    const enhanceOn = process.env.ZDE_AUDIO_ENHANCE !== '0';
    const afilter = enhanceOn
        ? ['-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11']
        : [];

    await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        videoPath,
        ...(Number.isFinite(clipSeconds) && clipSeconds > 0 ? ['-t', String(Math.max(1, clipSeconds))] : []),
        '-vn',
        ...afilter,
        '-acodec',
        'aac',
        '-b:a',
        '192k',
        outputFile
    ], getExecFileOptions(ffmpegTimeout));
    if (!fs.existsSync(outputFile)) throw new Error(`视频音频提取失败: ${outputFile}`);
    return outputFile;
}

async function renderCaptionVideo({ serveUrl, outputLocation, inputProps }) {
    const totalMemGb = Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2));
    // lowMemoryNode 同 transcriber.js,看可用内存才能识别"48GB 临时紧张"
    let availMemGb = Infinity;
    try {
        const { getAvailableMemoryGB } = require('../lib/preflight');
        availMemGb = getAvailableMemoryGB();
    } catch (_) { /* 静默 fallback */ }
    const lowMemoryNode = (totalMemGb > 0 && totalMemGb < 3) || availMemGb < 3;
    const timeoutInMilliseconds = Math.max(15000, Number(process.env.REMOTION_TIMEOUT_MS || 120000));
    const scaleRaw = Number(process.env.REMOTION_SCALE || (lowMemoryNode ? 0.75 : 1));
    const scale = Number.isFinite(scaleRaw) ? Math.max(0.25, Math.min(1, scaleRaw)) : (lowMemoryNode ? 0.75 : 1);
    const concurrencyRaw = Number(process.env.REMOTION_CONCURRENCY || (lowMemoryNode ? 1 : 0));
    const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.max(1, Math.floor(concurrencyRaw)) : undefined;
    const composition = await selectComposition({
        id: 'AlexCaptionVideo',
        serveUrl,
        inputProps,
        timeoutInMilliseconds
    });
    const renderOptions = {
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation,
        inputProps,
        timeoutInMilliseconds,
        scale,
        chromiumOptions: {
            gl: 'angle',
            ignoreCertificateErrors: true
        }
    };
    if (concurrency) renderOptions.concurrency = concurrency;
    await renderMedia(renderOptions);
}

module.exports = {
    ensureDir,
    prepareBundle,
    copyAudioToPublic,
    transcodeAudioToAacIfNeeded,
    renderCaptionVideo,
    burnSubtitleVideo,
    extractAudioFromVideo,
    probeVideoSize,
    probeVideoDuration
};
