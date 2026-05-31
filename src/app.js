const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { getConfig } = require('./config');
const { initDb } = require('./db');
const { ensureDefaultConfigs, getConfigValue } = require('./db/configRepo');
const {
    upsertTaskCheckpoint,
    updateTaskCheckpointStatus,
    listRecoverableTaskCheckpoints,
    markActiveTaskCheckpointsInterrupted
} = require('./db/taskCheckpointRepo');
const { startAdminServer } = require('./admin/server');
const { createContent, updateGeneratedContent, appendProcessTrace, updateVideoPath } = require('./db/contentsRepo');
const { generateContentBundle, generateVideoMetadata, generatePublishKit, generateXiaohongshu, generateDouyinDesc, analyzeImage, stripHallucinatedLoop, correctCaptions } = require('./services/processor');
const { ARTICLE_MODES, MODE_LIST } = require('./services/promptLibrary');
const { downloadAudio, transcribeAudio } = require('./services/transcriber');
const { downloadYoutubeVideo, isYoutubeUrl, extractYoutubeUrl } = require('./services/youtubeDl');
const { createLogger } = require('./services/logger');
const { buildRobustCaptions, applyFillerRemoval } = require('./video/captionUtils');
const { getVideoCaptionOptions } = require('./video/captionConfig');
const {
    renderCaptionVideo,
    copyAudioToPublic,
    ensureDir,
    prepareBundle,
    burnSubtitleVideo,
    extractAudioFromVideo,
    probeVideoSize
} = require('./video/remotionRunner');
const {
    isVideoMessage,
    isImageMessage,
    getVideoPayload,
    getImagePayload,
    detectMessageType,
    summarizeMessage,
    resolveMediaExt,
    getMediaEntries,
    hasFileMessage,
    clipText,
    readJsonFileSafe,
    buildTaskMessageSnapshot,
    normalizeMessageSnapshot
} = require('./bot/msgUtils');
const {
    runWithBotNetworkRetry,
    sendProgress,
    sendStatusMessage,
    editStatusMessage,
    renderProgressBar,
    formatPublishGroups,
    parseCaptionAsTitle,
    sendVideoWithFallback,
    delay
} = require('./bot/botSend');
const {
    setQueueConcurrency,
    formatMs,
    nowLabel,
    createStageTracker,
    getQueueStatus,
    getQueueDepth,
    inferTaskTypeFromMessage,
    getTaskTotalSteps,
    registerTaskForDashboard,
    updateTaskStep,
    markTaskDone,
    markTaskFailed,
    buildTaskStageMetricsText,
    startDashboardLoop,
    enqueueTask,
    getTask
} = require('./bot/taskManager');

const logger = createLogger({ name: 'bot' });
const chatContentModes = new Map(); // 每个 chat 的内容生成模式
let shutdownHookInstalled = false;

function createBot(config) {
    const options = {
        polling: {
            autoStart: true,
            interval: config.pollingIntervalMs,
            params: { timeout: config.pollingTimeoutSec }
        },
        request: {
            timeout: 30000,
            forever: true
        }
    };
    if (config.proxyUrl) {
        options.request.proxy = config.proxyUrl;
        console.log(`🌐 Telegram 代理已启用: ${config.proxyUrl}`);
    }
    return new TelegramBot(config.telegramToken, options);
}

