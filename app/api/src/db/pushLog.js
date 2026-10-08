// 推送记录的读写 SQL（防重复发 + 排查"今天怎么没弹"）
// 依据：specs/02-数据模型.md（push_log）、specs/04-核心规则.md 第六节
import { getDb } from './index.js';

/** 今天是否已经发过——"同一天不重复发第二条"就靠它 */
export function hasPushOn(date) {
  return getDb().prepare('SELECT 1 AS x FROM push_log WHERE date = ?').get(date) != null;
}

/**
 * 记一条推送流水。同一天已有一条就什么都不做（date 是 UNIQUE）。
 * @returns {boolean} 真的写下了才 true；说明这次是"今天第一条"
 */
export function recordPush({ date, body, delivered = true }) {
  const info = getDb()
    .prepare(`
      INSERT INTO push_log (date, body, delivered)
      VALUES (@date, @body, @delivered)
      ON CONFLICT(date) DO NOTHING
    `)
    .run({ date, body: String(body ?? ''), delivered: delivered ? 1 : 0 });
  return info.changes > 0;
}

/** 读某天的推送记录；没有返回 null */
export function getPushLog(date) {
  const row = getDb().prepare('SELECT * FROM push_log WHERE date = ?').get(date);
  if (!row) return null;
  return {
    date: row.date,
    sentAt: row.sent_at,
    body: row.body,
    delivered: row.delivered === 1
  };
}