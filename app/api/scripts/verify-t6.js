// T6 验收：错题队列与遗忘曲线（M3）
//   node app/api/scripts/verify-t6.js
//
// **不花钱、不动你现有的题库与今天的题单**：自己插 8 道带「【T6自检】」前缀的临时题，
// 跑完连作答记录、队列记录一起删干净。
//
// 为什么能"一天之内走完 26 天"：规则层（services/grading.js）的 submitAnswer 收一个 date 参数，
// 这里显式传不同的日期，等价于把系统日期往前拨。**接口层不开放这个参数**（前端不能自己定日期），
// 所以曲线部分直接调服务层；最后再用真实 HTTP 打一次，确认接口这条路也通。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { insertQuestions } from '../src/db/questions.js';
import { insertAnswer } from '../src/db/answers.js';
import { getQueueItem, upsertQueueItem, getDueReviewIds, getActiveReviewIds, countActiveReview } from '../src/db/reviewQueue.js';
import { submitAnswer } from '../src/services/grading.js';
import { todayInShanghai } from '../src/services/questionPicker.js';

const TAG = '【T6自检】';
/** 虚拟起点：自检里的"第一天"。故意用过去的日期，离真实数据远一点 */
const D0 = '2026-03-02';
const DAY = (n) => addDays(D0, n);

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));

