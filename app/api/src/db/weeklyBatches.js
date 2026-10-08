// 周批次的读写 SQL
// 周期是**滚动 7 天**（starts_on 起算），不是自然周——见 specs/04、docs/03 决策记录
import { getDb } from './index.js';

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    artworkId: row.artwork_id,
    excerptId: row.excerpt_id,
    openQuestionId: row.open_question_id,
    createdAt: row.created_at
  };
}

/** 当前批次 = 起算日最晚的那条 */
export function getLatestBatch() {
  return mapBatch(getDb().prepare('SELECT * FROM weekly_batches ORDER BY starts_on DESC, id DESC LIMIT 1').get());
}

export function getBatchById(id) {
  return mapBatch(getDb().prepare('SELECT * FROM weekly_batches WHERE id = ?').get(Number(id)));
}

/**
 * 插一个批次。三件内容先各自入库拿到 id，再建批次把三者串起来。
 * 任何一件生成失败都可为 null（表里允许空），不让整体崩掉。
 */
export function insertBatch({ startsOn, endsOn, artworkId = null, excerptId = null, openQuestionId = null } = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO weekly_batches (starts_on, ends_on, artwork_id, excerpt_id, open_question_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(startsOn, endsOn, artworkId, excerptId, openQuestionId);

  return getBatchById(Number(info.lastInsertRowid));
}

export function countBatches() {
  return getDb().prepare('SELECT count(*) AS c FROM weekly_batches').get().c;
}