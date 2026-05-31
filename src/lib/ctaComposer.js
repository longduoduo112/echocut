'use strict';

/**
 * 品牌营销 CTA 文案组装
 *
 * 对应品牌方案第 6 节缺陷 2:每条内容结尾必须有统一 CTA,
 * 让陌生人看完知道"下一步去哪、扫码找谁、评论什么"。
 *
 * 优先级:
 *   CLI --cta "<text>"                  → 一次性覆盖(最高)
 *   brand.cta.articleFooter             → 品牌专属长文尾(推荐填)
 *   brand.cta.title + brand.cta.subtitle → 回落,拼成一句话
 *   无                                   → 返回 null,不插入
 *
 * CTA 会被渲染成 markdown 块,前面带 `---` 横线,视觉和正文分开。
 */

function composeArticleCta({ brand, cliCta }) {
    const trim = (s) => (s == null ? '' : String(s)).trim();

    // 1. CLI 直传覆盖
    if (trim(cliCta)) {
        return wrap(trim(cliCta));
    }

    const cta = brand && brand.cta ? brand.cta : null;
    if (!cta || cta.enabled === false) return null;

    // 2. 品牌专属 articleFooter
    if (trim(cta.articleFooter)) {
        return wrap(trim(cta.articleFooter));
    }

    // 3. title + subtitle 回落
    const title = trim(cta.title);
    const subtitle = trim(cta.subtitle);
    if (!title && !subtitle) return null;

    const lines = [];
    if (title) lines.push(`**${title}**`);
    if (subtitle) lines.push(subtitle);
    return wrap(lines.join('  \n'));
}

function wrap(body) {
    // 末尾统一加一个视觉分隔 + 签名感,保证正文和 CTA 不粘
    return `\n\n---\n\n${body}\n`;
}

/**
 * 给朋友圈/小红书等"短文案"附加 CTA。
 * 短文案场景不加 --- 分隔符,直接换行两次后跟一句。
 */
function composeShortCta({ brand, cliCta }) {
    const trim = (s) => (s == null ? '' : String(s)).trim();
    if (trim(cliCta)) return `\n\n${trim(cliCta)}`;
    const cta = brand && brand.cta ? brand.cta : null;
    if (!cta || cta.enabled === false) return '';
    if (trim(cta.shortFooter)) return `\n\n${trim(cta.shortFooter)}`;
    const t = trim(cta.title);
    const s = trim(cta.subtitle);
    if (!t && !s) return '';
    return `\n\n${[t, s].filter(Boolean).join(' · ')}`;
}

module.exports = { composeArticleCta, composeShortCta };
