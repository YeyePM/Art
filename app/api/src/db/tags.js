// 标签的读写 SQL
import { getDb } from './index.js';
import { categoryOf } from '../services/taxonomy.js';

// AI 给的标签是自由文本，推断不出类别时落到这里（当前标签体系里最接近的兜底）
const DEFAULT_TAG_CATEGORY = '流派';

/** 取标签 id，没有就建。category 不传则按 taxonomy 推断。 */
export function ensureTagId(name, category = null) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
  if (existing) return existing.id;

  const info = db
    .prepare('INSERT INTO tags (name, category) VALUES (?, ?)')
    .run(name, category ?? categoryOf(name) ?? DEFAULT_TAG_CATEGORY);
  return Number(info.lastInsertRowid);
}

/** 给题目挂标签（覆盖式） */
export function setQuestionTags(questionId, tagNames = []) {
  const db = getDb();
  const run = db.transaction((names) => {
    const ids = [...new Set(names.filter(Boolean))].map((name) => ensureTagId(name));
    const link = db.prepare('INSERT OR IGNORE INTO question_tags (question_id, tag_id) VALUES (?, ?)');
    for (const tagId of ids) link.run(questionId, tagId);
  });
  run(tagNames);
}

/** 取题目的标签名 */
export function getQuestionTags(questionId) {
  return getDb()
    .prepare(`
      SELECT t.name FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
       WHERE qt.question_id = ? ORDER BY t.id
    `)
    .all(questionId)
    .map((row) => row.name);
}

/** 标签表总览，排查用 */
export function listTags() {
  return getDb().prepare('SELECT id, name, category FROM tags ORDER BY category, id').all();
}