// ---------- 中日韩字符按两列算，终端里才能真正对齐 ----------
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);
function truncate(text, width) {
  const clean = String(text ?? '').replace(/\s+/g, ' ');
  if (widthOf(clean) <= width) return clean;
  let out = '';
  let used = 0;
  for (const ch of clean) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (used + w > width - 2) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 与 services/reviewQueue.js 同款日期加减（只用来算期望值） */
function addDays(day, days) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

// ---------- 临时数据与清理 ----------
const createdQuestionIds = [];

function cleanup() {
  const db = getDb();
  if (!createdQuestionIds.length) return;

  const placeholders = createdQuestionIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM answers WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
  db.prepare(`DELETE FROM review_queue WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
  db.prepare(`DELETE FROM question_tags WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
  db.prepare(`DELETE FROM questions WHERE id IN (${placeholders})`).run(...createdQuestionIds);
  createdQuestionIds.length = 0;
}

/** 4 个选项，正确项由 letter 指定 */
const OPTIONS = ['A 郭熙', 'B 范宽', 'C 李成', 'D 王希孟'];
const buildChoice = (stem, letter, type = 'objective') => ({
  type,
  stem: TAG + stem,
  options: OPTIONS,
  answer: letter,
  explanation: `${TAG}解析：本题用于自检复习曲线。`,
  difficulty: '基础',
  tags: ['宋', '自检']
});

const buildTerm = (stem) => ({
  type: 'term',
  stem: TAG + stem,
  options: null,
  answer: '参考答案：用于自检。',
  explanation: `${TAG}解析：本题用于自检复习曲线。`,
  difficulty: '进阶',
  tags: ['自检']
});

function buildQuestions() {
  return [
    buildChoice('A · 走完 1→3→7→15 全程', 'B'), // ①
    buildChoice('B · 中途答错退回 1 天', 'B'), // ②
    buildChoice('C · 答对但没进过队', 'B'), // ③
    buildTerm('D1 · 今天才入队 → 改判成对'), // ④
    buildTerm('D2 · 老队 → 改判成对要推进'), // ⑤
    buildTerm('D3 · 原本判对 → 改判成错要入队'), // ⑥
    buildChoice('E · 重复提交不许推进间隔', 'B'), // ⑦
    buildChoice('F · 接口层（今天）', 'B') // ⑧
  ];
}

async function main() {
  const db = getDb();

  line('');
  line('T6 验收 · 错题队列与遗忘曲线（M3）');
  line(`虚拟起点：${D0}（自检里的"第一天"）`);
  line('本脚本不动你现有的题库与今天的题单，只会临时插几道自检题，跑完自动删掉。');
  rule();

  const { inserted } = insertQuestions(buildQuestions());
  createdQuestionIds.push(...inserted);
  line(`① 临时插入 ${inserted.length} 道自检题（id：${inserted.join(', ')}）`);
  line('');

  const [qWalk, qBack, qNoQueue, qOverrideToday, qOverrideOld, qOverrideWrong, qIdem, qHttp] = inserted;

  /** 直接调服务层：显式传日期，等价于把系统日期往前拨 */
  const ask = (questionId, userAnswer, options = {}) =>
    submitAnswer({ questionId, userAnswer, selfGrade: options.selfGrade, date: options.date ?? D0 });

  const checks = [];
  const check = (name, ok, detail) => checks.push([name, ok, detail]);

  line('② 走完 1 → 3 → 7 → 15（在这四个节点都答对，才出队）');
  rule();
  line(`${pad('节点', 30)}${pad('动作', 12)}${pad('next_review_at', 18)}队列`);
  rule();

  const walk = [
    { on: 0, answer: 'C', label: '第 1 天', action: '答错', expectNext: DAY(1), expectInterval: 1 },
    { on: 1, answer: 'B', label: '第 2 天', action: '答对', expectNext: DAY(4), expectInterval: 3 },
    { on: 4, answer: 'B', label: '第 5 天', action: '答对', expectNext: DAY(11), expectInterval: 7 },
    { on: 11, answer: 'B', label: '第 12 天', action: '答对', expectNext: DAY(26), expectInterval: 15 },
    { on: 26, answer: 'B', label: '第 27 天', action: '答对', expectNext: null, expectInterval: null }
  ];

  // 插入当天还没到期、第二天才到期——这两条必须在"第 1 天答错"之后马上验，
  // 等到走完全程再验就失去意义了（那时它已经出队）
  let dueCheck = { afterEnqueue: null, onDueDay: null };

  for (const [index, step] of walk.entries()) {
    const day = DAY(step.on);
    const result = await ask(qWalk, step.answer, { date: day });
    const item = getQueueItem(qWalk);
    const status = item?.status === 'active' ? `active · 间隔 ${item.intervalDays} · 连对 ${item.correctStreak}` : String(item?.status ?? '—');
    line(`${pad(`${step.label}（${day}）`, 30)}${pad(step.action, 12)}${pad(String(result.next_review_at ?? 'null'), 18)}${status}`);

    if (index === 0) {
      dueCheck = {
        afterEnqueue: getDueReviewIds(D0).includes(qWalk),
        onDueDay: getDueReviewIds(DAY(1)).includes(qWalk)
      };
    }

    check(`${step.label} ${step.action} → next_review_at 对`, result.next_review_at === step.expectNext, `期望 ${step.expectNext ?? 'null'}，实际 ${result.next_review_at ?? 'null'}`);
    check(`${step.label} → 间隔/状态对`, step.expectNext === null ? item?.status === 'done' : item?.intervalDays === step.expectInterval, status);
  }
  line('');

  line('③ 到期日算得对不对（组题时靠它把复习题插进来）');
  rule();
  line(`插入当天（${D0}，还没到期）：${dueCheck.afterEnqueue ? '出现了（错）' : '没出现（对）'}`);
  line(`到期日（${DAY(1)}）：${dueCheck.onDueDay ? '出现（对）' : '没出现（错）'}`);
  line(`出队后（${DAY(27)}）：${getDueReviewIds(DAY(27)).includes(qWalk) ? '出现（错）' : '没出现（对）'}`);
  check('插入当天不算到期', dueCheck.afterEnqueue === false, D0);
  check('到期的第二天出现在待复习里', dueCheck.onDueDay === true, DAY(1));
  check('出队后不再出现在待复习里', !getDueReviewIds(DAY(27)).includes(qWalk), DAY(27));
  check('出队后不在"还活着"的队列里', !getActiveReviewIds().includes(qWalk), `当前存活 ${countActiveReview()} 条`);
  line('');

  line('④ 中途答错：连对归零、间隔退回 1 天、从头再来');
  rule();
  await ask(qBack, 'C', { date: DAY(0) });
  const back1 = getQueueItem(qBack);
  line(`${pad('第 1 天 答错', 30)}${pad('入队', 12)}间隔 ${back1.intervalDays} · 连对 ${back1.correctStreak} · ${back1.nextReviewOn}`);

  await ask(qBack, 'B', { date: DAY(1) });
  const back2 = getQueueItem(qBack);
  line(`${pad('第 2 天 答对', 30)}${pad('推进', 12)}间隔 ${back2.intervalDays} · 连对 ${back2.correctStreak} · ${back2.nextReviewOn}`);

  const back3Result = await ask(qBack, 'C', { date: DAY(4) });
  const back3 = getQueueItem(qBack);
  line(`${pad('第 5 天 答错', 30)}${pad('退回', 12)}间隔 ${back3.intervalDays} · 连对 ${back3.correctStreak} · ${back3.nextReviewOn}`);

  const back4Result = await ask(qBack, 'B', { date: DAY(5) });
  const back4 = getQueueItem(qBack);
  line(`${pad('第 6 天 答对', 30)}${pad('再推进', 12)}间隔 ${back4.intervalDays} · 连对 ${back4.correctStreak} · ${back4.nextReviewOn}`);

  check('答对一次后间隔到 3 天', back2.intervalDays === 3 && back2.nextReviewOn === DAY(4), `${back2.intervalDays} 天 / ${back2.nextReviewOn}`);
  check('中途答错 → 间隔退回 1 天、连对归零', back3.intervalDays === 1 && back3.correctStreak === 0, `${back3.intervalDays} 天 / 连对 ${back3.correctStreak}`);
  check('中途答错 → 下次是"明天"', back3Result.next_review_at === DAY(5), `${back3Result.next_review_at}`);
  check('退回后重新答对 → 再回到 3 天', back4.intervalDays === 3 && back4Result.next_review_at === DAY(8), `${back4.intervalDays} 天 / ${back4Result.next_review_at}`);
  check('first_wrong_on 不被重来抹掉', back4.firstWrongOn === DAY(0), `${back4.firstWrongOn}`);
  line('');

  line('⑤ 答对但没进过队：与复习无关，什么都不该发生');
  rule();
  const noQueue = await ask(qNoQueue, 'B', { date: DAY(0) });
  line(`${pad('第 1 天 答对', 30)}${pad('—', 12)}next_review_at = ${String(noQueue.next_review_at)}　队列记录：${getQueueItem(qNoQueue) ? '有（错）' : '没有（对）'}`);
  check('答对不问复习 → next_review_at 为 null', noQueue.next_review_at === null, String(noQueue.next_review_at));
  check('答对不问复习 → 不入队', getQueueItem(qNoQueue) === null, '无队列记录');
  line('');

  line('⑥ 改判要跟着改队列（"AI 判错了我反馈"之后，复习计划也得对）');
  rule();

  // D1：今天才入的队（AI 判错）→ 用户当天改判成"其实答对了"→ 这道题本就不该进队
  insertAnswer({ questionId: qOverrideToday, sessionDate: DAY(0), userAnswer: '我的作答', isCorrect: false, aiCorrect: false, aiComment: 'AI 当时的点评' });
  upsertQueueItem({ questionId: qOverrideToday, firstWrongOn: DAY(0), nextReviewOn: DAY(1) });
  const d1 = await ask(qOverrideToday, '我的作答', { selfGrade: true, date: DAY(0) });
  line(`${pad('D1 今天入队 → 改判成对', 30)}next_review_at = ${String(d1.next_review_at)}　队列记录：${getQueueItem(qOverrideToday) ? '还在（错）' : '已删（对）'}`);
  check('改判成对 → 当天才入的队被删掉', d1.next_review_at === null && getQueueItem(qOverrideToday) === null, `next=${d1.next_review_at}`);
  check('改判：最终判定听用户的', d1.correct === true, `correct=${d1.correct}`);

  // D2：老队（10 天前就错了）→ 今天改判成对 → 该按"复习答对"推进一格
  insertAnswer({ questionId: qOverrideOld, sessionDate: DAY(0), userAnswer: '我的作答', isCorrect: false, aiCorrect: false });
  upsertQueueItem({ questionId: qOverrideOld, firstWrongOn: DAY(-10), nextReviewOn: DAY(0) });
  const d2 = await ask(qOverrideOld, '我的作答', { selfGrade: true, date: DAY(0) });
  const d2Item = getQueueItem(qOverrideOld);
  line(`${pad('D2 老队 → 改判成对', 30)}next_review_at = ${String(d2.next_review_at)}　间隔 ${d2Item.intervalDays} 天`);
  check('改判成对 → 老队按复习答对推进到 3 天', d2.next_review_at === DAY(3) && d2Item.intervalDays === 3, `${d2.next_review_at} / ${d2Item.intervalDays} 天`);

  // D3：AI 判对、没进队 → 用户改判成"其实我答错了" → 该入队
  insertAnswer({ questionId: qOverrideWrong, sessionDate: DAY(0), userAnswer: '我的作答', isCorrect: true, aiCorrect: true });
  const d3 = await ask(qOverrideWrong, '我的作答', { selfGrade: false, date: DAY(0) });
  const d3Item = getQueueItem(qOverrideWrong);
  line(`${pad('D3 原本判对 → 改判成错', 30)}next_review_at = ${String(d3.next_review_at)}　队列：${d3Item ? `${d3Item.status} · 间隔 ${d3Item.intervalDays}` : '没有（错）'}`);
  check('改判成错 → 入队、下次是明天', d3.next_review_at === DAY(1) && d3Item?.status === 'active' && d3Item?.intervalDays === 1, `${d3.next_review_at} / ${d3Item?.status}`);
  line('');

  line('⑦ 重复提交是幂等的：不许把间隔白白往前推一格');
  rule();
  await ask(qIdem, 'C', { date: DAY(0) });
  const idem1 = getQueueItem(qIdem);
  line(`${pad('第 1 天 答错', 30)}间隔 ${idem1.intervalDays} · ${idem1.nextReviewOn}`);

  const idemAgain = await ask(qIdem, 'C', { date: DAY(0) });
  const idem2 = getQueueItem(qIdem);
  line(`${pad('同一天再交一次（错）', 30)}间隔 ${idem2.intervalDays} · ${idem2.nextReviewOn}　next_review_at = ${String(idemAgain.next_review_at)}`);

  await ask(qIdem, 'B', { date: DAY(1) });
  const idem3 = getQueueItem(qIdem);
  const idemAgain2 = await ask(qIdem, 'B', { date: DAY(1) });
  const idem4 = getQueueItem(qIdem);
  line(`${pad('第 2 天 答对 → 再交一次', 30)}间隔 ${idem4.intervalDays} · ${idem4.nextReviewOn}　next_review_at = ${String(idemAgain2.next_review_at)}`);

  check('同一天重复提交答错 → 间隔没被重置（还是 1 天）', idem2.intervalDays === 1 && idem2.nextReviewOn === DAY(1), `${idem2.intervalDays} 天 / ${idem2.nextReviewOn}`);
  check('重复提交返回首次的 next_review_at', idemAgain.next_review_at === DAY(1), String(idemAgain.next_review_at));
  check('复习答对后重复提交 → 间隔没被推到 7 天', idem4.intervalDays === 3 && idem4.nextReviewOn === DAY(4), `${idem4.intervalDays} 天 / ${idem4.nextReviewOn}`);
  check('重复提交返回当前 next_review_at', idemAgain2.next_review_at === DAY(4), String(idemAgain2.next_review_at));
  line('');

  line('⑧ 出队后再答错：重新入队，从头再来');
  rule();
  const reWrong = await ask(qWalk, 'C', { date: DAY(30) });
  const reItem = getQueueItem(qWalk);
  line(`${pad('第 31 天 又答错', 30)}next_review_at = ${String(reWrong.next_review_at)}　队列：${reItem.status} · 间隔 ${reItem.intervalDays} · first_wrong_on ${reItem.firstWrongOn}`);
  check('出队后答错 → 重新入队', reWrong.next_review_at === DAY(31) && reItem.status === 'active', `${reWrong.next_review_at} / ${reItem.status}`);
  check('重新入队 → first_wrong_on 改成这一次', reItem.firstWrongOn === DAY(30), reItem.firstWrongOn);
  line('');

  // ---------- 真实 HTTP 走一遍（曲线那部分故意不开放日期参数，这里只验接口通） ----------
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const today = todayInShanghai();
  const response = await fetch(`${base}/api/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question_id: qHttp, user_answer: 'C' })
  });
  const httpBody = await response.json();
  server.close();

  line('⑨ 真实 HTTP 打一次 /api/answers（确认接口这条路也通）');
  rule();
  line(`POST /api/answers → HTTP ${response.status}　correct=${httpBody.correct}　next_review_at=${String(httpBody.next_review_at)}`);
  check('接口层答错 → HTTP 200', response.status === 200, `HTTP ${response.status}`);
  check('接口层答错 → next_review_at 是明天', httpBody.next_review_at === addDays(today, 1), `期望 ${addDays(today, 1)}，实际 ${httpBody.next_review_at}`);
  line('');

  // ---------- 清理 ----------
  const ids = [...createdQuestionIds];
  cleanup();
  const ph = ids.map(() => '?').join(',');
  const leftovers = {
    questions: db.prepare(`SELECT count(*) AS c FROM questions WHERE id IN (${ph})`).get(...ids).c,
    answers: db.prepare(`SELECT count(*) AS c FROM answers WHERE question_id IN (${ph})`).get(...ids).c,
    queue: db.prepare(`SELECT count(*) AS c FROM review_queue WHERE question_id IN (${ph})`).get(...ids).c
  };
  line('⑩ 清理临时数据');
  rule();
  line(`题库残留：${leftovers.questions} 道　作答残留：${leftovers.answers} 条　队列残留：${leftovers.queue} 条`);
  check('临时题清干净', leftovers.questions === 0, `${leftovers.questions} 道`);
  check('作答记录清干净', leftovers.answers === 0, `${leftovers.answers} 条`);
  check('队列记录清干净', leftovers.queue === 0, `${leftovers.queue} 条`);
  line('');

  // ---------- 汇总 ----------
  const passed = checks.filter(([, ok]) => ok);
  const failed = checks.filter(([, ok]) => !ok);

  line('='.repeat(96));
  line(`通过 ${passed.length} / ${checks.length}`);
  if (failed.length) {
    line('');
    line('未通过：');
    for (const [name, , detail] of failed) line(`  ✗ ${name}　${truncate(detail, 60)}`);
  } else {
    line('');
    line('遗忘曲线 1→3→7→15 全程走通：四个节点答对才出队，中途答错退回 1 天，改判会跟着改队列。');
  }
  line('='.repeat(96));

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('');
  console.error('自检本身出错了：', err?.message ?? err);
  try {
    cleanup();
  } catch {
    // 清理失败不覆盖原始错误
  }
  process.exitCode = 1;
});