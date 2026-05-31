/**
 * ctaComposer 单元测试 - CTA 文案组装(长文 + 短文两套)
 * 运行: node --test tests/ctaComposer.test.js
 *
 * 关键守护点:
 *   composeArticleCta 优先级:cliCta > brand.cta.articleFooter > title+subtitle > null
 *   composeShortCta  优先级:cliCta > brand.cta.shortFooter > title+subtitle > ''
 *   - cta.enabled === false 时一律不输出
 *   - 长文 wrap 加 \n\n---\n\n 分隔,短文用 \n\n
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { composeArticleCta, composeShortCta } = require('../src/lib/ctaComposer');

// ─── composeArticleCta ────────────────────────────────────────────────────

test('composeArticleCta: cliCta 是最高优先级', () => {
    const out = composeArticleCta({
        brand: { cta: { articleFooter: '来自 brand', title: 't', subtitle: 's' } },
        cliCta: '一次性 CTA'
    });
    assert.ok(out.includes('一次性 CTA'));
    assert.ok(!out.includes('来自 brand'));
});

test('composeArticleCta: brand.cta.articleFooter 次优(无 cliCta)', () => {
    const out = composeArticleCta({
        brand: { cta: { articleFooter: '关注我的 newsletter', title: '关注Example', subtitle: 's' } }
    });
    assert.ok(out.includes('关注我的 newsletter'));
    assert.ok(!out.includes('关注Example'));
});

test('composeArticleCta: 都没 footer 时 fallback title+subtitle', () => {
    const out = composeArticleCta({
        brand: { cta: { title: '关注 @example', subtitle: '陪你幸福成长' } }
    });
    assert.ok(out.includes('**关注 @example**'), '标题应该被 ** 包裹');
    assert.ok(out.includes('陪你幸福成长'));
});

test('composeArticleCta: 没 cta 返回 null', () => {
    assert.equal(composeArticleCta({ brand: {} }), null);
    assert.equal(composeArticleCta({ brand: null }), null);
    assert.equal(composeArticleCta({}), null);
});

test('composeArticleCta: cta.enabled === false 时返回 null', () => {
    const out = composeArticleCta({
        brand: { cta: { enabled: false, articleFooter: '不应该出现' } }
    });
    assert.equal(out, null);
});

test('composeArticleCta: title 空 + subtitle 也空 → null', () => {
    const out = composeArticleCta({ brand: { cta: { title: '', subtitle: '' } } });
    assert.equal(out, null);
});

test('composeArticleCta: 只有 title 也行', () => {
    const out = composeArticleCta({ brand: { cta: { title: '只有标题' } } });
    assert.ok(out.includes('**只有标题**'));
});

test('composeArticleCta: 输出有 markdown 分隔符 ---', () => {
    const out = composeArticleCta({ brand: { cta: { articleFooter: 'x' } } });
    assert.ok(out.includes('---'), '应该有分隔横线');
    assert.ok(out.startsWith('\n\n'), '前面应有空行');
});

test('composeArticleCta: 空白字符串 cliCta 应回落到 brand', () => {
    const out = composeArticleCta({
        brand: { cta: { articleFooter: 'brand footer' } },
        cliCta: '   '
    });
    assert.ok(out.includes('brand footer'), '纯空白不算覆盖');
});

// ─── composeShortCta ──────────────────────────────────────────────────────

test('composeShortCta: cliCta 最高优先级', () => {
    const out = composeShortCta({
        brand: { cta: { shortFooter: 'brand short' } },
        cliCta: 'cli short'
    });
    assert.equal(out, '\n\ncli short');
});

test('composeShortCta: shortFooter 次优', () => {
    const out = composeShortCta({
        brand: { cta: { shortFooter: '↓ 关注我 ↓', articleFooter: '长文用' } }
    });
    assert.equal(out, '\n\n↓ 关注我 ↓');
    assert.ok(!out.includes('长文用'));
});

test('composeShortCta: fallback title · subtitle 用中点连接', () => {
    const out = composeShortCta({
        brand: { cta: { title: '关注 @example', subtitle: '陪你成长' } }
    });
    assert.equal(out, '\n\n关注 @example · 陪你成长');
});

test('composeShortCta: 啥都没有返回空字符串(不是 null)', () => {
    assert.equal(composeShortCta({ brand: {} }), '');
    assert.equal(composeShortCta({}), '');
    assert.equal(composeShortCta({ brand: { cta: {} } }), '');
});

test('composeShortCta: cta.enabled=false 返回空', () => {
    const out = composeShortCta({
        brand: { cta: { enabled: false, shortFooter: '不要出现' } }
    });
    assert.equal(out, '');
});

test('composeShortCta: 短文不带 --- 分隔(跟长文区别)', () => {
    const out = composeShortCta({ brand: { cta: { shortFooter: 'x' } } });
    assert.ok(!out.includes('---'));
});
