'use strict';

/**
 * stripEmoji — 渲染前剥离 emoji,避免 drawtext 出现"口字型"豆腐块
 *
 * 背景:标题/封面/CTA 走 ffmpeg drawtext,用品牌中文字体(默认 Noto Sans SC)。
 * 该字体没有 emoji 字形,而 ffmpeg drawtext(libfreetype)不做逐字形 fallback,
 * 遇到 emoji 就渲染成方框(tofu)。彩色 emoji(Apple Color Emoji 等)是位图/SVG 字体,
 * drawtext 基本无法可靠渲染。所以最稳的做法是渲染前把 emoji 剥掉,得到干净文字。
 *
 * 只剥真·emoji 图形,保留:
 *   - CJK 文字与标点(、。「」《》【】· 等)
 *   - 箭头 U+2190–21FF(→ ↓ ↑,CTA / 标题常用,字体支持)
 *   - Misc Technical U+2300–23FF(⌘ 等技术符号,可能是有意写的)
 *
 * 剥离范围(这些块品牌字体没有、必然 tofu):
 *   - U+1F000–1FAFF  emoji 主块(表情/符号/交通/补充/旗帜等)
 *   - U+2600–27BF    杂项符号 + Dingbats(☀✨✅❤✂➡ 等)
 *   - U+2B00–2BFF    杂项符号与箭头(⭐⬆⬇ 等)
 *   - U+FE00–FE0F    变体选择符(emoji 变体)
 *   - U+200D ZWJ / U+20E3 keycap(组合用,剥基底后残留)
 */

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

function stripEmoji(text) {
    if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
    return text
        .replace(EMOJI_RE, '')
        .replace(/ {2,}/g, ' ')   // 剥掉 emoji 后残留的连续空格收成一个
        .trim();
}

module.exports = { stripEmoji, EMOJI_RE };
