// T7 验收：打卡 + 连续天数 + 正确率 + GET /api/stats
//   node app/api/scripts/verify-t7.js
//
// **不花钱、不动你现有的题库与作答**：临时插 3 道「【T7自检】」假题、造两个虚拟日期的会话，
// 跑完连题、作答、复习队列、打卡、会话一起删掉。
//
// 打卡只在"完成当天题单"时成立，所以这里用虚拟日期造会话 + 服务层显式传 date 来复现，
// 不去改系统日期（和 verify-t6 一个思路）。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { insertQuestions } from '../src/db/questions.js';
import { getSession, saveSession } from '../src/db/dailySessions.js';
import { getCheckin, getAllCheckinDates } from '../src/db/checkins.js';
import { getAccuracyRows } from '../src/db/answers.js';
import { submitAnswer } from '../src/services/grading.js';
import { getStats, computeCurrentStreak, computeLongestStreak } from '../src/services/stats.js';

const D0 = '2026-02-10'; // 自检的"第一天"：做完一张 3 道题的题单 → 打卡
const D1 = '2026-02-11'; // 自检的"第二天"：只做一半 → 不该打卡
const CHOICE = ['A 甲', 'B 乙', 'C 丙', 'D 丁'];

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);

/** 前一天 / 后一天（按 YYYY-MM-DD 算，避开本地时区） */
function shiftDay(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}

/** 现阶段库里已成型的打卡日期（用来做 delta 断言，不受你真实数据影响） */
const checkinDatesBefore = () => getAllCheckinDates();

function makeFakeQuestions() {
  return [0, 1, 2].map((index) => ({
    type: 'objective',
    stem: `【T7自检】打卡统计用假题 ${index + 1}`,
    options: CHOICE,
    answer: 'A',
    explanation: '自检用，跑完即删。',
    difficulty: '基础',
    tags: []
  }));
}

