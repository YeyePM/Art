// T10 验收：标记问题 + AI 异常兜底（M6）
//   node app/api/scripts/verify-t10.js
//
// **不花钱、不动你现有的题库与作答**：临时插 2 道「【T10自检】」假题，
// 拿它们试标记；AI 兜底那步把进程内的 AI Key 临时清空来复现"AI 挂了"，
// 用未来虚拟日、且故意不落库，跑完按高水位把标记记录与临时题一起删掉。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { insertQuestions, getCandidates } from '../src/db/questions.js';
import { countFlags, countFlagsFor } from '../src/db/flaggedItems.js';
import { getSession } from '../src/db/dailySessions.js';
import { pickDailyQuestions } from '../src/services/questionPicker.js';
import { describeAiFailure } from '../src/services/aiFailure.js';
import { getTodayView } from '../src/services/todaySession.js';

const VD = '2027-03-05';        // 虚拟未来日：AI 兜底用（不落库，只是保证不撞你真实会话）
const CHOICE = ['A 甲', 'B 乙', 'C 丙', 'D 丁'];

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);

function makeFakeQuestions() {
  return [0, 1].map((index) => ({
    type: 'objective',
    stem: `【T10自检】标记与兜底用假题 ${index + 1}`,
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

function maxId(table) {
  return getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
}

async function main() {
  const db = getDb();
  const checks = [];
  const check = (name, ok, detail = '') => checks.push([name, ok, detail]);

  line('');
  line('T10 验收 · 标记问题与 AI 兜底（M6）');
  line(`虚拟日 ${VD}（AI 兜底用）　本脚本只临时插 2 道自检假题，跑完自动删掉。`);
  rule();

  const flagMark = maxId('flagged_items');
  const flagsBefore = countFlags();
  // 先清一次虚拟日的会话，避免上次没跑完的残留让"AI 兜底"这步走进"当天已有会话"的短路分支
  db.prepare('DELETE FROM daily_sessions WHERE date = ?').run(VD);

  // ---------- 起真实服务 ----------
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed };
  };

  // ---------- ① 插临时题 + 标记一道题 ----------
  line('');
  line('① 临时插 2 道假题，把第 1 道标掉（POST /api/flag）');
  const { inserted } = insertQuestions(makeFakeQuestions());
  const [q1, q2] = inserted;

  const flagRes = await post('/api/flag', { target_type: 'question', target_id: q1, note: '自检：答案看着不对' });
  line(`   POST /api/flag → HTTP ${flagRes.status}　${JSON.stringify(flagRes.body)}`);
  check('标记接口返回 200 且 ok=true', flagRes.status === 200 && flagRes.body?.ok === true, `HTTP ${flagRes.status}`);
  check('flagged_items 记了一笔', countFlagsFor('question', q1) === 1, `${countFlagsFor('question', q1)} 笔`);
  check('questions.is_flagged 被置 1', db.prepare('SELECT is_flagged AS f FROM questions WHERE id = ?').get(q1).f === 1, 'is_flagged');

  // ---------- ② 被标记的题不再出现在出题池 ----------
  line('');
  line('② 被标记的题从出题池消失（连"昨日未完成"里那道也滤掉）');
  const inCandidates = getCandidates().map((q) => q.id);
  const plan = pickDailyQuestions({ carryOverIds: [q1, q2], dueReviewIds: [], date: VD });
  line(`   候选题里还有假题1吗：${inCandidates.includes(q1) ? '有（不对）' : '没有（对）'}　假题2：${inCandidates.includes(q2) ? '有' : '没有'}`);
  line(`   组题结果含假题1吗：${plan.questionIds.includes(q1) ? '有（不对）' : '没有（对）'}`);
  check('候选题池已排除被标记的题', !inCandidates.includes(q1), `含 q1=${inCandidates.includes(q1)}`);
  check('未标记的题照常在候选池里', inCandidates.includes(q2), `含 q2=${inCandidates.includes(q2)}`);
  check('组题时昨日未完成里被标记的题也被滤掉', !plan.questionIds.includes(q1), `含 q1=${plan.questionIds.includes(q1)}`);
  check('组题时未标记的那道仍被带上', plan.questionIds.includes(q2), `含 q2=${plan.questionIds.includes(q2)}`);

  // ---------- ③ 坏参数一律 400，且不落标记 ----------
  line('');
  line('③ 坏参数一律 400');
  const badCases = [
    ['target_type 不认识', { target_type: 'nope', target_id: q2 }],
    ['target_id 不是正整数', { target_type: 'question', target_id: 0 }],
    ['target_id 不是数字', { target_type: 'question', target_id: 'abc' }],
    ['什么都不传', {}]
  ];
  let badAllOk = true;
  for (const [name, body] of badCases) {
    const res = await post('/api/flag', body);
    if (res.status !== 400) badAllOk = false;
    line(`   ${pad(name, 30)}→ HTTP ${res.status}　${res.body?.error ?? ''}`);
  }
  rule();
  check('四种坏参数都返回 400', badAllOk, badAllOk ? '都是 400' : '有不是 400 的');
  check('坏参数没写进 flagged_items', countFlagsFor('question', q2) === 0, `${countFlagsFor('question', q2)} 笔`);

  // ---------- ④ 非题目类型也能标，且不动 is_flagged ----------
  line('');
  line('④ 标记"一件画"（非题目类型）：只记流水，不动题目的 is_flagged');
  const artFlag = await post('/api/flag', { target_type: 'artwork', target_id: 424242, note: '自检：这张画配错了' });
  line(`   POST /api/flag（artwork）→ HTTP ${artFlag.status}　${JSON.stringify(artFlag.body)}`);
  check('标记画作返回 200', artFlag.status === 200 && artFlag.body?.ok === true, `HTTP ${artFlag.status}`);
  check('画作标记也记进了 flagged_items', countFlagsFor('artwork', 424242) === 1, `${countFlagsFor('artwork', 424242)} 笔`);
  check('标记画作不影响任何题目的 is_flagged', db.prepare('SELECT count(*) AS c FROM questions WHERE is_flagged = 1 AND id = ?').get(q2).c === 0, 'q2 未被标记');

  // ---------- ⑤ AI 异常翻成人话（纯函数） ----------
  line('');
  line('⑤ AI 异常翻成人话（describeAiFailure）');
  const cases = [
    ['没配 Key', new Error('没有配置 ZHIPU_API_KEY —— 应在项目根目录 .env 里（.gitignore 已挡住它）'), 'no_key'],
    ['超时', new Error('调用智谱超时（120 秒）'), 'timeout'],
    ['内容审核', new Error('智谱内容审核拦截：xxx'), 'moderation'],
    ['其它', new Error('智谱返回 500：xxx'), 'unavailable']
  ];
  let mapAllOk = true;
  for (const [name, err, code] of cases) {
    const got = describeAiFailure(err);
    if (got.code !== code || !got.message) mapAllOk = false;
    line(`   ${pad(name, 12)}→ ${pad(got.code, 13)}${got.message}`);
  }
  rule();
  check('四类异常都翻成了对应 code + 人话', mapAllOk, mapAllOk ? '4/4' : '有漏');

  // ---------- ⑥ AI 挂了：/api/today 不白屏、给提示、且能重试 ----------
  line('');
  line('⑥ 把 AI Key 临时清空、并把题量临时调高（逼出"题库不够、必须靠 AI"的状态）');
  line('   （不动你真实数据：用未来虚拟日 + 显式传 artworks=[]，不联网、也不落库）');
  const savedKey = config.zhipuApiKey;
  const savedQuota = config.dailyQuestionCount;
  let view1 = null;
  let view2 = null;
  try {
    config.zhipuApiKey = '';
    config.dailyQuestionCount = 999; // 题库永远填不满，必然要调 AI
    view1 = await getTodayView({ date: VD, artworks: [] });
    view2 = await getTodayView({ date: VD, artworks: [] }); // 再打开一次：应当还能重试，而不是被"冻结"
  } finally {
    config.zhipuApiKey = savedKey;
    config.dailyQuestionCount = savedQuota;
  }

  line(`   第一次：notice.code=${view1?.notice?.code}　题数=${view1?.questions?.length}`);
  line(`   提示文案：${view1?.notice?.message ?? '（没有提示）'}`);
  check('AI 挂了接口仍返回（不是 500/白屏）', view1 != null && Array.isArray(view1.questions), `题数=${view1?.questions?.length}`);
  check('给出了可读的提示（notice.code=no_key）', view1?.notice?.code === 'no_key', String(view1?.notice?.code));
  check('提示是一句人话（不是空串）', typeof view1?.notice?.message === 'string' && view1.notice.message.length > 8, String(view1?.notice?.message?.length));
  check('进度与实际题数一致', view1?.progress?.total === view1?.questions?.length, `${view1?.progress?.total} / ${view1?.questions?.length}`);
  check('AI 失败时不落库（这天没被冻结）', getSession(VD) === null, getSession(VD) ? '写了会话' : '没写');
  check('再打开一次仍能重试（提示照样在）', view2?.notice?.code === 'no_key', String(view2?.notice?.code));

  // ---------- ⑦ 清理 ----------
  line('');
  line('⑦ 清理临时数据');
  server.close();
  db.prepare('DELETE FROM flagged_items WHERE id > ?').run(flagMark);
  db.prepare('DELETE FROM daily_sessions WHERE date = ?').run(VD); // AI 失败本不该落库；这里兜底清一次
  removeQuestions([q1, q2]);

  const residual = {
    临时题: db.prepare(`SELECT count(*) AS c FROM questions WHERE id IN (${[q1, q2].map(() => '?').join(',')})`).get(q1, q2).c,
    新标记: db.prepare('SELECT count(*) AS c FROM flagged_items WHERE id > ?').get(flagMark).c,
    假会话: getSession(VD) ? 1 : 0
  };
  rule();
  line('残留：' + Object.entries(residual).map(([key, value]) => `${key} ${value}`).join('　'));
  check('临时数据已清理干净', Object.values(residual).every((value) => value === 0), JSON.stringify(residual));
  check('你原有的标记记录一条没少', countFlags() === flagsBefore, `${flagsBefore} → ${countFlags()}`);

  // ---------- 结果 ----------
  line('');
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 42)}${detail}`);
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);
  line('');
  line('标记的题不再出现在每日题里；AI 用不了时接口照常返回，并给一句人话提示、下次打开自动重试。');
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