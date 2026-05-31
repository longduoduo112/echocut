/**
 * DB contentsRepo 单元测试（使用内存 SQLite）
 * 运行: node --test tests/contentsRepo.test.js
 */
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// 使用内存 DB，避免污染真实数据
// 注意：getDb() 返回已初始化的单例，需要在 initDb 之后调用
const { initDb } = require('../src/db');
const {
    createContent,
    getContentById,
    listRecentContents,
    updateGeneratedContent,
    updateRawText,
    appendProcessTrace,
    updateVideoPath,
    updatePublishKit
} = require('../src/db/contentsRepo');

before(() => {
    // 使用 ':memory:' 内存数据库，测试完毕自动销毁
    initDb(':memory:');
});

test('createContent: 创建成功并返回自增 ID', () => {
    const id = createContent({ rawText: '测试转写文本', status: 'pending' });
    assert.ok(typeof id === 'number' && id > 0, `期望正整数 ID，实际: ${id}`);
});

test('getContentById: 读取刚创建的条目', () => {
    const id = createContent({ rawText: '可被读取的文本', status: 'pending' });
    const item = getContentById(id);
    assert.ok(item, '应返回对象');
    assert.equal(item.id, id);
    assert.equal(item.raw_text, '可被读取的文本');
    assert.equal(item.status, 'pending');
});

test('getContentById: 不存在的 ID 返回 null', () => {
    const item = getContentById(999999);
    assert.equal(item, null);
});

test('createContent: source 字段默认为 bot', () => {
    const id = createContent({ rawText: 'bot 来源测试' });
    const item = getContentById(id);
    assert.equal(item.source, 'bot');
});

test('createContent: source 可设置为 cli', () => {
    const id = createContent({ rawText: 'cli 来源测试', source: 'cli', status: 'reviewing' });
    const item = getContentById(id);
    assert.equal(item.source, 'cli');
    assert.equal(item.status, 'reviewing');
});

test('createContent: headline/subline/publish_kit_json 字段正确存储', () => {
    const kit = JSON.stringify([{ title: '标题1', description: '简介1 #tag' }]);
    const id = createContent({
        rawText: '带宣发包的内容',
        headline: '反常识的标题',
        subline: '这才是真正的壁垒',
        publishKitJson: kit,
        source: 'cli',
        status: 'reviewing'
    });
    const item = getContentById(id);
    assert.equal(item.headline, '反常识的标题');
    assert.equal(item.subline, '这才是真正的壁垒');
    assert.equal(item.publish_kit_json, kit);
});

test('updateGeneratedContent: 更新文章与朋友圈内容', () => {
    const id = createContent({ rawText: '原始素材' });
    updateGeneratedContent(id, {
        draftArticle: '这是公众号文章',
        hookMoment: '朋友圈文案三版本',
        status: 'reviewing'
    });
    const item = getContentById(id);
    assert.equal(item.draft_article, '这是公众号文章');
    assert.equal(item.hook_moment, '朋友圈文案三版本');
    assert.equal(item.status, 'reviewing');
});

test('updateRawText: 更新转写文本', () => {
    const id = createContent({ rawText: '旧文本' });
    updateRawText(id, '新的转写文本');
    const item = getContentById(id);
    assert.equal(item.raw_text, '新的转写文本');
});

test('appendProcessTrace: 追加日志行', () => {
    const id = createContent({ rawText: '有日志的内容' });
    appendProcessTrace(id, '[第一条日志]');
    appendProcessTrace(id, '[第二条日志]');
    const item = getContentById(id);
    assert.ok(item.process_trace.includes('[第一条日志]'));
    assert.ok(item.process_trace.includes('[第二条日志]'));
    // 两条之间有换行
    assert.ok(item.process_trace.includes('\n'));
});

test('updateVideoPath: 更新视频路径', () => {
    const id = createContent({ rawText: '有视频的内容' });
    updateVideoPath(id, '/abs/path/output.mp4');
    const item = getContentById(id);
    assert.equal(item.video_output_path, '/abs/path/output.mp4');
});

test('updatePublishKit: 更新宣发素材包', () => {
    const id = createContent({ rawText: '需要更新宣发包的内容' });
    const kit = JSON.stringify([
        { title: '组一标题', description: '组一简介 #标签' },
        { title: '组二标题', description: '组二简介 #标签' }
    ]);
    updatePublishKit(id, {
        headline: '更新后标题',
        subline: '更新后副标题',
        publishKitJson: kit
    });
    const item = getContentById(id);
    assert.equal(item.headline, '更新后标题');
    assert.equal(item.subline, '更新后副标题');
    assert.equal(item.publish_kit_json, kit);
});

test('listRecentContents: 按 ID 倒序返回', () => {
    // 先创建几条
    createContent({ rawText: 'A' });
    createContent({ rawText: 'B' });
    createContent({ rawText: 'C' });
    const list = listRecentContents(3);
    assert.ok(list.length >= 3);
    // 第一条 ID 应大于最后一条（降序）
    assert.ok(list[0].id > list[list.length - 1].id);
});

test('listRecentContents: limit 参数生效', () => {
    const list = listRecentContents(2);
    assert.ok(list.length <= 2);
});
