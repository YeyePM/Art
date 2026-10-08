// 复习队列的读写 SQL（一题一条）
// 依据：specs/04-核心规则.md 第二节——1→3→7→15，走完全程才出队（15 天节点答对等价连对 4 次）
// T4 只读「今天到期该复习的题」；写入与推进间隔是 M3（T6）的，规则在 services/reviewQueue.js。
import { getDb } from './index.js';

/**
 * 今天到期该复习的题（含过期未做的）。
 * 组题时排在"昨日未完成题"之后。
 */
export function getDueReviewIds(today) {
  return getDb()
    .prepare(`
      SELECT question_id
        FROM review_queue
       WHERE status = 'active'
         AND next_review_on <= ?
       ORDER BY next_review_on, question_id
    `)
    .all(today)
    .map((row) => row.question_id);
}

/** 队列里还活着的题数（排查 / 自测用） */
export function countActiveReview() {
  return getDb().prepare("SELECT count(*) AS c FROM review_queue WHERE status = 'active'").get().c;
}

/**
 * 还在复习队列里的全部题目 id。
 * 接口里的 `is_review` 拿它标记——比"今天是否到期"更稳：
 * 同一天第二次打开时，题单是读库来的，靠这个仍然标得对。
 */
export function getActiveReviewIds() {
  return getDb()
    .prepare("SELECT question_id FROM review_queue WHERE status = 'active'")
    .all()
    .map((row) => row.question_id);
}

/** 取某题的队列记录（含已出队的）；没有返回 null */
export function getQueueItem(questionId) {
  const row = getDb()
    .prepare('SELECT * FROM review_queue WHERE question_id = ?')
    .get(Number(questionId));

  if (!row) return null;
  return {
    questionId: row.question_id,
    firstWrongOn: row.first_wrong_on,
    nextReviewOn: row.next_review_on,
    intervalDays: row.interval_days,
    correctStreak: row.correct_streak,
    status: row.status
  };
}

/**
 * 入队 / 重新入队（入队 + 答错重置走同一条路，所以是 upsert）。
 * 已出队的题以后再答错，会被重新激活——`first_wrong_on` 也跟着改成这次。
 */
export function upsertQueueItem({ questionId, firstWrongOn, nextReviewOn, intervalDays = 1, correctStreak = 0 } = {}) {
  getDb()
    .prepare(`
      INSERT INTO review_queue (question_id, first_wrong_on, next_review_on, interval_days, correct_streak, status, updated_at)
      VALUES (@question_id, @first_wrong_on, @next_review_on, @interval_days, @correct_streak, 'active', datetime('now','localtime'))
      ON CONFLICT(question_id) DO UPDATE SET
        first_wrong_on = excluded.first_wrong_on,
        next_review_on = excluded.next_review_on,
        interval_days  = excluded.interval_days,
        correct_streak = excluded.correct_streak,
        status         = 'active',
        updated_at     = datetime('now','localtime')
    `)
    .run({
      question_id: Number(questionId),
      first_wrong_on: firstWrongOn,
      next_review_on: nextReviewOn,
      interval_days: intervalDays,
      correct_streak: correctStreak
    });
}

/** 复习答对、间隔往前走一格 */
export function advanceQueueItem({ questionId, nextReviewOn, intervalDays, correctStreak } = {}) {
  getDb()
    .prepare(`
      UPDATE review_queue
         SET next_review_on = ?, interval_days = ?, correct_streak = ?, updated_at = datetime('now','localtime')
       WHERE question_id = ?
    `)
    .run(nextReviewOn, intervalDays, correctStreak, Number(questionId));
}

/**
 * 复习答错：连对归零、间隔退回 1 天。
 * `first_wrong_on` **不动**——那是这道题"第一次栽在哪儿"，重来一次不该抹掉。
 */
export function resetQueueItem({ questionId, nextReviewOn } = {}) {
  getDb()
    .prepare(`
      UPDATE review_queue
         SET next_review_on = ?, interval_days = 1, correct_streak = 0, updated_at = datetime('now','localtime')
       WHERE question_id = ?
    `)
    .run(nextReviewOn, Number(questionId));
}

/** 走完全程，出队（**保留记录**：以后能看这道题当初错了多久才拿下） */
export function completeQueueItem(questionId) {
  getDb()
    .prepare("UPDATE review_queue SET status = 'done', updated_at = datetime('now','localtime') WHERE question_id = ?")
    .run(Number(questionId));
}

/**
 * 删掉一条队列记录。
 * 只用于一种情况：答案是今天才入的队，随后用户改判成"其实答对了"——
 * 这道题**本就不该进队**，留个 done 反而污染"走完全程"的统计，所以直接删。
 */
export function deleteQueueItem(questionId) {
  getDb().prepare('DELETE FROM review_queue WHERE question_id = ?').run(Number(questionId));
}