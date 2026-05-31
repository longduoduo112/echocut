/**
 * brandLoader 单元测试 - 多品牌核心(占位符 / env 穿透 / 兜底)
 * 运行: node --test tests/brandLoader.test.js
 *
 * 关键守护点:
 *   - interpolateBrand 两轮插值:identity 占位符 → personaBase 嵌入
 *   - 未知占位符保留原样不被吞
 *   - ZDE_BRAND_CONFIG env 优先级最高(子进程穿透机制)
 *   - resolveBrandAsset 用 ZDE_PROJECT_ROOT,不用 process.cwd
 *   - resetBrandCache 真清缓存
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    interpolateBrand,
    loadBrand,
    resetBrandCache,
    brandToEnvString,
    resolveBrandAsset
} = require('../src/services/brandLoader');

// ─── interpolateBrand 两轮插值 ────────────────────────────────────────────────

test('interpolateBrand: 第一轮替换 identity 字段', () => {
    const raw = {
        identity: { name: 'Example', title: '数字游民', slogan: '快乐成长' },
        cta: { title: '关注 {{name}}', subtitle: '陪你{{slogan}}' }
    };
    const out = interpolateBrand(raw);
    assert.equal(out.cta.title, '关注 Example');
    assert.equal(out.cta.subtitle, '陪你快乐成长');
});

test('interpolateBrand: 第二轮把 personaBase 注入到其他 prompt', () => {
    const raw = {
        identity: { name: '彪' },
        llm: {
            personaBase: '你是{{name}}的语气',
            articlePrompt: '基础人格:{{personaBase}}。写一篇文章。'
        }
    };
    const out = interpolateBrand(raw);
    assert.equal(out.llm.personaBase, '你是彪的语气');
    assert.equal(out.llm.articlePrompt, '基础人格:你是彪的语气。写一篇文章。');
});

test('interpolateBrand: null/undefined identity 字段安全降级为空字符串', () => {
    const raw = {
        identity: { name: '彪', realName: null, title: undefined },
        cta: { title: '{{name}} / {{realName}} / {{title}}' }
    };
    const out = interpolateBrand(raw);
    // interpolateBrand 提取 vars 时用 `|| ''`,null/undefined 都变成空字符串
    // 然后 interpolate 把占位符替换成空字符串(不抛错)
    assert.equal(out.cta.title, '彪 /  / ');
});

test('interpolateBrand: 真未声明 vars 的占位符才保留', () => {
    const raw = {
        identity: { name: '彪' },
        cta: { title: '关注 {{name}},加 {{wechat}}' } // wechat 不在 vars 列表
    };
    const out = interpolateBrand(raw);
    assert.equal(out.cta.title, '关注 彪,加 {{wechat}}', 'wechat 不在 vars 里应保留占位符');
});

test('interpolateBrand: 数组里的字符串也插值', () => {
    const raw = {
        identity: { name: '彪' },
        asrDomainKeywords: ['{{name}}', '联营', '副业']
    };
    const out = interpolateBrand(raw);
    assert.deepEqual(out.asrDomainKeywords, ['彪', '联营', '副业']);
});

test('interpolateBrand: 嵌套对象也递归插值', () => {
    const raw = {
        identity: { name: '彪' },
        llm: {
            articleModes: {
                default: { system: '我是{{name}}' },
                soul: { system: '{{name}} 的灵魂' }
            }
        }
    };
    const out = interpolateBrand(raw);
    assert.equal(out.llm.articleModes.default.system, '我是彪');
    assert.equal(out.llm.articleModes.soul.system, '彪 的灵魂');
});

// ─── loadBrand env 穿透 ─────────────────────────────────────────────────────

test('loadBrand: ZDE_BRAND_CONFIG env 是最高优先级', () => {
    const original = process.env.ZDE_BRAND_CONFIG;
    const fakeBrand = { id: 'test_inline', identity: { name: '测试' } };
    process.env.ZDE_BRAND_CONFIG = JSON.stringify(fakeBrand);
    resetBrandCache();
    try {
        const brand = loadBrand();
        assert.equal(brand.id, 'test_inline');
        assert.equal(brand.identity.name, '测试');
    } finally {
        if (original === undefined) delete process.env.ZDE_BRAND_CONFIG;
        else process.env.ZDE_BRAND_CONFIG = original;
        resetBrandCache();
    }
});

test('loadBrand: ZDE_BRAND_CONFIG 解析失败时不 crash,fallback 文件加载', () => {
    const original = process.env.ZDE_BRAND_CONFIG;
    const originalWarn = console.warn;
    process.env.ZDE_BRAND_CONFIG = '{ not valid json';
    let warned = false;
    console.warn = () => { warned = true; };
    resetBrandCache();
    try {
        const brand = loadBrand();
        assert.ok(brand.id, '应该 fallback 到默认 example');
        assert.ok(warned, '应该有 warn 输出');
    } finally {
        if (original === undefined) delete process.env.ZDE_BRAND_CONFIG;
        else process.env.ZDE_BRAND_CONFIG = original;
        console.warn = originalWarn;
        resetBrandCache();
    }
});

test('loadBrand: 缓存生效 — 两次调用返回同一对象引用', () => {
    resetBrandCache();
    delete process.env.ZDE_BRAND_CONFIG;
    const b1 = loadBrand('example');
    const b2 = loadBrand('example');
    assert.strictEqual(b1, b2, '应该返回同一对象(缓存)');
    resetBrandCache();
});

test('resetBrandCache: 重置后再读拿到新对象', () => {
    delete process.env.ZDE_BRAND_CONFIG;
    resetBrandCache();
    const b1 = loadBrand('example');
    resetBrandCache();
    const b2 = loadBrand('example');
    assert.notStrictEqual(b1, b2, '重置后应返回新对象');
});

// ─── 工具函数 ───────────────────────────────────────────────────────────────

test('brandToEnvString: 输出可被 JSON.parse 还原', () => {
    const brand = { id: 'a', identity: { name: '中文' }, n: 1 };
    const env = brandToEnvString(brand);
    const parsed = JSON.parse(env);
    assert.deepEqual(parsed, brand);
});

test('resolveBrandAsset: 绝对路径原样返回', () => {
    const abs = '/absolute/path.png';
    assert.equal(resolveBrandAsset({}, abs), abs);
});

test('resolveBrandAsset: 相对路径基于 ZDE_PROJECT_ROOT', () => {
    const original = process.env.ZDE_PROJECT_ROOT;
    process.env.ZDE_PROJECT_ROOT = '/fake/proj';
    try {
        const out = resolveBrandAsset({}, 'configs/brands/x.png');
        assert.equal(out, path.resolve('/fake/proj', 'configs/brands/x.png'));
    } finally {
        if (original === undefined) delete process.env.ZDE_PROJECT_ROOT;
        else process.env.ZDE_PROJECT_ROOT = original;
    }
});

test('resolveBrandAsset: 空字符串返回空(不 crash)', () => {
    assert.equal(resolveBrandAsset({}, ''), '');
    assert.equal(resolveBrandAsset({}, null), '');
    assert.equal(resolveBrandAsset({}, undefined), '');
});
