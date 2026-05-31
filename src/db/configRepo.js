const { getDb } = require('./index');

const DEFAULT_CONFIGS = {
    prompt_system: `你是”Example（李标）”的数字分身。核心身份：95后极客创始人，14年底层架构经验，从珠三角流水线工人逆袭为AI企业（echocut科技）CEO，全球数字游民践行者。思想武器：《毛选》矛盾论/实践论、王阳明知行合一、系统动力学、反脆弱。行文铁律：短句成段，冷峻客观，一针见血。绝对禁止AI套话。`,
    style_guide: `写作风格：
1. 短句成段：像写现代诗一样，每句话尽量不超过20个字，大量换行，手机屏幕阅读零压力。
2. 观点先行：每段先给结论，再给依据。
3. 物理颗粒度：保留素材中的真实细节（具体金额、地名、时间），不要抽象化。
4. 结构化：善用 1️⃣ 2️⃣ 3️⃣ 或 A vs B 对比结构。
5. 商业导向：围绕增长、效率、杠杆、闭环、反脆弱、降维打击。
6. 禁止：「在这个瞬息万变的时代」「毋庸置疑」「总而言之」「不仅...而且」等AI套话。`,
    official_account_prompt: `你是微信”公众号深度长文”编辑，拥有Example的思维模型和表达风格。请基于输入素材输出一篇可直接发布的长文，中文输出。
硬性要求：
1) 标题有反差和收益感，用极客视角或架构师视角切入；
2) 正文结构：Hook引言 -> 模块化论述(1️⃣2️⃣3️⃣) -> 深度升华 -> 结语；
3) 每个论点保留素材中最真实的物理细节，不要抽象化；
4) 1200~2000字，短句成段，适合手机阅读；
5) 结尾以”愿于你有益 ❤️”或”共勉！”收束；
6) 不要输出任何”AI提示语””说明””免责声明”。`,
    moments_prompt: `你是Example的朋友圈操盘手。将长文草稿提炼为可发布朋友圈文案。
排版铁律：极简诗歌体，每句极短，大量换行。首行暴击：第一行必须是反常识洞察或极具哲理的短句。
生成3个版本：
- 版本A【商业狙击版】：直接、突出ROI、筛选高净值客户
- 版本B【极客生活版】：技术感悟与生活反差
- 版本C【引流钩子版】：提取最痛的1个点，用悬念作钩子
每版80~120字。专属Emoji：🤗 🤣 ❤️ 🚀 💰 ☕️（每条不超过4个）。结尾用”共勉”或”愿于你有益 ❤️”。严禁微商话术。`,
    hook_prompt: `你是Example的朋友圈诱饵文案编辑。基于给定长文，提炼一条100字以内的朋友圈文案。
要求：首行暴击（反常识或强冲突）+ 核心价值 + 轻量行动引导。极简诗歌体排版。只输出最终文案。`,
    video_caption_keywords: '重要,关键,增长,突破,优化,提升,智能,系统,机会,风险,AI,产品,用户',
    video_caption_highlight_color: '#FFCF40',
    video_caption_enable_emphasis: '1',
    video_caption_cjk_term_max_chars: '4',
    video_caption_chunk_max_chars: '16',
    video_caption_chunk_max_duration: '1.65',
    video_caption_chunk_gap_break_sec: '0.38',
    video_caption_cjk_gap_break_sec: '0.30',
    video_caption_latin_gap_break_sec: '0.18',
    video_caption_render_style: 'sentence',
    video_caption_sentence_max_chars: '18',
    video_caption_sentence_max_duration: '2.80',
    video_caption_sentence_gap_break_sec: '0.55',
    video_caption_subtitle_color: '#F2F4F8',
    video_caption_subtitle_outline_color: '#0F172A',
    video_caption_subtitle_outline: '0',
    video_caption_subtitle_shadow: '3.0',
    video_caption_subtitle_margin_v: '0',
    video_caption_filler_words: '嗯,啊,呃,哦,哎,唉,嗯啊,哎呀,哦哦,对吧,对吗,是吧,对不对,你知道吧,你知道吗,然后呢,然后吧,然后啊,然后嗯,就是呢,就是吧,就是说呢,怎么说呢,这样说吧,说白了,em,eh,uh,uhh,um,umm,hmm,you know,I mean,kind of,sort of',
    video_caption_subtitle_margin_h: '36',
    video_caption_subtitle_align: 'center',
    video_caption_title_color: '#FFCF40',
    video_caption_replace_map: [
        // AI/技术术语
        'AII=AI,Ai=AI,A=AI',
        // Whisper 高频同音误识别
        '诶=哎,恩=嗯,帐号=账号,湿滑=丝滑,英门=英文',
        '在坐=在座,做坐=在座,其时=其实,做为=作为,座为=作为',
        '在线=在现,反查=反差,必竟=毕竟,即使=既是,以经=已经',
        '因该=应该,连系=联系,从新=重新,那个=哪个',
        '建意=建议,合理=和理,收获=收货,事实=实施',
        '增长=增涨,包含=包涵,原来=原赖,在在=在',
        '佣金=拥金,频道=拼到,背景=被经,机器=基期',
        '大标=Example,大飙=Example,大表=Example,大镖=Example',
        '智顿=echocut,之盾=echocut,知盾=echocut,制盾=echocut',
        '抖音号=抖音,视频号=视频号'
    ].join(','),
    funasr_model: 'paraformer-zh',
    funasr_sensevoice_model: 'iic/SenseVoiceSmall',
    asr_domain_keywords: '曾国藩,王阳明,三省吾身,知行合一,阳明心学,正心诚意,成人达己,毛选,矛盾论,实践论,道德经,资治通鉴,纳瓦尔宝典,反脆弱,系统之美,大败局,echocut科技,Example Studio,旷视,金山云,example,地理套利,供应链,跨境电商,SaaS,LTD,B2B,DeepSeek,Qwen,Gemini,Claude,GPT,Ollama,Remotion,Stripe,API,CLI,RAG,LLM,大模型,具身智能,多模态,主权个人,数字游民,增强回路,代偿机制,系统动力学,降维打击,清迈,曼谷,巴厘岛,耒阳,东莞,深圳,北京',
    ollama_think: '0',
    content_mode: 'default',
    video_metadata_prompt: `你是Example的视频标题策划，专门生成反常识、强冲突的营销钩子。
标题要求（headline）：
- 必须是反常识结论、强冲突、或揭示隐藏规律
- 不超过10字，字字有张力
- 用极客视角或架构师视角切入
- 禁止"干货分享""深度解析""一文读懂"等废话标题
副标题要求（subline）：
- 补充核心矛盾或揭示本质，引发点击欲望
- 不超过18字
请直接返回 JSON 格式，不包含 markdown 标记：{"headline": "...", "subline": "..."}`,
    video_layout_target_w: '1080',
    video_layout_target_h: '1920',
    video_layout_crop_scale: '1.15',
    video_layout_crop_offset_y: '0.15',
    video_layout_treat_square_as_video_note: '1',
    video_layout_treat_vertical_as_video_note: '0',
    video_layout_top_band_ratio: '0.20',
    video_layout_bottom_band_ratio: '0.22',
    video_layout_headline_font_size: '96',
    video_layout_subline_font_size: '54',
    video_layout_subtitle_font_size: '150',
    video_layout_title_offset_y: '0',
    video_layout_subtitle_offset_y: '0',
    video_caption_semantic_break: '1',
    video_caption_subtitle_offset_ms: '0',
    // 品牌带 + 胶囊(雄哥说风格)— 顶部黑带 + 左上角黄色圆角胶囊
    video_layout_brand_band_enabled: '0',
    video_layout_brand_tag_text: '',
    video_layout_brand_tag_bg_color: '#FFD54F',
    video_layout_brand_tag_text_color: '#0B0F1A',
    video_layout_brand_tag_font_size: '48',
    video_layout_brand_band_opacity: '0.92'
};

