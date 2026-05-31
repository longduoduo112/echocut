/**
 * 纯消息/媒体工具函数（无副作用，无 bot 依赖）
 */
const fs = require('fs');
const path = require('path');

function clipText(raw, maxLen = 280) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
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

function cloneMediaField(value) {
    if (!value) return null;
    return JSON.parse(JSON.stringify(value));
}

function buildTaskMessageSnapshot(msg) {
    return {
        message_id: msg?.message_id || 0,
        chat: { id: msg?.chat?.id || 0 },
        from: {
            id: msg?.from?.id || 0,
            username: msg?.from?.username || '',
            first_name: msg?.from?.first_name || 'User',
            is_bot: false
        },
        text: typeof msg?.text === 'string' ? msg.text : '',
        caption: typeof msg?.caption === 'string' ? msg.caption : '',
        voice: cloneMediaField(msg?.voice),
        audio: cloneMediaField(msg?.audio),
        video: cloneMediaField(msg?.video),
        video_note: cloneMediaField(msg?.video_note),
        animation: cloneMediaField(msg?.animation),
        document: cloneMediaField(msg?.document)
    };
}

function normalizeMessageSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const chatId = raw?.chat?.id || raw?.chatId;
    if (!chatId) return null;
    return {
        message_id: raw?.message_id || raw?.messageId || 0,
        chat: { id: chatId },
        from: {
            id: raw?.from?.id || 0,
            username: raw?.from?.username || '',
            first_name: raw?.from?.first_name || 'Recovered',
            is_bot: false
        },
        text: typeof raw?.text === 'string' ? raw.text : '',
        caption: typeof raw?.caption === 'string' ? raw.caption : '',
        voice: raw?.voice || null,
        audio: raw?.audio || null,
        video: raw?.video || null,
        video_note: raw?.video_note || null,
        animation: raw?.animation || null,
        document: raw?.document || null
    };
}

function detectMessageType(msg) {
    if (!msg) return 'unknown';
    if (msg.text) return 'text';
    if (msg.voice) return 'voice';
    if (msg.audio) return 'audio';
    if (msg.video_note) return 'video_note';
    if (msg.video) return 'video';
    if (msg.animation) return 'animation';
    if (msg.document && typeof msg.document.mime_type === 'string' && msg.document.mime_type.startsWith('video/')) return 'video_document';
    if (msg.document) return 'document';
    if (msg.photo) return 'photo';
    if (msg.sticker) return 'sticker';
    if (msg.location) return 'location';
    if (msg.contact) return 'contact';
    if (msg.poll) return 'poll';
    return 'unsupported';
}

function summarizeMessage(msg) {
    const type = detectMessageType(msg);
    const base = {
        type,
        chatId: msg?.chat?.id,
        userId: msg?.from?.id,
        username: msg?.from?.username || '',
        messageId: msg?.message_id
    };
    if (type === 'text') {
        return { ...base, textLength: (msg.text || '').length };
    }
    if (type === 'voice' || type === 'audio') {
        const media = msg.voice || msg.audio;
        return { ...base, durationSec: media?.duration || 0, fileSize: media?.file_size || 0, mimeType: media?.mime_type || '' };
    }
    if (type === 'video' || type === 'video_note' || type === 'video_document' || type === 'animation') {
        const media = msg.video_note || msg.video || msg.animation || msg.document;
        return { ...base, durationSec: media?.duration || 0, fileSize: media?.file_size || 0, mimeType: media?.mime_type || '', fileName: media?.file_name || '' };
    }
    if (type === 'document') {
        const media = msg.document;
        return { ...base, durationSec: media?.duration || 0, fileSize: media?.file_size || 0, mimeType: media?.mime_type || '', fileName: media?.file_name || '' };
    }
    if (type === 'photo') {
        const media = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
        return { ...base, fileSize: media?.file_size || 0 };
    }
    if (type === 'sticker') {
        return { ...base, isAnimated: Boolean(msg.sticker?.is_animated), isVideo: Boolean(msg.sticker?.is_video) };
    }
    return base;
}

