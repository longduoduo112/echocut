const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRobustCaptions } = require('../src/video/captionUtils');

function buildMockPayload() {
    return {
        words: [
            { word: '今天', start: 0.0, end: 0.4 },
            { word: '我们', start: 0.4, end: 0.8 },
            { word: '先把', start: 0.8, end: 1.2 },
            { word: '本地调试', start: 1.2, end: 1.8 },
            { word: '流程', start: 1.8, end: 2.2 },
            { word: '跑通', start: 2.2, end: 2.7 },
            { word: '。', start: 2.7, end: 2.9 }
        ]
    };
}

function testCaptionRenderStyles() {
    const payload = buildMockPayload();
    const sentenceCaptions = buildRobustCaptions(payload, '', { renderStyle: 'sentence' });
    const wordCaptions = buildRobustCaptions(payload, '', { renderStyle: 'word' });
    const chunkCaptions = buildRobustCaptions(payload, '', { renderStyle: 'chunk' });
    assert.ok(sentenceCaptions.length >= 1, 'sentence style should produce captions');
    assert.ok(wordCaptions.length >= sentenceCaptions.length, 'word style should be more granular than sentence');
    assert.ok(chunkCaptions.length >= sentenceCaptions.length, 'chunk style should not be less than sentence style');
    assert.ok(chunkCaptions.length <= wordCaptions.length, 'chunk style should not exceed word style granularity');
}

function testVideoScriptHelp() {
    const projectRoot = path.resolve(__dirname, '..');
    const output = execFileSync('node', ['scripts/run-video-cases.js', '--help'], {
        cwd: projectRoot,
        encoding: 'utf8'
    });
    assert.ok(output.includes('Usage: node scripts/run-video-cases.js'), 'help output should include usage');
    assert.ok(output.includes('--video-case-file'), 'help output should include video-case-file option');
}

function testExistingTextAssetReadable() {
    const textPath = path.resolve(__dirname, '..', 'data', 'personal', 'dataset_moments', '朋友圈_001.md');
    const text = fs.readFileSync(textPath, 'utf8').replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 20, 'existing text asset should be readable');
}

function main() {
    testCaptionRenderStyles();
    testVideoScriptHelp();
    testExistingTextAssetReadable();
    console.log('local debug tests passed');
}

main();