function ensureAudioDir() {
    const dir = path.join(process.cwd(), 'audio_inputs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function ensureVideoDir() {
    const dir = path.join(process.cwd(), 'video_inputs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function ensureIncomingDir() {
    const dir = path.join(process.cwd(), 'incoming_files');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function ensureImageDir() {
    const dir = path.join(process.cwd(), 'image_inputs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function buildSessionLabel(msg) {
    const user = msg.from?.username ? `@${msg.from.username}` : `${msg.from?.first_name || 'User'}`;
    return `${user}#${msg.chat.id}`;
}

function getTaskId() {
    return `T${Date.now().toString().slice(-8)}`;
}


async function archiveIncomingMessage(bot, msg, incomingDir) {
    const chatId = msg?.chat?.id || 'unknown';
    const messageId = msg?.message_id || Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `chat_${chatId}_msg_${messageId}_${stamp}`;
    const mediaEntries = getMediaEntries(msg);
    const savedFiles = [];
    const failedFiles = [];
    for (let i = 0; i < mediaEntries.length; i += 1) {
        const { kind, media } = mediaEntries[i];
        const fileId = media?.file_id;
        if (!fileId) continue;
        const ext = resolveMediaExt(kind, media);
        const localPath = path.join(incomingDir, `${baseName}_${kind}_${i + 1}${ext}`);
        try {
            const fileLink = await runWithBotNetworkRetry(() => bot.getFileLink(fileId), { botNetworkRetries: 3, botNetworkRetryDelayMs: 1200 }, 'archive_get_file_link');
            await downloadAudio(fileLink, localPath);
            const stat = fs.statSync(localPath);
            savedFiles.push({
                kind,
                fileId,
                localPath,
                size: stat.size,
                mimeType: media?.mime_type || '',
                fileName: media?.file_name || ''
            });
        } catch (error) {
            failedFiles.push({
                kind,
                fileId,
                message: error.message
            });
        }
    }
    const metaPath = path.join(incomingDir, `${baseName}.json`);
    const meta = {
        ts: new Date().toISOString(),
        summary: summarizeMessage(msg),
        text: msg?.text || '',
        caption: msg?.caption || '',
        media: savedFiles,
        failedMedia: failedFiles
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    logger.info('bot.message.archived', {
        ...summarizeMessage(msg),
        metaPath,
        mediaCount: savedFiles.length,
        failedMediaCount: failedFiles.length
    });
    return { metaPath, mediaCount: savedFiles.length, failedMediaCount: failedFiles.length };
}

async function runTaskByMessage(bot, msg, config, audioDir, videoDir, imageDir, taskMeta = {}) {
    if (msg.voice || msg.audio) {
        await handleAudioMessage(bot, msg, config, audioDir, taskMeta);
        return;
    }
    if (isVideoMessage(msg)) {
        await handleVideoMessage(bot, msg, config, videoDir, taskMeta);
        return;
    }
    if (isImageMessage(msg)) {
        await handleImageMessage(bot, msg, config, imageDir, taskMeta);
        return;
    }
    if (msg.text) {
        const youtubeUrl = isYoutubeUrl(msg.text) ? extractYoutubeUrl(msg.text) : '';
        if (youtubeUrl) {
            await handleYoutubeMessage(bot, msg, youtubeUrl, config, taskMeta);
            return;
        }
        await handleTextMessage(bot, msg, config, taskMeta);
    }
}

function buildTaskPayload(msg, archiveResult, source) {
    return {
        source,
        archiveMetaPath: archiveResult?.metaPath || '',
        message: buildTaskMessageSnapshot(msg)
    };
}

async function recoverInterruptedTasks(bot, config, audioDir, videoDir, imageDir) {
    const rows = listRecoverableTaskCheckpoints(120);
    if (!rows.length) return 0;
    let recovered = 0;
    for (const row of rows) {
        let payload = {};
        try {
            payload = JSON.parse(row.payload_json || '{}');
        } catch (_) {
            payload = {};
        }
        const taskMsg = normalizeMessageSnapshot(payload.message);
        if (!taskMsg) {
            updateTaskCheckpointStatus(row.task_id, 'failed', {
                errorText: 'checkpoint payload malformed',
                stepTitle: '恢复失败: payload损坏'
            });
            continue;
        }
        const taskType = String(row.task_type || inferTaskTypeFromMessage(taskMsg) || 'text');
        const taskId = String(row.task_id || getTaskId());
        const session = String(row.session || buildSessionLabel(taskMsg));
        const queueNo = getQueueDepth();
        registerTaskForDashboard({
            taskId,
            chatId: taskMsg.chat.id,
            session,
            taskType,
            queueNo
        });
        updateTaskStep(taskId, {
            stepNo: Number(row.step_no || 0),
            totalNo: Number(row.total_no || getTaskTotalSteps(taskType)),
            stepTitle: '断点恢复入队',
            progressPct: Math.max(1, Number(row.progress_pct || 1))
        });
        upsertTaskCheckpoint({
            taskId,
            chatId: taskMsg.chat.id,
            session,
            taskType,
            status: 'queued',
            payload,
            stepNo: Number(row.step_no || 0),
            totalNo: Number(row.total_no || getTaskTotalSteps(taskType)),
            stepTitle: '断点恢复入队',
            progressPct: Math.max(1, Number(row.progress_pct || 1)),
            errorText: ''
        });
        try {
            // 恢复通知限速：每条间隔 800ms，避免批量恢复触发 Telegram 429
            if (recovered > 0) await delay(800);
            await sendProgress(
                bot,
                taskMsg.chat.id,
                `♻️ 检测到服务重启，任务已从断点恢复\n任务: ${taskId}\n会话: ${session}\n当前进度: ${Math.max(1, Number(row.progress_pct || 1))}%`,
                config
            );
        } catch (_) {
        }
        enqueueTask({
            taskId,
            run: async () => {
                await runTaskByMessage(bot, taskMsg, config, audioDir, videoDir, imageDir, { taskId, taskType, session, recovered: true });
            }
        }).catch((error) => {
            logger.error('queue.task.recovered.failed', { taskId, message: error.message });
        });
        recovered += 1;
    }
    logger.info('queue.recovery.done', { recovered });
    return recovered;
}

function installShutdownHooks() {
    if (shutdownHookInstalled) return;
    const shutdown = (signal) => {
        try {
            const changed = markActiveTaskCheckpointsInterrupted();
            logger.warn('process.shutdown', { signal, interruptedTasks: changed });
        } catch (error) {
            logger.error('process.shutdown.failed', { signal, message: error.message });
        } finally {
            process.exit(0);
        }
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    shutdownHookInstalled = true;
}


/**
 * 异步生成并发送小红书/抖音平台内容，失败时静默跳过
 */
async function sendPlatformContent(bot, chatId, rawText, config, logger, taskId) {
    try {
        const [xhsResult, douyinResult] = await Promise.all([
            generateXiaohongshu(rawText, config).catch((e) => { logger.warn('platform.xhs.failed', { taskId, message: String(e.message || '').slice(0, 120) }); return null; }),
            generateDouyinDesc(rawText, config).catch((e) => { logger.warn('platform.douyin.failed', { taskId, message: String(e.message || '').slice(0, 120) }); return null; })
        ]);
        const parts = [];
        if (xhsResult) {
            const tagLine = Array.isArray(xhsResult.tags) ? xhsResult.tags.join(' ') : '';
            parts.push(`📱 小红书版本\n${'─'.repeat(16)}\n标题：${xhsResult.title}\n\n${xhsResult.body}${tagLine ? `\n\n${tagLine}` : ''}`);
        }
        if (douyinResult) {
            const tagLine = Array.isArray(douyinResult.tags) ? douyinResult.tags.join(' ') : '';
            parts.push(`🎬 抖音/视频号\n${'─'.repeat(16)}\n${douyinResult.desc}${tagLine ? `\n\n${tagLine}` : ''}`);
        }
        if (parts.length > 0) {
            await sendProgress(bot, chatId, parts.join('\n\n'), config);
        }
    } catch (err) {
        logger.warn('platform.content.failed', { taskId, message: String(err.message || '').slice(0, 120) });
    }
}

const YOUTUBE_MAX_DURATION_WARN_SEC = 1800; // 30 minutes

async function handleYoutubeMessage(bot, msg, url, config, taskMeta = {}) {
    const taskId = taskMeta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'video');
    const stageCost = tracker.stageCost;
    const markStageCost = (key, title, beginAt, options = {}) => tracker.record(key, title, beginAt, options);
    const chatId = msg.chat.id;

    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('video'), stepTitle: '接收 YouTube 任务', progressPct: 5 });
    logger.info('task.youtube.received', { taskId, chatId, url, session: buildSessionLabel(msg) });

    const statusMsgId = await sendStatusMessage(bot, chatId, `📥 正在下载 YouTube 视频... | 任务 ${taskId}`);

    // Download YouTube video to tmp/youtube/
    const youtubeDir = path.join(process.cwd(), 'tmp', 'youtube');
    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('video'), stepTitle: '下载 YouTube 视频', progressPct: 15 });
    const downloadStartedAt = Date.now();
    let localVideoPath = '';
    let ytInfo = {};
    try {
        const dlResult = await downloadYoutubeVideo(url, youtubeDir);
        localVideoPath = dlResult.videoPath;
        ytInfo = dlResult.info || {};
        markStageCost('downloadMs', '下载 YouTube 视频', downloadStartedAt);
    } catch (dlErr) {
        markStageCost('downloadMs', '下载 YouTube 视频', downloadStartedAt, { status: 'failed' });
        await editStatusMessage(bot, chatId, statusMsgId, `❌ YouTube 下载失败 | ${dlErr.message.slice(0, 80)}`);
        throw dlErr;
    }

    const fileStats = fs.statSync(localVideoPath);
    logger.info('task.youtube.downloaded', { taskId, fileSize: fileStats.size, localVideoPath, title: ytInfo.title, duration: ytInfo.duration });

    // Warn if video is very long
    if (ytInfo.duration && ytInfo.duration > YOUTUBE_MAX_DURATION_WARN_SEC) {
        await sendProgress(
            bot,
            chatId,
            `⚠️ 视频时长 ${Math.floor(ytInfo.duration / 60)} 分钟，超过 30 分钟，转写可能耗时较长。如只需文字内容建议使用纯音频处理。`,
            config
        );
    }

    await editStatusMessage(bot, chatId, statusMsgId,
        `🛰️ 下载完成 (${(fileStats.size / 1024 / 1024).toFixed(1)}MB)${ytInfo.title ? ` | ${ytInfo.title.slice(0, 40)}` : ''} | 转写中... | 任务 ${taskId}`);

    // Transcribe
    let extractedAudioPath = '';
    let words = [];
    let fullText = '';
    let resultJsonPath = '';
    let stderr = '';
    let transcribeMs = 0;
    const transcribeStartedAt = Date.now();
    try {
        updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('video'), stepTitle: '提取音轨并转录', progressPct: 32 });
        extractedAudioPath = await extractAudioFromVideo(localVideoPath, `yt_${taskId}`);
        const transcribeResult = await transcribeAudio(extractedAudioPath, config);
        words = transcribeResult.words;
        fullText = stripHallucinatedLoop(transcribeResult.fullText || '');
        resultJsonPath = transcribeResult.resultJsonPath;
        stderr = transcribeResult.stderr;
        transcribeMs = transcribeResult.transcribeMs;
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt);
    } catch (audioError) {
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt, { status: 'failed' });
        await sendProgress(bot, chatId, `⚠️ 该 YouTube 视频音轨提取失败，无法继续\n任务: ${taskId}\n原因: ${audioError.message}`, config);
        throw audioError;
    }
    if (!fullText) throw new Error('YouTube 视频转录结果为空，请尝试其他视频');

    logger.info('task.youtube.transcribed', { taskId, words: words.length, textLength: fullText.length, transcribeMs, resultJsonPath });
    await editStatusMessage(bot, chatId, statusMsgId,
        `🎙️ 转写完成 (${words.length}词, ${(transcribeMs / 1000).toFixed(0)}s) | 生成内容中... | 任务 ${taskId}`);

    const contentId = createContent({
        audioPath: extractedAudioPath || localVideoPath,
        transcribeJsonPath: resultJsonPath,
        rawText: fullText,
        status: 'pending',
        processTrace: `[${nowLabel()}] YouTube 任务创建 task=${taskId} url=${url}\n[${nowLabel()}] 视频下载完成 file=${path.basename(localVideoPath)} size=${fileStats.size}${ytInfo.title ? ` title=${ytInfo.title}` : ''}${extractedAudioPath ? `\n[${nowLabel()}] 提取音频 file=${path.basename(extractedAudioPath)}` : ''}`
    });
    appendProcessTrace(contentId, `[${nowLabel()}] 转录完成 words=${words.length} ms=${transcribeMs}${resultJsonPath ? ` json=${path.basename(resultJsonPath)}` : ''}`);

    // Title: prefer YouTube video title as hint
    const contentMode = chatContentModes.get(chatId) || 'default';
    const videoContentMode = String(config.videoContentMode || 'fast').trim().toLowerCase() === 'full' ? 'full' : 'fast';
    // Use YouTube title as headline override candidate if available
    const ytTitleOverride = ytInfo.title ? { headline: ytInfo.title.slice(0, 30), subline: '' } : null;

    updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('video'), stepTitle: '并行生成文案与标题', progressPct: 52 });
    const contentStartedAt = Date.now();
    const metadataStartedAt = Date.now();
    let contentBundle = { draftArticle: '', hookMoment: '' };
    let metadata = { headline: '', subline: '' };
    const [bundleResult, metadataResult] = await Promise.all([
        generateContentBundle(fullText, config, contentMode),
        generateVideoMetadata(fullText, config)
    ]);
    contentBundle = bundleResult;
    // If YouTube title available, use it as headline but keep AI subline
    metadata = ytTitleOverride
        ? { headline: ytTitleOverride.headline, subline: metadataResult.subline || '' }
        : metadataResult;
    markStageCost('contentMs', '生成文案', contentStartedAt, { contentId });
    markStageCost('metadataMs', '生成标题', metadataStartedAt, { contentId });

    updateGeneratedContent(contentId, {
        draftArticle: contentBundle.draftArticle,
        hookMoment: contentBundle.hookMoment,
        status: 'reviewing'
    });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length} mode=${videoContentMode}`);
    await sendProgress(
        bot,
        chatId,
        `✍️ 文案已生成，视频仍在处理中\n任务: ${taskId}\n内容ID: ${contentId}\n主标题: ${metadata.headline}\n副标题: ${metadata.subline}\n\n${clipText(contentBundle.draftArticle, 220)}${contentBundle.hookMoment ? `\n\n----\n朋友圈诱饵：\n${clipText(contentBundle.hookMoment, 120)}` : ''}`,
        config
    );

    updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('video'), stepTitle: '标题元数据已就绪', progressPct: 64 });
    appendProcessTrace(contentId, `[${nowLabel()}] 视频元数据 headline=${metadata.headline} subline=${metadata.subline}`);
    await editStatusMessage(bot, chatId, statusMsgId,
        `🤖 内容已生成 | 标题: ${metadata.headline} | 🎞️ 烧录中... | 任务 ${taskId}`);

    const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);
    const { width: probeW, height: probeH } = probeVideoSize(localVideoPath);
    const probeAspect = probeW > 0 && probeH > 0 ? probeW / probeH : 1;
    const isVerticalVideo = probeAspect > 0 && probeAspect < 0.8;
    const tunedVideoCaptionOptions = isVerticalVideo
        ? {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 12),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 18, 12),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 2.4)
        }
        : {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 16),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 20, 20),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 3.0)
        };

    updateTaskStep(taskId, { stepNo: 6, totalNo: getTaskTotalSteps('video'), stepTitle: '字幕切分与视频烧录', progressPct: 82 });
    const transcribeData = resultJsonPath
        ? readJsonFileSafe(resultJsonPath, { words: [], segments: [{ start: 0, end: 4, text: fullText }] })
        : { words: [], segments: [{ start: 0, end: 4, text: fullText }] };
    let captions = applyFillerRemoval(buildRobustCaptions(transcribeData, fullText, tunedVideoCaptionOptions), tunedVideoCaptionOptions.fillerWords);
    try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[youtube] caption correction skipped:', e.message); }
    if (!captions.length) throw new Error('未生成可用字幕片段');

    const outputDir = path.join(process.cwd(), 'public', 'generated_videos');
    ensureDir(outputDir);
    const outputLocation = path.join(outputDir, `video_${taskId}.mp4`);
    const renderStartedAt = Date.now();
    let encodeLastEditMs = 0;
    const onEncodeProgress = async (pct) => {
        const now = Date.now();
        if (now - encodeLastEditMs < 4000 && pct < 100) return;
        encodeLastEditMs = now;
        await editStatusMessage(bot, chatId, statusMsgId,
            `🎞️ 烧录中 ${renderProgressBar(pct)} | 标题: ${metadata.headline} | 任务 ${taskId}`);
    };
    await burnSubtitleVideo({
        inputVideoPath: localVideoPath,
        outputVideoPath: outputLocation,
        captions,
        headline: metadata.headline,
        subline: metadata.subline,
        styleOptions: {
            ...tunedVideoCaptionOptions,
            sourceType: 'video',
            isVideoNoteLike: false
        },
        onProgress: onEncodeProgress
    });
    markStageCost('renderMs', '字幕切分与视频烧录', renderStartedAt, { contentId });

    updateVideoPath(contentId, outputLocation);
    appendProcessTrace(contentId, `[${nowLabel()}] 视频生成完成 output=${path.basename(outputLocation)}`);
    updateTaskStep(taskId, { stepNo: 7, totalNo: getTaskTotalSteps('video'), stepTitle: '回传视频并完成任务', progressPct: 100 });
    await editStatusMessage(bot, chatId, statusMsgId, `✅ 烧录完成 | 🚀 回传中... | 任务 ${taskId}`);
    const uploadStartedAt = Date.now();
    await sendVideoWithFallback(bot, chatId, outputLocation, `${metadata.headline}\n${metadata.subline}\n\n#Echo #AI`);
    markStageCost('uploadMs', '回传视频', uploadStartedAt, { contentId });
    const elapsedMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
    appendProcessTrace(contentId, `[${nowLabel()}] 阶段耗时 download=${formatMs(stageCost.downloadMs || 0)} transcribe=${formatMs(stageCost.transcribeMs || 0)} content=${formatMs(stageCost.contentMs || 0)} metadata=${formatMs(stageCost.metadataMs || 0)} render=${formatMs(stageCost.renderMs || 0)} upload=${formatMs(stageCost.uploadMs || 0)} total=${formatMs(elapsedMs)}`);
    logger.info('task.youtube.done', {
        taskId,
        contentId,
        url,
        outputLocation,
        headline: metadata.headline,
        elapsedMs,
        stageCost
    });
    await editStatusMessage(bot, chatId, statusMsgId,
        `✅ 完成！总耗时 ${formatMs(elapsedMs)}\n下载 ${formatMs(stageCost.downloadMs || 0)} | 转写 ${formatMs(stageCost.transcribeMs || 0)} | 文案 ${formatMs(stageCost.contentMs || 0)} | 烧录 ${formatMs(stageCost.renderMs || 0)} | 回传 ${formatMs(stageCost.uploadMs || 0)}`);

    // Send publish kit
    if (fullText) {
        try {
            const publishGroups = await generatePublishKit(fullText, metadata.headline, config);
            if (publishGroups.length > 0) {
                const publishText = formatPublishGroups(publishGroups, metadata.headline);
                await sendProgress(bot, chatId, publishText, config);
            }
        } catch (pubErr) {
            logger.warn('task.youtube.publish_kit_failed', { taskId, message: String(pubErr.message || '').slice(0, 120) });
        }
    }

    if (contentBundle.hookMoment) {
        await sendProgress(bot, chatId, `💬 朋友圈文案：\n${clipText(contentBundle.hookMoment, 400)}`, config);
    }

    // Cleanup extracted audio
    if (extractedAudioPath && extractedAudioPath.includes('tmp') && fs.existsSync(extractedAudioPath)) {
        try { fs.unlinkSync(extractedAudioPath); } catch (_) {}
    }
}

