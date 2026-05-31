function runMigrations(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS contents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            audio_path TEXT,
            raw_text TEXT NOT NULL,
            draft_article TEXT NOT NULL DEFAULT '',
            hook_moment TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewing', 'published')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_configs (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS task_checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL UNIQUE,
            chat_id TEXT NOT NULL DEFAULT '',
            session TEXT NOT NULL DEFAULT '',
            task_type TEXT NOT NULL DEFAULT 'text',
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed', 'interrupted')),
            payload_json TEXT NOT NULL DEFAULT '{}',
            step_no INTEGER NOT NULL DEFAULT 0,
            total_no INTEGER NOT NULL DEFAULT 0,
            step_title TEXT NOT NULL DEFAULT '',
            progress_pct INTEGER NOT NULL DEFAULT 0,
            error_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status_updated ON task_checkpoints(status, updated_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_checkpoints_chat ON task_checkpoints(chat_id, updated_at DESC)`);
    db.exec(`
        CREATE TABLE IF NOT EXISTS task_stage_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            task_type TEXT NOT NULL DEFAULT 'text',
            stage_key TEXT NOT NULL,
            stage_title TEXT NOT NULL DEFAULT '',
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('done', 'failed', 'skipped')),
            content_id INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_stage_metrics_task ON task_stage_metrics(task_id, id ASC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_stage_metrics_type_time ON task_stage_metrics(task_type, created_at DESC)`);

    const cols = db.prepare(`PRAGMA table_info(contents)`).all();
    const hasCol = (name) => cols.some((c) => c.name === name);
    if (!hasCol('transcribe_json_path')) {
        db.exec(`ALTER TABLE contents ADD COLUMN transcribe_json_path TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCol('video_output_path')) {
        db.exec(`ALTER TABLE contents ADD COLUMN video_output_path TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCol('process_trace')) {
        db.exec(`ALTER TABLE contents ADD COLUMN process_trace TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCol('headline')) {
        db.exec(`ALTER TABLE contents ADD COLUMN headline TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCol('subline')) {
        db.exec(`ALTER TABLE contents ADD COLUMN subline TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCol('publish_kit_json')) {
        db.exec(`ALTER TABLE contents ADD COLUMN publish_kit_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasCol('source')) {
        db.exec(`ALTER TABLE contents ADD COLUMN source TEXT NOT NULL DEFAULT 'bot'`);
    }
}

module.exports = { runMigrations };
