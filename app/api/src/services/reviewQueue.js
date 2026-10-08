// 错题队列与遗忘曲线（M3·T6）——唯一写"这道题什么时候再考你一遍"的地方
// 依据：specs/04-核心规则.md 第二节
//
// 一道错题要走完四个节点：1 → 3 → 7 → 15 天，**在 15 天节点答对才出队**（等价连对 4 次）。
// 中途任何一次答错 → 连对归零、间隔退回 1 天，从头再来。
//
// 谁调这里：services/grading.js。**每次"最终判定"被写下的那一刻调一次**——
// 首答、复习答对/答错都算；用户改判会再调一次（判定变了，队列就得跟着变）。
// 幂等返回那条路（同题同日重复提交）**不许调**，否则会把间隔白白往前推一格。
import {
  getQueueItem,
  upsertQueueItem,
  advanceQueueItem,
  resetQueueItem,
  completeQueueItem,
  deleteQueueItem
} from '../db/reviewQueue.js';

/** 间隔只能按这个阶梯走 */
const INTERVAL_CHAIN = [1, 3, 7, 15];

/**
 * 按"这道题今天的最终判定"更新复习队列。
 *
 * | 判定 | 在队里？ | 结果 |
 * | --- | --- | --- |
 * | 答错 | 在 | 连对归零、间隔退回 1 天（`first_wrong_on` 不动） |
 * | 答错 | 不在 | 入队：间隔 1 天、连对 0，`first_wrong_on` = 今天 |
 * | 答对 | 不在 | 与复习无关，什么都不做 |
 * | 答对 | 在，且今天才入的队 | 出队（**删掉**）：这是 AI 先判错、用户当天改判成"其实答对了"，本就不该进队 |
 * | 答对 | 在，且间隔还没到 15 天 | 间隔前进一格，连对 +1 |
 * | 答对 | 在，且当前间隔就是 15 天 | **走完全程，出队** |
 *
 * @param {{questionId:*, correct:boolean, date:string}} params  date 是作答当天（YYYY-MM-DD）
 * @returns {string|null} 下次复习日；null = 这道题不会再来了
 */
export function applyVerdictToReviewQueue({ questionId, correct, date } = {}) {
  const id = Number(questionId);
  const item = getQueueItem(id);
  const inQueue = item?.status === 'active';

  // ---------- 答错：在队里的重置，不在队里的入队 ----------
  if (!correct) {
    const nextReviewOn = addDays(date, 1);
    if (inQueue) resetQueueItem({ questionId: id, nextReviewOn });
    else upsertQueueItem({ questionId: id, firstWrongOn: date, nextReviewOn });
    return nextReviewOn;
  }

  // ---------- 答对：只有"在队里"才与复习有关 ----------
  if (!inQueue) return null;

  // 今天才入的队 → 说明是今天这次作答先被 AI 判错了、用户随后改判成对，这道题本就不该进队
  if (item.firstWrongOn === date) {
    deleteQueueItem(id);
    return null;
  }

  // 复习答对：间隔往前走一格；当前已经是 15 天 → 走完全程
  const nextInterval = INTERVAL_CHAIN[INTERVAL_CHAIN.indexOf(item.intervalDays) + 1];
  if (nextInterval == null) {
    completeQueueItem(id);
    return null;
  }

  const nextReviewOn = addDays(date, nextInterval);
  advanceQueueItem({
    questionId: id,
    nextReviewOn,
    intervalDays: nextInterval,
    correctStreak: item.correctStreak + 1
  });
  return nextReviewOn;
}

/**
 * 还在队里的话，它下次什么时候来；出队了或没入过队返回 null。
 * 给"幂等返回"那条路用（只读，不动数据）。
 */
export function getNextReviewOn(questionId) {
  const item = getQueueItem(questionId);
  return item?.status === 'active' ? item.nextReviewOn : null;
}

/** 日期加减（按 YYYY-MM-DD 用 UTC 算，避免本地时区把日子算歪） */
function addDays(day, days) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}