async function handleTextMessage(bot, msg, config, taskMeta = {}) {
    const taskId = taskMeta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'text');
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    if (!text) return;
    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('text'), stepTitle: '接收文本并初始化任务', progressPct: 10 });
    logger.info('task.text.received', { taskId, chatId, textLength: text.length, session: buildSessionLabel(msg) });

    if (text === '/start') {
        await sendProgress(bot, chatId, '✅ Echo 已就绪。支持文本、语音、音频、视频输入。', config);
        return;
    }
    if (text === '/health') {
        await sendProgress(bot, chatId, `✅ 引擎在线\n模型: ${config.ollamaModel}\n代理: ${config.proxyUrl || '未启用'}`, config);
        return;
    }

    await sendProgress(bot, chatId, `📥 已接收文本任务\n任务: ${taskId}\n会话: ${buildSessionLabel(msg)}\n长度: ${text.length} 字`, config);
    const contentId = createContent({
        rawText: text,
        status: 'pending',
        processTrace: `[${nowLabel()}] 文本任务创建 task=${taskId}`
    });
    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('text'), stepTitle: '调用模型生成内容', progressPct: 55 });
    const contentMode = chatContentModes.get(chatId) || 'default';
    const modeLabel = ARTICLE_MODES[contentMode] ? `${ARTICLE_MODES[contentMode].emoji} ${ARTICLE_MODES[contentMode].name}` : contentMode;
    await sendProgress(bot, chatId, `🧠 正在调用本地模型生成内容...\n模式: ${modeLabel}`, config);
    appendProcessTrace(contentId, `[${nowLabel()}] 开始内容生成 mode=${contentMode}`);
    const contentStartedAt = Date.now();
    const contentBundle = await generateContentBundle(text, config, contentMode);
    tracker.record('contentMs', '文本内容生成', contentStartedAt, { contentId });
    updateGeneratedContent(contentId, { draftArticle: contentBundle.draftArticle, hookMoment: contentBundle.hookMoment, status: 'reviewing' });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length}`);
    const totalMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
    appendProcessTrace(
        contentId,
        `[${nowLabel()}] 阶段耗时 content=${formatMs(tracker.stageCost.contentMs || 0)} total=${formatMs(totalMs)}`
    );
    updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('text'), stepTitle: '写入内容并完成回传', progressPct: 100 });
    await sendProgress(bot, chatId, `✅ 文本任务完成\n任务: ${taskId}\n内容ID: ${contentId}\n总耗时: ${formatMs(totalMs)}\n阶段耗时: 内容生成 ${formatMs(tracker.stageCost.contentMs || 0)}\n\n${contentBundle.draftArticle}\n\n----\n朋友圈诱饵：\n${contentBundle.hookMoment}`, config);
    logger.info('task.text.done', { taskId, contentId, elapsedMs: totalMs, stageCost: tracker.stageCost });
    // 异步生成平台文案（小红书/抖音），不阻塞主流程
    await sendPlatformContent(bot, chatId, text, config, logger, taskId);
}

async function handleAudioMessage(bot, msg, config, audioDir, taskMeta = {}) {
    const taskId = taskMeta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'audio');
    const chatId = msg.chat.id;
    const audioContent = msg.voice || msg.audio;
    const isVoice = Boolean(msg.voice);
    const fileLink = await runWithBotNetworkRetry(() => bot.getFileLink(audioContent.file_id), config, 'audio_get_file_link');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = isVoice ? '.ogg' : '.mp3';
    const localFilePath = path.join(audioDir, `echo_input_${timestamp}${ext}`);
    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('audio'), stepTitle: '接收音频任务', progressPct: 8 });
    logger.info('task.audio.received', { taskId, chatId, session: buildSessionLabel(msg), sourceType: isVoice ? 'voice' : 'audio', localFilePath });

    await sendProgress(bot, chatId, `📥 已接收语音任务\n任务: ${taskId}\n会话: ${buildSessionLabel(msg)}\n类型: ${isVoice ? 'voice' : 'audio'}\n正在下载音频...`, config);
    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('audio'), stepTitle: '下载音频文件', progressPct: 18 });
    const downloadStartedAt = Date.now();
    await downloadAudio(fileLink, localFilePath);
    tracker.record('downloadMs', '下载音频', downloadStartedAt);
    const fileStats = fs.statSync(localFilePath);
    logger.info('task.audio.downloaded', { taskId, fileSize: fileStats.size, localFilePath });
    await sendProgress(bot, chatId, `🛰️ 下载完成\n任务: ${taskId}\n文件: ${path.basename(localFilePath)}\n大小: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB\n正在 WhisperX 转录...`, config);

    updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('audio'), stepTitle: '语音转录中', progressPct: 32 });
    const transcribeStartedAt = Date.now();
    const { words, fullText: rawFullTextAudio, resultJsonPath, stderr, transcribeMs } = await transcribeAudio(localFilePath, config);
    const fullText = stripHallucinatedLoop(rawFullTextAudio || '');
    tracker.record('transcribeWallMs', '转录总耗时', transcribeStartedAt);
    tracker.recordFixed('transcribeMs', '转录引擎耗时', transcribeMs);
    if (!fullText) throw new Error('转录结果为空');
    logger.info('task.audio.transcribed', { taskId, words: words.length, textLength: fullText.length, transcribeMs, resultJsonPath });
    const contentId = createContent({
        audioPath: localFilePath,
        transcribeJsonPath: resultJsonPath,
        rawText: fullText,
        status: 'pending',
        processTrace: `[${nowLabel()}] 语音任务创建 task=${taskId}\n[${nowLabel()}] 音频下载完成 file=${path.basename(localFilePath)} size=${fileStats.size}`
    });
    console.log(`[${taskId}] 转录完成 words=${words.length} ms=${transcribeMs}`);
    appendProcessTrace(contentId, `[${nowLabel()}] 转录完成 words=${words.length} ms=${transcribeMs} json=${path.basename(resultJsonPath)}`);
    if (stderr) {
        const stderrLines = stderr.split('\n').filter(Boolean);
        const stderrPreview = stderrLines.slice(-6).join('\n');
        console.log(`[${taskId}] 转录stderr摘要:\n${stderrPreview}`);
        const useful = stderrLines.filter((line) => (
            !/Lightning automatically upgraded|upgrade_checkpoint|pytorch_model\.bin/.test(line)
        ));
        if (useful.length) {
            appendProcessTrace(contentId, `[${nowLabel()}] 转录日志 ${useful.slice(-2).join(' | ')}`);
            await sendProgress(bot, chatId, `🧪 转录引擎日志\n任务: ${taskId}\n${useful.slice(-4).join('\n')}`, config);
        }
    }
    await sendProgress(bot, chatId, `📝 转录完成\n任务: ${taskId}\n内容ID: ${contentId}\n词数: ${words.length}\n转写耗时: ${formatMs(transcribeMs)}\n字符数: ${fullText.length}\n转写文件: ${path.basename(resultJsonPath)}\n正在调用模型生成内容...`, config);

    const contentMode = chatContentModes.get(chatId) || 'default';
    const modeLabel = ARTICLE_MODES[contentMode] ? `${ARTICLE_MODES[contentMode].emoji} ${ARTICLE_MODES[contentMode].name}` : contentMode;
    updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('audio'), stepTitle: `生成文章(${ARTICLE_MODES[contentMode]?.name || contentMode})`, progressPct: 50 });
    const contentStartedAt = Date.now();
    const contentBundle = await generateContentBundle(fullText, config, contentMode);
    tracker.record('contentMs', '生成文案', contentStartedAt, { contentId });
    updateGeneratedContent(contentId, { draftArticle: contentBundle.draftArticle, hookMoment: contentBundle.hookMoment, status: 'reviewing' });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length}`);
    await sendProgress(bot, chatId, `✅ 语音文案阶段完成\n任务: ${taskId}\n内容ID: ${contentId}\n阶段耗时: 下载 ${formatMs(tracker.stageCost.downloadMs || 0)} / 转录 ${formatMs(tracker.stageCost.transcribeMs || 0)} / 文案 ${formatMs(tracker.stageCost.contentMs || 0)}\n\n${contentBundle.draftArticle}\n\n----\n朋友圈诱饵：\n${contentBundle.hookMoment}`, config);
    logger.info('task.audio.text.done', { taskId, contentId, elapsedMs: Date.now() - startedAt, stageCost: tracker.stageCost });
    // 异步生成平台文案（小红书/抖音），并行不阻塞视频渲染
    sendPlatformContent(bot, chatId, fullText, config, logger, taskId).catch(() => {});

    try {
        updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('audio'), stepTitle: '生成视频标题元数据', progressPct: 62 });
        await sendProgress(bot, chatId, '🎬 正在构思视频标题...', config);
        const metadataStartedAt = Date.now();
        const metadata = await generateVideoMetadata(fullText, config);
        tracker.record('metadataMs', '生成视频标题', metadataStartedAt, { contentId });
        appendProcessTrace(contentId, `[${nowLabel()}] 视频元数据 headline=${metadata.headline} subline=${metadata.subline}`);
        const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);

        updateTaskStep(taskId, { stepNo: 6, totalNo: getTaskTotalSteps('audio'), stepTitle: '渲染字幕视频', progressPct: 78 });
        await sendProgress(bot, chatId, '🎞️ 正在渲染视频 (可能需要几十秒)...', config);
        const stem = `content_${contentId}`; 
        const publicAudioPath = copyAudioToPublic(localFilePath, stem);
        const audioSrc = `http://127.0.0.1:${config.adminPort}/public/${publicAudioPath}`;
        const transcribeData = readJsonFileSafe(resultJsonPath, { words: [], segments: [] });
        let captions = applyFillerRemoval(buildRobustCaptions(transcribeData, fullText, videoCaptionOptions), videoCaptionOptions.fillerWords);
        try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[audio] caption correction skipped:', e.message); }
        const { serveUrl } = await prepareBundle();
        const outputDir = path.join(process.cwd(), 'public', 'generated_videos');
        ensureDir(outputDir);
        const videoFileName = `video_${taskId}.mp4`;
        const outputLocation = path.join(outputDir, videoFileName);

        const renderStartedAt = Date.now();
        await renderCaptionVideo({
            serveUrl,
            outputLocation,
            inputProps: {
                audioSrc,
                captions,
                headline: metadata.headline,
                subline: metadata.subline,
                emphasisWords: videoCaptionOptions.emphasisWords,
                emphasisColor: videoCaptionOptions.highlightColor,
                emphasisEnabled: videoCaptionOptions.emphasisEnabled
            }
        });
        tracker.record('renderMs', '渲染字幕视频', renderStartedAt, { contentId });
        
        updateVideoPath(contentId, outputLocation);
        appendProcessTrace(contentId, `[${nowLabel()}] 视频生成完成 file=${videoFileName}`);

        updateTaskStep(taskId, { stepNo: 7, totalNo: getTaskTotalSteps('audio'), stepTitle: '回传视频到 Telegram', progressPct: 92 });
        await sendProgress(bot, chatId, '🚀 正在发送视频...', config);
        const uploadStartedAt = Date.now();
        await sendVideoWithFallback(bot, chatId, outputLocation, `${metadata.headline}\n${metadata.subline}\n\n#Echo #AI`);
        tracker.record('uploadMs', '回传视频', uploadStartedAt, { contentId });
        const totalMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
        appendProcessTrace(contentId, `[${nowLabel()}] 阶段耗时 download=${formatMs(tracker.stageCost.downloadMs || 0)} transcribe=${formatMs(tracker.stageCost.transcribeMs || 0)} content=${formatMs(tracker.stageCost.contentMs || 0)} metadata=${formatMs(tracker.stageCost.metadataMs || 0)} render=${formatMs(tracker.stageCost.renderMs || 0)} upload=${formatMs(tracker.stageCost.uploadMs || 0)} total=${formatMs(totalMs)}`);
        updateTaskStep(taskId, { stepNo: 8, totalNo: getTaskTotalSteps('audio'), stepTitle: '任务完成', progressPct: 100 });
        await sendProgress(bot, chatId, `✅ 语音任务完成\n任务: ${taskId}\n内容ID: ${contentId}\n总耗时: ${formatMs(totalMs)}\n阶段耗时: 下载 ${formatMs(tracker.stageCost.downloadMs || 0)} / 转录 ${formatMs(tracker.stageCost.transcribeMs || 0)} / 文案 ${formatMs(tracker.stageCost.contentMs || 0)} / 标题 ${formatMs(tracker.stageCost.metadataMs || 0)} / 渲染 ${formatMs(tracker.stageCost.renderMs || 0)} / 回传 ${formatMs(tracker.stageCost.uploadMs || 0)}`, config);
        logger.info('task.audio.video.done', { taskId, contentId, outputLocation, headline: metadata.headline, subline: metadata.subline, stageCost: tracker.stageCost, elapsedMs: totalMs });

    } catch (err) {
        tracker.record('totalMs', '任务总耗时', startedAt, { contentId, status: 'failed' });
        console.error('Video generation failed in bot flow:', err);
        await sendProgress(bot, chatId, `⚠️ 视频生成失败: ${err.message}`, config);
        appendProcessTrace(contentId, `[${nowLabel()}] 视频生成失败 ${err.message}`);
        logger.error('task.audio.video.failed', { taskId, contentId, message: err.message, stack: String(err.stack || '').slice(0, 1000) });
    }
}

