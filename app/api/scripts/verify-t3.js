// T3 验收脚本：真调一次智谱，把"缺几题补几题 + 落库 + 不重复"跑通
//   node app/api/scripts/verify-t3.js            清空题库后从零跑一遍（推荐）
//   node app/api/scripts/verify-t3.js --keep     保留现有题库，只补缺的题
// 会花钱（一次约 0.005 元），只用来验收，不进运行时。
import { getDb } from '../src/db/index.js';
import { countQuestions, insertQuestions } from '../src/db/questions.js';
import { getQuestionTags } from '../src/db/tags.js';
import { countArtworks } from '../src/db/artworks.js';
import { pickDailyQuestionsDetailed, todayInShanghai } from '../src/services/questionPicker.js';
import { generateAndStoreDailyQuestions } from '../src/services/dailyGeneration.js';
import { inferOrigin } from '../src/services/taxonomy.js';
import { resetQuestionBank } from './seed-questions.js';

// ---------- 验收期用的博物馆元数据（真实存在，已核对过大都会官方接口） ----------
// 作者 / 年代一律以这里为准，AI 只写风格依据与干扰项。
// M5 的 images/ 层接管后，这里会换成从博物馆实时取。
const DEV_ARTWORKS = [
  {
    title: 'Landscape',
    artist: 'Zhang Ruitu（张瑞图）',
    period: 'early 17th century（明）',
    school: '明代文人画',
    sourceLibrary: 'met',
    externalId: 48968
  },
  {
    title: 'Young Woman with a Water Pitcher',
    artist: 'Johannes Vermeer',
    period: 'ca. 1662',
    school: '荷兰画派',
    sourceLibrary: 'met',
    externalId: 437881
  },
  {
    title: 'A Maid Asleep',
    artist: 'Johannes Vermeer',
    period: 'ca. 1656–57',
    school: '荷兰画派',
    sourceLibrary: 'met',
    externalId: 437878
  }
];

const TYPE_LABEL = { objective: '客观题', term: '名词解释', image: '图像辨识', essay: '论述题' };
const ORIGIN_LABEL = { cn: '中国', foreign: '外国', unknown: '—' };
const PRICE_IN = 0.4 / 1e6; // 限时五折：0.4 元 / M
const PRICE_OUT = 1.4 / 1e6; // 限时五折：1.4 元 / M

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

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(92));

