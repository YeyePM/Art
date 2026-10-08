// T4 验收：当日会话组装 + GET /api/today
//   node app/api/scripts/verify-t4.js
//
// 会真调一次 AI（约 0.005 元），只用来验收，不进运行时。
// 步骤：清空题库 → 起真实 HTTP 服务打一次 /api/today → 打印今天的 10 道题与自检 →
//       再用假数据模拟"明天"，验证 ① 昨日未完成题排最前 ② 到期复习题会补进来 ③ 一分钱不花
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { countQuestions } from '../src/db/questions.js';
import { countArtworks } from '../src/db/artworks.js';
import { getSession } from '../src/db/dailySessions.js';
import { getTodayView } from '../src/services/todaySession.js';
import { todayInShanghai } from '../src/services/questionPicker.js';
import { inferOrigin } from '../src/services/taxonomy.js';
import { resetQuestionBank } from './seed-questions.js';

const TYPE_LABEL = { objective: '客观题', term: '名词解释', image: '图像辨识', essay: '论述题' };
const ORIGIN_LABEL = { cn: '中国', foreign: '外国', unknown: '—' };

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));

// ---------- 中日韩字符按两列算，终端里才能真正对齐 ----------
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);
function truncate(text, width) {
  if (widthOf(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (used + w > width - 2) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function countByType(questions = []) {
  const counts = { objective: 0, term: 0, image: 0, essay: 0 };
  for (const q of questions) if (counts[q.type] !== undefined) counts[q.type] += 1;
  return counts;
}

/** 前一天 / 后一天（按 YYYY-MM-DD 算，避开本地时区） */
function shiftDay(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}

async function main() {
  const db = getDb();
  const date = todayInShanghai();
  const tomorrow = shiftDay(date, 1);

  line('');
  line('T4 验收 · 当日会话与 GET /api/today');
  line(`今天：${date}（Asia/Shanghai）`);
  rule();

  // ---------- ① 从零开始 ----------
  resetQuestionBank();
  db.exec('DELETE FROM artwork_notes; DELETE FROM artworks;');
  line(`① 从零开始：题库 ${countQuestions()} 道题、${countArtworks()} 件画作`);
  line('');

  // ---------- ② 起真实服务，打接口 ----------
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  line('② 打开今天（真调一次 AI 补齐、真取博物馆元数据，约 40～90 秒）');
  line('   窗口这几秒没有任何动静是正常的，别关。');
  const startedAt = Date.now();
  const response = await fetch(`${base}/api/today`);
  const today = await response.json();
  const tookMs = Date.now() - startedAt;
  line(`   HTTP ${response.status}　耗时 ${(tookMs / 1000).toFixed(1)} 秒　返回 ${today.questions?.length ?? 0} 道题`);
  line('');

  // ---------- ③ 今天的题单 ----------
  line('③ 今天会出的题');
  rule();
  line(`${pad('序号', 6)}${pad('题型', 12)}${pad('难度', 8)}${pad('范围', 8)}${pad('标记', 8)}题干`);
  rule();
  today.questions.forEach((question, index) => {
    const origin = inferOrigin(question.tags);
    line(
      `${pad(String(index + 1), 6)}${pad(TYPE_LABEL[question.type] ?? question.type, 12)}` +
        `${pad(question.difficulty ?? '', 8)}${pad(ORIGIN_LABEL[origin ?? 'unknown'], 8)}` +
        `${pad(question.is_review ? '复习' : '新题', 8)}${truncate(question.stem, 48)}`
    );
  });
  rule();
  line('');

  // ---------- ④ 抽一道完整看看（题干 + 选项，接口里就该只有这些） ----------
  const sample = today.questions.find((question) => question.type === 'objective') ?? today.questions[0];
  if (sample) {
    line('④ 抽一道完整样例（接口返回的原样内容）');
    rule();
    line(`[${TYPE_LABEL[sample.type]}] ${sample.stem}`);
    (sample.options ?? []).forEach((option) => line(`   ${option}`));
    line(`   字段：id=${sample.id} type=${sample.type} difficulty=${sample.difficulty} image_url=${sample.image_url} is_review=${sample.is_review} tags=${JSON.stringify(sample.tags)}`);
    rule();
    line('');
  }

  // ---------- ⑤ 自检 ----------
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, ok, detail]);

  const counts = countByType(today.questions);
  const choiceQuestions = today.questions.filter((q) => q.type === 'objective' || q.type === 'image');
  const openQuestions = today.questions.filter((q) => q.type === 'term' || q.type === 'essay');
  const imageRows = db.prepare("SELECT id, artwork_id FROM questions WHERE type = 'image'").all();

  // 红线：返回文本里一个答案字段都不能有
  const raw = JSON.stringify(today);
  const answerHits = (raw.match(/"answer"/g) ?? []).length;
  const explanationHits = (raw.match(/"explanation"/g) ?? []).length;

  check('接口返回 200', response.status === 200, `HTTP ${response.status}`);
  check('日期是今天', today.date === date, String(today.date));
  check('正好 10 道题', today.questions.length === 10, `${today.questions.length} 道`);
  check('题型上限守住（论述 ≤1、名词 ≤2、图像辨识 ≤2）', counts.essay <= 1 && counts.term <= 2 && counts.image <= 2, JSON.stringify(counts));
  check('四种题型都出现', counts.essay >= 1 && counts.term >= 1 && counts.image >= 1 && counts.objective >= 1, JSON.stringify(counts));
  check('客观题 / 图像辨识题各 4 个选项', choiceQuestions.length > 0 && choiceQuestions.every((q) => Array.isArray(q.options) && q.options.length === 4), `${choiceQuestions.length} 道带选项`);
  check('名词解释 / 论述题的选项为空', openQuestions.every((q) => q.options === null), `${openQuestions.length} 道不带选项`);
  check('图像辨识题挂上了博物馆画作', imageRows.length > 0 && imageRows.every((row) => row.artwork_id != null), `共 ${imageRows.length} 道，挂上 ${imageRows.filter((r) => r.artwork_id != null).length} 道`);
  check('红线：返回里没有答案与解析', answerHits === 0 && explanationHits === 0, `answer ${answerHits} 处、explanation ${explanationHits} 处`);
  check('进度从 0 开始、未打卡', today.progress.done === 0 && today.progress.total === 10 && today.checked_in === false, `done=${today.progress.done} / total=${today.progress.total}，checked_in=${today.checked_in}`);

  // 同一天再打开一次：题目必须一模一样，且不再花钱
  const again = await (await fetch(`${base}/api/today`)).json();
  const sessionRows = db.prepare('SELECT count(*) AS c FROM daily_sessions').get().c;
  check('同日再打开：题目逐题一致', JSON.stringify(again.questions.map((q) => q.id)) === JSON.stringify(today.questions.map((q) => q.id)), '题目与首次完全相同');
  check('同日再打开：不再入库新题、不再调 AI', countQuestions() === 10, `题库 ${countQuestions()} 道`);
  check('daily_sessions 只有 1 行（当天不重复建会话）', sessionRows === 1, `${sessionRows} 行`);

  // ---------- ⑥ 模拟明天：昨日未完成 + 到期复习 ----------
  // 把今天第 1 道标成"已作答"并丢进复习队列、明天到期。
  // 明天应该：其余 9 道按原顺序排最前 + 这道复习题补进来 = 正好 10，且不调 AI、不取画。
  const ids = today.questions.map((q) => q.id);
  const [answeredId, ...restIds] = ids;

  db.prepare('INSERT INTO answers (question_id, session_date, user_answer, is_correct) VALUES (?, ?, ?, ?)').run(answeredId, date, '（自测用假作答）', 0);
  db.prepare(`
    INSERT INTO review_queue (question_id, first_wrong_on, next_review_on, interval_days, correct_streak, status)
    VALUES (?, ?, ?, 1, 0, 'active')
  `).run(answeredId, date, tomorrow);

  const bankBefore = countQuestions();
  const artBefore = countArtworks();
  const view = await getTodayView({ date: tomorrow });
  const reviewQuestion = view.questions.find((q) => q.id === answeredId);

  check('明日会话：仍正好 10 道（配额不膨胀）', view.questions.length === 10, `${view.questions.length} 道`);
  check('昨日未完成的 9 道按原顺序排在最前', JSON.stringify(view.questions.slice(0, 9).map((q) => q.id)) === JSON.stringify(restIds), '顺序一致');
  check('到期复习题被排进明日题单', reviewQuestion != null, reviewQuestion ? `排在第 ${view.questions.findIndex((q) => q.id === answeredId) + 1} 位` : '没排进来');
  check('复习题标了 is_review', reviewQuestion?.is_review === true, `is_review=${reviewQuestion?.is_review}`);
  check('为明天组题没有再调 AI、没有再取画', countQuestions() === bankBefore && countArtworks() === artBefore, `题库 ${bankBefore} → ${countQuestions()}，画作 ${artBefore} → ${countArtworks()}`);
  check('今天的题单没有被明天的组装改掉', JSON.stringify(getSession(date).questionIds) === JSON.stringify(ids), '今天的题单原样保留');

  // 清掉这次模拟留下的假数据：明天的会话、假作答、假复习记录
  db.prepare('DELETE FROM daily_sessions WHERE date = ?').run(tomorrow);
  db.prepare('DELETE FROM answers WHERE session_date = ?').run(date);
  db.exec('DELETE FROM review_queue');

  // ---------- ⑦ 结果 ----------
  line('⑤ 自检');
  rule();
  for (const [name, ok, detail] of checks) {
    line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 44)}${detail}`);
  }
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);
  line('');

  server.close();
  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    line('');
    line(`验收脚本出错：${err?.message ?? err}`);
    line('（题库和画作已清空，重跑一次即可）');
    process.exitCode = 1;
  });