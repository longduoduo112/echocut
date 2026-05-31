const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const { getDb } = require('../db');
const { listRecentContents, getContentById, updateGeneratedContent, updateRawText, appendProcessTrace, updateVideoPath } = require('../db/contentsRepo');
const { listConfigs, upsertConfig, getConfigValue } = require('../db/configRepo');
const { listTaskStageMetrics } = require('../db/taskCheckpointRepo');
const { generateContentBundle, generateArticle, generateMoments } = require('../services/processor');
const { ensureDir, prepareBundle, copyAudioToPublic, transcodeAudioToAacIfNeeded, renderCaptionVideo } = require('../video/remotionRunner');
const { buildRobustCaptions } = require('../video/captionUtils');
const { getVideoCaptionOptions, sanitizeConfigValue } = require('../video/captionConfig');
const { getTask } = require('../bot/taskManager');

function toSafeAbsolute(targetPath) {
    const root = process.cwd();
    const abs = path.resolve(targetPath);
    if (!abs.startsWith(root)) return null;
    return abs;
}

function readJsonFileSafe(filePath, fallback = {}) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function collectFilesInDir(dirPath, limit = 80, maxDepth = 0, depth = 0) {
    if (!fs.existsSync(dirPath)) return [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const absPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && depth < maxDepth) {
            files.push(...collectFilesInDir(absPath, limit, maxDepth, depth + 1));
            continue;
        }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(absPath);
        files.push({
            name: entry.name,
            abs_path: absPath,
            rel_path: path.relative(process.cwd(), absPath),
            size: stat.size,
            mtime: stat.mtime.toISOString()
        });
    }
    return files.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime)).slice(0, limit);
}

function collectRecentTranscribeFiles(limit = 80) {
    const dirPath = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(dirPath)) return [];
    const files = collectFilesInDir(dirPath, limit * 3);
    return files.filter((x) => /^transcribe_.*\.json$/i.test(x.name)).slice(0, limit);
}

function getMediaMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.m4a') return 'audio/mp4';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    return 'application/octet-stream';
}