async function handleImageMessage(bot, msg, config, imageDir, taskMeta = {}) {
    const taskId = taskMeta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'image');
    const chatId = msg.chat.id;
    const imageContent = getImagePayload(msg);
    if (!imageContent) throw new Error('未找到图片消息数据');
    const fileLink = await runWithBotNetworkRetry(() => bot.getFileLink(imageContent.file_id), config, 'image_get_file_link');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = resolveMediaExt('photo', imageContent);
    const localImagePath = path.join(imageDir, `echo_image_${timestamp}${ext}`);
    const imageText = String(msg.caption || '').trim();
    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('image'), stepTitle: '接收图片任务', progressPct: 12 });
    await sendProgress(bot, chatId, `📥 已接收图片任务\n任务: ${taskId}\n会话: ${buildSessionLabel(msg)}\n正在下载图片...`, config);

    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('image'), stepTitle: '下载图片文件', progressPct: 36 });
    const downloadStartedAt = Date.now();
    await downloadAudio(fileLink, localImagePath);
    tracker.record('downloadMs', '下载图片', downloadStartedAt);
    const fileStats = fs.statSync(localImagePath);
    const contentId = createContent({
        audioPath: localImagePath,
        rawText: imageText || '[图片任务]',
        status: 'pending',
        processTrace: `[${nowLabel()}] 图片任务创建 task=${taskId}\n[${nowLabel()}] 图片下载完成 file=${path.basename(localImagePath)} size=${fileStats.size}`
    });

    // 若无 caption，用本地视觉模型分析图片（OCR + 画面描述）
    let ocrText = '';
    if (!imageText) {
        updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('image'), stepTitle: '视觉模型分析图片', progressPct: 55 });
        const ocrStartedAt = Date.now();
        try {
            ocrText = await analyzeImage(localImagePath, config);
            tracker.record('ocrMs', '图片分析', ocrStartedAt, { contentId });
            appendProcessTrace(contentId, `[${nowLabel()}] 图片分析完成 chars=${ocrText.length}`);
        } catch (ocrErr) {
            logger.warn('task.image.ocr.failed', { taskId, message: ocrErr.message });
            tracker.recordFixed('ocrMs', '图片分析', 0, { contentId, status: 'failed' });
        }
    }

    const effectiveText = imageText || ocrText;
    let contentBundle = { draftArticle: '', hookMoment: '' };
    if (effectiveText) {
        updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('image'), stepTitle: '基于图片内容生成文案', progressPct: 78 });
        const contentStartedAt = Date.now();
        contentBundle = await generateContentBundle(effectiveText, config);
        tracker.record('contentMs', '图片文案生成', contentStartedAt, { contentId });
        updateGeneratedContent(contentId, { rawText: effectiveText, draftArticle: contentBundle.draftArticle, hookMoment: contentBundle.hookMoment, status: 'reviewing' });
    } else {
        tracker.recordFixed('contentMs', '图片文案生成', 0, { contentId, status: 'skipped' });
        updateGeneratedContent(contentId, { draftArticle: '', hookMoment: '', status: 'reviewing' });
    }

    updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('image'), stepTitle: '写入内容并完成回传', progressPct: 100 });
    const totalMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
    const body = effectiveText
        ? `${ocrText && !imageText ? `📷 图片识别：\n${ocrText.slice(0, 120)}${ocrText.length > 120 ? '...' : ''}\n\n` : ''}${contentBundle.draftArticle}\n\n----\n朋友圈诱饵：\n${contentBundle.hookMoment}`
        : '图片内容无法识别，已完成归档。可添加说明文字后重新发送。';
    await sendProgress(
        bot,
        chatId,
        `✅ 图片任务完成\n任务: ${taskId}\n内容ID: ${contentId}\n总耗时: ${formatMs(totalMs)}\n阶段耗时: 下载 ${formatMs(tracker.stageCost.downloadMs || 0)} / 文案 ${formatMs(tracker.stageCost.contentMs || 0)}\n图片文件: ${path.basename(localImagePath)}\n\n${body}`,
        config
    );
    logger.info('task.image.done', {
        taskId,
        contentId,
        localImagePath,
        hasCaptionText: Boolean(imageText),
        stageCost: tracker.stageCost,
        elapsedMs: totalMs
    });
}

