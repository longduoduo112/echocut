const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

let dbInstance = null;

function ensureDbDir(dbPath) {
    const abs = path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return abs;
}

function initDb(dbPath) {
    if (dbInstance) return dbInstance;
    const absPath = ensureDbDir(dbPath);
    dbInstance = new Database(absPath);
    dbInstance.pragma('journal_mode = WAL');
    runMigrations(dbInstance);
    return dbInstance;
}

function getDb() {
    if (!dbInstance) throw new Error('数据库未初始化，请先调用 initDb');
    return dbInstance;
}

module.exports = { initDb, getDb };
