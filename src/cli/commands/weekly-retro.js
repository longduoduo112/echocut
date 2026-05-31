'use strict';

/**
 * echocut weekly-retro
 *
 * 周度复盘骨架(品牌方案 7.4)。不接入真实数据源爬虫,先出 md 模板:
 *   1. 生成 weekly-retro-YYYY-MM-DD.md 模板,留空待填
 *   2. 用户填完后 --analyze 走 LLM 分析爆款/掉量原因 + 下周 3 选题
 *
 * 目录:./weekly-retros/YYYY-WW/
 */

const fs = require('fs');
const path = require('path');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function parsePeriod(str) {
    // "2026-04-14~04-20" 或 "2026-04-14~2026-04-20"
    if (!str) return null;
    const m = String(str).match(/^(\d{4}-\d{2}-\d{2})\s*[~至]\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/);
    if (!m) return null;
    const start = m[1];
    let end = m[2];
    if (end.length === 5) end = start.slice(0, 4) + '-' + end;
    return { start, end };
}

function isoWeekLabel(start) {
    const d = new Date(start + 'T00:00:00Z');
    const year = d.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const days = Math.floor((d - jan1) / 86400000);
    const week = Math.ceil((days + jan1.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

function renderTemplate({ brandId, period, weekLabel }) {
    const dateNow = new Date().toISOString().slice(0, 10);
    return `---
brand: ${brandId}
period: ${period.start} ~ ${period.end}
week: ${weekLabel}
created: ${dateNow}
status: draft
---

# Weekly Retro · ${weekLabel}

> 品牌方案 7.4 节周度复盘骨架。填完后跑 \`echocut weekly-retro --analyze ${path.basename(templatePath({period}))}\` 让 LLM 分析。

## 1. 本周产出

### 📹 视频(burn / highlights / hmk)

| 日期 | 平台 | 标题 | 链接 | 备注 |
|---|---|---|---|---|
| ${period.start} |  |  |  |  |
|  |  |  |  |  |

### 📝 文章(afc / article)

| 日期 | 平台 | 标题 | 链接 | 备注 |
|---|---|---|---|---|
|  |  |  |  |  |

### 🧵 推特 thread(cross-lang)

| 日期 | 主题 | 链接 | 备注 |
|---|---|---|---|
|  |  |  |  |

## 2. 平台数据(本周)

### 视频号

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| 真实活跃粉丝 |  |  |  |
| 最高完播率 |  |  |  |
| 评论数 |  |  |  |
| 分享数(熟人裂变) |  |  |  |

### 抖音

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| 粉丝数 |  |  |  |
| 爆款条数 (>5K views) |  |  |  |
| 平均完播率 |  |  |  |

### 小红书

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| 粉丝数 |  |  |  |
| 笔记平均点赞 |  |  |  |

### 公众号

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| 订阅数 |  |  |  |
| 单篇最高阅读 |  |  |  |

### Twitter

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| 粉丝数 |  |  |  |
| Daily build log 完成数 |  |  |  |
| 最高 impression |  |  |  |

## 3. 产品数据(Build in Public)

| 指标 | 上周 | 本周 | Δ |
|---|---|---|---|
| PainHunt MRR |  |  |  |
| PainHunt 付费用户 |  |  |  |
| Echo 活跃租户 |  |  |  |

## 4. 本周洞察(自己写)

### 爆款在哪?为啥爆?

_(2-3 句话,强制写)_

### 哪条掉量最狠?为啥?

_(2-3 句话,强制写)_

### 真实失败/卡点(诚实,这是最强内容)

_(1-2 条)_

## 5. 下周 3 个选题(候选)

1. (标题)—(角度,A/B/C pillar,目标平台)
2.
3.

## 6. 本周执行 checklist 核对(对照品牌方案第 8 节)

- [ ] 周一 Build Log 录制 + 全自动分发
- [ ] 4 条 Twitter daily log
- [ ] 视频号周三 21:00 固定直播
- [ ] 3 条抖音钩子短视频
- [ ] 2-3 条小红书笔记
- [ ] 1 篇公众号长文
- [ ] 6 条朋友圈

## 7. 下周动作(具体到天)

- 周一: _
- 周二: _
- 周三: _
- 周四: _
- 周五: _
- 周六: _
- 周日: _

---
_模板生成于 ${dateNow}_
`;
}

function templatePath({ period, brandId }) {
    const weekLabel = isoWeekLabel(period.start);
    const dirName = weekLabel;
    return path.join('weekly-retros', dirName, `weekly-retro-${brandId || 'example'}-${period.start}-${period.end}.md`);
}

async function analyzeFilledReport(filePath) {
    const { getConfig } = require('../../config');
    const { initDb } = require('../../db');
    const { ensureDefaultConfigs } = require('../../db/configRepo');
    const { callChat } = require('../../services/processor');
    const { loadBrand } = require('../../services/brandLoader');
    const _config = getConfig();
    initDb(_config.contentDbPath);
    ensureDefaultConfigs();

    const text = fs.readFileSync(filePath, 'utf8');
    let brand = null;
    try { brand = loadBrand(); } catch (_) {}
    const persona = brand?.llm?.personaBase || '';

    const systemPrompt = [
        persona,
        '',
        '你是一个品牌运营 weekly retro 分析师。读用户填好的周度复盘模板,输出:',
        '',
        '1. 爆款归因:本周爆款的真正原因是什么(不是表面的"算法推荐",而是选题/钩子/时间/情绪的哪一层)',
        '2. 掉量归因:哪条掉量?为什么?(具体到钩子或结构问题)',
        '3. 下周 3 个高置信度选题建议:每条带 A/B/C pillar 分类、主推平台、前 3 秒钩子草稿',
        '4. 2 条执行级整改:明确到行动(不说"加强互动",说"周三直播前在朋友圈发预告")',
        '',
        '冷峻具体,禁止 AI 套话和空话。'
    ].join('\n');

    const userPrompt = [
        '这是我本周填好的 weekly retro 草稿,请按上面指令分析:',
        '',
        text
    ].join('\n');

    return await callChat({
        ollamaUrl: _config.ollamaUrl,
        ollamaModel: _config.ollamaModel,
        ollamaTimeoutMs: 420000,
        ollamaRetries: 1
    }, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
}

module.exports = async function weeklyRetro(opts) {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    try { process.chdir(root); } catch (_) {}

    if (opts.analyze) {
        const filePath = path.resolve(process.cwd(), opts.analyze);
        if (!fs.existsSync(filePath)) {
            console.error(`${C.red}✗${C.reset} 文件不存在: ${filePath}`);
            process.exit(1);
        }
        console.log(`\n${C.bold}${C.cyan}📊 weekly-retro --analyze${C.reset}`);
        console.log(`   ${C.gray}文件${C.reset}  ${filePath}`);
        console.log('');
        const { Spinner } = require('../../lib/cliUtils');
        const spinner = new Spinner('LLM 分析中(1-2 分钟)').start();
        try {
            const analysis = await analyzeFilledReport(filePath);
            spinner.stop('分析完成');
            const outPath = filePath.replace(/\.md$/, '-analysis.md');
            const body = `# Weekly Retro Analysis\n\n> 来源: \`${path.basename(filePath)}\`\n> 生成: ${new Date().toISOString()}\n\n---\n\n${analysis.trim()}\n`;
            fs.writeFileSync(outPath, body, 'utf8');
            console.log('');
            console.log(analysis.trim().slice(0, 800));
            console.log('');
            console.log(`${C.green}✓${C.reset} 完整分析已存: ${C.cyan}${outPath}${C.reset}\n`);
        } catch (err) {
            spinner.fail(String(err.message || err).slice(0, 120));
            process.exit(1);
        }
        return;
    }

    const period = parsePeriod(opts.period);
    if (!period) {
        console.error(`${C.red}✗${C.reset} --period 格式应为 YYYY-MM-DD~MM-DD 或 YYYY-MM-DD~YYYY-MM-DD`);
        console.error(`   例:  echocut weekly-retro --period "2026-04-14~04-20"`);
        process.exit(1);
    }
    const brandId = opts.brand || 'example';
    const weekLabel = isoWeekLabel(period.start);
    const outPath = templatePath({ period, brandId });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (fs.existsSync(outPath) && !opts.force) {
        console.log(`\n${C.yellow}⚠${C.reset} 模板已存在,跳过创建: ${outPath}`);
        console.log(`   ${C.gray}想重新生成加 --force${C.reset}\n`);
        return;
    }
    const tpl = renderTemplate({ brandId, period, weekLabel });
    fs.writeFileSync(outPath, tpl, 'utf8');

    console.log(`\n${C.bold}${C.cyan}📊 echocut weekly-retro${C.reset}`);
    console.log(`   ${C.gray}品牌${C.reset}  ${brandId}`);
    console.log(`   ${C.gray}周期${C.reset}  ${period.start} ~ ${period.end}  (${weekLabel})`);
    console.log(`   ${C.gray}模板${C.reset}  ${C.green}${outPath}${C.reset}`);
    console.log('');
    console.log(`${C.gray}下一步${C.reset}`);
    console.log(`  1. 编辑 ${path.basename(outPath)} 填入本周数据和洞察`);
    console.log(`  2. 跑 ${C.cyan}echocut weekly-retro --analyze ${outPath}${C.reset} 让 LLM 分析`);
    console.log('');
};
