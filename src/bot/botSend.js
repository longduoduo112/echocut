/**
 * Bot 网络重试 + 消息发送工具函数
 */
const { createLogger } = require('../services/logger');
const { notifyTargets } = require('../services/notifier');

const logger = createLogger({ name: 'bot' });

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTask(task, retries = 2, waitMs = 1200, options = {}) {
    const shouldRetry = typeof options.shouldRetry === 'function' ? options.shouldRetry : () => true;
    const resolveDelayMs = typeof options.resolveDelayMs === 'function' ? options.resolveDelayMs : null;
    let lastError = null;
    for (let i = 0; i <= retries; i += 1) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            if (!shouldRetry(error)) break;
            if (i >= retries) break;
            const jitter = Math.floor(Math.random() * 240);
            const dynamicDelay = resolveDelayMs ? resolveDelayMs(error, i, waitMs) : (waitMs * (i + 1));
            await delay(Math.max(200, Number(dynamicDelay) || waitMs * (i + 1)) + jitter);
        }
    }
    throw lastError;
}

function parseTelegramRetryAfterMs(error) {
    const bodyRetryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (Number.isFinite(bodyRetryAfter) && bodyRetryAfter > 0) return Math.floor(bodyRetryAfter * 1000);
    const message = String(error?.message || error?.response?.body?.description || '');
    const matched = message.match(/retry after\s+(\d+)/i);
    if (!matched) return 0;
    const sec = Number(matched[1]);
    if (!Number.isFinite(sec) || sec <= 0) return 0;
    return Math.floor(sec * 1000);
}

function isTransientNetworkError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '');
    const status = Number(
        error?.response?.status
        || error?.response?.statusCode
        || error?.response?.body?.error_code
        || 0
    );
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) return true;
    if (code === 'ETELEGRAM' && /too many requests|retry after/i.test(message)) return true;
    if (['EFATAL', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
    if (/socket|timeout|timed out|network|TLS|ECONNRESET|proxy|502|503|504|Bad Gateway/i.test(message)) return true;
    return false;
}

async function runWithBotNetworkRetry(task, config, label = 'bot_network') {
    const retries = Math.max(0, Number(config?.botNetworkRetries || 3));
    const waitMs = Math.max(300, Number(config?.botNetworkRetryDelayMs || 1200));
    return await retryTask(task, retries, waitMs, {
        resolveDelayMs: (error, index, baseDelayMs) => {
            const retryAfterMs = parseTelegramRetryAfterMs(error);
            if (retryAfterMs > 0) return retryAfterMs;
            return baseDelayMs * (index + 1);
        },
        shouldRetry: (error) => {
            const retryable = isTransientNetworkError(error);
            if (!retryable) {
                logger.warn('bot.network.non_retryable', {
                    label,
                    code: String(error?.code || ''),
                    status: Number(error?.response?.status || error?.response?.statusCode || 0),
                    message: String(error?.message || '').slice(0, 180)
                });
            }
            return retryable;
        }
    });
}

async function sendProgress(bot, chatId, text, config) {
    await runWithBotNetworkRetry(() => notifyTargets(bot, chatId, text, config), config, 'send_progress');
}

async function sendStatusMessage(bot, chatId, text) {
    try {
        const sent = await bot.sendMessage(chatId, text);
        return sent.message_id || 0;
    } catch (err) {
        logger.warn('status_msg.send_failed', { message: String(err.message || '').slice(0, 120) });
        return 0;
    }
}

async function editStatusMessage(bot, chatId, messageId, text) {
    if (!messageId) return;
    try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } catch (err) {
        const msg = String(err.message || '');
        if (!/not modified|message to edit not found/i.test(msg)) {
            logger.warn('status_msg.edit_failed', { message: msg.slice(0, 120) });
        }
    }
}

function renderProgressBar(pct, width = 16) {
    const filled = Math.floor(pct / 100 * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${pct}%`;
}

function formatPublishGroups(groups, commandHeadline) {
    const numChars = ['一', '二', '三', '四'];
    const lines = ['📋 宣发素材包'];
    if (commandHeadline) lines.push(`已烧录标题：${commandHeadline}`);
    lines.push('');
    for (let i = 0; i < Math.min(groups.length, 4); i += 1) {
        const g = groups[i];
        lines.push(`【组${numChars[i] || i + 1}】${g.title}`);
        lines.push(g.description);
        lines.push('');
    }
    return lines.join('\n').trim();
}

function parseCaptionAsTitle(caption) {
    const raw = String(caption || '').trim();
    if (!raw || raw.length > 60) return null;
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const headline = lines[0] && lines[0].length <= 20 ? lines[0] : null;
    if (!headline) return null;
    const subline = lines[1] && lines[1].length <= 40 ? lines[1] : '';
    return { headline, subline };
}

async function sendVideoWithFallback(bot, chatId, videoPath, caption) {
    try {
        await runWithBotNetworkRetry(
            () => bot.sendVideo(chatId, videoPath, { supports_streaming: true, caption }),
            { botNetworkRetries: 2, botNetworkRetryDelayMs: 1200 },
            'send_video'
        );
        return;
    } catch (videoError) {
        await runWithBotNetworkRetry(
            () => bot.sendDocument(chatId, videoPath, { caption }),
            { botNetworkRetries: 2, botNetworkRetryDelayMs: 1200 },
            'send_document_fallback'
        );
    }
}

module.exports = {
    delay,
    retryTask,
    parseTelegramRetryAfterMs,
    isTransientNetworkError,
    runWithBotNetworkRetry,
    sendProgress,
    sendStatusMessage,
    editStatusMessage,
    renderProgressBar,
    formatPublishGroups,
    parseCaptionAsTitle,
    sendVideoWithFallback
};
