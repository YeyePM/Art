// T11 验收：主界面概览 + 打卡日历（M7）
//   node app/api/scripts/verify-t11.js
//
// 两段：
//   A. 规则层（**不花钱、不联网**）：用虚拟日期 + 注入内容，验证
//      `/api/home` 的三处数字与「今日页 / 学习进度页 / 本周一批」**逐一同源**，日历也照数。
//   B. 真实接口（起一次服务打自己的 HTTP）：把 /api/today、/api/home、/api/stats、/api/weekly
//      四个接口的返回拿来做交叉比对——这就是 T11 的验收点"两处数字不能对不上"。
//      **若今天题单还没生成过，这里会顺手生成一次（1 次 AI，约 0.5 分钱）；当天已生成过则分文不花。**
//
// 临时数据全在虚拟日期上，跑完按"高水位"清干净，不动你现有的题库、作答、批次与打卡。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { insertQuestions } from '../src/db/questions.js';
import { getSession, saveSession } from '../src/db/dailySessions.js';
import { getCheckin, getAllCheckinDates } from '../src/db/checkins.js';
import { submitAnswer } from '../src/services/grading.js';
import { getStats, buildCalendar } from '../src/services/stats.js';
import { getTodayView } from '../src/services/todaySession.js';
import { getWeeklyView, createWeeklyBatch } from '../src/services/weeklyBatch.js';
import { getHomeView } from '../src/services/home.js';
import { todayInShanghai } from '../src/services/questionPicker.js';

const V = '2026-02-10';   // 自检的"今天"（过去的日子，不会顶掉你真实的连续天数）
const V2 = '2027-03-01';  // 用来造一个"最新批次"，让主界面的「本周一批」摘要有东西可读
const CHOICE = ['A 甲', 'B 乙', 'C 丙', 'D 丁'];

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, ok, detail]);

const gen = {
  artwork: { title: '【T11自检】画作', artist: '自检', period: '—', school: null, sourceLibrary: 'met', externalId: null, imageUrl: null },
  excerpt: { bookTitle: '【T11自检】历代名画记', chapter: '卷一 论画六法', sourceText: '气韵生动……（自检用原文）', contactLine: '自检触点' },
  openQuestion: { stem: '【T11自检】完成感究竟从哪里来？', referenceThoughts: '可从笔触与"停笔"的判断切入。' }
};

function shiftDay(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}

