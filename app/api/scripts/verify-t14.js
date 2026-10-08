// T14 验收：图像辨识题库存保鲜 + 坏题防线 + progress.total 对齐（M1 修补）
//   node app/api/scripts/verify-t14.js
//
// **不花钱、不联网**：全程用虚拟日期 + 注入的作品元数据 + 注入的生成函数（不真调 AI）。
// 三件事各验一段：
//   A. 库存保鲜：库里没有可用图像题时，当天仍是 10 道题（构成可能歪，口径 A 允许），
//      但题库会被**单独补出 2 道带 options 的图像题**，且当天题单**一个字都没变**。
//   B. 坏题防线：`options` 为空的图像题不进候选池、不出现在 /api/today。
//   C. 分母对齐：题单里挂着已删除的 id 时，progress.total 等于实际取到的题数。
//
// 过程中只借用了两样真实数据，跑完全部还原：
//   ① 临时把库里现成的可用图像题置为"已标记"（好造出"库存为空"的场景）；② 自检插的题按高水位删掉。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { insertQuestions, getCandidates, countUsableImageQuestions, countQuestions } from '../src/db/questions.js';
import { getSession, saveSession } from '../src/db/dailySessions.js';
import { getTodayView } from '../src/services/todaySession.js';
import { pickDailyQuestions, todayInShanghai } from '../src/services/questionPicker.js';

const V = '2026-02-10';  // 自检的"今天"（过去的日子，不会顶掉真实的连续天数）
const V3 = '2026-02-11'; // 用来验"分母对齐"
const CHOICE = ['A 甲', 'B 乙', 'C 丙', 'D 丁'];

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, ok, detail]);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const marks = {};
function takeMarks() {
  const db = getDb();
  marks.questions = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM questions').get().m;
  marks.flaggedBefore = new Set(db.prepare('SELECT id FROM questions WHERE is_flagged = 1').all().map((r) => r.id));
}

/** 造出"库里没有可用图像题"的场景（跑完按 id 还原，一条都不会漏） */
function hideUsableImageQuestions() {
  const db = getDb();
  const ids = db
    .prepare("SELECT id FROM questions WHERE type = 'image' AND options IS NOT NULL AND is_flagged = 0")
    .all()
    .map((r) => r.id);
  db.prepare("UPDATE questions SET is_flagged = 1 WHERE type = 'image' AND options IS NOT NULL").run();
  return ids;
}

