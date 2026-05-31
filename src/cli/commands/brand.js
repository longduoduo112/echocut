const fs = require('fs');
const path = require('path');
const { listAvailableBrands, loadBrandFile, BRANDS_DIR } = require('../../services/brandLoader');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m',
    bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function printBrand(b) {
    console.log(`\n${C.bold}${C.cyan}${b.id}${C.reset} — ${b.displayName || ''}`);
    console.log(`${C.gray}身份${C.reset}`);
    console.log(`  姓名      ${b.identity?.name || ''}`);
    if (b.identity?.realName) console.log(`  真名      ${b.identity.realName}`);
    if (b.identity?.title)    console.log(`  头衔      ${b.identity.title}`);
    if (b.identity?.slogan)   console.log(`  Slogan    ${b.identity.slogan}`);
    console.log(`${C.gray}视觉${C.reset}`);
    console.log(`  品牌胶囊  ${b.visual?.brandTag || ''}`);
    console.log(`  胶囊底色  ${b.visual?.tagBgColor || ''}`);
    console.log(`  胶囊字色  ${b.visual?.tagTextColor || ''}`);
    const cover = b.visual?.coverTemplate || '';
    const coverAbs = cover && path.isAbsolute(cover) ? cover : path.resolve(process.cwd(), cover);
    const coverExists = cover && fs.existsSync(coverAbs);
    console.log(`  封面模板  ${cover} ${coverExists ? C.green + '✓' : C.red + '✗ 不存在'}${C.reset}`);
    console.log(`${C.gray}CTA 尾卡${C.reset}`);
    console.log(`  主标题    ${b.cta?.title || ''}`);
    console.log(`  副标题    ${b.cta?.subtitle || ''}`);
    console.log(`  提示文字  ${b.cta?.hint || ''}`);
    console.log(`${C.gray}BGM${C.reset}`);
    console.log(`  默认      ${b.bgm?.defaultName || ''}`);
    console.log(`  默认音量  ${b.bgm?.defaultVolume ?? ''}`);
    console.log(`${C.gray}LLM Prompts${C.reset}`);
    console.log(`  personaBase        ${(b.llm?.personaBase || '').slice(0, 50)}${(b.llm?.personaBase || '').length > 50 ? '…' : ''}`);
    console.log(`  articleModes       ${Object.keys(b.llm?.articleModes || {}).join(', ') || '(无)'}`);
    console.log(`  momentsPrompt      ${b.llm?.momentsPrompt ? C.green + '✓' : C.red + '✗'}${C.reset}`);
    console.log(`  videoMetadataPrompt ${b.llm?.videoMetadataPrompt ? C.green + '✓' : C.red + '✗'}${C.reset}`);
    console.log(`  captionEmphasisPrompt ${b.llm?.captionEmphasisPrompt ? C.green + '✓' : C.red + '✗'}${C.reset}`);
    console.log(`  videoPublishPrompt ${b.llm?.videoPublishPrompt ? C.green + '✓' : C.red + '✗'}${C.reset}`);
    console.log(`${C.gray}ASR 专词表${C.reset}  ${(b.asrDomainKeywords || []).length} 个`);
}

