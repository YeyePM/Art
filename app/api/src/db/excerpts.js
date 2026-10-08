// 书籍摘录的读写 SQL（每周一批的三件内容之一）
// 依据：specs/02-数据模型.md、docs/03-MVP-Spec.md 8.1（书目轮换取材）
import { getDb } from './index.js';

/** 插一段摘录，返回 id。batch_id 建批次时还不知道，先留空，建好批次再回填（setExcerptBatch） */
export function insertExcerpt({ bookTitle, chapter = null, sourceText, contactLine = null, batchId = null } = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO excerpts (book_title, chapter, source_text, contact_line, batch_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(bookTitle, chapter, sourceText, contactLine, batchId);

  return Number(info.lastInsertRowid);
}

export function getExcerptById(id) {
  const row = getDb().prepare('SELECT * FROM excerpts WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    bookTitle: row.book_title,
    chapter: row.chapter,
    sourceText: row.source_text,
    contactLine: row.contact_line,
    isFavorite: row.is_favorite === 1,
    batchId: row.batch_id
  };
}

export function setExcerptBatch(id, batchId) {
  getDb().prepare('UPDATE excerpts SET batch_id = ? WHERE id = ?').run(batchId, Number(id));
}

/**
 * 最近 N 段摘录用过的书名（新的在前）。
 * 交给 AI 让它"轮换着取"——避开刚用过的书，同一个作者不至于连着三周出现。
 */
export function getRecentBookTitles(limit = 5) {
  return getDb()
    .prepare('SELECT book_title FROM excerpts ORDER BY id DESC LIMIT ?')
    .all(Number(limit))
    .map((row) => row.book_title);
}