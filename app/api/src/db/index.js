import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR, IMAGES_DIR, DB_FILE, SCHEMA_FILE } from '../config.js';

// db/ 是唯一能碰 SQLite 的地方。业务层只通过这里读写。
let db = null;

export function applySchema(database) {
  database.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/**
 * 给已存在的库补列。
 * `CREATE TABLE IF NOT EXISTS` 只建新表，**不会给老表加列**——旧库升级全靠这里。
 * 只加可空列，不加约束，失败也不会伤数据。
 */
function migrate(database) {
  const additions = {
    answers: {
      ai_correct: 'INTEGER',
      ai_comment: 'TEXT',
      ai_errors: 'TEXT'
    }
  };

  for (const [table, columns] of Object.entries(additions)) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

export function getDb() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  migrate(db);

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export { DB_FILE, DATA_DIR, IMAGES_DIR };