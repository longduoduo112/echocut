'use strict';

/**
 * 内容三支柱分类器(品牌方案第 3 节)
 *
 * Pillar A · Build in Public(硬核 60%)
 *   - PainHunt / Echo 真实进展、数据、系统架构、收入透明
 *   - 情绪特征:理性 · 数字 · 具体
 *
 * Pillar B · 主权思想(差异化 30%)
 *   - 主权个人 / 契约精神 / Bootstrapping 心法 / 数字游民实操
 *   - 情绪特征:观点 · 尖锐 · 反共识
 *
 * Pillar C · 真实生活(情感 10%)
 *   - 家庭 · 孩子 · 出差 · 脆弱时刻 · 城市 · 食物 · 旅途
 *   - 情绪特征:温度 · 人味 · 不装
 *
 * 启发式映射(不走 LLM,避免打破 hls 缓存):
 *   - hook_type = 实用 / 观点(含数字) → A
 *   - hook_type = 反常识 / 观点(无数字) → B
 *   - hook_type = 故事 / 地理见闻 → C
 *   - tags / context_note 里出现 $金额 / MRR / user_count / 架构词 → 向 A 倾斜
 */

// 各平台方案比例(品牌方案第 3 节表格)
const PLATFORM_WEIGHTS = {
    // 每平台对 A/B/C 的偏好权重
    douyin:   { A: 0.30, B: 0.50, C: 0.20 },
    kuaishou: { A: 0.30, B: 0.50, C: 0.20 },
    xhs:      { A: 0.20, B: 0.30, C: 0.50 },
    channel:  { A: 0.50, B: 0.30, C: 0.20 },
    gzh:      { A: 0.40, B: 0.50, C: 0.10 },
    twitter:  { A: 0.80, B: 0.20, C: 0.00 }
};

const PILLAR_INFO = {
    A: { name: 'Build in Public', short: '硬核', color: '\x1b[36m', emoji: '🛠' },
    B: { name: '主权思想', short: '思想', color: '\x1b[33m', emoji: '🧠' },
    C: { name: '真实生活', short: '生活', color: '\x1b[35m', emoji: '🌸' }
};

// 关键词指纹 — 命中强烈暗示某个 pillar
const A_KEYWORDS = /MRR|ARR|\$\d|收入|用户数|付费|退款|架构|部署|API|数据库|bug|代码|工程|系统|栈|SaaS/i;
const B_KEYWORDS = /主权|契约精神|反脆弱|杠杆|降维打击|势能|闭环|本质|地缘|博弈|套利|数字游民|bootstrap/i;
const C_KEYWORDS = /老婆|女儿|儿子|爸爸|妈妈|家人|家庭|出差|酒店|航班|机场|街头|吃|早餐|朋友|生日|结婚/i;

function classifySeg(seg) {
    if (!seg) return { pillar: 'A', confidence: 0.3, reason: '无输入默认' };

    const hookType = String(seg.hook_type || '').trim();
    const context = String(seg.context_note || '').trim();
    const value = String(seg.value_note || '').trim();
    const tags = Array.isArray(seg.tags) ? seg.tags.join(' ') : '';
    const title = String(seg.title || seg.suggested_headline || '').trim();
    const corpus = [hookType, context, value, tags, title].join(' ');

    const scores = { A: 0, B: 0, C: 0 };

    // 基础分:按 hook_type
    const hookMap = {
        反常识: { B: 0.6, A: 0.2, C: 0.2 },
        观点:   { B: 0.5, A: 0.3, C: 0.2 },
        实用:   { A: 0.6, B: 0.3, C: 0.1 },
        提问:   { B: 0.4, A: 0.3, C: 0.3 },
        故事:   { C: 0.5, B: 0.3, A: 0.2 },
        地理见闻: { C: 0.6, B: 0.3, A: 0.1 }
    };
    const hookWeights = hookMap[hookType] || { A: 0.34, B: 0.33, C: 0.33 };
    for (const k of ['A', 'B', 'C']) scores[k] += hookWeights[k];

    // 关键词指纹加成
    if (A_KEYWORDS.test(corpus)) scores.A += 0.4;
    if (B_KEYWORDS.test(corpus)) scores.B += 0.4;
    if (C_KEYWORDS.test(corpus)) scores.C += 0.4;

    // 找最大
    let best = 'A';
    let bestScore = scores.A;
    for (const k of ['B', 'C']) {
        if (scores[k] > bestScore) { best = k; bestScore = scores[k]; }
    }
    // 归一化成 0-1 置信度
    const total = scores.A + scores.B + scores.C;
    const confidence = total > 0 ? bestScore / total : 0.33;

    return {
        pillar: best,
        confidence: Number(confidence.toFixed(2)),
        scores,
        reason: buildReason(hookType, corpus, scores, best)
    };
}

function buildReason(hookType, corpus, scores, pillar) {
    const parts = [];
    if (hookType) parts.push(`hook_type=${hookType}`);
    if (pillar === 'A' && A_KEYWORDS.test(corpus)) parts.push('含 Build 关键词');
    if (pillar === 'B' && B_KEYWORDS.test(corpus)) parts.push('含思想关键词');
    if (pillar === 'C' && C_KEYWORDS.test(corpus)) parts.push('含生活关键词');
    return parts.join(' · ') || '加权计分';
}

/**
 * 按 pillar 给出平台发布优先级列表(priority-sorted)。
 */
function rankPlatforms(pillar) {
    const entries = Object.entries(PLATFORM_WEIGHTS).map(([k, w]) => ({
        platform: k,
        weight: w[pillar] || 0
    }));
    entries.sort((a, b) => b.weight - a.weight);
    return entries;
}

/**
 * 渲染一段 markdown 说明(distribute README / cross-lang README 用)
 */
function renderPillarMd(classification) {
    const info = PILLAR_INFO[classification.pillar] || PILLAR_INFO.A;
    const ranking = rankPlatforms(classification.pillar);
    const lines = [];
    lines.push(`## 📊 内容支柱分类`);
    lines.push('');
    lines.push(`- **Pillar**: ${info.emoji} **${classification.pillar} · ${info.name}**(${info.short})  置信度 ${classification.confidence}`);
    lines.push(`- **判断依据**: ${classification.reason}`);
    lines.push('');
    lines.push(`## 🎯 推荐发布优先级`);
    lines.push('');
    lines.push('| 排名 | 平台 | 该 pillar 权重 | 备注 |');
    lines.push('|---|---|---|---|');
    const NAME = { douyin: '抖音', kuaishou: '快手', xhs: '小红书', channel: '视频号', gzh: '公众号', twitter: 'Twitter' };
    ranking.forEach((r, i) => {
        const star = i < 2 ? '⭐⭐' : i < 4 ? '⭐' : '';
        lines.push(`| ${i + 1} | ${NAME[r.platform] || r.platform} | ${(r.weight * 100).toFixed(0)}% | ${star} |`);
    });
    lines.push('');
    lines.push(`> Top 2 平台是这条内容的"主战场",建议优先精修其文案。`);
    return lines.join('\n');
}

module.exports = { classifySeg, rankPlatforms, renderPillarMd, PLATFORM_WEIGHTS, PILLAR_INFO };
