const { getDb } = require('./index');

function upsertTaskCheckpoint({
    taskId,
    chatId = '',
    session = '',
    taskType = 'text',
    status = 'queued',
    payload = {},
    stepNo = 0,
    totalNo = 0,
    stepTitle = '',
    progressPct = 0,
    errorText = ''
}) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO task_checkpoints (
            task_id, chat_id, session, task_type, status, payload_json, step_no, total_no, step_title, progress_pct, error_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(task_id) DO UPDATE SET
            chat_id=excluded.chat_id,
            session=excluded.session,
            task_type=excluded.task_type,
            status=excluded.status,
            payload_json=excluded.payload_json,
            step_no=excluded.step_no,
            total_no=excluded.total_no,
            step_title=excluded.step_title,
            progress_pct=excluded.progress_pct,
            error_text=excluded.error_text,
            updated_at=datetime('now')
    `);
    stmt.run(
        String(taskId || ''),
        String(chatId || ''),
        String(session || ''),
        String(taskType || 'text'),
        String(status || 'queued'),
        JSON.stringify(payload || {}),
        Math.max(0, Math.floor(Number(stepNo) || 0)),
        Math.max(0, Math.floor(Number(totalNo) || 0)),
        String(stepTitle || ''),
        Math.max(0, Math.min(100, Math.floor(Number(progressPct) || 0))),
        String(errorText || '')
    );
}

function updateTaskCheckpointProgress(taskId, {
    stepNo,
    totalNo,
    stepTitle,
    progressPct
} = {}) {
    const db = getDb();
    const sets = ['updated_at=datetime(\'now\')'];
    const values = [];
    if (Number.isFinite(stepNo)) {
        sets.push('step_no=?');
        values.push(Math.max(0, Math.floor(stepNo)));
    }
    if (Number.isFinite(totalNo)) {
        sets.push('total_no=?');
        values.push(Math.max(0, Math.floor(totalNo)));
    }
    if (typeof stepTitle === 'string') {
        sets.push('step_title=?');
        values.push(stepTitle.trim());
    }
    if (Number.isFinite(progressPct)) {
        sets.push('progress_pct=?');
        values.push(Math.max(0, Math.min(100, Math.floor(progressPct))));
    }
    if (sets.length <= 1) return;
    const stmt = db.prepare(`UPDATE task_checkpoints SET ${sets.join(', ')} WHERE task_id=?`);
    stmt.run(...values, String(taskId || ''));
}

function updateTaskCheckpointStatus(taskId, status, { errorText, stepTitle, progressPct } = {}) {
    const db = getDb();
    const sets = ['status=?', 'updated_at=datetime(\'now\')'];
    const values = [String(status || 'queued')];
    if (typeof errorText === 'string') {
        sets.push('error_text=?');
        values.push(errorText);
    }
    if (typeof stepTitle === 'string') {
        sets.push('step_title=?');
        values.push(stepTitle);
    }
    if (Number.isFinite(progressPct)) {
        sets.push('progress_pct=?');
        values.push(Math.max(0, Math.min(100, Math.floor(progressPct))));
    }
    const stmt = db.prepare(`UPDATE task_checkpoints SET ${sets.join(', ')} WHERE task_id=?`);
    stmt.run(...values, String(taskId || ''));
}

function listRecoverableTaskCheckpoints(limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT *
        FROM task_checkpoints
        WHERE status IN ('queued', 'running', 'interrupted')
        ORDER BY created_at ASC
        LIMIT ?
    `);
    return stmt.all(Math.max(1, Math.floor(Number(limit) || 100)));
}

function markActiveTaskCheckpointsInterrupted() {
    const db = getDb();
    const stmt = db.prepare(`
        UPDATE task_checkpoints
        SET status='interrupted', step_title=CASE WHEN step_title = '' THEN '服务中断' ELSE step_title END, updated_at=datetime('now')
        WHERE status IN ('queued', 'running')
    `);
    return stmt.run().changes;
}

function insertTaskStageMetric({
    taskId,
    taskType = 'text',
    stageKey = '',
    stageTitle = '',
    elapsedMs = 0,
    status = 'done',
    contentId = 0
}) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO task_stage_metrics (
            task_id, task_type, stage_key, stage_title, elapsed_ms, status, content_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        String(taskId || ''),
        String(taskType || 'text'),
        String(stageKey || '').trim(),
        String(stageTitle || '').trim(),
        Math.max(0, Math.floor(Number(elapsedMs) || 0)),
        ['done', 'failed', 'skipped'].includes(String(status)) ? String(status) : 'done',
        Math.max(0, Math.floor(Number(contentId) || 0))
    );
}

function listTaskStageMetrics(taskId, limit = 64) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT task_id, task_type, stage_key, stage_title, elapsed_ms, status, content_id, created_at
        FROM task_stage_metrics
        WHERE task_id = ?
        ORDER BY id ASC
        LIMIT ?
    `);
    return stmt.all(String(taskId || ''), Math.max(1, Math.floor(Number(limit) || 64)));
}

module.exports = {
    upsertTaskCheckpoint,
    updateTaskCheckpointProgress,
    updateTaskCheckpointStatus,
    listRecoverableTaskCheckpoints,
    markActiveTaskCheckpointsInterrupted,
    insertTaskStageMetric,
    listTaskStageMetrics
};
