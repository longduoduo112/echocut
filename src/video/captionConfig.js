const { DEFAULT_CONFIGS } = require('../db/configRepo');
const { parseKeywordList, removeFillerWords } = require('./captionUtils');

const CONFIG_NUMERIC_BOUNDS = {
    video_caption_cjk_term_max_chars: { min: 2, max: 8, fallback: 4, fixed: 0 },
    video_caption_chunk_max_chars: { min: 6, max: 18, fallback: 16, fixed: 0 },
    video_caption_chunk_max_duration: { min: 0.5, max: 4.5, fallback: 1.65, fixed: 2 },
    video_caption_chunk_gap_break_sec: { min: 0.05, max: 1.5, fallback: 0.38, fixed: 2 },
    video_caption_cjk_gap_break_sec: { min: 0.05, max: 1.5, fallback: 0.30, fixed: 2 },
    video_caption_latin_gap_break_sec: { min: 0.02, max: 1.5, fallback: 0.18, fixed: 2 },
    video_caption_sentence_max_chars: { min: 10, max: 20, fallback: 18, fixed: 0 },
    video_caption_sentence_max_duration: { min: 1.2, max: 3.2, fallback: 2.8, fixed: 2 },
    video_caption_sentence_gap_break_sec: { min: 0.1, max: 2, fallback: 0.55, fixed: 2 },
    video_caption_subtitle_offset_ms: { min: -2000, max: 2000, fallback: 0, fixed: 0 },
    video_caption_subtitle_outline: { min: 0, max: 8, fallback: 0, fixed: 1 },
    video_caption_subtitle_shadow: { min: 0, max: 8, fallback: 3.0, fixed: 1 },
    video_caption_subtitle_margin_v: { min: 0, max: 280, fallback: 0, fixed: 0 },
    video_caption_subtitle_margin_h: { min: 12, max: 180, fallback: 36, fixed: 0 },
    video_layout_target_w: { min: 540, max: 2160, fallback: 1080, fixed: 0 },
    video_layout_target_h: { min: 960, max: 3840, fallback: 1920, fixed: 0 },
    video_layout_crop_scale: { min: 1, max: 1.4, fallback: 1.15, fixed: 2 },
    video_layout_crop_offset_y: { min: 0, max: 0.5, fallback: 0.15, fixed: 2 },
    video_layout_top_band_ratio: { min: 0.08, max: 0.32, fallback: 0.2, fixed: 2 },
    video_layout_bottom_band_ratio: { min: 0.08, max: 0.4, fallback: 0.22, fixed: 2 },
    video_layout_headline_font_size: { min: 28, max: 140, fallback: 96, fixed: 0 },
    video_layout_subline_font_size: { min: 18, max: 88, fallback: 54, fixed: 0 },
    video_layout_subtitle_font_size: { min: 20, max: 300, fallback: 150, fixed: 0 },
    video_layout_title_offset_y: { min: -220, max: 220, fallback: 0, fixed: 0 },
    video_layout_subtitle_offset_y: { min: -220, max: 220, fallback: 0, fixed: 0 },
    video_layout_brand_tag_font_size: { min: 24, max: 80, fallback: 48, fixed: 0 }
};

function getNumericConfig(getConfigValue, key, fallback, { min, max } = {}) {
    const raw = getConfigValue(key, String(fallback));
    const val = Number(raw);
    if (!Number.isFinite(val)) return fallback;
    if (typeof min === 'number' && val < min) return fallback;
    if (typeof max === 'number' && val > max) return fallback;
    return val;
}

function getBooleanConfig(getConfigValue, key, fallback = true) {
    const raw = String(getConfigValue(key, fallback ? '1' : '0')).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return fallback;
}

