// 打卡记录的读写 SQL（一天最多一条，date UNIQUE）
// 依据：specs/02-数据模型.md、specs/04-核心规则.md 第三节
// 规则不在这：什么时候该打卡在 services/stats.js。
import { getDb } from './index.js';

/** 读某天的打卡记录；没打卡返回 null */
export function getCheckin(date) {
  const row = getDb()
    .prepare('SELECT date, completed_at, question_count FROM checkins WHERE date = ?')
    .get(date);
  if (!row) return null;
  return { date: row.date, completedAt: row.completed_at, questionCount: row.question_count };
}

/**
 * 写一条打卡记录。`date` 有 UNIQUE 约束，所以重复写不会产生第二条（用 INSERT OR IGNORE）。
 * 这是"同一天完成多次也只记一次"的落地方式。
 */
export function insertCheckin({ date, questionCount = 10 } = {}) {
  getDb()
    .prepare('INSERT OR IGNORE INTO checkins (date, question_count) VALUES (?, ?)')
    .run(date, Number(questionCount));
  return getCheckin(date);
}

/** 所有打卡日期，按升序（算连续天数用；date 唯一，不用去重） */
export function getAllCheckinDates() {
  return getDb()
    .prepare('SELECT date FROM checkins ORDER BY date')
    .all()
    .map((row) => row.date);
}