async function handleVideoMessage(bot, msg, config, videoDir, taskMeta = {}) {
    const taskId = taskMeta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'video');
    const stageCost = tracker.stageCost;
    const markStageCost = (key, title, beginAt, options = {}) => tracker.record(key, title, beginAt, options);
    const chatId = msg.chat.id;
    const sourceType = detectMessageType(msg);
    const videoContent = getVideoPayload(msg);
    if (!videoContent) throw new Error('未找到视频消息数据');

    // Parse caption: short caption (≤60 chars, line1 ≤20 chars) → use as manual title override
    const captionTitle = parseCaptionAsTitle(msg.caption);
    const manualTitleOverride = taskMeta.titleOverride || captionTitle || null;

    const fileLink = await runWithBotNetworkRetry(() => bot.getFileLink(videoContent.file_id), config, 'video_get_file_link');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = resolveMediaExt(sourceType, videoContent);
    const localVideoPath = path.join(videoDir, `echo_video_${timestamp}${ext}`);
    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('video'), stepTitle: '接收视频任务', progressPct: 8 });
    logger.info('task.video.received', { taskId, chatId, session: buildSessionLabel(msg), localVideoPath, inputExt: ext });

    // Single editable status message — updated throughout the pipeline
    const statusMsgId = await sendStatusMessage(bot, chatId, `📥 下载中... | 任务 ${taskId}`);

    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('video'), stepTitle: '下载视频文件', progressPct: 16 });
    const downloadStartedAt = Date.now();
    await downloadAudio(fileLink, localVideoPath);
    markStageCost('downloadMs', '下载视频', downloadStartedAt);
    const fileStats = fs.statSync(localVideoPath);
    logger.info('task.video.downloaded', { taskId, fileSize: fileStats.size, localVideoPath });
    await editStatusMessage(bot, chatId, statusMsgId,
        `🛰️ 下载完成 (${(fileStats.size / 1024 / 1024).toFixed(1)}MB) | 转写中... | 任务 ${taskId}`);

    let extractedAudioPath = '';
    let words = [];
    let fullText = '';
    let resultJsonPath = '';
    let stderr = '';
    let transcribeMs = 0;
    const fallbackText = String(msg.caption || '').trim();
    const transcribeStartedAt = Date.now();
    try {
        updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('video'), stepTitle: '提取音轨并转录', progressPct: 32 });
        extractedAudioPath = await extractAudioFromVideo(localVideoPath, `video_${taskId}`);
        const transcribeResult = await transcribeAudio(extractedAudioPath, config);
        words = transcribeResult.words;
        fullText = stripHallucinatedLoop(transcribeResult.fullText || '');
        resultJsonPath = transcribeResult.resultJsonPath;
        stderr = transcribeResult.stderr;
        transcribeMs = transcribeResult.transcribeMs;
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt);
    } catch (audioError) {
        fullText = fallbackText;
        stderr = `[transcribe_fallback] ${audioError.message}`;
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt, { status: 'failed' });
        await sendProgress(
            bot,
            chatId,
            `⚠️ 该视频音轨不可用，已回退为字幕/文案模式\n任务: ${taskId}\n原因: ${audioError.message}`,
            config
        );
    }
    if (!fullText) throw new Error('视频无可用语音且未提供文字描述，请附带字幕或文案后重试');
    logger.info('task.video.transcribed', {
        taskId,
        extractedAudioPath,
        words: words.length,
        textLength: fullText.length,
        transcribeMs,
        resultJsonPath
    });
    await editStatusMessage(bot, chatId, statusMsgId,
        `🎙️ 转写完成 (${words.length}词, ${(transcribeMs / 1000).toFixed(0)}s) | 生成内容中... | 任务 ${taskId}`);

    const contentId = createContent({
        audioPath: extractedAudioPath || localVideoPath,
        transcribeJsonPath: resultJsonPath,
        rawText: fullText,
        status: 'pending',
        processTrace: `[${nowLabel()}] 视频任务创建 task=${taskId}\n[${nowLabel()}] 视频下载完成 file=${path.basename(localVideoPath)} size=${fileStats.size}${extractedAudioPath ? `\n[${nowLabel()}] 提取音频 file=${path.basename(extractedAudioPath)}` : '\n[音轨] 未提取成功，进入文案兜底'}`
    });

    appendProcessTrace(contentId, `[${nowLabel()}] 视频转录完成 words=${words.length} ms=${transcribeMs}${resultJsonPath ? ` json=${path.basename(resultJsonPath)}` : ''}`);
    if (stderr) {
        const useful = stderr.split('\n').filter(Boolean).filter((line) => (
            !/Lightning automatically upgraded|upgrade_checkpoint|pytorch_model\.bin/.test(line)
        ));
        if (useful.length) {
            appendProcessTrace(contentId, `[${nowLabel()}] 转录日志 ${useful.slice(-2).join(' | ')}`);
        }
    }

    // (legacy progress removed — using editable status message above)

    const isVideoNote = Boolean(msg?.video_note || sourceType === 'video_note');
    const videoContentMode = String(config.videoContentMode || 'fast').trim().toLowerCase() === 'full' ? 'full' : 'fast';
    const contentMode = chatContentModes.get(chatId) || 'default';
    let contentBundle = { draftArticle: '', hookMoment: '' };
    let metadata = { headline: '', subline: '' };
    updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('video'), stepTitle: videoContentMode === 'fast' ? '快速并行生成文案与标题' : '并行生成文案与标题', progressPct: 52 });
    const contentStartedAt = Date.now();
    const metadataStartedAt = Date.now();
    const [bundleResult, metadataResult] = await Promise.all([
        generateContentBundle(fullText, config, contentMode),
        manualTitleOverride ? Promise.resolve({ headline: manualTitleOverride.headline || '', subline: manualTitleOverride.subline || '' }) : generateVideoMetadata(fullText, config)
    ]);
    contentBundle = bundleResult;
    metadata = metadataResult;
    // Fill missing subline from AI if manual headline was provided without subline
    if (manualTitleOverride && !manualTitleOverride.subline && metadata.subline) {
        metadata = { headline: manualTitleOverride.headline, subline: metadataResult.subline || metadata.subline };
    }
    markStageCost('contentMs', '生成文案', contentStartedAt, { contentId });
    markStageCost('metadataMs', '生成标题', metadataStartedAt, { contentId });
    updateGeneratedContent(contentId, {
        draftArticle: contentBundle.draftArticle,
        hookMoment: contentBundle.hookMoment,
        status: 'reviewing'
    });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length} mode=${videoContentMode}`);
    await sendProgress(
        bot,
        chatId,
        `✍️ 文案已生成，视频仍在处理中\n任务: ${taskId}\n内容ID: ${contentId}\n主标题: ${metadata.headline}\n副标题: ${metadata.subline}\n\n${clipText(contentBundle.draftArticle, 220)}${contentBundle.hookMoment ? `\n\n----\n朋友圈诱饵：\n${clipText(contentBundle.hookMoment, 120)}` : ''}`,
        config
    );
    updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('video'), stepTitle: '标题元数据已就绪', progressPct: 64 });
    appendProcessTrace(contentId, `[${nowLabel()}] 视频元数据 headline=${metadata.headline} subline=${metadata.subline}`);
    await editStatusMessage(bot, chatId, statusMsgId,
        `🤖 内容已生成 | 标题: ${metadata.headline} | 🎞️ 烧录中... | 任务 ${taskId}`);
    const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);
    // Auto-detect orientation to apply orientation-appropriate sentence length
    const { width: probeW, height: probeH } = probeVideoSize(localVideoPath);
    const probeAspect = probeW > 0 && probeH > 0 ? probeW / probeH : 1;
    const isVerticalVideo = probeAspect > 0 && probeAspect < 0.8;
    const tunedVideoCaptionOptions = isVideoNote
        ? {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 14, 12),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 26, 12),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 4.2, 2.6)
        }
        : isVerticalVideo
        ? {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 12),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 18, 12),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 2.4)
        }
        : {
            // Landscape: allow longer sentences (more horizontal space)
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 16),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 20, 20),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 3.0)
        };
    updateTaskStep(taskId, { stepNo: 6, totalNo: getTaskTotalSteps('video'), stepTitle: '字幕切分与视频烧录', progressPct: 82 });
    const transcribeData = resultJsonPath
        ? readJsonFileSafe(resultJsonPath, {
            words: [],
            segments: [{
                start: 0,
                end: Math.max(4, Number(videoContent.duration || 0) || 4),
                text: fullText
            }]
        })
        : {
            words: [],
            segments: [{
                start: 0,
                end: Math.max(4, Number(videoContent.duration || 0) || 4),
                text: fullText
            }]
        };
    let captions = applyFillerRemoval(buildRobustCaptions(transcribeData, fullText, tunedVideoCaptionOptions), tunedVideoCaptionOptions.fillerWords);
    try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[video] caption correction skipped:', e.message); }
    if (!captions.length) throw new Error('未生成可用字幕片段');

    const outputDir = path.join(process.cwd(), 'public', 'generated_videos');
    ensureDir(outputDir);
    const outputLocation = path.join(outputDir, `video_${taskId}.mp4`);
    const renderStartedAt = Date.now();
    // Throttled encode progress → edits status message at most once per 4s
    let encodeLastEditMs = 0;
    const onEncodeProgress = async (pct) => {
        const now = Date.now();
        if (now - encodeLastEditMs < 4000 && pct < 100) return;
        encodeLastEditMs = now;
        await editStatusMessage(bot, chatId, statusMsgId,
            `🎞️ 烧录中 ${renderProgressBar(pct)} | 标题: ${metadata.headline} | 任务 ${taskId}`);
    };
    await burnSubtitleVideo({
        inputVideoPath: localVideoPath,
        outputVideoPath: outputLocation,
        captions,
        headline: metadata.headline,
        subline: metadata.subline,
        styleOptions: {
            ...tunedVideoCaptionOptions,
            sourceType,
            isVideoNoteLike: Boolean(msg?.video_note || sourceType === 'video_note')
        },
        onProgress: onEncodeProgress
    });
    markStageCost('renderMs', '字幕切分与视频烧录', renderStartedAt, { contentId });

    updateVideoPath(contentId, outputLocation);
    appendProcessTrace(contentId, `[${nowLabel()}] 视频生成完成 output=${path.basename(outputLocation)}`);
    updateTaskStep(taskId, { stepNo: 7, totalNo: getTaskTotalSteps('video'), stepTitle: '回传视频并完成任务', progressPct: 100 });
    await editStatusMessage(bot, chatId, statusMsgId,
        `✅ 烧录完成 | 🚀 回传中... | 任务 ${taskId}`);
    const uploadStartedAt = Date.now();
    await sendVideoWithFallback(bot, chatId, outputLocation, `${metadata.headline}\n${metadata.subline}\n\n#Echo #AI`);
    markStageCost('uploadMs', '回传视频', uploadStartedAt, { contentId });
    const elapsedMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
    appendProcessTrace(contentId, `[${nowLabel()}] 阶段耗时 download=${formatMs(stageCost.downloadMs || 0)} transcribe=${formatMs(stageCost.transcribeMs || 0)} content=${formatMs(stageCost.contentMs || 0)} metadata=${formatMs(stageCost.metadataMs || 0)} render=${formatMs(stageCost.renderMs || 0)} upload=${formatMs(stageCost.uploadMs || 0)} total=${formatMs(stageCost.totalMs || 0)} mode=${videoContentMode}`);
    logger.info('task.video.done', {
        taskId,
        contentId,
        outputLocation,
        headline: metadata.headline,
        subline: metadata.subline,
        elapsedMs,
        videoContentMode,
        stageCost
    });
    // Update final status message with completion summary
    await editStatusMessage(bot, chatId, statusMsgId,
        `✅ 完成！总耗时 ${formatMs(elapsedMs)}\n下载 ${formatMs(stageCost.downloadMs || 0)} | 转写 ${formatMs(stageCost.transcribeMs || 0)} | 文案 ${formatMs(stageCost.contentMs || 0)} | 烧录 ${formatMs(stageCost.renderMs || 0)} | 回传 ${formatMs(stageCost.uploadMs || 0)}`);

    // Send publish kit (4 groups of title + description + hashtags)
    if (fullText) {
        try {
            const publishGroups = await generatePublishKit(fullText, metadata.headline, config);
            if (publishGroups.length > 0) {
                const publishText = formatPublishGroups(publishGroups, metadata.headline);
                await sendProgress(bot, chatId, publishText, config);
            }
        } catch (pubErr) {
            logger.warn('task.video.publish_kit_failed', { taskId, message: String(pubErr.message || '').slice(0, 120) });
        }
    }

    // Send hook moments for WeChat moments if available
    if (contentBundle.hookMoment) {
        await sendProgress(bot, chatId, `💬 朋友圈文案：\n${clipText(contentBundle.hookMoment, 400)}`, config);
    }

    // 生成平台文案（小红书/抖音）
    if (fullText) {
        await sendPlatformContent(bot, chatId, fullText, config, logger, taskId);
    }

    // Cleanup temp extracted audio
    if (extractedAudioPath && extractedAudioPath.includes('tmp') && fs.existsSync(extractedAudioPath)) {
        try { fs.unlinkSync(extractedAudioPath); } catch (_) {}
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Admin 直传处理（绕过 Telegram，文件已在本地磁盘）
// ────────────────────────────────────────────────────────────────────────────

async function handleAdminAudioUpload(filePath, meta, config) {
    const taskId = meta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'audio');
    const ext = path.extname(filePath).toLowerCase();

    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('audio'), stepTitle: '接收音频任务', progressPct: 8 });
    logger.info('task.admin_audio.received', { taskId, filePath, ext });

    const fileStats = fs.statSync(filePath);
    logger.info('task.admin_audio.file_ready', { taskId, fileSize: fileStats.size, filePath });

    updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('audio'), stepTitle: '语音转录中', progressPct: 28 });
    const transcribeStartedAt = Date.now();
    const { words, fullText: rawFullTextAudio, resultJsonPath, stderr, transcribeMs } = await transcribeAudio(filePath, config);
    const fullText = stripHallucinatedLoop(rawFullTextAudio || '');
    tracker.record('transcribeWallMs', '转录总耗时', transcribeStartedAt);
    tracker.recordFixed('transcribeMs', '转录引擎耗时', transcribeMs);
    if (!fullText) throw new Error('转录结果为空');

    logger.info('task.admin_audio.transcribed', { taskId, words: words.length, textLength: fullText.length, transcribeMs, resultJsonPath });
    const contentId = createContent({
        audioPath: filePath,
        transcribeJsonPath: resultJsonPath,
        rawText: fullText,
        status: 'pending',
        processTrace: `[${nowLabel()}] Admin上传音频任务 task=${taskId}\n[${nowLabel()}] 文件已就绪 file=${path.basename(filePath)} size=${fileStats.size}`
    });
    appendProcessTrace(contentId, `[${nowLabel()}] 转录完成 words=${words.length} ms=${transcribeMs} json=${path.basename(resultJsonPath || '')}`);

    updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('audio'), stepTitle: `生成文章(${meta.mode || 'default'})`, progressPct: 48 });
    const contentStartedAt = Date.now();
    const contentBundle = await generateContentBundle(fullText, config, meta.mode || 'default');
    tracker.record('contentMs', '生成文案', contentStartedAt, { contentId });
    updateGeneratedContent(contentId, { draftArticle: contentBundle.draftArticle, hookMoment: contentBundle.hookMoment, status: 'reviewing' });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length}`);
    logger.info('task.admin_audio.text.done', { taskId, contentId, stageCost: tracker.stageCost });

    try {
        updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('audio'), stepTitle: '生成视频标题元数据', progressPct: 60 });
        const metadataStartedAt = Date.now();
        const metaOverride = meta.headline ? { headline: meta.headline, subline: meta.subline || '' } : null;
        const metadata = metaOverride || await generateVideoMetadata(fullText, config);
        tracker.record('metadataMs', '生成视频标题', metadataStartedAt, { contentId });
        appendProcessTrace(contentId, `[${nowLabel()}] 视频元数据 headline=${metadata.headline} subline=${metadata.subline}`);
        const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);

        updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('audio'), stepTitle: '渲染字幕视频', progressPct: 76 });
        const stem = `content_${contentId}`;
        const publicAudioPath = copyAudioToPublic(filePath, stem);
        const audioSrc = `http://127.0.0.1:${config.adminPort}/public/${publicAudioPath}`;
        const transcribeData = readJsonFileSafe(resultJsonPath, { words: [], segments: [] });
        let captions = applyFillerRemoval(buildRobustCaptions(transcribeData, fullText, videoCaptionOptions), videoCaptionOptions.fillerWords);
        try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[admin_audio] caption correction skipped:', e.message); }
        const { serveUrl } = await prepareBundle();
        const outputDir = path.join(process.cwd(), 'public', 'generated_videos');
        ensureDir(outputDir);
        const videoFileName = `video_${taskId}.mp4`;
        const outputLocation = path.join(outputDir, videoFileName);

        const renderStartedAt = Date.now();
        await renderCaptionVideo({
            serveUrl,
            outputLocation,
            inputProps: {
                audioSrc,
                captions,
                headline: metadata.headline,
                subline: metadata.subline,
                emphasisWords: videoCaptionOptions.emphasisWords,
                emphasisColor: videoCaptionOptions.highlightColor,
                emphasisEnabled: videoCaptionOptions.emphasisEnabled
            }
        });
        tracker.record('renderMs', '渲染字幕视频', renderStartedAt, { contentId });

        updateVideoPath(contentId, outputLocation);
        appendProcessTrace(contentId, `[${nowLabel()}] 视频生成完成 file=${videoFileName}`);
        updateTaskStep(taskId, { stepNo: 6, totalNo: getTaskTotalSteps('audio'), stepTitle: '任务完成', progressPct: 100 });
        const totalMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
        logger.info('task.admin_audio.video.done', { taskId, contentId, outputLocation, stageCost: tracker.stageCost, elapsedMs: totalMs });
    } catch (err) {
        tracker.record('totalMs', '任务总耗时', startedAt, { contentId, status: 'failed' });
        appendProcessTrace(contentId, `[${nowLabel()}] 视频生成失败 ${err.message}`);
        logger.error('task.admin_audio.video.failed', { taskId, contentId, message: err.message });
        throw err;
    }
    return { taskId, contentId };
}

