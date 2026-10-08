// T2 验收脚本：node app/api/scripts/verify-t2.js
// 会先清空题库再塞 30 道假题，所以只在开发期跑。
import { countQuestions } from '../src/db/questions.js';
import { inferOrigin } from '../src/services/taxonomy.js';
import { insertQuestions } from '../src/db/questions.js';
import { calcDeficit, pickDailyQuestions, pickDailyQuestionsDetailed } from '../src/services/questionPicker.js';
import { buildFakeQuestions, resetQuestionBank } from './seed-questions.js';

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
}

/** 同类连续出现的最大长度 */
function maxRun(list) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < list.length; i += 1) {
    run = i > 0 && list[i] === list[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

// 1. 塞 30 道假题
resetQuestionBank();
const { inserted } = insertQuestions(buildFakeQuestions());
check('题库塞入假题 30 道', inserted.length === 30, `实际 ${inserted.length}`);

// 2. 什么都没有时，缺 10 道
const deficit = calcDeficit({});
check('空手起局时缺题数为 10', deficit.need === 10, `need=${deficit.need}`);

// 3. 产出 10 题
const day1 = pickDailyQuestionsDetailed({ date: '2026-10-08' });
check('能产出 10 题', day1.questionIds.length === 10, `实际 ${day1.questionIds.length}`);
check('题库够用时 needMore 为 0', day1.needMore === 0, `needMore=${day1.needMore}`);

// 4. 当日题型构成：论述 1、名词 2、图像辨识 2、客观 5
const c = day1.counts;
check('论述题 1 道', c.essay === 1, `essay=${c.essay}`);
check('名词题 2 道', c.term === 2, `term=${c.term}`);
check('图像辨识题 2 道', c.image === 2, `image=${c.image}`);
check('客观题 5 道', c.objective === 5, `objective=${c.objective}`);
check('论述题不超过上限 1', c.essay <= 1, `essay=${c.essay}`);
check('名词题不超过上限 2', c.term <= 2, `term=${c.term}`);
check('图像辨识题不超过上限 2', c.image <= 2, `image=${c.image}`);
check('题型不扎堆（同类不连续超过 2 道）', maxRun(day1.questions.map((q) => q.type)) <= 2, `最长连续 ${maxRun(day1.questions.map((q) => q.type))}`);

// 5. 不重复
check('10 题之间不重复', new Set(day1.questionIds).size === 10);

// 6. 中外混合
const origins = day1.questions.map((q) => inferOrigin(q.tags));
check('中外两边都出现', origins.filter((o) => o === 'cn').length > 0 && origins.filter((o) => o === 'foreign').length > 0, JSON.stringify(origins));

// 7. 不按时间线排：中外应交替出现，不该"全是中国的再接全是外国的"
const transitions = origins.filter((o, i) => i > 0 && o !== origins[i - 1]).length;
check('补齐的题中外交替出现（不按时间线堆叠）', transitions >= 1, `相邻差异 ${transitions} 处`);

// 8. 同一天结果稳定
const again = pickDailyQuestions({ date: '2026-10-08' });
check('同一天重复调用结果一致', JSON.stringify(again.questionIds) === JSON.stringify(day1.questionIds));

// 9. 换一天顺序会变
const day2 = pickDailyQuestions({ date: '2026-10-09' });
check('换一天选题顺序会变（不是写死顺序）', JSON.stringify(day2.questionIds) !== JSON.stringify(day1.questionIds));

// 10. 配额不膨胀：已有 6 道未完成题时，只再补 4 道
const carryOver = day1.questionIds.slice(0, 6);
const withCarry = pickDailyQuestions({ carryOverIds: carryOver, date: '2026-10-08' });
check('带 6 道昨日未完成题时总数仍是 10（配额不膨胀）', withCarry.questionIds.length === 10, `实际 ${withCarry.questionIds.length}`);
check('昨日未完成题排在最前且顺序不变', JSON.stringify(withCarry.questionIds.slice(0, 6)) === JSON.stringify(carryOver));

// 11. 题库不足时如实报缺
resetQuestionBank();
insertQuestions(buildFakeQuestions().filter((q) => q.type === 'objective').slice(0, 5));
const short = pickDailyQuestions({ date: '2026-10-08' });
check('题库只有 5 道时如实报缺 5 道', short.needMore === 5, `needMore=${short.needMore}`);
check(
  '缺的是哪些题型也一并报出（供 T3 生成）',
  JSON.stringify(short.needMoreByType) === JSON.stringify({ objective: 0, term: 2, image: 2, essay: 1 }),
  JSON.stringify(short.needMoreByType)
);
check('题目不够时也不重复充数', new Set(short.questionIds).size === short.questionIds.length);
check('题库不够时客观题不超上限、数量如实', short.counts.objective === 5 && short.counts.term <= 2, JSON.stringify(short.counts));

// 还原题库
resetQuestionBank();
insertQuestions(buildFakeQuestions());
check('还原题库后题数为 30', countQuestions() === 30, `实际 ${countQuestions()}`);

// ---------- 输出 ----------
let failed = 0;
for (const item of checks) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  (${item.detail})` : ''}`);
}
console.log(`\n通过 ${checks.length - failed} / ${checks.length}${failed ? `，失败 ${failed}` : ''}`);
process.exit(failed ? 1 : 0);