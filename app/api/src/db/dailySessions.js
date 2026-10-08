// 每日任务的读写 SQL（当天题写在 question_ids 里，同一天不再重新生成）
// 依据：specs/02-数据模型.md、specs/04-核心规则.md 第一节
import { getDb } from './index.js';

/** 读某天的会话；没有返回 null。questionIds 已 parse 成数组 */
export function getSession(date) {
  const row = getDb().prepare('SELECT * FROM daily_sessions WHERE date = ?').get(date);
  if (!row) return null;
  return {
    date: row.date,
    questionIds: parseQuestionIds(row.question_ids),
    doneCount: row.done_count,
    total: row.total,
    checkedIn: row.checked_in === 1,
    hook: row.hook ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * 写当天会话：同一天重复写只更新，不会产生第二条。
 * hook 传 null 时保留原来那句（生成失败不该把推送文案抹掉）。
 */
export function saveSession({ date, questionIds = [], total = questionIds.length, hook = null } = {}) {
  getDb()
    .prepare(`
      INSERT INTO daily_sessions (date, question_ids, total, hook)
      VALUES (@date, @question_ids, @total, @hook)
      ON CONFLICT(date) DO UPDATE SET
        question_ids = excluded.question_ids,
        total        = excluded.total,
        hook         = COALESCE(excluded.hook, daily_sessions.hook),
        updated_at   = datetime('now','localtime')
    `)
    .run({
      date,
      question_ids: JSON.stringify(questionIds.map(Number)),
      total,
      hook
    });

  return getSession(date);
}

/** 某天的题目 id 列表；没有这天就返回空数组（组题时用来算"昨日未完成"） */
export function getSessionQuestionIds(date) {
  return getSession(date)?.questionIds ?? [];
}

/**
 * 更新某天的完成进度与打卡标记（M4）。
 * 两个字段都按需更新：传 null 表示"这次不动它"，别把已有的打卡标记抹掉。
 */
export function setSessionProgress({ date, doneCount = null, checkedIn = null } = {}) {
  getDb()
    .prepare(`
      UPDATE daily_sessions
         SET done_count = COALESCE(@done_count, done_count),
             checked_in = COALESCE(@checked_in, checked_in),
             updated_at = datetime('now','localtime')
       WHERE date = @date
    `)
    .run({
      date,
      done_count: doneCount == null ? null : Number(doneCount),
      checked_in: checkedIn == null ? null : checkedIn ? 1 : 0
    });
}

function parseQuestionIds(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}