async function handleAdminVideoUpload(filePath, meta, config) {
    const taskId = meta.taskId || getTaskId();
    const startedAt = Date.now();
    const tracker = createStageTracker(taskId, 'video');
    const stageCost = tracker.stageCost;
    const markStageCost = (key, title, beginAt, options = {}) => tracker.record(key, title, beginAt, options);

    updateTaskStep(taskId, { stepNo: 1, totalNo: getTaskTotalSteps('video'), stepTitle: '接收视频任务', progressPct: 8 });
    logger.info('task.admin_video.received', { taskId, filePath });

    const fileStats = fs.statSync(filePath);
    logger.info('task.admin_video.file_ready', { taskId, fileSize: fileStats.size, filePath });

    let extractedAudioPath = '';
    let words = [];
    let fullText = '';
    let resultJsonPath = '';
    let stderr = '';
    let transcribeMs = 0;
    const transcribeStartedAt = Date.now();
    try {
        updateTaskStep(taskId, { stepNo: 2, totalNo: getTaskTotalSteps('video'), stepTitle: '提取音轨并转录', progressPct: 28 });
        extractedAudioPath = await extractAudioFromVideo(filePath, `admin_video_${taskId}`);
        const transcribeResult = await transcribeAudio(extractedAudioPath, config);
        words = transcribeResult.words;
        fullText = stripHallucinatedLoop(transcribeResult.fullText || '');
        resultJsonPath = transcribeResult.resultJsonPath;
        stderr = transcribeResult.stderr;
        transcribeMs = transcribeResult.transcribeMs;
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt);
    } catch (audioError) {
        fullText = meta.fallbackText || '';
        stderr = `[transcribe_fallback] ${audioError.message}`;
        markStageCost('transcribeMs', '提取音轨并转录', transcribeStartedAt, { status: 'failed' });
        logger.warn('task.admin_video.transcribe_fallback', { taskId, message: audioError.message });
    }
    if (!fullText) throw new Error('视频无可用语音且未提供文字描述');
    logger.info('task.admin_video.transcribed', { taskId, extractedAudioPath, words: words.length, textLength: fullText.length, transcribeMs, resultJsonPath });

    const contentId = createContent({
        audioPath: extractedAudioPath || filePath,
        transcribeJsonPath: resultJsonPath,
        rawText: fullText,
        status: 'pending',
        processTrace: `[${nowLabel()}] Admin上传视频任务 task=${taskId}\n[${nowLabel()}] 文件已就绪 file=${path.basename(filePath)} size=${fileStats.size}${extractedAudioPath ? `\n[${nowLabel()}] 提取音频 file=${path.basename(extractedAudioPath)}` : '\n[音轨] 未提取成功，进入文案兜底'}`
    });
    appendProcessTrace(contentId, `[${nowLabel()}] 视频转录完成 words=${words.length} ms=${transcribeMs}${resultJsonPath ? ` json=${path.basename(resultJsonPath)}` : ''}`);

    const contentMode = meta.mode || 'default';
    updateTaskStep(taskId, { stepNo: 3, totalNo: getTaskTotalSteps('video'), stepTitle: '并行生成文案与标题', progressPct: 48 });
    const contentStartedAt = Date.now();
    const metadataStartedAt = Date.now();
    const manualTitleOverride = meta.headline ? { headline: meta.headline, subline: meta.subline || '' } : null;
    const [contentBundle, metadata] = await Promise.all([
        generateContentBundle(fullText, config, contentMode),
        manualTitleOverride ? Promise.resolve(manualTitleOverride) : generateVideoMetadata(fullText, config)
    ]);
    markStageCost('contentMs', '生成文案', contentStartedAt, { contentId });
    markStageCost('metadataMs', '生成标题', metadataStartedAt, { contentId });
    updateGeneratedContent(contentId, { draftArticle: contentBundle.draftArticle, hookMoment: contentBundle.hookMoment, status: 'reviewing' });
    appendProcessTrace(contentId, `[${nowLabel()}] 内容生成完成 draft=${contentBundle.draftArticle.length} hook=${contentBundle.hookMoment.length}`);
    appendProcessTrace(contentId, `[${nowLabel()}] 视频元数据 headline=${metadata.headline} subline=${metadata.subline}`);

    const videoCaptionOptions = getVideoCaptionOptions(getConfigValue);
    const { width: probeW, height: probeH } = probeVideoSize(filePath);
    const probeAspect = probeW > 0 && probeH > 0 ? probeW / probeH : 1;
    const isVerticalVideo = probeAspect > 0 && probeAspect < 0.8;
    const sourceType = isVerticalVideo ? 'vertical' : 'landscape';
    const tunedVideoCaptionOptions = isVerticalVideo
        ? {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 12),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 18, 12),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 2.4)
        }
        : {
            ...videoCaptionOptions,
            chunkMaxChars: Math.min(videoCaptionOptions.chunkMaxChars || 16, 16),
            sentenceMaxChars: Math.min(videoCaptionOptions.sentenceMaxChars || 20, 20),
            sentenceMaxDuration: Math.min(videoCaptionOptions.sentenceMaxDuration || 2.8, 3.0)
        };

    updateTaskStep(taskId, { stepNo: 4, totalNo: getTaskTotalSteps('video'), stepTitle: '字幕切分与视频烧录', progressPct: 68 });
    const transcribeData = resultJsonPath
        ? readJsonFileSafe(resultJsonPath, { words: [], segments: [{ start: 0, end: 60, text: fullText }] })
        : { words: [], segments: [{ start: 0, end: 60, text: fullText }] };
    let captions = applyFillerRemoval(buildRobustCaptions(transcribeData, fullText, tunedVideoCaptionOptions), tunedVideoCaptionOptions.fillerWords);
    try { captions = await correctCaptions(captions, config); } catch (e) { console.error('[admin_video] caption correction skipped:', e.message); }
    if (!captions.length) throw new Error('未生成可用字幕片段');

    const outputDir = path.join(process.cwd(), 'public', 'generated_videos');
    ensureDir(outputDir);
    const outputLocation = path.join(outputDir, `video_${taskId}.mp4`);
    const renderStartedAt = Date.now();
    await burnSubtitleVideo({
        inputVideoPath: filePath,
        outputVideoPath: outputLocation,
        captions,
        headline: metadata.headline,
        subline: metadata.subline,
        styleOptions: {
            ...tunedVideoCaptionOptions,
            sourceType,
            isVideoNoteLike: false
        },
        onProgress: null
    });
    markStageCost('renderMs', '字幕切分与视频烧录', renderStartedAt, { contentId });

    updateVideoPath(contentId, outputLocation);
    appendProcessTrace(contentId, `[${nowLabel()}] 视频生成完成 output=${path.basename(outputLocation)}`);
    updateTaskStep(taskId, { stepNo: 5, totalNo: getTaskTotalSteps('video'), stepTitle: '任务完成', progressPct: 100 });
    const elapsedMs = tracker.record('totalMs', '任务总耗时', startedAt, { contentId });
    appendProcessTrace(contentId, `[${nowLabel()}] 阶段耗时 transcribe=${formatMs(stageCost.transcribeMs || 0)} content=${formatMs(stageCost.contentMs || 0)} render=${formatMs(stageCost.renderMs || 0)} total=${formatMs(elapsedMs)}`);
    logger.info('task.admin_video.done', { taskId, contentId, outputLocation, headline: metadata.headline, subline: metadata.subline, elapsedMs, stageCost });

    // Cleanup temp extracted audio
    if (extractedAudioPath && extractedAudioPath.includes('tmp') && fs.existsSync(extractedAudioPath)) {
        try { fs.unlinkSync(extractedAudioPath); } catch (_) {}
    }
    return { taskId, contentId };
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);