function restoreFlagged(ids) {
  if (!ids.length) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE questions SET is_flagged = 0 WHERE id IN (${placeholders})`).run(...ids);
}

function cleanup() {
  const db = getDb();
  // 外键顺序：题先删引用它的三张子表
  db.prepare('DELETE FROM review_queue  WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM answers       WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM question_tags WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM questions     WHERE id > ?').run(marks.questions);
  db.prepare('DELETE FROM daily_sessions WHERE date IN (?, ?)').run(V, V3);
  db.prepare('DELETE FROM checkins       WHERE date IN (?, ?)').run(V, V3);
}

/** 注入的生成函数：记下每次调用参数，并按需往库里插题（**不真调 AI**） */
function makeStub({ insertImages = 0 } = {}) {
  const calls = [];
  const fn = async (params = {}) => {
    calls.push(params);
    const requested = Math.max(0, Number(params.needMore) || 0);
    let inserted = [];

    if (insertImages > 0 && params.scope === 'image-restock') {
      const rows = [];
      for (let i = 0; i < insertImages; i += 1) {
        rows.push({
          type: 'image',
          stem: `【T14自检】补货用图像题 ${i + 1}`,
          options: CHOICE,
          answer: 'A',
          explanation: '自检用，跑完即删。',
          difficulty: '进阶',
          tags: []
        });
      }
      inserted = insertQuestions(rows).inserted;
    }

    return {
      hook: '【T14自检】钩子',
      insertedIds: inserted,
      inserted: inserted.length,
      skipped: 0,
      requested,
      shortfall: Math.max(0, requested - inserted.length),
      reused: false,
      generatedRaw: inserted.length,
      imagesCached: 0,
      usage: null
    };
  };
  fn.calls = calls;
  return fn;
}

const objectiveQuestions = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'objective',
  stem: `【T14自检】铺底假题 ${i + 1}`,
  options: CHOICE,
  answer: 'A',
  explanation: '自检用，跑完即删。',
  difficulty: '基础',
  tags: []
}));

function imageRowsInBank() {
  return getDb()
    .prepare("SELECT id, options FROM questions WHERE type = 'image' AND options IS NOT NULL AND is_flagged = 0")
    .all();
}

function flaggedIds() {
  return new Set(getDb().prepare('SELECT id FROM questions WHERE is_flagged = 1').all().map((r) => r.id));
}

async function main() {
  const db = getDb();

  line('');
  line('T14 验收 · 图像辨识题库存保鲜 / 坏题防线 / 分母对齐（M1 修补）');
  line(`虚拟日：${V}（口径 A 的场景）与 ${V3}（分母对齐）　全程不花钱、不联网`);
  rule();

  cleanup();
  takeMarks();

  // ---------- ① 铺底：库里没有可用图像题，但客观题足够填满当天 ----------
  line('');
  line('① 造场景：库里 0 道可用图像题、客观题足够 → 组题层会"退让"把 10 道填满');
  const hidden = hideUsableImageQuestions();
  line(`   临时置为"已标记"的现成图像题：${hidden.length} 道（跑完还原）`);
  const seeded = insertQuestions(objectiveQuestions(10)).inserted;
  const bankBefore = countQuestions();
  line(`   铺底假题 ${seeded.length} 道；库里可用图像题 ${countUsableImageQuestions()} 道`);
  check('场景成立：可用图像题为 0', countUsableImageQuestions() === 0, String(countUsableImageQuestions()));
  check('铺底假题已入库（10 道客观题）', seeded.length === 10, String(seeded.length));

  // ---------- ② 口径 A：当天照样 10 道，且题单一动不动 ----------
  line('');
  line('② 口径 A：当天仍是 10 道（构成可以歪），但补货不许改当天题单');
  const idsBefore = pickDailyQuestions({ date: V }).questionIds;
  check('先取一次计划：喂 0 道 AI 也是 10 道（退让生效）', idsBefore.length === 10, String(idsBefore.length));

  const stub = makeStub({ insertImages: 2 });
  const view = await getTodayView({ date: V, artworks: [], generate: stub });
  const session = getSession(V);
  const imageInDay = view.questions.filter((q) => q.type === 'image').length;

  line(`   当天 ${view.questions.length} 道（图像题 ${imageInDay} 道）｜progress ${view.progress.done}/${view.progress.total}`);
  line(`   注入的生成函数被调用 ${stub.calls.length} 次：${stub.calls.map((c) => `${c.scope ?? 'daily'}(needMore=${c.needMore})`).join(', ') || '—'}`);

  check('当天仍然是 10 道题', view.questions.length === 10, String(view.questions.length));
  check('当天构成里确实没有图像题（退让，口径 A 允许）', imageInDay === 0, String(imageInDay));
  check('当天题单与补货前完全一致（补货不改题单）', deepEqual(session.questionIds, idsBefore), session.questionIds.join(','));
  check('补货只多调了一次生成', stub.calls.length === 1, String(stub.calls.length));
  check(
    '这一次要的就是图像题（needMore=2、needMoreByType.image=2）',
    stub.calls[0]?.needMore === 2 && stub.calls[0]?.needMoreByType?.image === 2,
    JSON.stringify({ needMore: stub.calls[0]?.needMore, byType: stub.calls[0]?.needMoreByType })
  );
  check('补货走独立用途记忆（scope=image-restock）', stub.calls[0]?.scope === 'image-restock', String(stub.calls[0]?.scope));
  check('补货用的是注入的作品元数据（没联网）', Array.isArray(stub.calls[0]?.artworks), typeof stub.calls[0]?.artworks);

  const bankRows = imageRowsInBank();
  check('题库被补出 2 道图像题', bankRows.length === 2, String(bankRows.length));
  check(
    '补出来的图像题都带 options（不是坏题）',
    bankRows.every((r) => Array.isArray(JSON.parse(r.options)) && JSON.parse(r.options).length === 4),
    bankRows.map((r) => r.id).join(',')
  );
  check('补货只增不删（库存缺口被填上，可用图像题 = 2）', countUsableImageQuestions() === 2, String(countUsableImageQuestions()));
  check('题库总数只多了这 2 道', countQuestions() === bankBefore + 2, `${countQuestions()} / ${bankBefore + 2}`);

  // ---------- ③ 第二天组题时自然用上 ----------
  line('');
  line('③ 补的货明天自然被用上：清掉当天题单重取，图像题就进得来');
  db.prepare('DELETE FROM daily_sessions WHERE date = ?').run(V);
  const noop = makeStub();
  const view2 = await getTodayView({ date: V, artworks: [], generate: noop });
  const imageInDay2 = view2.questions.filter((q) => q.type === 'image').length;

  line(`   重取：当天 ${view2.questions.length} 道（图像题 ${imageInDay2} 道）｜生成函数被调用 ${noop.calls.length} 次`);
  check('清掉题单重取，能取到图像题', imageInDay2 === 2, String(imageInDay2));
  check('重取当天仍是 10 道题', view2.questions.length === 10, String(view2.questions.length));
  check('库存已够，重取不再补货（一次生成都没调）', noop.calls.length === 0, String(noop.calls.length));

  // ---------- ④ 坏题防线 ----------
  line('');
  line('④ 坏题防线：options 为空的图像题进不了候选池，也进不了当天题单');
  const bad = insertQuestions([{
    type: 'image',
    stem: '【T14自检】坏图像题（options 为空）',
    options: null,
    answer: 'A',
    explanation: '自检用，跑完即删。',
    difficulty: '进阶',
    tags: []
  }]).inserted;
  const badId = bad[0];

  db.prepare('DELETE FROM daily_sessions WHERE date = ?').run(V);
  const view3 = await getTodayView({ date: V, artworks: [], generate: makeStub() });
  const candidateIds = getCandidates().map((q) => q.id);
  const badExists = db.prepare('SELECT count(*) AS c FROM questions WHERE id = ?').get(badId).c === 1;

  line(`   坏题 id=${badId}　在候选池里 ${candidateIds.includes(badId) ? '在（不对）' : '不在（对）'}`);
  check('坏题确实躺在库里（不是被删了才不出现）', badExists, String(badExists));
  check('坏图像题不进候选池', !candidateIds.includes(badId), `候选 ${candidateIds.length} 道`);
  check('坏图像题不出现在 /api/today', !view3.questions.some((q) => q.id === badId), view3.questions.map((q) => q.id).join(','));
  check('挡住了坏题，当天仍是 10 道', view3.questions.length === 10, String(view3.questions.length));

  // ---------- ⑤ 分母与实际题数对齐 ----------
  line('');
  line('⑤ 分母对齐：题单里挂着已删除的 id 时，progress.total 要等于实际题数');
  const ghostId = marks.questions + 99999; // 一个不存在的 id
  const realIds = seeded.slice(0, 3);
  saveSession({ date: V3, questionIds: [...realIds, ghostId], total: 4 });
  const view4 = await getTodayView({ date: V3, artworks: [], generate: makeStub() });

  line(`   题单存档 4 个 id（其中 ${ghostId} 不存在）→ 实际取到 ${view4.questions.length} 道｜progress ${view4.progress.done}/${view4.progress.total}`);
  check('题单里的死 id 被跳过（实际只有 3 道）', view4.questions.length === 3, String(view4.questions.length));
  check('progress.total 等于实际题数', view4.progress.total === view4.questions.length, String(view4.progress.total));
  check('progress.total 不再是存档里的 4', view4.progress.total === 3, String(view4.progress.total));
  check('progress.done 口径不变（这批没作答，仍是 0）', view4.progress.done === 0, String(view4.progress.done));
  check('死 id 不会出现在返回里', !view4.questions.some((q) => q.id === ghostId), String(ghostId));

  // ---------- ⑥ 真实接口冒烟（今天没有题单就跳过，免得白花钱） ----------
  line('');
  line('⑥ 真实服务冒烟：/api/health 与 /api/today');
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };

  const health = await getJson('/api/health');
  const realToday = todayInShanghai();
  const hasRealSession = getSession(realToday) != null;
  let todayHttp = null;
  if (hasRealSession) todayHttp = await getJson('/api/today');
  server.close();

  line(`   /api/health  ${health.status} ${JSON.stringify(health.body)}`);
  line(`   /api/today   ${hasRealSession ? `${todayHttp.status}　进度 ${todayHttp.body?.progress?.done}/${todayHttp.body?.progress?.total}` : '（今天还没题单，跳过，避免真调 AI 花钱）'}`);
  check('GET /api/health 返回 200 且 ok', health.status === 200 && health.body?.ok === true, `HTTP ${health.status}`);
  if (hasRealSession) {
    check(
      '真实 /api/today 的分母与实际题数一致',
      todayHttp.status === 200 && todayHttp.body?.progress?.total === todayHttp.body?.questions?.length,
      `${todayHttp.body?.progress?.total} / ${todayHttp.body?.questions?.length}`
    );
  }

  // ---------- ⑦ 清理与还原 ----------
  line('');
  line('⑦ 清理临时数据、还原被临时隐藏的图像题');
  cleanup();
  restoreFlagged(hidden);

  const leftover = {
    题库: db.prepare('SELECT count(*) AS c FROM questions     WHERE id > ?').get(marks.questions).c,
    会话: db.prepare('SELECT count(*) AS c FROM daily_sessions WHERE date IN (?, ?)').get(V, V3).c,
    打卡: db.prepare('SELECT count(*) AS c FROM checkins       WHERE date IN (?, ?)').get(V, V3).c
  };
  const flaggedAfter = flaggedIds();
  const flagSame = flaggedAfter.size === marks.flaggedBefore.size && [...flaggedAfter].every((id) => marks.flaggedBefore.has(id));

  rule();
  line('残留：' + Object.entries(leftover).map(([k, v]) => `${k} ${v}`).join('　') + `　临时标记 ${flagSame ? '已还原' : '没还原'}`);
  check('临时数据已清理干净', Object.values(leftover).every((v) => v === 0), JSON.stringify(leftover));
  check('被临时隐藏的图像题已还原（标记状态与跑之前一致）', flagSame, `${flaggedAfter.size} / ${marks.flaggedBefore.size}`);

  // ---------- 结果 ----------
  line('');
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 52)}${detail}`);
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);
  line('');
  line('口径 A 落地：当天题数优先（凑不上构成不算 bug），但图像辨识题会单独补货，不会枯竭。');
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