function upsertConfig(key, value) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO app_configs (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    stmt.run(key, value);
}

// 旧版 prompt 指纹（用于检测是否需要自动迁移）
const OLD_PROMPT_FINGERPRINTS = {
    prompt_system: '你是"内容中台总编"',
    official_account_prompt: '你是微信"公众号深度长文"编辑。请基于输入素材',
    moments_prompt: '你是微信"朋友圈短文案"编辑',
    hook_prompt: '你是顶级社媒增长编辑',
    video_metadata_prompt: '请基于以下内容总结一个短视频标题和副标题'
};

// 陈旧默认值指纹(精确匹配旧 default),自动升级到新 default。
// 与 OLD_PROMPT_FINGERPRINTS 不同:prompt 是 startsWith 检查,这里是 full-string 匹配。
const STALE_DEFAULT_EXACT_FINGERPRINTS = {
    video_caption_filler_words: '嗯,啊,呃,哦,哎,em,uh,um'
};

function ensureDefaultConfigs() {
    const db = getDb();
    const insertStmt = db.prepare(`INSERT OR IGNORE INTO app_configs (key, value) VALUES (?, ?)`);
    Object.entries(DEFAULT_CONFIGS).forEach(([key, value]) => insertStmt.run(key, value));
    // 自动迁移：如果 prompt 还是旧版通用模板，升级为人格化版本
    const updateStmt = db.prepare(`UPDATE app_configs SET value = ?, updated_at = datetime('now') WHERE key = ?`);
    Object.entries(OLD_PROMPT_FINGERPRINTS).forEach(([key, fingerprint]) => {
        const current = getConfigValue(key, '');
        if (current && current.startsWith(fingerprint)) {
            updateStmt.run(DEFAULT_CONFIGS[key], key);
        }
    });
    // Soft migration: 精确匹配旧 default 的字段自动升级(用户没改过才动)
    Object.entries(STALE_DEFAULT_EXACT_FINGERPRINTS).forEach(([key, staleValue]) => {
        const current = getConfigValue(key, '');
        if (current === staleValue && DEFAULT_CONFIGS[key] && DEFAULT_CONFIGS[key] !== staleValue) {
            updateStmt.run(DEFAULT_CONFIGS[key], key);
        }
    });
}

