const { getDb } = require('./index');

function createContent({
    audioPath = null,
    transcribeJsonPath = '',
    videoOutputPath = '',
    processTrace = '',
    rawText = '',
    draftArticle = '',
    hookMoment = '',
    status = 'pending',
    headline = '',
    subline = '',
    publishKitJson = '[]',
    source = 'bot'
}) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO contents (audio_path, transcribe_json_path, video_output_path, process_trace, raw_text, draft_article, hook_moment, status, headline, subline, publish_kit_json, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(audioPath, transcribeJsonPath, videoOutputPath, processTrace, rawText, draftArticle, hookMoment, status, headline, subline, publishKitJson, source);
    return Number(result.lastInsertRowid);
}

function updateGeneratedContent(id, { draftArticle = '', hookMoment = '', status = 'reviewing', videoOutputPath }) {
    const db = getDb();
    if (typeof videoOutputPath === 'string') {
        const stmt = db.prepare(`
            UPDATE contents
            SET draft_article = ?, hook_moment = ?, status = ?, video_output_path = ?
            WHERE id = ?
        `);
        stmt.run(draftArticle, hookMoment, status, videoOutputPath, id);
        return;
    }
    const stmt = db.prepare(`
        UPDATE contents
        SET draft_article = ?, hook_moment = ?, status = ?
        WHERE id = ?
    `);
    stmt.run(draftArticle, hookMoment, status, id);
}

function updateContentStatus(id, status) {
    const db = getDb();
    const stmt = db.prepare(`UPDATE contents SET status = ? WHERE id = ?`);
    stmt.run(status, id);
}

function updateVideoPath(id, path) {
    const db = getDb();
    const stmt = db.prepare(`UPDATE contents SET video_output_path = ? WHERE id = ?`);
    stmt.run(path, id);
}

function appendProcessTrace(id, line) {
    const db = getDb();
    const stmt = db.prepare(`
        UPDATE contents
        SET process_trace = CASE
            WHEN process_trace IS NULL OR process_trace = '' THEN ?
            ELSE process_trace || char(10) || ?
        END
        WHERE id = ?
    `);
    stmt.run(line, line, id);
}

function updateRawText(id, rawText) {
    const db = getDb();
    const stmt = db.prepare(`UPDATE contents SET raw_text = ? WHERE id = ?`);
    stmt.run(rawText, id);
}

function getContentById(id) {
    const db = getDb();
    const stmt = db.prepare(`SELECT * FROM contents WHERE id = ?`);
    return stmt.get(id) || null;
}

function listRecentContents(limit = 20) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT * FROM contents
        ORDER BY id DESC
        LIMIT ?
    `);
    return stmt.all(limit);
}

function updatePublishKit(id, { headline = '', subline = '', publishKitJson = '[]' }) {
    const db = getDb();
    db.prepare(`UPDATE contents SET headline = ?, subline = ?, publish_kit_json = ? WHERE id = ?`)
        .run(headline, subline, publishKitJson, id);
}

module.exports = {
    createContent,
    updateGeneratedContent,
    updateContentStatus,
    updateRawText,
    appendProcessTrace,
    getContentById,
    listRecentContents,
    updateVideoPath,
    updatePublishKit
};
