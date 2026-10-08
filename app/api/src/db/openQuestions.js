// 开放问题的读写 SQL（每周一批的三件内容之一）
// 依据：specs/02-数据模型.md
import { getDb } from './index.js';

/** 插一个开放问题，返回 id。batch_id 建批次时回填（setOpenQuestionBatch） */
export function insertOpenQuestion({ stem, referenceThoughts = null, batchId = null } = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO open_questions (stem, reference_thoughts, batch_id)
      VALUES (?, ?, ?)
    `)
    .run(stem, referenceThoughts, batchId);

  return Number(info.lastInsertRowid);
}

export function getOpenQuestionById(id) {
  const row = getDb().prepare('SELECT * FROM open_questions WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    stem: row.stem,
    referenceThoughts: row.reference_thoughts,
    userAnswer: row.user_answer,
    answeredAt: row.answered_at,
    batchId: row.batch_id
  };
}

export function setOpenQuestionBatch(id, batchId) {
  getDb().prepare('UPDATE open_questions SET batch_id = ? WHERE id = ?').run(batchId, Number(id));
}

/** 写下你的回答；空内容不当作"答过"（answered_at 保持 null，界面仍显示未写） */
export function saveOpenAnswer({ id, content } = {}) {
  const text = String(content ?? '').trim();
  getDb()
    .prepare(`
      UPDATE open_questions
         SET user_answer = @answer,
             answered_at = CASE WHEN @answer IS NULL THEN NULL ELSE datetime('now','localtime') END
       WHERE id = @id
    `)
    .run({ id: Number(id), answer: text || null });

  return text || null;
}