/** 连带子表一起删临时题（foreign_keys=ON，必须先删引用它的表） */
function removeQuestions(ids = []) {
  if (!ids.length) return;
  const db = getDb();
  const marks = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM review_queue WHERE question_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM answers      WHERE question_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM question_tags WHERE question_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM questions    WHERE id IN (${marks})`).run(...ids);
}

function cleanup(questionIds = []) {
  const db = getDb();
  db.prepare('DELETE FROM checkins       WHERE date IN (?, ?)').run(D0, D1);
  db.prepare('DELETE FROM daily_sessions WHERE date IN (?, ?)').run(D0, D1);
  removeQuestions(questionIds);
}

function residualReport(questionIds = []) {
  const db = getDb();
  const marks = questionIds.map(() => '?').join(',');
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  return {
    题库: questionIds.length ? count(`SELECT count(*) AS c FROM questions    WHERE id IN (${marks})`, ...questionIds) : 0,
    作答: questionIds.length ? count(`SELECT count(*) AS c FROM answers      WHERE question_id IN (${marks})`, ...questionIds) : 0,
    队列: questionIds.length ? count(`SELECT count(*) AS c FROM review_queue WHERE question_id IN (${marks})`, ...questionIds) : 0,
    打卡: count('SELECT count(*) AS c FROM checkins       WHERE date IN (?, ?)', D0, D1),
    会话: count('SELECT count(*) AS c FROM daily_sessions WHERE date IN (?, ?)', D0, D1)
  };
}

async function main() {
  const db = getDb();
  const checks = [];
  const check = (name, ok, detail = '') => checks.push([name, ok, detail]);

  line('');
  line('T7 验收 · 打卡与统计（M4）');
  line(`虚拟日：第一天 ${D0}（做完就打卡）、第二天 ${D1}（只做一半，不该打卡）`);
  line('本脚本不动你现有的题库与作答，只临时插 3 道自检假题，跑完自动删掉。');
  rule();

  // 先清一遍，避免上次没跑完的残留影响判断
  cleanup([]);
  const datesBefore = checkinDatesBefore();
  const rowsBefore = getAccuracyRows();
  const baseTotal = rowsBefore.reduce((sum, row) => sum + row.total, 0);
  const baseCorrect = rowsBefore.reduce((sum, row) => sum + row.correct, 0);

  // ---------- ① 造题与虚拟会话 ----------
  const { inserted, skipped } = insertQuestions(makeFakeQuestions());
  const ids = [...inserted];
  const createdQuestionIds = [...ids];

  line('');
  line(`① 临时插入 ${ids.length} 道自检假题（id：${ids.join(', ')}，跳过重复 ${skipped} 道）`);

  saveSession({ date: D0, questionIds: ids, total: ids.length });
  saveSession({ date: D1, questionIds: ids.slice(0, 2), total: 2 });
  line(`   已造好会话：${D0} 共 3 道、${D1} 共 2 道`);

  // ---------- ② 做完当天的题单 → 打卡 ----------
  line('');
  line('② 把第一天的 3 道题做完（客观题直接比，不花钱）');
  rule();
  line(`${pad('动作', 26)}${pad('打卡了吗', 12)}${pad('当日进度', 12)}打卡记录`);
  rule();

  const answer = async (date, questionId, value) => {
    await submitAnswer({ questionId, userAnswer: value, date });
    const session = getSession(date);
    const progress = `${session.doneCount}/${session.total}`;
    const checked = getCheckin(date) != null;
    return { progress, checked };
  };

  const first = await answer(D0, ids[0], 'A');
  line(`${pad('答第 1 道（对）', 26)}${pad(first.checked ? '是' : '否', 12)}${pad(first.progress, 12)}${first.checked ? '有' : '—'}`);
  check('做完一半：还没打卡', first.checked === false, `进度 ${first.progress}`);

  const second = await answer(D0, ids[1], 'A');
  line(`${pad('答第 2 道（对）', 26)}${pad(second.checked ? '是' : '否', 12)}${pad(second.progress, 12)}${second.checked ? '有' : '—'}`);
  check('做完三分之二：还没打卡', second.checked === false, `进度 ${second.progress}`);

  const third = await answer(D0, ids[2], 'A');
  line(`${pad('答第 3 道（对）→ 做完', 26)}${pad(third.checked ? '是' : '否', 12)}${pad(third.progress, 12)}${third.checked ? '有' : '—'}`);
  rule();
  check('做完当天题单：打卡成立', third.checked === true, `进度 ${third.progress}`);
  check('打卡记录写进了 checkins', getCheckin(D0) != null, getCheckin(D0)?.date ?? '没有');
  check('daily_sessions 标成已打卡', getSession(D0).checkedIn === true, `checked_in=${getSession(D0).checkedIn}`);
  check('done_count 跟着记到 3', getSession(D0).doneCount === 3, `done_count=${getSession(D0).doneCount}`);

  // ---------- ③ 幂等：再交一次不会多打一张卡 ----------
  await submitAnswer({ questionId: ids[2], userAnswer: 'A', date: D0 });
  const d0Count = db.prepare('SELECT count(*) AS c FROM checkins WHERE date = ?').get(D0).c;
  check('同一天重复提交：不会多记一条打卡', d0Count === 1, `${d0Count} 条`);

  // ---------- ④ 只做一半 → 不打卡 ----------
  line('');
  line('④ 第二天只做一半（2 道里做 1 道，且答错）→ 不该打卡');
  const half = await answer(D1, ids[0], 'B');
  line(`   ${D1} 进度 ${half.progress}　打卡：${half.checked ? '有（不对）' : '没有（对）'}`);
  check('题单没做完：不打卡', half.checked === false, `进度 ${half.progress}`);
  check('第二天的会话仍标记未打卡', getSession(D1).checkedIn === false, `checked_in=${getSession(D1).checkedIn}`);

  // ---------- ⑤ 连续天数算法（纯函数，不受真实数据影响） ----------
  line('');
  line('⑤ 连续天数怎么算（纯函数，喂假的打卡日期）');
  rule();
  const streak3 = ['2026-02-01', '2026-02-02', '2026-02-03'];
  const gapped = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-06', '2026-02-07'];

  const nowAlive = computeCurrentStreak(streak3, '2026-02-03');
  const aliveYesterday = computeCurrentStreak(streak3, '2026-02-04');
  const broken = computeCurrentStreak(streak3, '2026-02-05');
  const longest = computeLongestStreak(gapped);

  line(`${pad('连 3 天，今天就是最后一天', 34)}当前连续 ${nowAlive}`);
  line(`${pad('连 3 天，最后一天是"昨天"', 34)}当前连续 ${aliveYesterday}（今天还没过完，不算断）`);
  line(`${pad('连 3 天，之后断了两天', 34)}当前连续 ${broken}（归零）`);
  line(`${pad('3 天 + 断 2 天 + 2 天', 34)}最长连续 ${longest}（保留 3）`);
  rule();
  check('连 3 天且最后一天是今天 → 3', nowAlive === 3, String(nowAlive));
  check('最后一天是昨天 → 仍算活着（3）', aliveYesterday === 3, String(aliveYesterday));
  check('断了两天 → 当前连续归零', broken === 0, String(broken));
  check('最长连续保留历史峰值（3）', longest === 3, String(longest));

  // ---------- ⑥ GET /api/stats 的聚合数字 ----------
  line('');
  line('⑥ GET /api/stats 的返回（用 delta 判断，不受你真实数据影响）');
  const stats = getStats();
  const datesAfter = checkinDatesBefore();
  const rowsAfter = getAccuracyRows();
  const afterTotal = rowsAfter.reduce((sum, row) => sum + row.total, 0);
  const afterCorrect = rowsAfter.reduce((sum, row) => sum + row.correct, 0);

  const expectOverall = afterTotal ? Math.round((afterCorrect / afterTotal) * 100) / 100 : null;
  const objectiveRow = rowsAfter.find((row) => row.type === 'objective');
  const expectObjective = objectiveRow?.total
    ? Math.round((objectiveRow.correct / objectiveRow.total) * 100) / 100
    : null;

  line(`   total_days  ${datesBefore.length} → ${stats.total_days}（本次 +${datesAfter.length - datesBefore.length}）`);
  line(`   current_streak ${stats.current_streak}　longest_streak ${stats.longest_streak}`);
  line(`   accuracy.overall ${stats.accuracy.overall}　by_type.objective ${stats.accuracy.by_type.objective}`);

  check('total_days = 打卡记录条数', stats.total_days === datesAfter.length, String(stats.total_days));
  check('本次打卡让 total_days 多了 1 天', datesAfter.length - datesBefore.length === 1, `${datesBefore.length} → ${datesAfter.length}`);
  check('longest_streak ≥ current_streak', stats.longest_streak >= stats.current_streak, `${stats.longest_streak} / ${stats.current_streak}`);
  check('accuracy.overall 与作答记录一致', stats.accuracy.overall === expectOverall, `${stats.accuracy.overall}（期望 ${expectOverall}；本次作答 3 对 + 1 错）`);
  check('accuracy.by_type.objective 与作答记录一致', stats.accuracy.by_type.objective === expectObjective, `${stats.accuracy.by_type.objective}（期望 ${expectObjective}）`);
  check(
    'accuracy.by_type 四种题型键齐全',
    ['objective', 'term', 'image', 'essay'].every((type) => type in stats.accuracy.by_type),
    Object.keys(stats.accuracy.by_type).join(', ')
  );
  check('本次作答确实改变了整体正确率的分母', afterTotal - baseTotal === 4, `+${afterTotal - baseTotal} 条`);
  check('本次作答确实改变了整体正确率分子', afterCorrect - baseCorrect === 3, `+${afterCorrect - baseCorrect} 条`);

  // ---------- ⑦ 真实 HTTP 打一次 ----------
  line('');
  line('⑦ 起真实服务打一次 GET /api/stats');
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/stats`);
  const body = await response.json();
  server.close();

  line(`   HTTP ${response.status}　${JSON.stringify(body)}`);
  check('接口返回 200', response.status === 200, `HTTP ${response.status}`);
  check(
    '返回含四个约定字段',
    ['current_streak', 'longest_streak', 'total_days', 'accuracy'].every((key) => key in body),
    Object.keys(body).join(', ')
  );

  // ---------- ⑧ 清理 ----------
  line('');
  line('⑧ 清理临时数据');
  cleanup(createdQuestionIds);
  const residual = residualReport(createdQuestionIds);
  rule();
  line('残留：' + Object.entries(residual).map(([key, value]) => `${key} ${value}`).join('　'));
  check('临时数据已清理干净', Object.values(residual).every((value) => value === 0), JSON.stringify(residual));

  // ---------- 结果 ----------
  line('');
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 40)}${detail}`);
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);
  line('');
  line('打卡靠"做完当天题单"触发；当前连续断了归零、最长连续与总天数永久保留。');
  rule();

  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    line('');
    line(`验收脚本出错：${err?.message ?? err}`);
    line('（临时数据可能没清干净，重跑一次即可）');
    process.exitCode = 1;
  });