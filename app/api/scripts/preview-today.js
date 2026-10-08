// 看结果用：把"今天会出的 10 道题"按顺序打印出来
//   npm run preview                          看今天
//   npm run preview -- --date=2026-10-09     看指定某天
// 只读，不改数据库。
import { getCandidates, countQuestions } from '../src/db/questions.js';
import { config } from '../src/config.js';
import {
  pickDailyQuestionsDetailed,
  dailyTypeTarget,
  todayInShanghai
} from '../src/services/questionPicker.js';
import { inferOrigin } from '../src/services/taxonomy.js';

const TYPE_LABEL = { objective: '客观题', term: '名词解释', image: '图像辨识', essay: '论述题' };
const ORIGIN_LABEL = { cn: '中国', foreign: '外国', unknown: '—' };

// ---------- 中日韩字符按两列算，终端里才能真正对齐 ----------
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function pad(text, width) {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function truncate(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const date = arg('date', todayInShanghai());
const total = countQuestions();
const usable = getCandidates({}).length;

if (total === 0) {
  console.log('题库是空的，先塞一批假题再看：npm run seed');
  process.exit(0);
}

const result = pickDailyQuestionsDetailed({ date });
const target = dailyTypeTarget();

console.log('');
console.log(`今天是 ${date}，打开今日页会看到这 ${result.questionIds.length} 道题：`);
console.log('');
console.log(`${pad('序号', 6)}${pad('题型', 12)}${pad('范围', 6)}题目`);
console.log('-'.repeat(96));

result.questions.forEach((q, index) => {
  const origin = ORIGIN_LABEL[inferOrigin(q.tags) ?? 'unknown'];
  console.log(
    `${pad(String(index + 1), 6)}${pad(TYPE_LABEL[q.type] ?? q.type, 12)}${pad(origin, 6)}${truncate(q.stem, 68)}`
  );
});

console.log('-'.repeat(96));
console.log('');

const targetObjective = config.dailyQuestionCount - target.essay - target.term - target.image;
console.log(
  `题型构成：论述 ${result.counts.essay}/${target.essay} · 名词 ${result.counts.term}/${target.term} · ` +
    `图像辨识 ${result.counts.image}/${target.image} · 客观 ${result.counts.objective}/${targetObjective}`
);
console.log(
  `中外顺序：${result.questions.map((q) => ORIGIN_LABEL[inferOrigin(q.tags) ?? 'unknown']).join(' ')}`
);
console.log(`题库状态：共 ${total} 道，可用 ${usable} 道`);

if (result.needMore > 0) {
  console.log('');
  console.log(`注意：题库不够，还缺 ${result.needMore} 道（T3 要生成：${JSON.stringify(result.needMoreByType)}）`);
}

console.log('');
console.log('（题干在这里做了截断，只是给你看构成对不对。完整的题面在今日页里。）');
console.log('');