function isVideoMessage(msg) {
    return Boolean(
        msg.video
        || msg.video_note
        || msg.animation
        || (msg.document && typeof msg.document.mime_type === 'string' && msg.document.mime_type.startsWith('video/'))
        || (msg.document && /\.(mp4|m4v|mov|webm)$/i.test(msg.document.file_name || ''))
    );
}

function isImageMessage(msg) {
    if (Array.isArray(msg?.photo) && msg.photo.length) return true;
    return Boolean(msg?.document && typeof msg.document.mime_type === 'string' && msg.document.mime_type.startsWith('image/'));
}

function getVideoPayload(msg) {
    if (msg.video_note) return msg.video_note;
    if (msg.video) return msg.video;
    if (msg.animation) return msg.animation;
    if (msg.document) return msg.document;
    return null;
}

function getImagePayload(msg) {
    if (Array.isArray(msg?.photo) && msg.photo.length) {
        return msg.photo.slice().sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
    }
    if (msg?.document && typeof msg.document.mime_type === 'string' && msg.document.mime_type.startsWith('image/')) {
        return msg.document;
    }
    return null;
}

function extFromMimeType(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('video/mp4')) return '.mp4';
    if (mime.includes('video/quicktime')) return '.mov';
    if (mime.includes('video/webm')) return '.webm';
    if (mime.includes('audio/ogg')) return '.ogg';
    if (mime.includes('audio/mpeg')) return '.mp3';
    if (mime.includes('audio/mp4')) return '.m4a';
    if (mime.includes('image/jpeg')) return '.jpg';
    if (mime.includes('image/png')) return '.png';
    if (mime.includes('image/webp')) return '.webp';
    if (mime.includes('application/pdf')) return '.pdf';
    return '';
}

function getMediaEntries(msg) {
    const rows = [];
    if (!msg) return rows;
    if (msg.voice) rows.push({ kind: 'voice', media: msg.voice });
    if (msg.audio) rows.push({ kind: 'audio', media: msg.audio });
    if (msg.video) rows.push({ kind: 'video', media: msg.video });
    if (msg.video_note) rows.push({ kind: 'video_note', media: msg.video_note });
    if (msg.animation) rows.push({ kind: 'animation', media: msg.animation });
    if (msg.document) rows.push({ kind: 'document', media: msg.document });
    if (Array.isArray(msg.photo) && msg.photo.length) {
        const sorted = msg.photo.slice().sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
        rows.push({ kind: 'photo', media: sorted[0] });
    }
    if (msg.sticker) rows.push({ kind: 'sticker', media: msg.sticker });
    return rows;
}

function hasFileMessage(msg) {
    return getMediaEntries(msg).length > 0;
}

function resolveMediaExt(kind, media) {
    const fromName = path.extname(media?.file_name || '').toLowerCase();
    if (fromName) return fromName;
    const fromMime = extFromMimeType(media?.mime_type || '');
    if (fromMime) return fromMime;
    if (kind === 'voice') return '.ogg';
    if (kind === 'audio') return '.mp3';
    if (kind === 'video' || kind === 'video_note' || kind === 'animation') return '.mp4';
    if (kind === 'photo') return '.jpg';
    if (kind === 'sticker') return media?.is_video ? '.webm' : '.webp';
    return '.bin';
}

module.exports = {
    clipText,
    readJsonFileSafe,
    cloneMediaField,
    buildTaskMessageSnapshot,
    normalizeMessageSnapshot,
    detectMessageType,
    summarizeMessage,
    isVideoMessage,
    isImageMessage,
    getVideoPayload,
    getImagePayload,
    extFromMimeType,
    getMediaEntries,
    hasFileMessage,
    resolveMediaExt
};
