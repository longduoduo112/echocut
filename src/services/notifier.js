function splitMessage(text, maxLength) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + maxLength));
        start += maxLength;
    }
    return chunks;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(error, fallbackMs) {
    const bodyRetryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (Number.isFinite(bodyRetryAfter) && bodyRetryAfter > 0) return Math.floor(bodyRetryAfter * 1000);
    const message = String(error?.message || error?.response?.body?.description || '');
    const match = message.match(/retry after\s+(\d+)/i);
    if (match) {
        const sec = Number(match[1]);
        if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);
    }
    return fallbackMs;
}

function isRetryableTelegramError(error) {
    const status = Number(error?.response?.status || error?.response?.statusCode || error?.response?.body?.error_code || 0);
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '');
    if (status === 429 || (status >= 500 && status < 600)) return true;
    if (code === 'ETELEGRAM' && /too many requests|retry after/i.test(message)) return true;
    if (['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
    return /timeout|network|bad gateway|gateway timeout|service unavailable/i.test(message);
}

const chatQueue = new Map();
const chatLastSentAt = new Map();

function enqueueByChat(chatId, task) {
    const key = String(chatId);
    const prev = chatQueue.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    chatQueue.set(key, next.catch(() => {}));
    return next;
}

async function sendChunkWithRetry(bot, chatId, chunk, config) {
    const retries = Math.max(0, Number(config?.bot429MaxRetries || 6));
    const minGapMs = Math.max(120, Number(config?.botSendMinIntervalMs || 450));
    const key = String(chatId);
    const now = Date.now();
    const last = Number(chatLastSentAt.get(key) || 0);
    const gapWaitMs = Math.max(0, minGapMs - (now - last));
    if (gapWaitMs > 0) await delay(gapWaitMs);
    let attempt = 0;
    for (;;) {
        try {
            const sent = await bot.sendMessage(chatId, chunk);
            chatLastSentAt.set(key, Date.now());
            return sent;
        } catch (error) {
            if (!isRetryableTelegramError(error) || attempt >= retries) throw error;
            const baseRetryMs = Math.max(1200, Number(config?.botNetworkRetryDelayMs || 1200));
            const retryAfterMs = parseRetryAfterMs(error, baseRetryMs * (attempt + 1));
            await delay(retryAfterMs + Math.floor(Math.random() * 260));
            attempt += 1;
        }
    }
}

async function sendMessage(bot, chatId, text, maxLength, config) {
    const chunks = splitMessage(text, maxLength);
    await enqueueByChat(chatId, async () => {
        for (const chunk of chunks) {
            await sendChunkWithRetry(bot, chatId, chunk, config);
        }
    });
}

async function notifyTargets(bot, mainChatId, text, config) {
    await sendMessage(bot, mainChatId, text, config.maxMessageLength, config);
    if (config.adminChatId && String(config.adminChatId) !== String(mainChatId)) {
        await sendMessage(bot, config.adminChatId, `[镜像通知] ${text}`, config.maxMessageLength, config);
    }
}

module.exports = { notifyTargets };
