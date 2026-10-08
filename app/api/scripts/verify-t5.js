// T5 验收：POST /api/answers（判分接口）
//   node app/api/scripts/verify-t5.js
//
// **不动你现有的题库、今天的题单与打卡记录**：自己插 10 道带「【T5自检】」前缀的临时题，打完所有用例再删干净。
// 步骤：插临时题 → 起真实 HTTP 服务 → 四种题型逐个提交 → 检查落库字段与红线 → 清理
//
// 客观题部分不花钱；名词解释 / 论述题会**真调两次 AI**（各约十几秒、合计约 0.1 分钱），
// 因为这一版主观题就是 AI 判分，它的点评得真调一次才看得见。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { insertQuestions } from '../src/db/questions.js';
import { getAnsweredIdsOn } from '../src/db/answers.js';
import { getSession, setSessionProgress } from '../src/db/dailySessions.js';
import { getCheckin } from '../src/db/checkins.js';
import { todayInShanghai } from '../src/services/questionPicker.js';

const TYPE_LABEL = { objective: '客观题', term: '名词解释', image: '图像辨识', essay: '论述题' };
const TAG = '【T5自检】';

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

// ---------- 临时数据与清理 ----------
const createdQuestionIds = [];
const extraAnswerIds = [];

function cleanup() {
  const db = getDb();

  if (createdQuestionIds.length) {
    const placeholders = createdQuestionIds.map(() => '?').join(',');
    // review_queue 也要清：M3 起答错会入队，而它引用 questions(id)——
    // 不清就会在下一行删题时撞外键
    db.prepare(`DELETE FROM review_queue WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
    db.prepare(`DELETE FROM answers WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
    db.prepare(`DELETE FROM question_tags WHERE question_id IN (${placeholders})`).run(...createdQuestionIds);
    db.prepare(`DELETE FROM questions WHERE id IN (${placeholders})`).run(...createdQuestionIds);
    createdQuestionIds.length = 0;
  }

  if (extraAnswerIds.length) {
    const placeholders = extraAnswerIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM answers WHERE id IN (${placeholders})`).run(...extraAnswerIds);
    extraAnswerIds.length = 0;
  }
}

/** 4 个选项，正确项由 letter 指定 */
const OPTIONS = ['A 郭熙', 'B 范宽', 'C 李成', 'D 王希孟'];
const buildChoice = (stem, letter, type = 'objective') => ({
  type,
  stem: TAG + stem,
  options: OPTIONS,
  answer: letter,
  explanation: `${TAG}解析：本题用于自检判分链路。`,
  difficulty: '基础',
  tags: ['宋', '自检']
});

function buildQuestions() {
  return [
    // ① 客观题：提交正确选项
    buildChoice('客观题 · 提交正确选项 B', 'B'),
    // ② 客观题：先提交错误选项；再用正确答案重复提交，验幂等
    buildChoice('客观题 · 提交错误选项 C', 'A'),
    // ③ 客观题：提交整条选项文字（带 "B " 前缀）
    buildChoice('客观题 · 提交整条选项文字', 'B'),
    // ④ 客观题：提交小写字母
    buildChoice('客观题 · 提交小写字母', 'A'),
    // ⑤ 图像辨识题：和客观题走同一套自动判分
    buildChoice('图像辨识题 · 提交正确选项', 'B', 'image'),
    // ⑥ 名词解释：AI 判 + 用户改判
    {
      type: 'term',
      stem: `${TAG}名词解释 · AI 判完再改判`,
      options: null,
      answer: '参考答案：气韵生动是谢赫六法之首，指画面整体呈现的生命气息与精神格调，是品评绘画的最高标准。',
      explanation: `${TAG}解析：名词解释看是否落到"生命气息 + 品评标准"。`,
      difficulty: '进阶',
      tags: ['魏晋南北朝', '自检']
    },
    // ⑦ 论述题：作答里塞了明显的事实错误，看 AI 抓不抓得出来
    {
      type: 'essay',
      stem: `${TAG}论述题 · 作答含事实性硬错误`,
      options: null,
      answer: '参考思路：可从写生与重构的关系切入，须落到具体作品。',
      explanation: `${TAG}解析：开放题不要求跟参考一致，但要抓事实性硬错误。`,
      difficulty: '挑战',
      tags: ['后印象', '自检']
    },
    // ⑧ 名词解释：只想直接自评、不交卷，应被拒（拿不到参考答案）
    {
      type: 'term',
      stem: `${TAG}名词解释 · 只带自评、不交卷`,
      options: null,
      answer: '参考答案：图像证史主张把图像当史料来读。',
      explanation: `${TAG}解析：用于验证参数校验。`,
      difficulty: '进阶',
      tags: ['自检']
    },
    // ⑨ 客观题：故意不带 user_answer，应被拒
    buildChoice('客观题 · 故意不带作答', 'B'),
    // ⑩ 客观题：故意带 self_grade，应被拒（客观题由系统直接判）
    buildChoice('客观题 · 故意带自评', 'B')
  ];
}

async function main() {
  const db = getDb();
  const date = todayInShanghai();

  line('');
  line('T5 验收 · POST /api/answers（判分接口）');
  line(`今天：${date}（Asia/Shanghai）`);
  line('本脚本不动你现有的题库与今天的题单，只会临时插几道自检题，跑完自动删掉。');
  rule();

  // ---------- ① 临时题入库 ----------
  const { inserted } = insertQuestions(buildQuestions());
  createdQuestionIds.push(...inserted);
  line(`① 临时插入 ${inserted.length} 道自检题（id：${inserted.join(', ')}）`);
  line('');

  // ---------- ② 起真实服务 ----------
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (body) => {
    const response = await fetch(`${base}/api/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const [qObjectiveRight, qObjectiveWrong, qObjectiveFull, qObjectiveLower, qImage, qTermRight, qEssayWrong, qTermNoGrade, qObjectiveNoAnswer, qObjectiveWithGrade] =
    inserted;

  const checks = [];
  const check = (name, ok, detail) => checks.push([name, ok, detail]);

  line('② 逐题提交（四种题型 + 4 个应被拒的坏参数；主观题会真调 AI，稍等）');
  rule();
  line(`${pad('用例', 34)}${pad('HTTP', 7)}${pad('correct', 10)}返回`);
  rule();

  const log = (name, result, summary) =>
    line(`${pad(name, 34)}${pad(String(result.status), 7)}${pad(String(result.body?.correct ?? '—'), 10)}${summary}`);

  // ① 客观题 · 正确选项
  const r1 = await post({ question_id: qObjectiveRight, user_answer: 'B' });
  log('客观题 · 提交 B（正确答案）', r1, `reference_answer=${r1.body.reference_answer}　解析 ${truncate(r1.body.explanation, 30)}`);
  check('客观题答对 → correct=true', r1.status === 200 && r1.body.correct === true, `HTTP ${r1.status}`);
  check('返回里带解析', typeof r1.body.explanation === 'string' && r1.body.explanation.length > 0, `${String(r1.body.explanation).length} 字`);
  check('客观题带上正确答案', r1.body.reference_answer === 'B', `reference_answer=${r1.body.reference_answer}`);

  // ② 客观题 · 先答错
  const r2 = await post({ question_id: qObjectiveWrong, user_answer: 'C' });
  log('客观题 · 提交 C（错误选项）', r2, `reference_answer=${r2.body.reference_answer}`);
  check('客观题答错 → correct=false', r2.status === 200 && r2.body.correct === false, `HTTP ${r2.status}`);

  // ② 幂等：同题同日再提交正确答案，仍返回上次结果，且不新增记录
  const r2again = await post({ question_id: qObjectiveWrong, user_answer: 'A' });
  log('同一题同日再提交 A（验幂等）', r2again, `仍返回 correct=${r2again.body.correct}`);
  const rowsForWrong = db.prepare('SELECT count(*) AS c FROM answers WHERE question_id = ? AND session_date = ?').get(qObjectiveWrong, date).c;
  check('同一题同日重复提交不新增记录', rowsForWrong === 1, `answers 里 ${rowsForWrong} 条`);
  check('重复提交返回首次的判定', r2again.body.correct === false, `correct=${r2again.body.correct}`);

  // ③ 整条选项文字
  const r3 = await post({ question_id: qObjectiveFull, user_answer: 'B 范宽' });
  log('客观题 · 提交整条选项 "B 范宽"', r3, `correct=${r3.body.correct}`);
  check('传整条选项文字也能判对', r3.body.correct === true, `correct=${r3.body.correct}`);

  // ④ 小写字母
  const r4 = await post({ question_id: qObjectiveLower, user_answer: 'a' });
  log('客观题 · 提交小写 "a"', r4, `correct=${r4.body.correct}`);
  check('传小写字母也能判对', r4.body.correct === true, `correct=${r4.body.correct}`);

  // ⑤ 图像辨识题
  const r5 = await post({ question_id: qImage, user_answer: 'B' });
  log('图像辨识题 · 提交 B', r5, `correct=${r5.body.correct}`);
  check('图像辨识题走同一套自动判分', r5.status === 200 && r5.body.correct === true, `correct=${r5.body.correct}`);

  // ⑥ 名词解释 · AI 判分（交卷即判，判完就落库）
  const TERM_ANSWER = '气韵生动是谢赫六法的第一条，指画面的气韵与生动感，是品评绘画的最高标准。';
  const termFirst = await post({ question_id: qTermRight, user_answer: TERM_ANSWER });
  log('名词解释 · AI 判分', termFirst, `点评 ${truncate(termFirst.body.ai_comment, 26)}`);
  check('主观题：AI 给出布尔判定', termFirst.status === 200 && typeof termFirst.body.correct === 'boolean', `HTTP ${termFirst.status}　correct=${termFirst.body.correct}`);
  check('主观题：AI 给出点评', String(termFirst.body.ai_comment ?? '').length > 0, truncate(termFirst.body.ai_comment, 26));
  check('主观题：仍带参考答案', String(termFirst.body.reference_answer ?? '').startsWith('参考答案'), truncate(termFirst.body.reference_answer, 20));
  const termRows = db.prepare('SELECT count(*) AS c FROM answers WHERE question_id = ?').get(qTermRight).c;
  check('主观题：AI 判完即落库', termRows === 1, `answers 里 ${termRows} 条`);

  // ⑥ 名词解释 · 用户改判（"AI 判错了我再给它反馈"）
  const aiVerdict = termFirst.body.correct;
  const termOverride = await post({ question_id: qTermRight, user_answer: TERM_ANSWER, self_grade: false });
  log('名词解释 · 用户改判为"没答对"', termOverride, `AI 判 ${aiVerdict} → 用户改成 ${termOverride.body.correct}`);
  check('改判：最终判定听用户的', termOverride.status === 200 && termOverride.body.correct === false, `correct=${termOverride.body.correct}`);
  check('改判：AI 的点评仍在', String(termOverride.body.ai_comment ?? '').length > 0, truncate(termOverride.body.ai_comment, 22));
  const termRow = db.prepare('SELECT is_correct, is_self_graded, ai_correct FROM answers WHERE question_id = ?').get(qTermRight);
  check('改判：落库为"用户判定"', termRow.is_self_graded === 1 && termRow.is_correct === 0, `is_correct=${termRow.is_correct}　is_self_graded=${termRow.is_self_graded}`);
  check('改判：AI 的原始判定留底', termRow.ai_correct === (aiVerdict ? 1 : 0), `ai_correct=${termRow.ai_correct}（AI 当时判 ${aiVerdict}）`);

  // ⑦ 论述题 · 作答里塞了明显事实错误，看 AI 抓不抓 + 幂等
  const ESSAY_ANSWER = '德加是未来主义画派的代表，他的《持水壶的年轻女子》画于文艺复兴时期，讲究几何化的运动感。';
  const essayFirst = await post({ question_id: qEssayWrong, user_answer: ESSAY_ANSWER });
  log('论述题 · AI 判分', essayFirst, `correct=${essayFirst.body.correct}`);
  check('论述题：AI 给出布尔判定', essayFirst.status === 200 && typeof essayFirst.body.correct === 'boolean', `correct=${essayFirst.body.correct}`);
  line(`   AI 点评：${essayFirst.body.ai_comment ?? '（无）'}`);
  if ((essayFirst.body.ai_errors ?? []).length) {
    for (const item of essayFirst.body.ai_errors) line(`   抓到错误：${item}`);
  } else {
    line('   这轮 AI 没抓出事实性硬错误（作答里"德加=未来主义""维米尔的作品归给德加"都是错的）——这条不判 FAIL，你看看它的点评就行。');
  }

  const essayAgain = await post({ question_id: qEssayWrong, user_answer: ESSAY_ANSWER });
  const essayRows = db.prepare('SELECT count(*) AS c FROM answers WHERE question_id = ?').get(qEssayWrong).c;
  log('论述题 · 同日重复提交（验幂等）', essayAgain, `仍是 correct=${essayAgain.body.correct}，${essayRows} 条记录`);
  check('主观题幂等：重复提交不重新调 AI、不新增记录', essayAgain.body.correct === essayFirst.body.correct && essayRows === 1, `${essayRows} 条`);

  // ⑧ 主观题只想直接自评、不交卷 → 看不了答案
  const r8 = await post({ question_id: qTermNoGrade, self_grade: true });
  log('主观题 · 只带自评、不交卷', r8, truncate(r8.body.error, 40));
  check('没交卷就不给看答案 → 400', r8.status === 400, `HTTP ${r8.status}　${truncate(r8.body.error, 30)}`);

  // ⑨ 客观题不交卷 → 400
  const r9 = await post({ question_id: qObjectiveNoAnswer });
  log('客观题 · 不带 user_answer', r9, truncate(r9.body.error, 40));
  check('客观题缺 user_answer → 400', r9.status === 400, `HTTP ${r9.status}　${truncate(r9.body.error, 30)}`);

  // ⑩ 客观题带自评 → 400（客观题由系统直接判，不给用户改）
  const r10 = await post({ question_id: qObjectiveWithGrade, user_answer: 'B', self_grade: true });
  log('客观题 · 带 self_grade', r10, truncate(r10.body.error, 40));
  check('客观题不接受 self_grade → 400', r10.status === 400, `HTTP ${r10.status}　${truncate(r10.body.error, 30)}`);

  // ⑪ 不存在的题
  const r11 = await post({ question_id: 99999999, user_answer: 'B' });
  log('不存在的题目 id', r11, truncate(r11.body.error, 40));
  check('题目不存在 → 400', r11.status === 400, `HTTP ${r11.status}　${truncate(r11.body.error, 30)}`);
  rule();
  line('');

  // ---------- ③ 落库字段 ----------
  line('③ 落库检查（answers 表）');
  rule();
  const stored = db
    .prepare('SELECT question_id, session_date, user_answer, is_correct, is_self_graded, ai_correct FROM answers WHERE question_id IN (' + createdQuestionIds.map(() => '?').join(',') + ') ORDER BY question_id')
    .all(...createdQuestionIds);

  for (const row of stored) {
    const source = row.ai_correct == null ? '系统判' : row.is_self_graded ? '用户改判' : 'AI 判';
    line(`${pad(String(row.question_id), 10)}${pad(row.session_date, 14)}${pad(row.is_correct ? '对' : '错', 6)}${pad(source, 10)}${truncate(row.user_answer, 38)}`);
  }
  rule();

  check('该落库的记录都落了库', stored.length === 7, `${stored.length} 条（4 个坏参数不该落库）`);
  check(
    '客观题 / 图像辨识标为"系统判"',
    stored.filter((r) => [qObjectiveRight, qImage].includes(r.question_id)).every((r) => r.is_self_graded === 0 && r.ai_correct == null),
    'is_self_graded=0 且没有 AI 判定'
  );
  check(
    '论述题标为"AI 判"',
    stored.filter((r) => r.question_id === qEssayWrong).every((r) => r.is_self_graded === 0 && r.ai_correct != null),
    'is_self_graded=0 且 ai_correct 有值'
  );
  check(
    '名词解释标为"用户改判"',
    stored.filter((r) => r.question_id === qTermRight).every((r) => r.is_self_graded === 1 && r.ai_correct != null),
    'is_self_graded=1 且 ai_correct 留底'
  );
  check('落库归属今天', stored.every((r) => r.session_date === date), `session_date=${date}`);
  check('坏参数不落任何记录', stored.every((r) => ![qTermNoGrade, qObjectiveNoAnswer, qObjectiveWithGrade].includes(r.question_id)), '4 次 400 都没写库');
  line('');

  // ---------- ④ 答案只在 /api/answers 给 ----------
  const todayView = await (await fetch(`${base}/api/today`)).json();
  const todayRaw = JSON.stringify(todayView);
  const answerHits = (todayRaw.match(/"answer"/g) ?? []).length;
  const explanationHits = (todayRaw.match(/"explanation"/g) ?? []).length;
  const referenceHits = (todayRaw.match(/"reference_answer"/g) ?? []).length;
  check('红线：/api/today 里仍然没有答案与解析', answerHits === 0 && explanationHits === 0 && referenceHits === 0, `answer ${answerHits} 处、explanation ${explanationHits} 处、reference_answer ${referenceHits} 处`);

  // ---------- ⑤ 答一道真题，看进度动没动 ----------
  line('④ 进度联动：答今天题单里的一道，看 /api/today 的 done 会不会 +1');
  rule();
  const beforeDone = todayView.progress?.done ?? 0;
  // 只挑今天题单里**还没作答**的题，否则重复提交是幂等的、进度不会涨，还会误删你已有的作答
  const answeredToday = new Set(getAnsweredIdsOn(date));
  const pending = (todayView.questions ?? []).filter((q) => !answeredToday.has(q.id));
  const target = pending.find((q) => q.type === 'objective' || q.type === 'image') ?? pending[0];

  if (!target) {
    check('进度联动：今天题单里还有题可答', true, '今天 10 题已全部作答，跳过（不影响判分链路）');
    line('   今天 10 题已经全部作答，跳过这一步。');
  } else {
    const payload = target.type === 'objective' || target.type === 'image' ? { question_id: target.id, user_answer: 'A' } : { question_id: target.id, user_answer: '（自检作答）', self_grade: false };
    // M4：这一步可能刚好把当天额度做完而触发打卡——先记下来，撤回作答时一并还原
    const checkinBefore = getCheckin(date);
    const sessionBefore = getSession(date);
    const submitted = await post(payload);
    const afterView = await (await fetch(`${base}/api/today`)).json();
    const afterDone = afterView.progress?.done ?? 0;

    const row = db.prepare('SELECT id FROM answers WHERE question_id = ? AND session_date = ? ORDER BY id DESC LIMIT 1').get(target.id, date);
    if (row) extraAnswerIds.push(row.id);

    line(`   答了第 ${todayView.questions.findIndex((q) => q.id === target.id) + 1} 题（${TYPE_LABEL[target.type]}）→ done ${beforeDone} → ${afterDone}`);
    check('作答后 /api/today 的进度 +1', submitted.status === 200 && afterDone === beforeDone + 1, `done ${beforeDone} → ${afterDone}`);

    // 把这笔自检作答删掉，还原你今天真实的进度
    if (row) {
      db.prepare('DELETE FROM answers WHERE id = ?').run(row.id);
      extraAnswerIds.length = 0;
      // M4：作答撤回了，打卡记录与当天进度也要一起还原（不然会凭空多出一天打卡）
      if (!checkinBefore) db.prepare('DELETE FROM checkins WHERE date = ?').run(date);
      setSessionProgress({ date, doneCount: sessionBefore?.doneCount ?? 0, checkedIn: sessionBefore?.checkedIn ?? false });
      const restored = await (await fetch(`${base}/api/today`)).json();
      check('自检作答已撤回，进度还原', (restored.progress?.done ?? 0) === beforeDone, `done 回到 ${restored.progress?.done}`);
    }
  }
  rule();
  line('');

  // ---------- ⑥ 清理临时数据 ----------
  cleanup();
  const leftovers = db.prepare('SELECT count(*) AS c FROM questions WHERE stem LIKE ?').get(`${TAG}%`).c;
  check('临时自检题已清理干净', leftovers === 0, `库里剩 ${leftovers} 道`);

  // ---------- ⑦ 结果 ----------
  line('⑤ 自检');
  rule();
  for (const [name, ok, detail] of checks) {
    line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 40)}${detail}`);
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
    cleanup();
    line('');
    line(`验收脚本出错：${err?.message ?? err}`);
    line('（临时自检题已清理，重跑一次即可）');
    process.exitCode = 1;
  });