/**
 * Brand Loader — 多用户品牌配置加载器
 *
 * 加载 configs/brands/<id>.json,做占位符插值,提供统一访问接口。
 * 支持三种加载源(按优先级):
 *   1. env ZDE_BRAND_CONFIG (JSON 字符串,子进程穿透用)
 *   2. env ZDE_DEFAULT_BRAND + 文件
 *   3. 默认 example
 *
 * 占位符:所有 llm.* 字段自动替换
 *   {{name}}        → identity.name
 *   {{realName}}    → identity.realName
 *   {{title}}       → identity.title
 *   {{slogan}}      → identity.slogan
 *   {{description}} → identity.description
 *   {{personaBase}} → llm.personaBase(二次展开,让其他 prompt 可以内嵌人格)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BRANDS_DIR = path.resolve(__dirname, '..', '..', 'configs', 'brands');
const DEFAULT_BRAND_ID = 'example';

let cachedBrand = null;

function brandFilePath(id) {
    return path.join(BRANDS_DIR, `${id}.json`);
}

function listAvailableBrands() {
    if (!fs.existsSync(BRANDS_DIR)) return [];
    return fs.readdirSync(BRANDS_DIR)
        .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
        .map((name) => name.replace(/\.json$/, ''));
}

function interpolate(template, vars) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        // 未知占位符保留,等下一轮插值处理(支持两轮:identity → personaBase)
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null) {
            return String(vars[key]);
        }
        return match;
    });
}

function deepInterpolate(node, vars) {
    if (typeof node === 'string') return interpolate(node, vars);
    if (Array.isArray(node)) return node.map((x) => deepInterpolate(x, vars));
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v, vars);
        return out;
    }
    return node;
}

function interpolateBrand(raw) {
    const vars = {
        name: raw?.identity?.name || '',
        realName: raw?.identity?.realName || '',
        title: raw?.identity?.title || '',
        slogan: raw?.identity?.slogan || '',
        description: raw?.identity?.description || ''
    };
    // 第一轮:把 identity 相关的占位符全部展开
    const firstPass = deepInterpolate(raw, vars);
    // 第二轮:把 {{personaBase}} 嵌入到其他 prompt
    const personaBase = firstPass?.llm?.personaBase || '';
    const varsWithPersona = { ...vars, personaBase };
    return deepInterpolate(firstPass, varsWithPersona);
}

function loadBrandFile(id) {
    const file = brandFilePath(id);
    if (!fs.existsSync(file)) {
        throw new Error(`[brand] 品牌配置不存在: ${file}。可用品牌: ${listAvailableBrands().join(', ') || '(空)'}`);
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return interpolateBrand(raw);
    } catch (err) {
        throw new Error(`[brand] 解析 ${file} 失败: ${err.message}`);
    }
}

/**
 * 加载品牌配置(含缓存)
 * 优先级:
 *   1. process.env.ZDE_BRAND_CONFIG (JSON 字符串,已插值)
 *   2. 传参 id
 *   3. process.env.ZDE_DEFAULT_BRAND
 *   4. example (兜底)
 */
function loadBrand(id) {
    if (cachedBrand) return cachedBrand;

    // 1. 子进程穿透:直接读 env 里的 JSON 字符串(已插值)
    const envConfig = process.env.ZDE_BRAND_CONFIG;
    if (envConfig) {
        try {
            cachedBrand = JSON.parse(envConfig);
            return cachedBrand;
        } catch (err) {
            console.warn(`[brand] ZDE_BRAND_CONFIG 解析失败,fallback 到文件加载: ${err.message}`);
        }
    }

    // 2. 参数 / env / 默认
    const targetId = id || process.env.ZDE_DEFAULT_BRAND || DEFAULT_BRAND_ID;
    cachedBrand = loadBrandFile(targetId);
    return cachedBrand;
}

/**
 * 重置缓存(测试 / 切换品牌时用)
 */
function resetBrandCache() {
    cachedBrand = null;
}

/**
 * 序列化品牌为 env 字符串,供子进程透传
 */
function brandToEnvString(brand) {
    return JSON.stringify(brand);
}

/**
 * 解析绝对路径:visual.coverTemplate 等字段可能是相对项目根目录的路径
 * 2026-04-23 bug 修复:原本用 process.cwd(),用户在其他目录下调命令会解析错
 * 现在优先 ZDE_PROJECT_ROOT(bin 入口注入),没有则 fallback cwd
 */
function resolveBrandAsset(brand, relOrAbs) {
    if (!relOrAbs) return '';
    if (path.isAbsolute(relOrAbs)) return relOrAbs;
    const base = process.env.ZDE_PROJECT_ROOT || process.cwd();
    return path.resolve(base, relOrAbs);
}

module.exports = {
    loadBrand,
    loadBrandFile,
    resetBrandCache,
    brandToEnvString,
    resolveBrandAsset,
    listAvailableBrands,
    interpolateBrand,
    DEFAULT_BRAND_ID,
    BRANDS_DIR
};
