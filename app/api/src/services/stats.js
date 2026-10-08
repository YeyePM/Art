// 打卡与统计（唯一写"什么时候算打卡""连续天数怎么算"的地方）
// 依据：specs/04-核心规则.md 第三节（打卡与连续天数）、第五节（统计指标）
//      specs/01-接口契约.md 第一节第 4 条（GET /api/stats）
//
// 三条规则，别改错：
//  ① 打卡只由"完成当天题单"触发——把当天的题（含昨日补做的）全部作答完就成立。
//     正常情况下题单是 10 道；那天 AI 没补齐（题单不足 10）时，做完题单也算，不然连续天数会无故断掉。
//  ② **被耽误的那一天不补记打卡**：只会给传进来的那一天写打卡，从不回填过去。
//  ③ 当前连续只看"最后一次打卡是不是今天或昨天"——断了就归零；最长连续与总天数永久保留。
import { getSession, setSessionProgress } from '../db/dailySessions.js';
import { getAnsweredIdsOn, getAccuracyRows } from '../db/answers.js';
import { getCheckin, insertCheckin, getAllCheckinDates } from '../db/checkins.js';
import { todayInShanghai } from './questionPicker.js';

const TYPES = ['objective', 'term', 'image', 'essay'];

// 打卡日历的窗口长度（含今天，往前数）。M7/T11 加的，只给学习进度页画格子用。
const CALENDAR_DAYS = 30;

/**
 * 作答之后看一眼：那一天的题单做完了吗？做完了就打卡。
 * **幂等**：同一天重复调用只会写一条 checkins（date 有 UNIQUE 约束）。
 *
 * @param {{date?:string}} params 不传就按 Asia/Shanghai 的今天
 * @returns {boolean} 这一次是否"新打出"了一张卡
 */
export function maybeCheckIn({ date } = {}) {
  const day = date ?? todayInShanghai();
  const session = getSession(day);
  if (!session || session.questionIds.length === 0) return false;

  const answered = new Set(getAnsweredIdsOn(day));
  const done = session.questionIds.filter((id) => answered.has(id)).length;
  const complete = done >= session.questionIds.length;

  // 进度随手记下（done_count 就是给这里用的）；打卡标记一旦为真就不再改回
  setSessionProgress({ date: day, doneCount: done, checkedIn: complete || session.checkedIn });

  if (!complete) return false;
  if (getCheckin(day)) return false;

  insertCheckin({ date: day, questionCount: done });
  return true;
}

/**
 * `GET /api/stats` 的完整返回。
 *
 * @param {{date?:string}} params "今天"是哪天（自测用；接口不开放这个参数）
 * @returns {{current_streak:number, longest_streak:number, total_days:number,
 *            accuracy:{overall:number|null, by_type:Record<string,number|null>},
 *            calendar:Array<{date:string, checked_in:boolean}>}}
 */
export function getStats({ date } = {}) {
  const day = date ?? todayInShanghai();
  const dates = getAllCheckinDates();

  return {
    current_streak: computeCurrentStreak(dates, day),
    longest_streak: computeLongestStreak(dates),
    total_days: dates.length,
    accuracy: accuracyOf(),
    calendar: buildCalendar(dates, day)
  };
}

/**
 * 打卡日历：最近 `days` 天（含今天）逐日列出，只标"完成 / 未完成"。
 * 连续日期一定齐全（缺的天 `checked_in:false`），前端直接照着画格子。
 * M7/T11 加，供学习进度页用；**不新增数据表**，数据全来自 `checkins`。
 */
export function buildCalendar(dates = [], today, days = CALENDAR_DAYS) {
  const checked = new Set(dates);
  const calendar = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = shiftDay(today, -back);
    calendar.push({ date: day, checked_in: checked.has(day) });
  }
  return calendar;
}

/**
 * 当前连续：取"最后一次打卡"往前连的那一串。
 * 最后一次不在今天 / 昨天 → 已经断了，归零（今天还没过完不算断，所以昨天也算活着）。
 */
export function computeCurrentStreak(dates = [], today) {
  if (!dates.length) return 0;

  const last = dates[dates.length - 1];
  if (last !== today && last !== shiftDay(today, -1)) return 0;

  let streak = 1;
  for (let i = dates.length - 1; i > 0; i -= 1) {
    if (dates[i - 1] === shiftDay(dates[i], -1)) streak += 1;
    else break;
  }
  return streak;
}

/** 最长连续：历史上最长的那一串，断了也永久保留 */
export function computeLongestStreak(dates = []) {
  let best = 0;
  let run = 0;
  let prev = null;

  for (const day of dates) {
    run = prev != null && day === shiftDay(prev, 1) ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

/** 正确率：总体 + 按题型；没有作答的那一类给 null（前端显示"—"而不是 0%） */
function accuracyOf() {
  const rows = getAccuracyRows();
  const byType = Object.fromEntries(TYPES.map((type) => [type, null]));
  let total = 0;
  let correct = 0;

  for (const row of rows) {
    total += row.total;
    correct += row.correct;
    byType[row.type] = ratio(row.correct, row.total);
  }

  return { overall: ratio(correct, total), by_type: byType };
}

/** 没有作答 → null；否则 0～1 的两位小数 */
function ratio(correct, total) {
  if (!total) return null;
  return Math.round((correct / total) * 100) / 100;
}

/** 日期加减（按 YYYY-MM-DD 用 UTC 算，避免本地时区把日子算歪） */
function shiftDay(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}