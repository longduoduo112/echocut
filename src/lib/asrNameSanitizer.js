'use strict';

const fs = require('fs');
const path = require('path');

/**
 * asrNameSanitizer — ASR 同音字校正
 *
 * 场景: qwen3-ASR / mlx_whisper 转写时把人名/公司名识别成同音字
 *   (李标→李彪, We点AI→微点AI, ORBOT→Oboat, 拥抱智序→拥抱秩序, ...)
 *
 * 用法:
 *   const corrections = [
 *     { wrong: ['李彪', 'Pan Hunt'], right: '李标 Bill' },
 *     { wrong: ['We点AI', '微点AI', '位点AI'], right: 'WUI.AI' },
 *   ];
 *   const fixed = sanitizeText('先从这个李彪开始', corrections);
 *   // → '先从这个李标 Bill开始'
 *
 * 集成点:
 *   - brand.json 可加 brand.asrNameCorrections 字段
 *   - burn 流水线 LLM 校正字幕后,过这一层 sanitize
 *   - article/distribute 生成内容前,过这一层 sanitize
 *
 * 设计原则:
 *   - 不做模糊匹配,只做精确字符串替换(可控,避免误改)
 *   - 大小写敏感(英文公司名常有大小写敏感)
 *   - 调用方负责按上下文长度限制(超长文本切块)
 *   - 空/无效输入不抛异常(返回原值或空字符串)
 */

function isValidCorrection(c) {
    if (!c || typeof c !== 'object') return false;
    if (typeof c.right !== 'string' || !c.right.trim()) return false;
    if (!Array.isArray(c.wrong) && typeof c.wrong !== 'string') return false;
    const wrongs = Array.isArray(c.wrong) ? c.wrong : [c.wrong];
    return wrongs.some((w) => typeof w === 'string' && w.trim().length > 0);
}

/**
 * 单一文本字符串过校正
 * @param {string} text
 * @param {Array<{wrong:string|string[],right:string}>} corrections
 * @returns {string}
 */
function sanitizeText(text, corrections) {
    if (typeof text !== 'string') return '';
    if (!text) return text;
    if (!Array.isArray(corrections) || corrections.length === 0) return text;
    let out = text;
    for (const c of corrections) {
        if (!isValidCorrection(c)) continue;
        const wrongs = Array.isArray(c.wrong) ? c.wrong : [c.wrong];
        const right = c.right;
        for (const w of wrongs) {
            if (typeof w !== 'string' || !w) continue;
            if (w === right) continue;  // 不无意义自替换
            // 全局精确替换(string replace 一次只换第一个,用 split+join 全局替换)
            out = out.split(w).join(right);
        }
    }
    return out;
}

/**
 * 字幕 caption 数组过校正(支持 [{text, start, end}] 或 [{word, start, end}] 形式)
 * @param {Array<object>} captions
 * @param {Array<{wrong:string|string[],right:string}>} corrections
 * @returns {Array<object>} 新数组,不修改入参
 */
function sanitizeCaptions(captions, corrections) {
    if (!Array.isArray(captions)) return [];
    if (!Array.isArray(corrections) || corrections.length === 0) return captions.slice();
    return captions.map((c) => {
        if (!c || typeof c !== 'object') return c;
        const out = { ...c };
        if (typeof out.text === 'string') out.text = sanitizeText(out.text, corrections);
        if (typeof out.word === 'string') out.word = sanitizeText(out.word, corrections);
        return out;
    });
}

/**
 * 统计 corrections 命中数(用于诊断 / 日志)
 * @returns {{ totalHits: number, perCorrection: Array<{right: string, hits: number}> }}
 */
function countHits(text, corrections) {
    if (typeof text !== 'string' || !text) return { totalHits: 0, perCorrection: [] };
    if (!Array.isArray(corrections)) return { totalHits: 0, perCorrection: [] };
    const result = [];
    let totalHits = 0;
    for (const c of corrections) {
        if (!isValidCorrection(c)) continue;
        const wrongs = Array.isArray(c.wrong) ? c.wrong : [c.wrong];
        let hits = 0;
        for (const w of wrongs) {
            if (typeof w !== 'string' || !w) continue;
            if (w === c.right) continue;
            // 数 text 里出现 w 多少次
            const parts = text.split(w);
            hits += Math.max(0, parts.length - 1);
        }
        if (hits > 0) {
            result.push({ right: c.right, hits });
            totalHits += hits;
        }
    }
    return { totalHits, perCorrection: result };
}

/**
 * 从 brand 配置里提取 corrections(向前兼容:brand 没配返回空)
 */
function getBrandCorrections(brand) {
    if (!brand || typeof brand !== 'object') return [];
    const arr = brand.asrNameCorrections;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidCorrection);
}

// 全局技术术语词库(configs/asr-tech-terms.json),进程内缓存,所有品牌通用。
// 中文口播里的英文技术名词常被 ASR 听成同音字(Claude Code→Cloud Code 等),
// 这一层在 brand 人名校正之外补技术词;两者合并后一起过 sanitizeCaptions。
let _techTermsCache = null;
function getTechTermCorrections() {
    if (_techTermsCache) return _techTermsCache;
    try {
        const p = path.resolve(__dirname, '..', '..', 'configs', 'asr-tech-terms.json');
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const arr = Array.isArray(raw.corrections) ? raw.corrections : [];
        _techTermsCache = arr.filter(isValidCorrection);
    } catch (_) {
        _techTermsCache = []; // 词库缺失/损坏不阻塞主流程
    }
    return _techTermsCache;
}

module.exports = {
    sanitizeText,
    sanitizeCaptions,
    countHits,
    getBrandCorrections,
    getTechTermCorrections,
    isValidCorrection,
};