// Preset override layer —— 由 CLI 通过 ZDE_PRESET_CONFIG 环境变量注入的 JSON。
// 命中的 key 会短路 DB 查询,不命中则 fallthrough 正常读取。
// 设计目的:让 `echocut burn --preset=douyin` 一次性覆盖多个 video_* 配置,且不污染 DB。
let __presetCache = null;
let __presetCacheRaw = null;
function getPresetOverride() {
    const raw = process.env.ZDE_PRESET_CONFIG || '';
    if (raw === __presetCacheRaw) return __presetCache;
    __presetCacheRaw = raw;
    if (!raw) {
        __presetCache = null;
    } else {
        try {
            const parsed = JSON.parse(raw);
            __presetCache = (parsed && typeof parsed === 'object') ? parsed : null;
        } catch (_) {
            __presetCache = null;
        }
    }
    return __presetCache;
}

function getConfigValue(key, fallback = '') {
    const preset = getPresetOverride();
    if (preset && Object.prototype.hasOwnProperty.call(preset, key)) {
        return String(preset[key]);
    }
    const db = getDb();
    const stmt = db.prepare(`SELECT value FROM app_configs WHERE key = ?`);
    const row = stmt.get(key);
    return row ? row.value : fallback;
}

function listConfigs() {
    const db = getDb();
    const stmt = db.prepare(`SELECT key, value, updated_at FROM app_configs ORDER BY key ASC`);
    return stmt.all();
}

module.exports = { DEFAULT_CONFIGS, upsertConfig, ensureDefaultConfigs, getConfigValue, listConfigs };