function clearArtworks() {
  const db = getDb();
  db.exec('DELETE FROM artwork_notes; DELETE FROM artworks;');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const date = todayInShanghai();

  line('');
  line('美术史复盘 · T3 验收（AI 生成今日 10 题）');
  line(`日期：${date}　模式：${keep ? '保留现有题库，只补缺的题' : '清空题库，从零跑一遍'}`);
  line('');

  if (!keep) {
    resetQuestionBank();
    clearArtworks();
    // 先塞一批"用过的题"再清掉不合适，这里就用空库：应该缺满 10 道
  }

  line(`当前题库：${countQuestions()} 道题、${countArtworks()} 件画作`);
  line('');

  // ---------- 第一步：先让 T2 的组题规则算"还缺几题、缺哪些题型" ----------
  const before = pickDailyQuestionsDetailed({ date });
  line('① 组题规则算出的缺口');
  rule();
  line(`  已有 ${before.questionIds.length} 道，还缺 ${before.needMore} 道`);
  line(`  按题型补：${Object.entries(before.needMoreByType)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${TYPE_LABEL[type]} ${n} 道`)
    .join('、') || '（不缺）'}`);
  line('');

  if (before.needMore === 0) {
    line('题库已经够 10 道了，T3 不需要调 AI。想看生成过程请把题库清空再跑一次。');
    return finish([]);
  }

  // ---------- 第二步：真调一次智谱 ----------
  line('② 调 AI 生成（思考压到最低档）…');
  line('   正在等智谱回话，约 40～90 秒。窗口这几秒没有任何动静是正常的，别关。');
  const startedAt = Date.now();
  const result = await generateAndStoreDailyQuestions({
    date,
    needMore: before.needMore,
    needMoreByType: before.needMoreByType,
    artworks: DEV_ARTWORKS
  });
  const tookMs = Date.now() - startedAt;

  line(`  耗时 ${(tookMs / 1000).toFixed(1)} 秒，AI 给了 ${result.generatedRaw} 道，按配额留 ${result.inserted} 道，指纹重复跳过 ${result.skipped} 道`);
  line('');

  // ---------- 第三步：看生成的题 ----------
  const after = pickDailyQuestionsDetailed({ date });

  line('③ 今天会出的 10 道题');
  rule();
  line(`${pad('序号', 6)}${pad('题型', 12)}${pad('难度', 8)}${pad('范围', 6)}题目`);
  rule();
  after.questions.forEach((q, index) => {
    const origin = ORIGIN_LABEL[inferOrigin(q.tags) ?? 'unknown'];
    line(
      `${pad(String(index + 1), 6)}${pad(TYPE_LABEL[q.type] ?? q.type, 12)}${pad(q.difficulty ?? '—', 8)}${pad(origin, 6)}${truncate(q.stem, 60)}`
    );
  });
  rule();
  line('');

  line(`当天推送用的钩子（hook）：${result.hook ? `「${result.hook}」` : '（没生成出钩子）'}`);
  line('');

  // 抽两道完整的题给老叶看质量
  const db = getDb();
  const pickOne = (type) =>
    db.prepare('SELECT * FROM questions WHERE type = ? ORDER BY id DESC LIMIT 1').get(type);

  for (const type of ['objective', 'essay']) {
    const q = pickOne(type);
    if (!q) continue;
    line(`④ 样例（${TYPE_LABEL[type]}）`);
    rule();
    line(`题干：${q.stem}`);
    if (q.options) {
      JSON.parse(q.options).forEach((option) => line(`      ${option}`));
    }
    line(`答案：${q.answer}`);
    line(`解析：${truncate(q.explanation, 200)}`);
    line('');
  }

  // ---------- 第四步：自检 ----------
  const checks = [];
  const insertedByType = { objective: 0, term: 0, image: 0, essay: 0 };
  for (const id of result.insertedIds) {
    const row = db.prepare('SELECT type FROM questions WHERE id = ?').get(id);
    if (row) insertedByType[row.type] += 1;
  }

  checks.push(['缺几题就补几题（生成数 = 缺口数）', result.inserted === before.needMore, `${result.inserted} / ${before.needMore}`]);
  checks.push([
    '题型分布与 needMoreByType 一致',
    deepEqual(insertedByType, before.needMoreByType),
    JSON.stringify(insertedByType)
  ]);
  checks.push(['补齐后当天正好 10 道，缺口归零', after.needMore === 0 && after.questionIds.length === 10, `共 ${after.questionIds.length} 道，还缺 ${after.needMore}`]);
  checks.push(['题型上限守住（论述 ≤1、名词 ≤2、图像辨识 ≤2）', after.counts.essay <= 1 && after.counts.term <= 2 && after.counts.image <= 2, JSON.stringify(after.counts)]);
  checks.push(['中外两边都出现', after.origins.cn > 0 && after.origins.foreign > 0, `中国 ${after.origins.cn} / 外国 ${after.origins.foreign}`]);
  checks.push(['题目库里没有重复题（按内容指纹）', countQuestions() === after.questionIds.length, `题库共 ${countQuestions()} 道`]);

  const imageRows = db.prepare("SELECT id, artwork_id FROM questions WHERE type = 'image'").all();
  checks.push([
    '图像辨识题挂上了博物馆画作（作者/年代以元数据为准）',
    imageRows.length > 0 && imageRows.every((row) => row.artwork_id != null),
    `共 ${imageRows.length} 道，挂上画作 ${imageRows.filter((row) => row.artwork_id != null).length} 道`
  ]);

  // 把刚生成的题原样再插一遍：指纹相同，应该一道都进不去（这是跨进程的防线，不靠上面的进程内记忆）
  const dupRows = after.questionIds.map((id) => {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return {
      type: row.type,
      stem: row.stem,
      options: row.options ? JSON.parse(row.options) : null,
      answer: row.answer,
      explanation: row.explanation,
      difficulty: row.difficulty,
      tags: getQuestionTags(id)
    };
  });
  const dup = insertQuestions(dupRows);
  checks.push(['原样重插一遍，指纹把重复题全挡下', dup.inserted.length === 0 && dup.skipped === dupRows.length, `拦下 ${dup.skipped} / ${dupRows.length} 道`]);

  // 同一天再调一次：不该再花钱调 AI（题目数必须一道不增）
  const bankBefore = countQuestions();
  const again = await generateAndStoreDailyQuestions({
    date,
    needMore: before.needMore,
    needMoreByType: before.needMoreByType,
    artworks: DEV_ARTWORKS
  });
  checks.push([
    '同一天再调一次不再调 AI、不再重复入库',
    again.reused === true && countQuestions() === bankBefore,
    `reused=${again.reused}，题库 ${bankBefore} → ${countQuestions()} 道`
  ]);
  checks.push(['同一天两次拿到的题目完全一致', deepEqual(pickDailyQuestionsDetailed({ date }).questionIds, after.questionIds)]);

  if (result.hook) {
    const banned = ['你还没做', '还差几题', '连续要断了', '进度'];
    const hit = banned.find((word) => result.hook.includes(word));
    checks.push(['钩子文案不含催办话', !hit, hit ? `命中「${hit}」` : '干净']);
  }

  // ---------- 第五步：花费 ----------
  const usage = result.usage ?? null;
  line('⑤ 本次用量');
  rule();
  if (usage) {
    const inTok = usage.prompt_tokens ?? 0;
    const outTok = usage.completion_tokens ?? 0;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    line(`  输入 ${inTok} tokens，输出 ${outTok} tokens${reasoning ? `（其中思考 ${reasoning}）` : '（没有思考 token）'}`);
    line(`  按五折价估算：约 ${((inTok * PRICE_IN + outTok * PRICE_OUT) * 100).toFixed(2)} 分钱`);
  } else {
    line('  （接口没返回用量）');
  }
  line(`  智谱用量以控制台为准：https://open.bigmodel.cn`);
  line('');

  finish(checks.map(([name, pass, detail]) => ({ name, pass, detail })));
}

function finish(checks) {
  if (checks.length) {
    line('⑥ 自检');
    rule();
    let failed = 0;
    for (const item of checks) {
      if (!item.pass) failed += 1;
      line(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  (${item.detail})` : ''}`);
    }
    rule();
    line(`通过 ${checks.length - failed} / ${checks.length}${failed ? `，失败 ${failed}` : ''}`);
    line('');
    if (!failed) {
      line('T3 通过。题库里现在装的是 AI 真出的题，双击「测试\\api\\01-M1-看今天题目.bat」可以看到同一批。');
      line('');
      process.exit(0);
    }
    line('有失败项，先把上面 FAIL 的几行发我。');
    line('');
    process.exit(1);
  }
  line('');
}

main().catch((err) => {
  line('');
  line(`出错了：${err?.message ?? err}`);
  line('');
  line('常见原因：① .env 里没配 ZHIPU_API_KEY；② 智谱账号没开通 glm-5.3-flash；③ 网络不通。');
  line(`（想先用假题把链路跑通的话：npm run seed）`);
  line('');
  process.exit(1);
});