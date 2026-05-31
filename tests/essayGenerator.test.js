/**
 * essayGenerator 单元测试 — 纯函数 + 输入校验
 * 运行: node --test tests/essayGenerator.test.js
 *
 * 关键守护点:
 *   - cleanupMarkdown 剥 ```markdown``` fence + 头部"以下是"元话语
 *   - buildUserMessage 拼装顺序稳定(context → transcript → 任务)
 *   - STYLES / MODELS / PROMPTS 三件常量结构齐全
 *   - generateEssay 输入校验抛 invalid_input
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    cleanupMarkdown,
    buildUserMessage,
    STYLES,
    MODELS,
    PROMPTS,
    generateEssay
} = require('../src/services/essayGenerator');

// ─── 常量结构 ─────────────────────────────────────────────────────────────

test('STYLES: 三种风格 structured / narrative / hardcore', () => {
    assert.deepEqual(STYLES, ['structured', 'narrative', 'hardcore']);
});

test('MODELS: 两种模型 ollama / minimax', () => {
    assert.deepEqual(MODELS, ['ollama', 'minimax']);
});

// v06: PROMPTS 不再有 `system` 字段,改用 `systemFirst` / `systemThird`
// 用 pickSystemPrompt 工具拿对应 voice 的 system
const { pickSystemPrompt, VOICES } = require('../src/services/essayGenerator');

test('VOICES: first / third 两种口吻', () => {
    assert.deepEqual(VOICES, ['first', 'third']);
});

test('PROMPTS: 每个风格都有 label / targetCharCount / systemFirst / systemThird', () => {
    for (const s of STYLES) {
        const p = PROMPTS[s];
        assert.ok(p, `${s} 不能缺 prompt`);
        assert.ok(p.label, 'label 必填');
        assert.ok(p.targetCharCount, 'targetCharCount 必填');
        for (const voice of ['first', 'third']) {
            const sys = pickSystemPrompt(p, voice);
            assert.ok(sys && sys.length > 200, `${s} × ${voice} system 应该是完整 prompt`);
            // 排版铁律和转译规则必须注入(共享地基)
            assert.ok(sys.includes('排版铁律'), `${s} × ${voice} 必须注入排版铁律`);
            assert.ok(sys.includes('口播→文章转译规则'), `${s} × ${voice} 必须注入转译规则`);
            assert.ok(sys.includes('事实保真'), `${s} × ${voice} 应有"事实保真"硬约束`);
            assert.ok(sys.includes('反 AI 味 12 条'), `${s} × ${voice} 必须注入反 AI 味 12 条`);
            assert.ok(sys.includes('自检清单'), `${s} × ${voice} 必须注入自检清单`);
            // v06 新增: Example命名固化
            assert.ok(sys.includes('Example'), `${s} × ${voice} 必须包含"Example"主角命名`);
        }
    }
});

test('PROMPTS: 三位老编辑人设分明(structured=老刘/narrative=老何/hardcore=老吴)', () => {
    assert.ok(pickSystemPrompt(PROMPTS.structured, 'first').includes('老刘'), 'structured 应用老刘人设');
    assert.ok(pickSystemPrompt(PROMPTS.narrative, 'first').includes('老何'), 'narrative 应用老何人设');
    assert.ok(pickSystemPrompt(PROMPTS.hardcore, 'first').includes('老吴'), 'hardcore 应用老吴人设');
});

test('PROMPTS: 所有 prompt 都明确禁用号召式结尾', () => {
    for (const s of STYLES) {
        for (const voice of ['first', 'third']) {
            const sys = pickSystemPrompt(PROMPTS[s], voice);
            assert.ok(/愿你|共勉|号召|从今天开始/.test(sys), `${s} × ${voice} 应该提到要禁用号召式结尾`);
        }
    }
});

test('PROMPTS: 都包含"X 不是 A,而是 B" 句式限制', () => {
    for (const s of STYLES) {
        const sys = pickSystemPrompt(PROMPTS[s], 'first');
        assert.ok(/不是 A.*而是 B|句式.*1 次|句式.*2 次/.test(sys),
            `${s} 应有 X 不是 A 而是 B 句式限制`);
    }
});

test('PROMPTS v06: first vs third 系统提示词的人称指引明显不同', () => {
    for (const s of STYLES) {
        const first = pickSystemPrompt(PROMPTS[s], 'first');
        const third = pickSystemPrompt(PROMPTS[s], 'third');
        assert.ok(first.includes('第一人称'), `${s} systemFirst 必须有第一人称指引`);
        assert.ok(third.includes('第三人称'), `${s} systemThird 必须有第三人称指引`);
        // 各自禁用对方的语境
        assert.ok(third.includes('旁观'), `${s} systemThird 必须有旁观叙述者概念`);
    }
});

test('PROMPTS v06: 全程禁用 Bill,统一Example', () => {
    for (const s of STYLES) {
        for (const voice of ['first', 'third']) {
            const sys = pickSystemPrompt(PROMPTS[s], voice);
            // prompt 里出现 "Bill" 的只允许在"禁用/不准 Bill"语境
            const billMentions = (sys.match(/Bill/g) || []).length;
            const billProhibits = (sys.match(/不准用 ["「]Bill|绝对不准用 ["*]?\*?Bill|不用["「]Bill/g) || []).length;
            assert.ok(billMentions === 0 || billMentions <= billProhibits + 2,
                `${s} × ${voice} 里 Bill 提到 ${billMentions} 次,但只有 ${billProhibits} 处是禁用语境`);
        }
    }
});

// ─── cleanupMarkdown ─────────────────────────────────────────────────────

test('cleanupMarkdown: 剥 ```markdown 头 + ``` 尾', () => {
    const raw = '```markdown\n# 标题\n\n正文\n```';
    assert.equal(cleanupMarkdown(raw), '# 标题\n\n正文');
});

test('cleanupMarkdown: 剥纯 ``` 包裹', () => {
    const raw = '```\n# 标题\n```';
    assert.equal(cleanupMarkdown(raw), '# 标题');
});

test('cleanupMarkdown: 剥头部元话语"好的"', () => {
    const raw = '好的,以下是文章:\n# 标题\n正文';
    const out = cleanupMarkdown(raw);
    assert.ok(out.startsWith('# 标题'), `应剥掉"好的"那行,实际: ${out.slice(0, 30)}`);
});

test('cleanupMarkdown: 剥头部"这是"', () => {
    const raw = '这是根据你的转写生成的文章:\n# 标题\n正文';
    const out = cleanupMarkdown(raw);
    assert.ok(out.startsWith('# 标题'));
});

test('cleanupMarkdown: 真正的 markdown 内容里"好的"不被误剥', () => {
    // 第一行长度 > 80,或者后面再出现"好的"不该被吃掉
    const raw = '# 文章标题\n\n正文里说"好的我们继续"这种引用不该被影响';
    assert.equal(cleanupMarkdown(raw), raw);
});

test('cleanupMarkdown: 空输入返回空字符串', () => {
    assert.equal(cleanupMarkdown(''), '');
    assert.equal(cleanupMarkdown(null), '');
    assert.equal(cleanupMarkdown(undefined), '');
});

test('cleanupMarkdown: trim 头尾空白', () => {
    assert.equal(cleanupMarkdown('\n\n   # 标题\n  '), '# 标题');
});

// ─── buildUserMessage ────────────────────────────────────────────────────

test('buildUserMessage: 包含 transcript 全文 + 任务说明', () => {
    const msg = buildUserMessage({
        transcript: '我今天聊聊出海',
        context: { title: '出海主体选择' },
        style: 'structured'
    });
    assert.ok(msg.includes('出海主体选择'), '应注入 title');
    assert.ok(msg.includes('我今天聊聊出海'), '应注入 transcript');
    // v05 label = "老刘流·结构清晰派"(不再是 v01 的"结构化观点流")
    assert.ok(/老刘流|结构化|结构清晰/.test(msg), '应注入 structured 风格 label');
    assert.ok(msg.includes('Markdown'), '应明确要求 markdown');
});

test('buildUserMessage: 缺 context 字段时不 crash,只跳过那行', () => {
    const msg = buildUserMessage({
        transcript: '随便',
        context: {},
        style: 'narrative'
    });
    assert.ok(msg.includes('随便'));
    assert.ok(msg.includes('未提供') || !msg.includes('【副标题】'), 'subline 不存在就不该出现该行');
});

test('buildUserMessage: brandName 出现在作者身份里', () => {
    const msg = buildUserMessage({
        transcript: 't',
        context: { brandName: 'Example(数字游民创业者)' },
        style: 'hardcore'
    });
    assert.ok(msg.includes('Example'));
    assert.ok(msg.includes('作者身份'));
});

test('buildUserMessage: voice 字段会写进 user message', () => {
    const a = buildUserMessage({ transcript: 't', context: {}, style: 'structured', voice: 'first' });
    const b = buildUserMessage({ transcript: 't', context: {}, style: 'structured', voice: 'third' });
    assert.ok(a.includes('第一人称'), 'first 应在 user message 里标第一人称');
    assert.ok(b.includes('第三人称'), 'third 应在 user message 里标第三人称');
});

test('buildUserMessage: 不同 style 用不同 label(v05 命名)', () => {
    const a = buildUserMessage({ transcript: 't', context: {}, style: 'structured' });
    const b = buildUserMessage({ transcript: 't', context: {}, style: 'narrative' });
    const c = buildUserMessage({ transcript: 't', context: {}, style: 'hardcore' });
    // v05 label: 老刘流/老何流/老吴流 — 用人设关键字判定
    assert.ok(/老刘|结构/.test(a), 'structured 应有"老刘/结构"标识');
    assert.ok(/老何|叙事/.test(b), 'narrative 应有"老何/叙事"标识');
    assert.ok(/老吴|硬核|反共识/.test(c), 'hardcore 应有"老吴/硬核/反共识"标识');
});

// ─── generateEssay 输入校验 ───────────────────────────────────────────────

test('generateEssay: 空 transcript 抛错', async () => {
    await assert.rejects(
        () => generateEssay({ transcript: '', style: 'structured', model: 'ollama' }),
        /transcript 不能为空/
    );
});

test('generateEssay: 未知 style 抛错', async () => {
    await assert.rejects(
        () => generateEssay({ transcript: 'x', style: 'mystery', model: 'ollama' }),
        /style 必须是/
    );
});

test('generateEssay: 未知 model 抛错', async () => {
    await assert.rejects(
        () => generateEssay({ transcript: 'x', style: 'structured', model: 'gpt5' }),
        /model 必须是/
    );
});

test('generateEssay: transcript 只有空白也算空', async () => {
    await assert.rejects(
        () => generateEssay({ transcript: '   \n\t  ', style: 'structured', model: 'ollama' })
    );
});
