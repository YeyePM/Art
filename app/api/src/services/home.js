// 主界面概览的规则层（T11 / M7）
// 依据：docs/03-MVP-Spec.md 3.1（主界面只做粗略预览）与 3.3（进度页只读）、
//       specs/01-接口契约.md「一之六」
//
// 一条硬要求：**主界面上的数字必须与今日页 / 学习进度页完全一致。**
// 落地方式不是"再算一遍"，而是**复用同一批函数**——
//   今日的题 ← `todaySession.getTodayView`（和 GET /api/today 同一条路）
//   学习进度 ← `stats.getStats`（和 GET /api/stats 同一个函数）
//   本周一批 ← `weeklyBatch.getWeeklyView`（和 GET /api/weekly 同一个函数）
// 谁都不新写一份口径，所以三处数字不可能对不上。
//
// 副作用：主界面是"当天内容就绪"的入口——第一次打开会按需把当天题单（与本周批次）备好，
// 之后进今日页/本周一批就是秒开。幂等，一天只发生一次。
import { getTodayView } from './todaySession.js';
import { getStats } from './stats.js';
import { getWeeklyView } from './weeklyBatch.js';
import { todayInShanghai } from './questionPicker.js';

/**
 * `GET /api/home` 的完整返回。
 *
 * @param {{date?:string, artworks?:Array<object>, generation?:object}} params
 *   artworks / generation：测试注入，给了就不调 AI、不联网
 * @returns {Promise<{date, today_progress:{done,total}, stats:{current_streak, accuracy},
 *                    weekly_summary:object|null, notice:object|null}>}
 */
export async function getHomeView({ date, artworks, generation } = {}) {
  const day = date ?? todayInShanghai();

  const today = await getTodayView({ date: day, artworks });
  const stats = getStats({ date: day });
  const weekly = await getWeeklyView({ date: day, generation });

  return {
    date: day,
    // 与 /api/today 的 progress 同源，不做任何再计算
    today_progress: { done: today.progress.done, total: today.progress.total },
    // 「学习进度」卡片只给粗略结论：当前连续 + 总正确率（趋势留给 v0.3）
    stats: { current_streak: stats.current_streak, accuracy: stats.accuracy.overall },
    // 「本周一批」只给摘要：一张画 + 一段摘录 + 一个开放问题，不给正文
    weekly_summary: weekly ? summarizeWeekly(weekly) : null,
    // M6 的兜底照旧带出来：AI 没帮上忙时给一句人话（正常为 null，字段始终在）
    notice: today.notice ?? null
  };
}

/** 只取"粗略"的那几样，正文不给（主界面不泄露内容） */
function summarizeWeekly(weekly) {
  return {
    batch_id: weekly.batch_id,
    starts_on: weekly.starts_on,
    ends_on: weekly.ends_on,
    artwork_title: weekly.artwork?.title ?? null,
    excerpt_book: weekly.excerpt?.book_title ?? null,
    has_open_question: Boolean(weekly.open_question)
  };
}