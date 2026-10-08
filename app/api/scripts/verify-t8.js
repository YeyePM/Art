// T8 验收：每周一批（滚动 7 天：1 张画 + 1 段摘录 + 1 个开放问题）
//   node app/api/scripts/verify-t8.js
//
// 规则部分用**注入内容**验证（不花钱、不联网）；
// 最后真跑一次生成（调 1 次 AI，约 0.05 分钱）——因为"每周一批"的整条价值就在 AI 能出内容。
// 批次用**未来虚拟日**（2027-01-04 起），跑完按"高水位"删干净，不动你现有的批次与题库。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { needsNewBatch, getWeeklyView, createWeeklyBatch } from '../src/services/weeklyBatch.js';

const D0 = '2027-01-04';

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(92));

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

function addDays(day, delta) {
  const [year, month, date] = String(day).split('-').map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date));
  moment.setUTCDate(moment.getUTCDate() + delta);
  return moment.toISOString().slice(0, 10);
}

const marks = {};
function takeMarks() {
  const db = getDb();
  marks.batches = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM weekly_batches').get().m;
  marks.excerpts = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM excerpts').get().m;
  marks.openQuestions = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM open_questions').get().m;
  marks.artworks = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM artworks').get().m;
}

function cleanup() {
  const db = getDb();
  // 外键顺序：weekly_batches 引用 artworks/excerpts/open_questions，先删它
  db.prepare('DELETE FROM weekly_batches WHERE id > ?').run(marks.batches);
  db.prepare('DELETE FROM artwork_notes WHERE artwork_id > ?').run(marks.artworks);
  db.prepare('DELETE FROM excerpts WHERE id > ?').run(marks.excerpts);
  db.prepare('DELETE FROM open_questions WHERE id > ?').run(marks.openQuestions);
  db.prepare('DELETE FROM artworks WHERE id > ?').run(marks.artworks);
}

// 注入内容：不给 AI 出题，用来确定性验证"滚动 7 天"这类规则
const gen1 = {
  artwork: { title: '【T8自检】画作一', artist: '自检', period: '—', school: null, sourceLibrary: 'met', externalId: null, imageUrl: null },
  excerpt: { bookTitle: '【T8自检】历代名画记', chapter: '卷一 论画六法', sourceText: '气韵生动、骨法用笔……（自检用原文）', contactLine: '自检触点' },
  openQuestion: { stem: '【T8自检】完成感究竟从哪里来？', referenceThoughts: '可从笔触与"停笔"的判断切入。' }
};
const gen2 = {
  artwork: { title: '【T8自检】画作二', artist: '自检', period: '—', school: null, sourceLibrary: 'met', externalId: null, imageUrl: null },
  excerpt: { bookTitle: '【T8自检】艺术的故事', chapter: '第一章', sourceText: '实际上没有艺术这种东西……（自检用原文）', contactLine: '自检触点二' },
  openQuestion: { stem: '【T8自检】写生与重构是什么关系？', referenceThoughts: '可从现场感与画室整理两条线切入。' }
};

