const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function dateStamp(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function createLogger({ name = 'echo', logDir = path.join(process.cwd(), 'logs') } = {}) {
    ensureDir(logDir);
    const logFilePath = path.join(logDir, `${name}-${dateStamp()}.log`);

    function write(level, event, payload = {}) {
        const row = {
            ts: new Date().toISOString(),
            level,
            event,
            ...payload
        };
        const line = `${JSON.stringify(row)}\n`;
        fs.appendFileSync(logFilePath, line, 'utf8');
        const printer = level === 'error' ? console.error : console.log;
        printer(`[${level}] ${event}`, payload);
    }

    return {
        info: (event, payload) => write('info', event, payload),
        warn: (event, payload) => write('warn', event, payload),
        error: (event, payload) => write('error', event, payload),
        logFilePath
    };
}

module.exports = { createLogger };
