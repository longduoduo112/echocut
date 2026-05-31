require('dotenv').config();
const os = require('os');

function normalizeProxyEnv() {
    if (process.env.http_proxy && !process.env.HTTP_PROXY) process.env.HTTP_PROXY = process.env.http_proxy;
    if (process.env.https_proxy && !process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = process.env.https_proxy;
    if (process.env.all_proxy && !process.env.ALL_PROXY) process.env.ALL_PROXY = process.env.all_proxy;
    if (!process.env.NO_PROXY) process.env.NO_PROXY = '127.0.0.1,localhost';
}

function parseBoolean(raw, fallback = false) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return fallback;
}

function getConfig(options = {}) {
    const { requireTelegramToken = true } = options;
    normalizeProxyEnv();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (requireTelegramToken && !token) throw new Error('缺少 TELEGRAM_BOT_TOKEN，请在 .env 中配置');
    const localVenvPython = './.venv/bin/python';
    const pythonBin = process.env.PYTHON_BIN || (require('fs').existsSync(localVenvPython) ? localVenvPython : 'python3');

    const videoContentMode = String(process.env.VIDEO_CONTENT_MODE || 'fast').trim().toLowerCase();
    const normalizedVideoContentMode = videoContentMode === 'full' ? 'full' : 'fast';
    const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
    const adaptiveQueueConcurrency = Math.max(1, Math.min(4, Math.floor(cpuCount / 4) || 1));
    const rawQueueConcurrency = Number(process.env.TASK_QUEUE_CONCURRENCY || adaptiveQueueConcurrency);
    const taskQueueConcurrency = Math.max(1, Math.min(4, rawQueueConcurrency || adaptiveQueueConcurrency));
    const botNetworkRetries = Math.max(0, Number(process.env.BOT_NETWORK_RETRIES || 3));
    const botNetworkRetryDelayMs = Math.max(200, Number(process.env.BOT_NETWORK_RETRY_DELAY_MS || 1200));
    const botSendMinIntervalMs = Math.max(120, Number(process.env.BOT_SEND_MIN_INTERVAL_MS || 450));
    const bot429MaxRetries = Math.max(0, Number(process.env.BOT_429_MAX_RETRIES || 6));

    return {
        telegramToken: token,
        adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
        proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
        ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:9b',
        ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat',
        ollamaThink: parseBoolean(process.env.OLLAMA_THINK, false),
        ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 300000),
        ollamaRetries: Number(process.env.OLLAMA_RETRIES || 2),
        maxMessageLength: Number(process.env.TELEGRAM_MESSAGE_MAX_LENGTH || 3500),
        adminPort: Number(process.env.ADMIN_PORT || 3399),
        transcribeEngine: process.env.TRANSCRIBE_ENGINE || 'auto',
        transcribeScriptPath: process.env.TRANSCRIBE_SCRIPT_PATH || 'python/transcribe.py',
        transcribeMlxScriptPath: process.env.TRANSCRIBE_MLX_SCRIPT_PATH || 'python/transcribe_mlx.py',
        transcribeFunasrScriptPath: process.env.TRANSCRIBE_FUNASR_SCRIPT_PATH || 'python/transcribe_funasr.py',
        pollingIntervalMs: Number(process.env.TELEGRAM_POLLING_INTERVAL_MS || 700),
        pollingTimeoutSec: Number(process.env.TELEGRAM_POLLING_TIMEOUT_SEC || 25),
        taskQueueConcurrency,
        videoContentMode: normalizedVideoContentMode,
        botNetworkRetries,
        botNetworkRetryDelayMs,
        botSendMinIntervalMs,
        bot429MaxRetries,
        pythonBin,
        contentDbPath: process.env.CONTENT_DB_PATH || 'data/contents.db'
    };
}

module.exports = { getConfig };
