// 标记问题的读写 SQL（SQL 只写在 db/）
// 依据：specs/02-数据模型.md（flagged_items 表）、specs/04 第九节第 5 条
//
// flagged_items 是"标记"的流水账（题 / 画 / 摘录 / 开放问题 / 碎片都能标）；
// 题目要不要从出题池剔除，看 questions.is_flagged（组题时按它过滤）。
import { getDb } from './index.js';

// 与 schema.sql 的 CHECK 约束保持一致
export const TARGET_TYPES = ['question', 'artwork', 'excerpt', 'open_question', 'fragment'];

export function isValidTargetType(targetType) {
  return TARGET_TYPES.includes(String(targetType));
}

/** 记一笔标记；返回新记录的 id */
export function insertFlag({ targetType, targetId, note = null } = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO flagged_items (target_type, target_id, note)
      VALUES (@target_type, @target_id, @note)
    `)
    .run({
      target_type: String(targetType),
      target_id: Number(targetId),
      note: note == null || note === '' ? null : String(note)
    });
  return Number(info.lastInsertRowid);
}

/** 某个对象被标过几次（自测 / 排查用） */
export function countFlagsFor(targetType, targetId) {
  return getDb()
    .prepare('SELECT count(*) AS c FROM flagged_items WHERE target_type = ? AND target_id = ?')
    .get(String(targetType), Number(targetId)).c;
}

/** 标记总数（自测用高水位对照） */
export function countFlags() {
  return getDb().prepare('SELECT count(*) AS c FROM flagged_items').get().c;
}