async function main() {
  line('');
  line('T8 验收 · 每周一批（滚动 7 天）');
  line(`虚拟日：第一批 ${D0}，未满 7 天不换、满 7 天才换到 ${addDays(D0, 7)}`);
  line('规则部分用注入内容验证（不花钱）；最后真跑一次生成（1 次 AI）。');
  rule();

  takeMarks();

  // ---------- ① 滚动 7 天：纯函数 ----------
  line('① 该不该开新批次（纯函数）');
  const cases = [
    ['还没有任何批次', needsNewBatch(D0, null), true],
    [`距起算日第 6 天（${addDays(D0, 6)}）`, needsNewBatch(addDays(D0, 6), D0), false],
    [`距起算日第 7 天（${addDays(D0, 7)}）`, needsNewBatch(addDays(D0, 7), D0), true],
    ['距起算日第 100 天', needsNewBatch(addDays(D0, 100), D0), true]
  ];
  for (const [label, got, want] of cases) {
    line(`   ${label} → ${got}（期望 ${want}）`);
    check(`滚动 7 天：${label}`, got === want, `${got}`);
  }
  line('');

  // ---------- ② 注入内容造第一批 ----------
  line('② 注入内容造第一批（不调 AI）');
  const v1 = await getWeeklyView({ date: D0, generation: gen1 });
  line(`   batch_id=${v1?.batch_id}　starts_on=${v1?.starts_on} ~ ${v1?.ends_on}`);
  line(`   画：${v1?.artwork?.title}　|　摘录：${v1?.excerpt?.book_title}　|　开放问题：${v1?.open_question?.stem}`);
  check('批次已建立', Number.isInteger(v1?.batch_id), String(v1?.batch_id));
  check('起算日就是调用那天', v1?.starts_on === D0, String(v1?.starts_on));
  check('结束日 = 起算日 + 6 天', v1?.ends_on === addDays(D0, 6), String(v1?.ends_on));
  check('三件内容齐全', Boolean(v1?.artwork && v1?.excerpt && v1?.open_question), '画 / 摘录 / 开放问题');
  check('摘录内容与注入一致', v1?.excerpt?.source_text === gen1.excerpt.sourceText, String(v1?.excerpt?.source_text).slice(0, 20));
  check('开放问题与注入一致', v1?.open_question?.stem === gen1.openQuestion.stem, String(v1?.open_question?.stem).slice(0, 20));
  check('还没写画库（note 为空）', v1?.artwork?.note === null, String(v1?.artwork?.note));
  check('没有外链图（未提供图床地址）', v1?.artwork?.image_url === null, String(v1?.artwork?.image_url));

  const excerptRow = getDb().prepare('SELECT batch_id FROM excerpts WHERE id = ?').get(v1.excerpt.id);
  const openRow = getDb().prepare('SELECT batch_id FROM open_questions WHERE id = ?').get(v1.open_question.id);
  check('摘录的 batch_id 已回填', excerptRow?.batch_id === v1.batch_id, String(excerptRow?.batch_id));
  check('开放问题的 batch_id 已回填', openRow?.batch_id === v1.batch_id, String(openRow?.batch_id));
  line('');

  // ---------- ③④ 未满 7 天：内容不变，且不被新注入影响 ----------
  line('③④ 未满 7 天 → 返回当前批次，内容不变');
  const sameDay = await getWeeklyView({ date: D0, generation: gen2 });
  const day5 = await getWeeklyView({ date: addDays(D0, 5), generation: gen2 });
  line(`   同一天再取 → batch_id=${sameDay?.batch_id}（应等于 ${v1.batch_id}）`);
  line(`   第 6 天取   → batch_id=${day5?.batch_id}（应等于 ${v1.batch_id}）`);
  check('同一天再取不新建批次', sameDay?.batch_id === v1.batch_id, String(sameDay?.batch_id));
  check('第 6 天仍用当前批次', day5?.batch_id === v1.batch_id, String(day5?.batch_id));
  check('内容没被新注入顶掉', day5?.excerpt?.source_text === gen1.excerpt.sourceText, String(day5?.excerpt?.source_text).slice(0, 20));
  line('');

  // ---------- ⑤ 满 7 天：换成新批次 ----------
  line('⑤ 满 7 天 → 生成新批次');
  const v2 = await getWeeklyView({ date: addDays(D0, 7), generation: gen2 });
  line(`   第 7 天取 → batch_id=${v2?.batch_id}　starts_on=${v2?.starts_on}`);
  check('满 7 天开了新批次', v2?.batch_id !== v1.batch_id, `${v1.batch_id} → ${v2?.batch_id}`);
  check('新批次起算日是第 7 天', v2?.starts_on === addDays(D0, 7), String(v2?.starts_on));
  check('新批次内容是新的', v2?.excerpt?.book_title === gen2.excerpt.bookTitle, String(v2?.excerpt?.book_title));
  line('');

  // ---------- ⑥ 写一句（画库）与开放问题回答 ----------
  line('⑥ 两个"写一句"入口（真实 HTTP）');
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // 注意：getWeeklyView 永远返回"最新批次"（此刻是 v2），所以写 / 读都必须对着 v2 的画
  const noteOk = await post('/api/artworks/note', { artwork_id: v2.artwork.id, content: '自检：这张画的留白很狠' });
  line(`   POST /api/artworks/note（有内容）→ HTTP ${noteOk.status}　${JSON.stringify(noteOk.body)}`);
  check('画库写入成功', noteOk.status === 200 && noteOk.body.ok === true, `HTTP ${noteOk.status}`);

  const afterNote = await getWeeklyView({ date: addDays(D0, 7) });
  check('画库内容读得回来', afterNote?.artwork?.note?.content === '自检：这张画的留白很狠', String(afterNote?.artwork?.note?.content));
  check('有内容时 is_empty=false', afterNote?.artwork?.note?.is_empty === false, String(afterNote?.artwork?.note?.is_empty));

  const noteEmpty = await post('/api/artworks/note', { artwork_id: v2.artwork.id, content: '   ' });
  const afterEmpty = await getWeeklyView({ date: addDays(D0, 7) });
  line(`   POST /api/artworks/note（空内容）→ HTTP ${noteEmpty.status}　is_empty=${afterEmpty?.artwork?.note?.is_empty}`);
  check('留空也记一笔，并标成"未写"', noteEmpty.status === 200 && afterEmpty?.artwork?.note?.is_empty === true, String(afterEmpty?.artwork?.note?.is_empty));

  const ansOk = await post('/api/open-questions/answer', { open_question_id: v2.open_question.id, content: '自检：我认为完成感来自"判断停笔"' });
  const afterAns = await getWeeklyView({ date: addDays(D0, 7) });
  line(`   POST /api/open-questions/answer → HTTP ${ansOk.status}　user_answer=${String(afterAns?.open_question?.user_answer).slice(0, 16)}…`);
  check('开放问题回答写入成功', ansOk.status === 200 && ansOk.body.ok === true, `HTTP ${ansOk.status}`);
  check('回答读得回来', afterAns?.open_question?.user_answer === '自检：我认为完成感来自"判断停笔"', String(afterAns?.open_question?.user_answer));

  const badNote = await post('/api/artworks/note', { artwork_id: 999999999, content: 'x' });
  const badAns = await post('/api/open-questions/answer', { open_question_id: 999999999, content: 'x' });
  const noId = await post('/api/artworks/note', { content: 'x' });
  line(`   坏参数：不存在的画 → HTTP ${badNote.status}；不存在的开放问题 → HTTP ${badAns.status}；缺 id → HTTP ${noId.status}`);
  check('不存在的画 → 400', badNote.status === 400, `HTTP ${badNote.status}`);
  check('不存在的开放问题 → 400', badAns.status === 400, `HTTP ${badAns.status}`);
  check('缺 artwork_id → 400', noId.status === 400, `HTTP ${noId.status}`);

  const getRes = await fetch(`${base}/api/weekly`);
  const weeklyBody = await getRes.json();
  line(`   GET /api/weekly → HTTP ${getRes.status}　batch_id=${weeklyBody?.batch_id}　字段：${Object.keys(weeklyBody ?? {}).join(', ')}`);
  check('GET /api/weekly 返回 200', getRes.status === 200, `HTTP ${getRes.status}`);
  check('返回约定字段', ['batch_id', 'starts_on', 'artwork', 'excerpt', 'open_question'].every((k) => k in (weeklyBody ?? {})), Object.keys(weeklyBody ?? {}).join(', '));
  check('返回的是最新批次', weeklyBody?.batch_id === v2.batch_id, String(weeklyBody?.batch_id));
  line('');

  // ---------- ⑦ 真跑一次生成（调 1 次 AI） ----------
  line('⑦ 真跑一次生成（会调 1 次 AI，约 0.05 分钱，请稍等）');
  const realDate = addDays(D0, 14);
  const real = await createWeeklyBatch({ date: realDate });
  const realView = await getWeeklyView({ date: realDate });
  line(`   批次 ${realView?.batch_id}　摘录：《${realView?.excerpt?.book_title}》${realView?.excerpt?.chapter ?? ''}`);
  line(`   触点：${realView?.excerpt?.contact_line ?? '（空）'}`);
  line(`   原文：${String(realView?.excerpt?.source_text ?? '').slice(0, 60)}…`);
  line(`   开放问题：${realView?.open_question?.stem ?? '（空）'}`);
  line(`   画：${realView?.artwork?.title ?? '（无）'}　本地图：${realView?.artwork?.image_url ?? '（无）'}`);
  check('真实生成出了摘录', Boolean(real?.excerptId), `excerptId=${real?.excerptId}`);
  check('真实生成出了开放问题', Boolean(real?.openQuestionId), `openQuestionId=${real?.openQuestionId}`);
  check('摘录带书名与原文', Boolean(realView?.excerpt?.book_title && realView?.excerpt?.source_text), `${realView?.excerpt?.book_title}`);
  check('开放问题有题干', Boolean(realView?.open_question?.stem), String(realView?.open_question?.stem).slice(0, 20));
  check('批次带一张画', Boolean(realView?.artwork?.id), String(realView?.artwork?.id));
  line('');

  server.close();

  // ---------- ⑧ 清理 ----------
  cleanup();
  const leftover = {
    批次: getDb().prepare('SELECT count(*) AS c FROM weekly_batches WHERE id > ?').get(marks.batches).c,
    摘录: getDb().prepare('SELECT count(*) AS c FROM excerpts WHERE id > ?').get(marks.excerpts).c,
    开放问题: getDb().prepare('SELECT count(*) AS c FROM open_questions WHERE id > ?').get(marks.openQuestions).c,
    画作: getDb().prepare('SELECT count(*) AS c FROM artworks WHERE id > ?').get(marks.artworks).c
  };
  line('⑧ 清理临时数据');
  line(`   残留：批次 ${leftover.批次}　摘录 ${leftover.摘录}　开放问题 ${leftover.开放问题}　画作 ${leftover.画作}`);
  check('临时批次已清理', leftover.批次 === 0, String(leftover.批次));
  check('临时摘录已清理', leftover.摘录 === 0, String(leftover.摘录));
  check('临时开放问题已清理', leftover.开放问题 === 0, String(leftover.开放问题));
  check('临时画作已清理', leftover.画作 === 0, String(leftover.画作));
  line('');

  // ---------- 汇总 ----------
  rule();
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) {
    line(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `　　${detail}` : ''}`);
  }

  const failed = checks.filter(([, ok]) => !ok);
  rule();
  line(`通过 ${checks.length - failed.length} / ${checks.length}`);
  line('');
  line('一批管 7 天：未满 7 天原样返回、满 7 天才换新；画 / 摘录 / 开放问题三件一起给。');
  line('');

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});