function preparePlayableAudio(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.ogg' && ext !== '.oga') return { filePath: absPath, transcoded: false };
    const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (ffmpegCheck.status !== 0) return { filePath: absPath, transcoded: false };
    const stat = fs.statSync(absPath);
    const cacheDir = path.join(process.cwd(), 'tmp', 'admin_audio_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const digest = crypto.createHash('md5').update(`${absPath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    const outPath = path.join(cacheDir, `${digest}.m4a`);
    if (fs.existsSync(outPath)) return { filePath: outPath, transcoded: true };
    const transcode = spawnSync('ffmpeg', ['-y', '-i', absPath, '-c:a', 'aac', '-b:a', '192k', outPath], { stdio: 'ignore' });
    if (transcode.status !== 0 || !fs.existsSync(outPath)) return { filePath: absPath, transcoded: false };
    return { filePath: outPath, transcoded: true };
}

function detectStatusLabel(status) {
    if (status === 'published') return '已发布';
    if (status === 'reviewing') return '已生成';
    return '处理中';
}

function srtToTimeline(srtText) {
    const lines = String(srtText || '').split(/\r?\n/);
    const blocks = [];
    let cursor = 0;
    while (cursor < lines.length) {
        const indexLine = lines[cursor]?.trim();
        if (!indexLine) {
            cursor += 1;
            continue;
        }
        const timeLine = lines[cursor + 1] || '';
        const textLines = [];
        let i = cursor + 2;
        while (i < lines.length && lines[i].trim()) {
            textLines.push(lines[i].trim());
            i += 1;
        }
        if (timeLine.includes('-->')) {
            blocks.push(`${timeLine} ${textLines.join(' ')}`.trim());
        }
        cursor = i + 1;
    }
    return blocks.slice(0, 160);
}

function getTimelinePreviewForAudio(audioPath) {
    const stem = path.basename(audioPath).replace(/\.[^.]+$/, '');
    const db = getDb();
    
    let content = null;
    
    // Try to find content by audio_path first
    content = db.prepare(`SELECT * FROM contents WHERE audio_path = ? ORDER BY id DESC LIMIT 1`).get(audioPath);
    
    // If not found, try to extract ID from filename (e.g. content_123_...)
    if (!content) {
        const match = stem.match(/content_(\d+)/);
        if (match) {
            const id = Number(match[1]);
            content = getContentById(id);
        }
    }
    
    // Also try checking video_output_path match
    if (!content) {
        content = db.prepare(`SELECT * FROM contents WHERE video_output_path = ? ORDER BY id DESC LIMIT 1`).get(audioPath);
    }

    if (content?.transcribe_json_path && fs.existsSync(content.transcribe_json_path)) {
        const payload = readJsonFileSafe(content.transcribe_json_path, { words: [] });
        const words = Array.isArray(payload.words) ? payload.words : [];
        const lines = words.slice(0, 200).map((w) => {
            const t0 = Number(w.start ?? w.startSec ?? 0);
            const t1 = Number(w.end ?? w.endSec ?? 0);
            const text = String(w.word || w.text || '').trim();
            return `${t0.toFixed(2)} --> ${t1.toFixed(2)} ${text}`;
        }).filter(Boolean);
        return {
            source: `contents#${content.id}`,
            trace: content.process_trace || '',
            status: detectStatusLabel(content.status),
            lines
        };
    }
    const videoRoot = path.join(process.cwd(), 'debug_outputs', 'video');
    const candidates = collectFilesInDir(videoRoot, 600, 4).filter((x) => (
        (x.name === 'captions.srt' || x.name === 'captions.json' || x.name === 'transcript.json') && x.rel_path.includes(stem)
    ));
    const srt = candidates.find((x) => x.name === 'captions.srt');
    if (srt && fs.existsSync(srt.abs_path)) {
        const lines = srtToTimeline(fs.readFileSync(srt.abs_path, 'utf8'));
        return {
            source: srt.rel_path,
            trace: '',
            status: '已生成',
            lines
        };
    }
    return {
        source: '',
        trace: '',
        status: '处理中',
        lines: []
    };
}

function startAdminServer(config, { enqueueAdminUpload } = {}) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    // Multer upload middleware — saves to incoming_files/
    const incomingDir = path.join(process.cwd(), 'incoming_files');
    if (!fs.existsSync(incomingDir)) fs.mkdirSync(incomingDir, { recursive: true });
    const uploadStorage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, incomingDir),
        filename: (req, file, cb) => {
            const ts = Date.now();
            const safe = file.originalname.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_');
            cb(null, `${ts}_${safe}`);
        }
    });
    const upload = multer({
        storage: uploadStorage,
        limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
    });

    app.get('/admin/api/health', (req, res) => {
        res.json({ ok: true, now: new Date().toISOString() });
    });

    // POST /admin/api/upload — accept file upload and enqueue processing
    app.post('/admin/api/upload', upload.single('file'), (req, res) => {
        if (!req.file) {
            res.status(400).json({ error: '未收到文件，请选择文件后重试' });
            return;
        }
        if (typeof enqueueAdminUpload !== 'function') {
            res.status(503).json({ error: 'enqueueAdminUpload 未就绪，请在完整模式下启动服务' });
            return;
        }
        const filePath = req.file.path;
        const headline = String(req.body.headline || '').trim() || null;
        const subline = String(req.body.subline || '').trim() || null;
        const mode = String(req.body.mode || 'default').trim();
        try {
            const result = enqueueAdminUpload(filePath, {
                headline: headline || undefined,
                subline: subline || undefined,
                mode
            });
            res.json({ ok: true, taskId: result.taskId, filePath });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // GET /admin/api/tasks/:taskId — poll task status
    app.get('/admin/api/tasks/:taskId', (req, res) => {
        const taskId = String(req.params.taskId || '').trim();
        if (!taskId) {
            res.status(400).json({ error: 'taskId 不能为空' });
            return;
        }
        const task = getTask(taskId);
        if (!task) {
            res.status(404).json({ error: '任务不存在或已过期' });
            return;
        }
        res.json({
            taskId: task.taskId,
            status: task.status,
            stepTitle: task.stepTitle,
            progressPct: task.progressPct,
            error: task.error || '',
            stepNo: task.stepNo,
            totalNo: task.totalNo
        });
    });

    app.get('/admin/api/summary', (req, res) => {
        const db = getDb();
        const total = db.prepare('SELECT COUNT(*) AS count FROM contents').get().count;
        const pending = db.prepare(`SELECT COUNT(*) AS count FROM contents WHERE status = 'pending'`).get().count;
        const reviewing = db.prepare(`SELECT COUNT(*) AS count FROM contents WHERE status = 'reviewing'`).get().count;
        const published = db.prepare(`SELECT COUNT(*) AS count FROM contents WHERE status = 'published'`).get().count;
        res.json({
            total,
            processing: pending,
            generated: reviewing,
            published,
            pending,
            reviewing
        });
    });

    app.get('/admin/api/tasks/:taskId/stages', (req, res) => {
        const taskId = String(req.params.taskId || '').trim();
        if (!taskId) {
            res.status(400).json({ error: 'taskId 不能为空' });
            return;
        }
        const rows = listTaskStageMetrics(taskId, 200);
        const totalMs = rows.reduce((sum, item) => sum + Math.max(0, Number(item.elapsed_ms || 0)), 0);
        const stageSummary = {};
        for (const row of rows) {
            const key = String(row.stage_key || '').trim() || 'unknown';
            if (!stageSummary[key]) {
                stageSummary[key] = {
                    stage_key: key,
                    stage_title: row.stage_title || key,
                    task_type: row.task_type || '',
                    count: 0,
                    total_ms: 0,
                    failed_count: 0,
                    skipped_count: 0
                };
            }
            stageSummary[key].count += 1;
            stageSummary[key].total_ms += Math.max(0, Number(row.elapsed_ms || 0));
            if (row.status === 'failed') stageSummary[key].failed_count += 1;
            if (row.status === 'skipped') stageSummary[key].skipped_count += 1;
        }
        res.json({
            task_id: taskId,
            total_ms: totalMs,
            stages: rows,
            summary: Object.values(stageSummary).sort((a, b) => b.total_ms - a.total_ms)
        });
    });

    app.get('/admin/api/contents', (req, res) => {
        const limit = Math.min(Number(req.query.limit || 100), 500);
        const status = String(req.query.status || '').trim();
        const q = String(req.query.q || '').trim();
        let rows = listRecentContents(limit);
        if (status) rows = rows.filter((item) => item.status === status);
        if (q) rows = rows.filter((item) => (item.raw_text || '').includes(q) || (item.draft_article || '').includes(q));
        rows = rows.map((item) => ({ ...item, status_label: detectStatusLabel(item.status) }));
        res.json(rows);
    });

    app.get('/admin/api/contents/:id', (req, res) => {
        const id = Number(req.params.id);
        const item = getContentById(id);
        if (!item) {
            res.status(404).json({ error: '内容不存在' });
            return;
        }
        res.json({ ...item, status_label: detectStatusLabel(item.status) });
    });

    app.patch('/admin/api/contents/:id', (req, res) => {
        const id = Number(req.params.id);
        const current = getContentById(id);
        if (!current) {
            res.status(404).json({ error: '内容不存在' });
            return;
        }
        const draftArticle = typeof req.body.draft_article === 'string' ? req.body.draft_article : current.draft_article;
        const hookMoment = typeof req.body.hook_moment === 'string' ? req.body.hook_moment : current.hook_moment;
        const rawText = typeof req.body.raw_text === 'string' ? req.body.raw_text : current.raw_text;
        const status = current.status;
        updateRawText(id, rawText);
        updateGeneratedContent(id, { draftArticle, hookMoment, status });
        appendProcessTrace(id, `[${new Date().toISOString()}] 手动更新内容`);
        res.json(getContentById(id));
    });

    app.post('/admin/api/contents/:id/regenerate', async (req, res) => {
        const id = Number(req.params.id);
        const current = getContentById(id);
        if (!current) {
            res.status(404).json({ error: '内容不存在' });
            return;
        }
        const mode = String(req.body.mode || 'all');
        const rawText = String(req.body.raw_text || current.raw_text || '').trim();
        
        // Video regeneration logic
        if (mode === 'video') {
             if (!current.audio_path || !fs.existsSync(current.audio_path)) {
                res.status(400).json({ error: '缺少音频文件，无法生成视频' });
                return;
            }
            if (!current.transcribe_json_path || !fs.existsSync(current.transcribe_json_path)) {
                res.status(400).json({ error: '缺少转录数据，无法生成视频' });
                return;
            }

            try {
                appendProcessTrace(id, `[${new Date().toISOString()}] 后台发起重试 mode=video`);
                
                // 1. Prepare Audio
                const stem = `content_${id}`;
                // Copy original audio to public for web access if needed, but Remotion needs local path or public URL
                // remotionRunner expects audio to be available. 
                // Let's use the helper to copy to public/video_audio which is served statically
                const playbackAudioPath = transcodeAudioToAacIfNeeded(current.audio_path, stem);
                const publicAudioPath = copyAudioToPublic(playbackAudioPath, stem);
                const audioSrc = `/${publicAudioPath}`; // Relative URL for frontend/remotion

                // 2. Prepare Captions
                const transcribeData = readJsonFileSafe(current.transcribe_json_path, { words: [], segments: [] });
                const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);
                const captions = buildRobustCaptions(transcribeData, current.raw_text || '', videoCaptionOptions);

                // 3. Render
                const { serveUrl } = await prepareBundle();
                const outputDir = path.join(process.cwd(), 'debug_outputs', 'video');
                ensureDir(outputDir);
                const outputLocation = path.join(outputDir, `${stem}_${Date.now()}.mp4`);

                await renderCaptionVideo({
                    serveUrl,
                    outputLocation,
                    inputProps: {
                        audioSrc,
                        captions,
                        emphasisWords: videoCaptionOptions.emphasisWords,
                        emphasisColor: videoCaptionOptions.highlightColor,
                        emphasisEnabled: videoCaptionOptions.emphasisEnabled
                    }
                });

                updateVideoPath(id, outputLocation);
                appendProcessTrace(id, `[${new Date().toISOString()}] 视频重生成完成 path=${path.basename(outputLocation)}`);
                
                res.json(getContentById(id));
            } catch (err) {
                console.error('Video generation failed:', err);
                res.status(500).json({ error: '视频生成失败: ' + err.message });
            }
            return;
        }

        if (!rawText) {
            res.status(400).json({ error: '原始文本为空，无法重新生成' });
            return;
        }
        
        appendProcessTrace(id, `[${new Date().toISOString()}] 后台发起重试 mode=${mode}`);
        
        try {
            if (mode === 'all') {
                const bundle = await generateContentBundle(rawText, config);
                updateRawText(id, rawText);
                updateGeneratedContent(id, { draftArticle: bundle.draftArticle, hookMoment: bundle.hookMoment, status: 'reviewing' });
                appendProcessTrace(id, `[${new Date().toISOString()}] 重试完成 all`);
            } else if (mode === 'article') {
                 const draftArticle = await generateArticle(rawText, config);
                 updateRawText(id, rawText);
                 updateGeneratedContent(id, { draftArticle, status: 'reviewing' });
                 appendProcessTrace(id, `[${new Date().toISOString()}] 重试完成 article`);
            } else if (mode === 'moments') {
                let draftArticle = current.draft_article;
                if (!draftArticle) {
                    // Fallback: generate article on the fly if missing, to provide context
                    draftArticle = await generateArticle(rawText, config);
                }
                const hookMoment = await generateMoments(rawText, draftArticle, config);
                updateRawText(id, rawText);
                updateGeneratedContent(id, { hookMoment, status: 'reviewing' });
                appendProcessTrace(id, `[${new Date().toISOString()}] 重试完成 moments`);
            }
            res.json(getContentById(id));
        } catch (err) {
             console.error('Text generation failed:', err);
             res.status(500).json({ error: '内容生成失败: ' + err.message });
        }
    });

    app.get('/admin/api/configs', (req, res) => {
        res.json(listConfigs());
    });

    // 导出全量配置为 JSON 文件
    app.get('/admin/api/configs/export', (req, res) => {
        const configs = listConfigs();
        const exportObj = {};
        for (const row of configs) exportObj[row.key] = row.value;
        const filename = `echo_config_${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(exportObj, null, 2));
    });

    // 重置 pending 内容为 reviewing（用于手动清理卡死任务）
    app.post('/admin/api/contents/:id/reset-pending', (req, res) => {
        const id = Number(req.params.id);
        const item = getContentById(id);
        if (!item) { res.status(404).json({ error: '内容不存在' }); return; }
        if (item.status !== 'pending') { res.status(400).json({ error: '只能重置 pending 状态的内容' }); return; }
        const db = getDb();
        db.prepare(`UPDATE contents SET status='reviewing', process_trace=COALESCE(process_trace,'') || char(10) || '[reset] 手动重置状态' WHERE id=?`).run(id);
        res.json(getContentById(id));
    });

    app.put('/admin/api/configs/:key', (req, res) => {
        const key = String(req.params.key || '').trim();
        const value = sanitizeConfigValue(key, req.body.value);
        if (!key) {
            res.status(400).json({ error: '配置键不能为空' });
            return;
        }
        upsertConfig(key, value);
        res.json({ ok: true, key, value });
    });

    app.get('/admin/api/files', (req, res) => {
        const audioInputs = collectFilesInDir(path.join(process.cwd(), 'audio_inputs'));
        const videoInputs = collectFilesInDir(path.join(process.cwd(), 'video_inputs'));
        const incomingFiles = collectFilesInDir(path.join(process.cwd(), 'incoming_files'), 200, 1);
        const generatedVideos = collectFilesInDir(path.join(process.cwd(), 'public', 'generated_videos'), 120, 1);
        const logs = collectFilesInDir(path.join(process.cwd(), 'logs'), 120, 1);
        const recentAudioDebug = collectFilesInDir(path.join(process.cwd(), 'debug_outputs', 'audio'), 120, 2);
        const recentVideoDebug = collectFilesInDir(path.join(process.cwd(), 'debug_outputs', 'video'), 120, 3);
        const recentTextDebug = collectFilesInDir(path.join(process.cwd(), 'debug_outputs', 'text'), 120, 2);
        const transcribeJson = collectRecentTranscribeFiles();
        res.json({
            audio_inputs: audioInputs,
            video_inputs: videoInputs,
            incoming_files: incomingFiles,
            generated_videos: generatedVideos,
            logs,
            debug_audio: recentAudioDebug,
            debug_video: recentVideoDebug,
            debug_text: recentTextDebug,
            transcribe_json: transcribeJson
        });
    });

    app.get('/admin/api/file-content', (req, res) => {
        const raw = String(req.query.path || '');
        const absPath = toSafeAbsolute(raw);
        if (!absPath) {
            res.status(400).json({ error: '文件路径不合法' });
            return;
        }
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.status(404).json({ error: '文件不存在' });
            return;
        }
        const ext = path.extname(absPath).toLowerCase();
        const asText = ['.txt', '.json', '.md', '.srt', '.log', '.csv', '.py', '.js', '.jsx', '.ts', '.tsx'].includes(ext);
        if (!asText) {
            res.json({
                abs_path: absPath,
                rel_path: path.relative(process.cwd(), absPath),
                binary: true,
                message: '该文件为二进制或不支持预览'
            });
            return;
        }
        const full = fs.readFileSync(absPath, 'utf8');
        res.json({
            abs_path: absPath,
            rel_path: path.relative(process.cwd(), absPath),
            binary: false,
            content: full.slice(0, 50000)
        });
    });

    app.get('/admin/api/audio-timeline', (req, res) => {
        const raw = String(req.query.path || '');
        const absPath = toSafeAbsolute(raw);
        if (!absPath) {
            res.status(400).json({ error: '文件路径不合法' });
            return;
        }
        const preview = getTimelinePreviewForAudio(absPath);
        res.json(preview);
    });

    app.get('/admin/api/file-playback', (req, res) => {
        const raw = String(req.query.path || '');
        const absPath = toSafeAbsolute(raw);
        if (!absPath) {
            res.status(400).json({ error: '文件路径不合法' });
            return;
        }
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.status(404).json({ error: '文件不存在' });
            return;
        }
        const playable = preparePlayableAudio(absPath);
        res.json({
            playable_path: playable.filePath,
            rel_path: path.relative(process.cwd(), playable.filePath),
            transcoded: playable.transcoded,
            mime: getMediaMime(playable.filePath),
            stream_url: `/admin/api/file-stream?path=${encodeURIComponent(playable.filePath)}`
        });
    });

    app.get('/admin/api/file-stream', (req, res) => {
        const raw = String(req.query.path || '');
        const absPath = toSafeAbsolute(raw);
        if (!absPath) {
            res.status(400).json({ error: '文件路径不合法' });
            return;
        }
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            res.status(404).json({ error: '文件不存在' });
            return;
        }
        res.setHeader('Content-Type', getMediaMime(absPath));
        res.sendFile(absPath);
    });

    const staticDir = path.join(__dirname, 'public');
    app.use('/admin', express.static(staticDir));
    // Serve project root public folder
    app.use('/public', express.static(path.join(process.cwd(), 'public')));
    
    // Serve landing page at root
    app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'landing.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

    const server = app.listen(config.adminPort, () => {
        console.log(`🧭 Admin 工作台已启动: http://127.0.0.1:${config.adminPort}/admin`);
    });
    server.on('error', (error) => {
        console.error(`[admin_server_error] ${error.message}`);
    });

    return server;
}

module.exports = { startAdminServer };