const marks = {};
function takeMarks() {
  const db = getDb();
  const max = (table) => db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM ${table}`).get().m;
  marks.questions = max('questions');
  marks.batches = max('weekly_batches');
  marks.excerpts = max('excerpts');
  marks.openQuestions = max('open_questions');
  marks.artworks = max('artworks');
}

function cleanup() {
  const db = getDb();
  // 外键顺序：weekly_batches 引用 artworks/excerpts/open_questions，先删它
  db.prepare('DELETE FROM weekly_batches  WHERE id > ?').run(marks.batches);
  db.prepare('DELETE FROM artwork_notes   WHERE artwork_id > ?').run(marks.artworks);
  db.prepare('DELETE FROM excerpts        WHERE id > ?').run(marks.excerpts);
  db.prepare('DELETE FROM open_questions  WHERE id > ?').run(marks.openQuestions);
  db.prepare('DELETE FROM artworks        WHERE id > ?').run(marks.artworks);
  // 题：先删引用它的三张子表
  db.prepare('DELETE FROM review_queue  WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM answers       WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM question_tags WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM questions     WHERE id > ?').run(marks.questions);
  db.prepare('DELETE FROM checkins        WHERE date = ?').run(V);
  db.prepare('DELETE FROM daily_sessions  WHERE date = ?').run(V);
}

function residual() {
  const db = getDb();
  const c = (sql, ...args) => db.prepare(sql).get(...args).c;
  return {
    题库: c('SELECT count(*) AS c FROM questions      WHERE id > ?', marks.questions),
    作答: c('SELECT count(*) AS c FROM answers        WHERE question_id > ?', marks.questions),
    队列: c('SELECT count(*) AS c FROM review_queue   WHERE question_id > ?', marks.questions),
    批次: c('SELECT count(*) AS c FROM weekly_batches WHERE id > ?', marks.batches),
    画作: c('SELECT count(*) AS c FROM artworks       WHERE id > ?', marks.artworks),
    打卡: c('SELECT count(*) AS c FROM checkins       WHERE date = ?', V),
    会话: c('SELECT count(*) AS c FROM daily_sessions WHERE date = ?', V)
  };
}

const fakeQuestions = () => [0, 1, 2].map((i) => ({
  type: 'objective',
  stem: `【T11自检】主界面概览用假题 ${i + 1}`,
  options: CHOICE,
  answer: 'A',
  explanation: '自检用，跑完即删。',
  difficulty: '基础',
  tags: []
}));

async function main() {
  const db = getDb();

  line('');
  line('T11 验收 · 主界面概览与打卡日历（M7）');
  line(`虚拟日：${V}（自检的"今天"）　另造一个最新批次起算日 ${V2}`);
  line('规则部分不花钱不联网；最后真实比对四个接口的数字。');
  rule();

  cleanup();
  takeMarks();

  // ---------- ① 打卡日历（纯函数，喂假日期） ----------
  line('');
  line('① 打卡日历怎么排（纯函数，只看"完成 / 未完成"）');
  const cal5 = buildCalendar(['2026-02-10'], '2026-02-10', 5);
  line(`   ${cal5.map((d) => `${d.date.slice(5)}${d.checked_in ? '●' : '○'}`).join('  ')}`);
  check('日历条数 = 窗口长度', cal5.length === 5, String(cal5.length));
  check('最后一天就是"今天"', cal5[4].date === '2026-02-10', cal5[4].date);
  check('打过卡的当天标 ●', cal5[4].checked_in === true, String(cal5[4].checked_in));
  check('没打卡的日子标 ○', cal5[0].checked_in === false, String(cal5[0].checked_in));
  check(
    '日期连续、一天不缺',
    cal5.every((d, i) => d.date === shiftDay(cal5[0].date, i)),
    cal5.map((d) => d.date).join(',')
  );

  // ---------- ② 造一份"最新批次"和虚拟"今天"的题单 ----------
  line('');
  line('② 造测试数据（最新批次 + 虚拟今天的 3 道假题，注入内容不调 AI）');
  const batch = await createWeeklyBatch({ date: V2, generation: gen });
  line(`   批次 batch_id=${batch?.id}（starts_on ${batch?.startsOn}）`);

  const { inserted } = insertQuestions(fakeQuestions());
  const ids = [...inserted];
  saveSession({ date: V, questionIds: ids, total: ids.length });
  line(`   题单：${ids.length} 道（id ${ids.join(', ')}）｜会话已写在 ${V}`);

  // 做完这 3 道（2 对 1 错）→ 当天题单完成 → 打卡成立
  await submitAnswer({ questionId: ids[0], userAnswer: 'A', date: V });
  await submitAnswer({ questionId: ids[1], userAnswer: 'A', date: V });
  await submitAnswer({ questionId: ids[2], userAnswer: 'B', date: V });
  check('做完题单即打卡（虚拟日）', getCheckin(V) != null, getCheckin(V)?.date ?? '没有');

  // ---------- ③ 主界面的三处数字必须与各自页面同源 ----------
  line('');
  line('③ 主界面 vs 今日页 / 学习进度页 / 本周一批（同一套口径）');
  const home = await getHomeView({ date: V, artworks: [], generation: gen });
  const todayView = await getTodayView({ date: V, artworks: [] });
  const statsView = getStats({ date: V });
  const weeklyView = await getWeeklyView({ date: V });

  line(`   今日的题　主界面 ${home.today_progress.done}/${home.today_progress.total}　今日页 ${todayView.progress.done}/${todayView.progress.total}`);
  line(`   学习进度　主界面 连续 ${home.stats.current_streak} · 正确率 ${home.stats.accuracy}　统计页 连续 ${statsView.current_streak} · 正确率 ${statsView.accuracy.overall}`);
  line(`   本周一批　主界面 「${home.weekly_summary?.artwork_title}」/「${home.weekly_summary?.excerpt_book}」/ 开放问题 ${home.weekly_summary?.has_open_question}`);

  check('返回里带 date，且就是传入那天', home.date === V, String(home.date));
  check(
    '今日进度与 /api/today 完全一致',
    home.today_progress.done === todayView.progress.done && home.today_progress.total === todayView.progress.total,
    JSON.stringify(home.today_progress)
  );
  check('连续天数与 /api/stats 完全一致', home.stats.current_streak === statsView.current_streak, `${home.stats.current_streak} / ${statsView.current_streak}`);
  check('正确率与 /api/stats 完全一致', home.stats.accuracy === statsView.accuracy.overall, `${home.stats.accuracy} / ${statsView.accuracy.overall}`);
  check('本周摘要与 /api/weekly 同批次', home.weekly_summary?.batch_id === weeklyView?.batch_id, `${home.weekly_summary?.batch_id} / ${weeklyView?.batch_id}`);
  check('本周摘要的画名与 /api/weekly 一致', home.weekly_summary?.artwork_title === weeklyView?.artwork?.title, String(home.weekly_summary?.artwork_title));
  check('本周摘要不给正文（不泄露内容）', home.weekly_summary?.excerpt_book === weeklyView?.excerpt?.book_title && !('source_text' in home.weekly_summary) && !('stem' in home.weekly_summary), Object.keys(home.weekly_summary ?? {}).join(','));
  check('正常时 notice 为 null', home.notice === null, String(home.notice));

  // ---------- ④ 真实接口交叉比对 ----------
  line('');
  line('④ 起真实服务，四个接口的数字做交叉比对');
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };

  const todayHttp = await getJson('/api/today');
  const homeHttp = await getJson('/api/home');
  const statsHttp = await getJson('/api/stats');
  const weeklyHttp = await getJson('/api/weekly');
  server.close();

  line(`   /api/today   ${todayHttp.status}　进度 ${todayHttp.body?.progress?.done}/${todayHttp.body?.progress?.total}`);
  line(`   /api/home    ${homeHttp.status}　进度 ${homeHttp.body?.today_progress?.done}/${homeHttp.body?.today_progress?.total}`);
  line(`   /api/stats   ${statsHttp.status}　连续 ${statsHttp.body?.current_streak}　日历 ${statsHttp.body?.calendar?.length} 格`);
  line(`   /api/weekly  ${weeklyHttp.status}　批次 ${weeklyHttp.body?.batch_id ?? '—'}`);

  check('GET /api/home 返回 200', homeHttp.status === 200, `HTTP ${homeHttp.status}`);
  check(
    '首页数字与今日页数字一致（HTTP）',
    homeHttp.body?.today_progress?.done === todayHttp.body?.progress?.done &&
      homeHttp.body?.today_progress?.total === todayHttp.body?.progress?.total,
    `${homeHttp.body?.today_progress?.done}/${homeHttp.body?.today_progress?.total}`
  );
  check('首页连续天数与统计页一致（HTTP）', homeHttp.body?.stats?.current_streak === statsHttp.body?.current_streak, `${homeHttp.body?.stats?.current_streak} / ${statsHttp.body?.current_streak}`);
  check('首页正确率与统计页一致（HTTP）', homeHttp.body?.stats?.accuracy === statsHttp.body?.accuracy?.overall, `${homeHttp.body?.stats?.accuracy} / ${statsHttp.body?.accuracy?.overall}`);
  check('首页本周摘要与周批次接口同批次（HTTP）', homeHttp.body?.weekly_summary?.batch_id === weeklyHttp.body?.batch_id, `${homeHttp.body?.weekly_summary?.batch_id} / ${weeklyHttp.body?.batch_id}`);

  // 日历：与真实打卡记录对得上
  const realDates = new Set(getAllCheckinDates());
  const realToday = todayInShanghai();
  const cal = statsHttp.body?.calendar ?? [];
  line(`   日历窗口：${cal[0]?.date} ~ ${cal[cal.length - 1]?.date}`);
  check('/api/stats 返回 200', statsHttp.status === 200, `HTTP ${statsHttp.status}`);
  check('日历共 30 格', cal.length === 30, String(cal.length));
  check('日历最后一格是今天', cal[cal.length - 1]?.date === realToday, String(cal[cal.length - 1]?.date));
  check('日历里打过卡的日子全部露出', cal.filter((d) => d.checked_in).every((d) => realDates.has(d.date)), cal.filter((d) => d.checked_in).map((d) => d.date).join(','));
  check('日历里没打卡的日子都没标', cal.filter((d) => !d.checked_in).every((d) => !realDates.has(d.date)), `${cal.filter((d) => !d.checked_in).length} 格未完成`);
  check('日历里连续打卡的日子都在（总数对得上）', cal.filter((d) => d.checked_in).length === [...realDates].filter((d) => cal.some((x) => x.date === d)).length, String(cal.filter((d) => d.checked_in).length));

  check('审计用：/api/home 的字段就这三个板块 + notice', ['date', 'today_progress', 'stats', 'weekly_summary', 'notice'].every((k) => k in homeHttp.body), Object.keys(homeHttp.body ?? {}).join(','));

  // ---------- ⑤ 清理 ----------
  line('');
  line('⑤ 清理临时数据');
  cleanup();
  const left = residual();
  rule();
  line('残留：' + Object.entries(left).map(([k, v]) => `${k} ${v}`).join('　'));
  check('临时数据已清理干净', Object.values(left).every((v) => v === 0), JSON.stringify(left));

  // ---------- 结果 ----------
  line('');
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 46)}${detail}`);
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);
  line('');
  line('主界面上的数字与今日页 / 学习进度页同源，所以两处永远不会对不上。');
  rule();

  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    line('');
    line(`验收脚本出错：${err?.message ?? err}`);
    line('（临时数据可能没清干净，重跑一次即可）');
    process.exitCode = 1;
  });