function enqueueAdminUpload(filePath, meta = {}) {
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = VIDEO_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);
    if (!isVideo && !isAudio) throw new Error(`不支持的文件格式: ${ext}`);
    const taskType = isVideo ? 'video' : 'audio';
    const taskId = meta.taskId || getTaskId();
    const session = `admin_upload#${path.basename(filePath)}`;

    registerTaskForDashboard({ taskId, chatId: 'admin', session, taskType, queueNo: 0 });

    const config = getConfig();
    enqueueTask({
        taskId,
        run: async () => {
            if (isVideo) {
                return handleAdminVideoUpload(filePath, { ...meta, taskId }, config);
            }
            return handleAdminAudioUpload(filePath, { ...meta, taskId }, config);
        }
    }).catch((error) => {
        logger.error('admin_upload.task.failed', { taskId, message: error.message });
    });

    return { taskId };
}

async function startBot() {
    const config = getConfig();
    setQueueConcurrency(config.taskQueueConcurrency);
    initDb(config.contentDbPath);
    ensureDefaultConfigs();
    installShutdownHooks();
    startAdminServer(config, { enqueueAdminUpload });
    const bot = createBot(config);
    const audioDir = ensureAudioDir();
    const videoDir = ensureVideoDir();
    const imageDir = ensureImageDir();
    const incomingDir = ensureIncomingDir();
    let pollingRecovering = false;
    let pollingRecoverCount = 0;

    console.log(`🚀 echocut 已启动，模型: ${config.ollamaModel}`);
    logger.info('bot.start', {
        model: config.ollamaModel,
        queueConcurrency: getQueueStatus().concurrency,
        videoContentMode: config.videoContentMode,
        adminPort: config.adminPort,
        proxyUrl: config.proxyUrl || '',
        logFilePath: logger.logFilePath
    });
    startDashboardLoop(bot, config);

    // 清理超过 2 小时仍在 pending 且无活跃 checkpoint 的内容（服务意外中断遗留）
    try {
        const db = initDb(config.contentDbPath);
        const stale = db.prepare(`
            UPDATE contents SET status='reviewing',
                process_trace=COALESCE(process_trace,'') || char(10) || '[stale] 任务未能完成，服务重启后自动标记为可查看状态'
            WHERE status='pending'
            AND created_at < datetime('now','-2 hours')
            AND NOT EXISTS (
                SELECT 1 FROM task_checkpoints tc WHERE tc.status IN ('queued','running','interrupted')
            )
        `).run();
        if (stale.changes > 0) {
            logger.info('startup.stale_pending_cleared', { count: stale.changes });
            console.log(`🧹 已清理 ${stale.changes} 个滞留 pending 内容`);
        }
    } catch (sweepErr) {
        logger.warn('startup.stale_sweep.failed', { message: sweepErr.message });
    }

    const recoveredCount = await recoverInterruptedTasks(bot, config, audioDir, videoDir, imageDir);
    if (recoveredCount > 0) {
        logger.info('queue.recovery.summary', { recoveredCount });
        console.log(`♻️ 已恢复 ${recoveredCount} 个中断任务`);
    }

    bot.on('error', (error) => {
        const message = String(error?.message || '');
        logger.error('bot.runtime.error', { message, stack: String(error?.stack || '').slice(0, 1000) });
        console.error('[bot_error]', message);
    });
    bot.on('webhook_error', (error) => {
        const message = String(error?.message || '');
        logger.warn('bot.webhook.error', { message });
        console.error('[webhook_error]', message);
    });

    bot.on('polling_error', async (error) => {
        const code = String(error?.code || '');
        const statusCode = Number(error?.response?.statusCode || error?.response?.status || error?.response?.body?.error_code || 0);
        const message = String(error?.message || '');
        console.error('[polling_error]', code, statusCode, message);
        logger.warn('bot.polling.error', { code, statusCode, message });
        if (pollingRecovering) return;
        const isNetworkError = (
            code === 'EFATAL'
            || code === 'ETIMEDOUT'
            || code === 'ECONNRESET'
            || statusCode === 429
            || statusCode >= 500
            || /ETELEGRAM/i.test(code)
            || /TLS|socket disconnected|network/i.test(message)
        );
        if (!isNetworkError) return;
        pollingRecovering = true;
        pollingRecoverCount += 1;
        const waitMs = Math.min(30000, 1200 * (2 ** Math.min(pollingRecoverCount - 1, 5))) + Math.floor(Math.random() * 600);
        try {
            await delay(waitMs);
            if (typeof bot.isPolling === 'function' && bot.isPolling()) {
                await bot.stopPolling({ cancel: false });
            }
            await bot.startPolling();
            pollingRecoverCount = 0;
            console.log(`♻️ Telegram 轮询已自动恢复 wait=${waitMs}ms`);
            logger.info('bot.polling.recovered', { waitMs });
        } catch (recoverError) {
            console.error('轮询恢复失败:', recoverError.message);
            logger.error('bot.polling.recover_failed', { waitMs, recoverCount: pollingRecoverCount, message: recoverError.message });
        } finally {
            pollingRecovering = false;
        }
    });

    bot.on('callback_query', async (query) => {
        try {
            if (!query.data || !query.message?.chat?.id) return;
            const chatId = query.message.chat.id;

            if (query.data.startsWith('mode_')) {
                const modeKey = query.data.replace('mode_', '');
                const modeConfig = ARTICLE_MODES[modeKey];
                if (modeConfig) {
                    chatContentModes.set(chatId, modeKey);
                    await bot.answerCallbackQuery(query.id, { text: `已切换: ${modeConfig.name}` });
                    await bot.sendMessage(chatId, `✅ 内容模式已切换为: ${modeConfig.emoji} ${modeConfig.name}\n\n后续发送的文本/语音/视频将使用此模式生成内容。\n发送 /mode 可随时切换。`);
                } else {
                    await bot.answerCallbackQuery(query.id, { text: '未知模式' });
                }
            }
        } catch (err) {
            logger.error('bot.callback_query.error', { message: err.message });
        }
    });

    const onIncomingMessage = async (msg, { allowAiTask = true, source = 'message' } = {}) => {
        try {
            if (!msg?.chat?.id || msg.from?.is_bot) return;
            const archiveResult = await archiveIncomingMessage(bot, msg, incomingDir);
            logger.info('bot.message.received', { ...summarizeMessage(msg), ...archiveResult, source });
            if (msg.text === '/start') {
                await sendProgress(bot, msg.chat.id, '✅ Echo 已就绪。支持文本、图片、语音、音频、视频输入。\n\n命令：\n/mode - 切换内容生成模式\n/health - 查看引擎状态\n/stages 任务ID - 查看阶段耗时', config);
                logger.info('bot.command.start', summarizeMessage(msg));
                return;
            }
            if (msg.text === '/health') {
                const { waiting, running, concurrency } = getQueueStatus();
                const currentMode = chatContentModes.get(msg.chat.id) || 'default';
                const modeLabel = ARTICLE_MODES[currentMode] ? `${ARTICLE_MODES[currentMode].emoji} ${ARTICLE_MODES[currentMode].name}` : currentMode;
                await sendProgress(
                    bot,
                    msg.chat.id,
                    `✅ 引擎在线\n模型: ${config.ollamaModel}\n内容模式: ${modeLabel}\n思考模式: ${config.ollamaThink ? '开启' : '关闭'}\n代理: ${config.proxyUrl || '未启用'}\n队列: 运行中 ${running} / 等待 ${waiting} / 并发 ${concurrency}\n视频模式: ${config.videoContentMode}\n超时: ${(config.ollamaTimeoutMs / 1000).toFixed(0)}s\n重试: ${config.ollamaRetries}\nBot网络重试: ${config.botNetworkRetries}`,
                    config
                );
                logger.info('bot.command.health', { ...summarizeMessage(msg), waiting, running });
                return;
            }
            if (typeof msg.text === 'string' && msg.text.startsWith('/stages')) {
                const taskId = msg.text.replace('/stages', '').trim();
                if (!taskId) {
                    await sendProgress(bot, msg.chat.id, '用法: /stages 任务ID', config);
                    return;
                }
                await sendProgress(bot, msg.chat.id, buildTaskStageMetricsText(taskId, config.maxMessageLength), config);
                return;
            }
            if (typeof msg.text === 'string' && msg.text.startsWith('/mode')) {
                const modeArg = msg.text.replace('/mode', '').trim();
                if (modeArg && ARTICLE_MODES[modeArg]) {
                    chatContentModes.set(msg.chat.id, modeArg);
                    await sendProgress(bot, msg.chat.id, `✅ 内容模式已切换为: ${ARTICLE_MODES[modeArg].emoji} ${ARTICLE_MODES[modeArg].name}`, config);
                } else {
                    const currentMode = chatContentModes.get(msg.chat.id) || 'default';
                    const currentLabel = ARTICLE_MODES[currentMode] ? `${ARTICLE_MODES[currentMode].emoji} ${ARTICLE_MODES[currentMode].name}` : currentMode;
                    const keyboard = [];
                    const row1 = [];
                    const row2 = [];
                    MODE_LIST.forEach((m, i) => {
                        const target = i < 2 ? row1 : row2;
                        target.push({ text: `${m.emoji} ${m.name}`, callback_data: `mode_${m.key}` });
                    });
                    keyboard.push(row1);
                    if (row2.length) keyboard.push(row2);
                    await bot.sendMessage(msg.chat.id, `📝 当前内容模式: ${currentLabel}\n\n选择内容生成风格：`, {
                        reply_markup: { inline_keyboard: keyboard }
                    });
                }
                return;
            }

            const isAiTask = Boolean(msg.voice || msg.audio || isVideoMessage(msg) || isImageMessage(msg) || msg.text);
            if (!allowAiTask || !isAiTask) {
                if (hasFileMessage(msg)) {
                    await sendProgress(bot, msg.chat.id, '📦 已归档该文件到本地。当前自动生成支持文本、图片、语音、音频、视频。', config);
                } else {
                    await sendProgress(bot, msg.chat.id, '已接收该消息类型并记录日志。当前自动生成支持文本、图片、语音、音频、视频。', config);
                }
                logger.warn('bot.message.non_ai', summarizeMessage(msg));
                return;
            }

            // 视频直接入队，AI 自动生成标题（caption 非空时会被解析为手动标题）

            const queueNo = getQueueDepth();
            const taskId = getTaskId();
            const taskType = inferTaskTypeFromMessage(msg);
            const session = buildSessionLabel(msg);
            registerTaskForDashboard({
                taskId,
                chatId: msg.chat.id,
                session,
                taskType,
                queueNo
            });
            const payload = buildTaskPayload(msg, archiveResult, source);
            upsertTaskCheckpoint({
                taskId,
                chatId: msg.chat.id,
                session,
                taskType,
                status: 'queued',
                payload,
                stepNo: 0,
                totalNo: getTaskTotalSteps(taskType),
                stepTitle: '排队中',
                progressPct: 0,
                errorText: ''
            });
            await sendProgress(
                bot,
                msg.chat.id,
                `🧾 任务已入队\n任务: ${taskId}\n会话: ${session}\n排队序号: ${queueNo}`,
                config
            );
            logger.info('bot.task.queued', { ...summarizeMessage(msg), taskId, taskType, queueNo });

            await enqueueTask({
                taskId,
                run: async () => {
                    await runTaskByMessage(bot, msg, config, audioDir, videoDir, imageDir, { taskId, taskType, session });
                }
            });
        } catch (error) {
            const chatId = msg?.chat?.id || config.adminChatId;
            const errorLine = (error.stack || '').split('\n').slice(0, 2).join('\n');
            const errorText = `❌ 任务失败\n会话: ${msg ? buildSessionLabel(msg) : 'unknown'}\n错误: ${error.message}\n定位: ${errorLine}`;
            if (chatId) await sendProgress(bot, chatId, errorText, config);
            console.error('消息处理失败:', error);
            logger.error('bot.message.failed', {
                ...summarizeMessage(msg),
                message: error.message,
                stack: String(error.stack || '').slice(0, 1000)
            });
        }
    };

    bot.on('message', (msg) => onIncomingMessage(msg, { allowAiTask: true, source: 'message' }));
    bot.on('edited_message', (msg) => onIncomingMessage(msg, { allowAiTask: false, source: 'edited_message' }));
    bot.on('channel_post', (msg) => onIncomingMessage(msg, { allowAiTask: false, source: 'channel_post' }));
    bot.on('edited_channel_post', (msg) => onIncomingMessage(msg, { allowAiTask: false, source: 'edited_channel_post' }));
}

module.exports = { startBot, enqueueAdminUpload };
