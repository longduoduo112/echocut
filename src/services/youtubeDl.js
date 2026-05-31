'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEFAULT_YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const DOWNLOAD_TIMEOUT_MS = 600000; // 10 minutes

function getYtDlpPath() {
    return process.env.YT_DLP_PATH || DEFAULT_YT_DLP_PATH;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function runYtDlp(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = getYtDlpPath();
        const timer = setTimeout(() => {
            reject(new Error(`yt-dlp 超时 (>${(timeoutMs / 60000).toFixed(0)} 分钟)`));
        }, timeoutMs);

        execFile(ytDlpPath, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error) {
                const reason = String(stderr || error.message || error).trim().split('\n').slice(-3).join(' | ');
                reject(new Error(`yt-dlp 失败: ${reason}`));
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

/**
 * Read the info.json written by yt-dlp --write-info-json
 * Returns { title, duration } — duration in seconds (number)
 */
function readInfoJson(infoJsonPath) {
    try {
        if (!fs.existsSync(infoJsonPath)) return {};
        const raw = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
        return {
            title: String(raw.title || raw.fulltitle || '').trim(),
            duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : 0,
            uploader: String(raw.uploader || raw.channel || '').trim(),
            description: String(raw.description || '').trim().slice(0, 500)
        };
    } catch (_) {
        return {};
    }
}

/**
 * Download YouTube audio as WAV.
 * Returns the path to the downloaded .wav file.
 */
async function downloadYoutubeAudio(url, outputDir) {
    ensureDir(outputDir);
    const uid = `yt_audio_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const outputTemplate = path.join(outputDir, `${uid}.%(ext)s`);
    const infoJsonBase = path.join(outputDir, uid);

    // yt-dlp writes info as <uid>.info.json when using -o <uid>
    const args = [
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '0',
        '--write-info-json',
        '--no-playlist',
        '--no-warnings',
        '-o', outputTemplate,
        url
    ];

    await runYtDlp(args, DOWNLOAD_TIMEOUT_MS);

    // Find the resulting wav file
    const entries = fs.readdirSync(outputDir).filter((f) => f.startsWith(uid) && f.endsWith('.wav'));
    if (!entries.length) {
        throw new Error('yt-dlp 未生成 WAV 文件，请检查 URL 是否有效');
    }
    const wavPath = path.join(outputDir, entries[0]);

    // Try to read info.json
    const infoJsonPath = `${infoJsonBase}.info.json`;
    const info = readInfoJson(infoJsonPath);

    return { wavPath, info };
}

/**
 * Download YouTube video as MP4.
 * Returns { videoPath, info } where info = { title, duration, uploader, description }.
 */
async function downloadYoutubeVideo(url, outputDir) {
    ensureDir(outputDir);
    const uid = `yt_video_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const outputTemplate = path.join(outputDir, `${uid}.%(ext)s`);
    const infoJsonBase = path.join(outputDir, uid);

    const args = [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--write-info-json',
        '--no-playlist',
        '--no-warnings',
        '-o', outputTemplate,
        url
    ];

    await runYtDlp(args, DOWNLOAD_TIMEOUT_MS);

    // Find resulting mp4
    const entries = fs.readdirSync(outputDir).filter((f) => f.startsWith(uid) && f.endsWith('.mp4'));
    if (!entries.length) {
        throw new Error('yt-dlp 未生成 MP4 文件，请检查 URL 是否有效');
    }
    const videoPath = path.join(outputDir, entries[0]);

    const infoJsonPath = `${infoJsonBase}.info.json`;
    const info = readInfoJson(infoJsonPath);

    return { videoPath, info };
}

/**
 * Detect whether a string contains a YouTube URL.
 * Matches: youtube.com/watch, youtu.be, youtube.com/shorts
 */
function isYoutubeUrl(text) {
    if (!text || typeof text !== 'string') return false;
    return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_\-]{6,}/i.test(text);
}

/**
 * Extract the first YouTube URL from a string.
 */
function extractYoutubeUrl(text) {
    if (!text || typeof text !== 'string') return '';
    const match = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_\-?&=%#.]+/i);
    return match ? match[0] : '';
}

module.exports = {
    downloadYoutubeAudio,
    downloadYoutubeVideo,
    isYoutubeUrl,
    extractYoutubeUrl
};