function getHexColorConfig(getConfigValue, key, fallback) {
    const raw = String(getConfigValue(key, fallback) || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
    return fallback;
}

function getVideoCaptionOptions(getConfigValue) {
    const defaultKeywords = DEFAULT_CONFIGS.video_caption_keywords || '';
    const defaultReplacementMapRaw = String(DEFAULT_CONFIGS.video_caption_replace_map || '').trim();
    const customReplacementMapRaw = String(getConfigValue('video_caption_replace_map', defaultReplacementMapRaw) || '').trim();
    const replacementMapRaw = [defaultReplacementMapRaw, customReplacementMapRaw].filter(Boolean).join(',');
    return {
        cjkTermMaxChars: getNumericConfig(getConfigValue, 'video_caption_cjk_term_max_chars', 4, { min: 2, max: 8 }),
        chunkMaxChars: getNumericConfig(getConfigValue, 'video_caption_chunk_max_chars', 16, { min: 6, max: 18 }),
        chunkMaxDuration: getNumericConfig(getConfigValue, 'video_caption_chunk_max_duration', 1.65, { min: 0.5, max: 4.5 }),
        chunkGapBreakSec: getNumericConfig(getConfigValue, 'video_caption_chunk_gap_break_sec', 0.38, { min: 0.05, max: 1.5 }),
        cjkGapBreakSec: getNumericConfig(getConfigValue, 'video_caption_cjk_gap_break_sec', 0.3, { min: 0.05, max: 1.5 }),
        latinGapBreakSec: getNumericConfig(getConfigValue, 'video_caption_latin_gap_break_sec', 0.18, { min: 0.02, max: 1.5 }),
        sentenceMaxChars: getNumericConfig(getConfigValue, 'video_caption_sentence_max_chars', 18, { min: 10, max: 20 }),
        sentenceMaxDuration: getNumericConfig(getConfigValue, 'video_caption_sentence_max_duration', 2.8, { min: 1.2, max: 3.2 }),
        sentenceGapBreakSec: getNumericConfig(getConfigValue, 'video_caption_sentence_gap_break_sec', 0.55, { min: 0.1, max: 2 }),
        subtitleColor: getHexColorConfig(getConfigValue, 'video_caption_subtitle_color', '#F2F4F8'),
        subtitleOutlineColor: getHexColorConfig(getConfigValue, 'video_caption_subtitle_outline_color', '#0F172A'),
        subtitleOutline: getNumericConfig(getConfigValue, 'video_caption_subtitle_outline', 0, { min: 0, max: 8 }),
        subtitleShadow: getNumericConfig(getConfigValue, 'video_caption_subtitle_shadow', 3.0, { min: 0, max: 8 }),
        subtitleMarginV: getNumericConfig(getConfigValue, 'video_caption_subtitle_margin_v', 0, { min: 0, max: 280 }),
        subtitleMarginH: getNumericConfig(getConfigValue, 'video_caption_subtitle_margin_h', 36, { min: 12, max: 180 }),
        subtitleAlign: String(getConfigValue('video_caption_subtitle_align', 'center') || 'center').trim().toLowerCase(),
        renderStyle: String(getConfigValue('video_caption_render_style', 'sentence') || 'sentence').trim().toLowerCase(),
        fillerWords: parseKeywordList(getConfigValue('video_caption_filler_words', DEFAULT_CONFIGS.video_caption_filler_words || '')),
        emphasisWords: parseKeywordList(getConfigValue('video_caption_keywords', defaultKeywords)),
        emphasisEnabled: getBooleanConfig(getConfigValue, 'video_caption_enable_emphasis', true),
        highlightColor: getHexColorConfig(getConfigValue, 'video_caption_highlight_color', '#FFCF40'),
        titleColor: getHexColorConfig(getConfigValue, 'video_caption_title_color', '#FFCF40'),
        titleOffsetY: getNumericConfig(getConfigValue, 'video_layout_title_offset_y', 0, { min: -220, max: 220 }),
        subtitleOffsetY: getNumericConfig(getConfigValue, 'video_layout_subtitle_offset_y', 0, { min: -220, max: 220 }),
        brandBandEnabled: getBooleanConfig(getConfigValue, 'video_layout_brand_band_enabled', false),
        brandTagText: String(getConfigValue('video_layout_brand_tag_text', '') || '').trim(),
        brandTagBgColor: getHexColorConfig(getConfigValue, 'video_layout_brand_tag_bg_color', '#FFD54F'),
        brandTagTextColor: getHexColorConfig(getConfigValue, 'video_layout_brand_tag_text_color', '#0B0F1A'),
        brandTagFontSize: getNumericConfig(getConfigValue, 'video_layout_brand_tag_font_size', 48, { min: 24, max: 80 }),
        brandBandOpacity: Number(getConfigValue('video_layout_brand_band_opacity', '0.92')) || 0.92,
        semanticBreak: getBooleanConfig(getConfigValue, 'video_caption_semantic_break', true),
        subtitleOffsetMs: getNumericConfig(getConfigValue, 'video_caption_subtitle_offset_ms', 0, { min: -2000, max: 2000 }),
        replacementMapRaw
    };
}

function sanitizeConfigValue(key, rawValue) {
    const value = String(rawValue ?? '');
    if (key === 'video_caption_keywords') {
        return parseKeywordList(value).slice(0, 80).join(',');
    }
    if (key === 'video_caption_highlight_color' || key === 'video_caption_title_color' || key === 'video_caption_subtitle_color' || key === 'video_caption_subtitle_outline_color') {
        const color = value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase();
        if (key === 'video_caption_subtitle_color') return '#F2F4F8';
        if (key === 'video_caption_subtitle_outline_color') return '#0F172A';
        return '#FFCF40';
    }
    if (key === 'video_caption_enable_emphasis') {
        const boolLike = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(boolLike)) return '1';
        if (['0', 'false', 'no', 'off'].includes(boolLike)) return '0';
        return '1';
    }
    if (key === 'video_caption_semantic_break') {
        const boolLike = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(boolLike)) return '1';
        if (['0', 'false', 'no', 'off'].includes(boolLike)) return '0';
        return '1';
    }
    if (key === 'video_layout_treat_square_as_video_note' || key === 'video_layout_treat_vertical_as_video_note') {
        const boolLike = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(boolLike)) return '1';
        if (['0', 'false', 'no', 'off'].includes(boolLike)) return '0';
        return key === 'video_layout_treat_vertical_as_video_note' ? '0' : '1';
    }
    if (key === 'video_caption_render_style') {
        const style = value.trim().toLowerCase();
        if (['sentence', 'chunk', 'term', 'word'].includes(style)) return style;
        return 'sentence';
    }
    if (key === 'video_caption_subtitle_align') {
        const align = value.trim().toLowerCase();
        if (['left', 'center', 'right'].includes(align)) return align;
        return 'center';
    }
    if (CONFIG_NUMERIC_BOUNDS[key]) {
        const rule = CONFIG_NUMERIC_BOUNDS[key];
        const parsed = Number(value);
        const normalized = Number.isFinite(parsed)
            ? Math.min(rule.max, Math.max(rule.min, parsed))
            : rule.fallback;
        return rule.fixed > 0 ? normalized.toFixed(rule.fixed) : String(Math.round(normalized));
    }
    return value;
}

module.exports = {
    CONFIG_NUMERIC_BOUNDS,
    getVideoCaptionOptions,
    sanitizeConfigValue
};