function printChecklist(b) {
    const name = b.identity?.name || b.id;
    const realName = b.identity?.realName || '';
    const slogan = b.identity?.slogan || '';
    const taglineZh = b.identity?.taglineZh || '(未配置 taglineZh,建议加一句)';
    const taglineEn = b.identity?.taglineEn || '(未配置 taglineEn,建议加一句)';
    const tag = b.visual?.brandTag || '@' + name;

    console.log(`\n${C.bold}${C.cyan}📋 品牌资产 checklist · ${b.id}${C.reset}`);
    console.log(`${C.gray}对照品牌方案附录 A + 第 2 节视觉统一 + 第 6 节缺陷 3 身份一致${C.reset}`);
    console.log('');

    console.log(`${C.bold}1. 各平台 bio/简介统一(附录 A)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} Twitter bio:  ${C.cyan}${taglineEn}${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 视频号简介:   ${C.cyan}${taglineZh}${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 公众号简介:   ${C.cyan}${taglineZh} · 每周一更 · 数据、收入、真实失败${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 小红书简介:   ${C.cyan}${taglineZh} · 记录真实商业与生活${C.reset}`);
    console.log('');

    console.log(`${C.bold}2. 公众号改名建议(附录 A 第 3 条)${C.reset}`);
    if (name === 'Example') {
        console.log(`   ${C.gray}·${C.reset} "Example幸福成长说" → ${C.cyan}"Example · 数字游民创业周刊"${C.reset}(去掉旧人设)`);
    } else {
        console.log(`   ${C.gray}·${C.reset} 建议改名为:${C.cyan}"${name} · 数字游民创业周刊"${C.reset}(或你自己的方向)`);
    }
    console.log('');

    console.log(`${C.bold}3. 视觉统一资产(第 2 节)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 头像:  ${C.yellow}所有平台用同一张${C.reset}(建议巴厘岛那张人像)`);
    console.log(`   ${C.gray}·${C.reset} 品牌主色: ${b.visual?.tagBgColor || '(未配置)'} ${b.visual?.brandPrimary ? '(brandPrimary=' + b.visual.brandPrimary + ')' : ''}`);
    console.log(`   ${C.gray}·${C.reset} 品牌胶囊: ${tag}`);
    console.log(`   ${C.gray}·${C.reset} 字幕字体: ${b.visual?.titleFont || '(默认)'}  ${C.gray}—— 所有视频锁死不换${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} BGM 固定: ${b.bgm?.defaultName || '(未配置)'}  ${C.gray}—— 听到就知道是你${C.reset}`);
    console.log('');

    console.log(`${C.bold}4. Outro 统一口号(3 秒)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 中文视频结尾: ${C.cyan}"我是 ${name},下次见。"${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 英文视频结尾: ${C.cyan}"I'm ${realName || 'Bill Li'}. See you next week."${C.reset}`);
    if (slogan) console.log(`   ${C.gray}·${C.reset} 可选 slogan 补:  ${C.cyan}"${slogan}"${C.reset}`);
    console.log('');

    console.log(`${C.bold}5. CTA 统一(第 6 节缺陷 2)${C.reset}`);
    if (b.cta?.articleFooter) {
        const preview = String(b.cta.articleFooter).replace(/\n/g, ' | ').slice(0, 80);
        console.log(`   ${C.gray}·${C.reset} ${C.green}✓${C.reset} articleFooter 已配置: ${C.cyan}${preview}${C.reset}…`);
    } else {
        console.log(`   ${C.gray}·${C.reset} ${C.red}✗${C.reset} articleFooter 未配置 — 建议到 brand.json 加一段长文 CTA`);
    }
    if (b.cta?.shortFooter) {
        console.log(`   ${C.gray}·${C.reset} ${C.green}✓${C.reset} shortFooter 已配置: ${C.cyan}${b.cta.shortFooter}${C.reset}`);
    } else {
        console.log(`   ${C.gray}·${C.reset} ${C.red}✗${C.reset} shortFooter 未配置 — 朋友圈/小红书短 CTA 建议加`);
    }
    console.log('');

    console.log(`${C.bold}6. 平台 10 禁忌(第 9 节)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} ❌ 朋友圈不发英文   ${C.gray}(90% 中文受众,英文显装)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} ❌ 中文公域不发英文 ${C.gray}(两个池子分开)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} ❌ 推特不发中文     ${C.gray}(同上)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} ❌ 内地公域不用"主权个人/网络国家/主权货币"`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不再投视频号流量 ${C.gray}(历史僵尸粉已 25-35%)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不用家人名字做营销`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不秀奢侈`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不讲未验证的技术概念当噱头`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不做成功学`);
    console.log(`   ${C.gray}·${C.reset} ❌ 不假装每天都在赢  ${C.gray}(真失败 = 最强内容)${C.reset}`);
    console.log('');

    console.log(`${C.bold}7. 每周节奏模板(第 4 节)${C.reset}`);
    console.log(`   ${C.gray}·${C.reset} 周一  录 1 条 Build Log 6-10 分钟 + echocut 全自动分发`);
    console.log(`   ${C.gray}·${C.reset} 周二  Twitter daily log(1 条,英文)`);
    console.log(`   ${C.gray}·${C.reset} 周三  视频号 21:00 固定直播 30 分钟`);
    console.log(`   ${C.gray}·${C.reset} 周四  B 类思想短视频(观点钩子)`);
    console.log(`   ${C.gray}·${C.reset} 周五  周五答疑(公众号或长推特)`);
    console.log(`   ${C.gray}·${C.reset} 周六  朋友圈数据卡片(MRR / 用户增长)`);
    console.log(`   ${C.gray}·${C.reset} 周日  休息`);
    console.log('');

    console.log(`${C.gray}这份 checklist 是静态模板,不调 LLM。${C.reset}`);
    console.log(`${C.gray}详细方案: Life-Coach-Everything/think/2026-04-18-brand-content-system.md${C.reset}`);
    console.log(`${C.gray}落地报告: docs/BRAND-MARKETING-IMPL-REPORT.md${C.reset}\n`);
}

module.exports = async function brand(opts) {
    const brands = listAvailableBrands();

    if (opts.checklist) {
        const targetId = typeof opts.checklist === 'string' ? opts.checklist : (opts.show || 'example');
        try {
            const b = loadBrandFile(targetId);
            printChecklist(b);
        } catch (err) {
            console.error(`${C.red}✗${C.reset} ${err.message}`);
            process.exit(1);
        }
        return;
    }

    if (opts.show) {
        try {
            const b = loadBrandFile(opts.show);
            printBrand(b);
        } catch (err) {
            console.error(`${C.red}✗${C.reset} ${err.message}`);
            process.exit(1);
        }
        return;
    }

    console.log(`\n${C.bold}${C.cyan}🎨 echocut brand${C.reset}`);
    console.log(`   ${C.gray}目录${C.reset}   ${BRANDS_DIR}`);
    console.log(`   ${C.gray}数量${C.reset}   ${brands.length} 个品牌`);
    console.log('');
    if (!brands.length) {
        console.log(`   ${C.yellow}(空)${C.reset} 参考 configs/brands/_README.md 创建你的第一个品牌`);
        return;
    }
    for (const id of brands) {
        try {
            const b = loadBrandFile(id);
            console.log(`  ${C.green}●${C.reset} ${C.bold}${id}${C.reset} — ${b.displayName || ''}  ${C.gray}(${b.identity?.name || ''})${C.reset}`);
        } catch (err) {
            console.log(`  ${C.red}●${C.reset} ${id} — ${C.red}加载失败${C.reset} ${err.message.slice(0, 80)}`);
        }
    }
    console.log(`\n${C.gray}用法${C.reset}`);
    console.log(`  echocut brand --show <id>               查看详情`);
    console.log(`  echocut brand --checklist [id]          品牌 7 点资产清单(bio/改名/视觉/CTA/禁忌/节奏)`);
    console.log(`  echocut burn <file> --brand <id>        用指定品牌烧片`);
    console.log(`  echocut highlights <file> --brand <id>  用指定品牌切精华`);
    console.log('');
};
