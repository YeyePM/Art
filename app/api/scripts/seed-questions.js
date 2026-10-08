// 开发期假题生成器（替代 AI，让 T2 / T4 的链路能先跑通）
//   node app/api/scripts/seed-questions.js          塞 30 道假题（题库非空则跳过）
//   node app/api/scripts/seed-questions.js --reset  清空题库后重塞
//   node app/api/scripts/seed-questions.js --clear  只清空题库
import { pathToFileURL } from 'node:url';
import { getDb } from '../src/db/index.js';
import { insertQuestions, countQuestions } from '../src/db/questions.js';

// [作品, 作者, 时期, 流派] —— 9 中国 + 9 外国，够铺开中外混合
const CN_WORKS = [
  ['早春图', '郭熙', '宋', '文人画'],
  ['千里江山图', '王希孟', '宋', '青绿山水'],
  ['富春山居图', '黄公望', '元', '文人画'],
  ['溪山行旅图', '范宽', '宋', '院体'],
  ['鹊华秋色图', '赵孟頫', '元', '文人画'],
  ['泼墨仙人图', '梁楷', '宋', '院体'],
  ['墨葡萄图', '徐渭', '明', '写意'],
  ['六君子图', '倪瓒', '元', '文人画'],
  ['汉宫春晓图', '仇英', '明', '院体']
];

const FOREIGN_WORKS = [
  ['蒙娜丽莎', '达·芬奇', '文艺复兴', '佛罗伦萨画派'],
  ['夜巡', '伦勃朗', '巴洛克', '荷兰画派'],
  ['大碗岛的星期日下午', '修拉', '后印象', '新印象派'],
  ['亚威农少女', '毕加索', '现代', '立体主义'],
  ['星夜', '梵高', '后印象', '印象派'],
  ['记忆的永恒', '达利', '现代', '超现实主义'],
  ['自由引导人民', '德拉克罗瓦', '浪漫主义', '浪漫主义'],
  ['奥尔加斯伯爵的葬礼', '格列柯', '文艺复兴', '威尼斯画派'],
  ['苹果与橘子', '塞尚', '后印象', '印象派']
];

const ALL_WORKS = [...CN_WORKS, ...FOREIGN_WORKS];
const ALL_ARTISTS = ALL_WORKS.map(([, artist]) => artist);
const LETTERS = ['A', 'B', 'C', 'D'];

// 四个选项：正确答案 + 3 个干扰项，位置由序号决定，保证可复现
function optionsFor(answer, index) {
  const distractors = [];
  for (let step = 1; distractors.length < 3 && step < ALL_ARTISTS.length; step += 1) {
    const candidate = ALL_ARTISTS[(index + step * 3) % ALL_ARTISTS.length];
    if (candidate !== answer && !distractors.includes(candidate)) distractors.push(candidate);
  }
  const at = index % 4;
  const items = [...distractors];
  items.splice(at, 0, answer);
  return { options: items.map((text, i) => `${LETTERS[i]} ${text}`), answer: LETTERS[at] };
}

const TERMS = [
  ['解释「气韵生动」，并说明它在谢赫六法中的位置。', ['魏晋南北朝', '文人画', '中国美术史'], '气韵生动是六法之首，指画面整体呈现的生命气息与精神格调，是品评的最高标准。'],
  ['解释「图像证史」，说明它与传统文献证史的区别。', ['中国美术史'], '图像证史主张把图像当作史料来读，可补文献之缺，但须先辨图像的用途与生产语境。'],
  ['解释「有意味的形式」，并指出它出自谁的理论。', ['现代', '外国美术史'], '克莱夫·贝尔提出，认为艺术作品的根本在于能唤起审美情感的线条与色彩的组合关系。'],
  ['解释「巴洛克」在艺术上的含义，并举一位代表画家。', ['巴洛克', '外国美术史'], '巴洛克强调动势、明暗对比与戏剧性，代表画家如伦勃朗、鲁本斯。']
];

const IMAGE_QUESTIONS = [
  [CN_WORKS[0], '图像辨识：判断这幅山水作品的作者与年代，并说明断代依据。'],
  [CN_WORKS[5], '图像辨识：判断这幅人物画（减笔水墨）的作者与年代。'],
  [FOREIGN_WORKS[1], '图像辨识：判断这幅群像画的作品名、作者与流派。'],
  [FOREIGN_WORKS[2], '图像辨识：判断这幅点彩作品的作者与流派。']
];

const ESSAYS = [
  ['试论宋代文人画思潮的形成背景，以及它对后世绘画评价标准的影响。', ['宋', '文人画', '中国美术史'], '可从科举与士人阶层、苏轼等人的画论、以及"论画以形似"的转向切入。'],
  ['「什么时候该停笔」是一个判断，不是一个事实。提香晚年任由颜料堆在画布上，塞尚在写生中反复涂改，德加干脆把画面停在"未完成"。请结合一位画家的具体作品、以及你自己的作画经验，论述：完成感究竟从哪里来？', ['现代', '外国美术史'], '开放题。看是否落到具体作品与个人作画经验，避免只谈概念。'],
  ['写生与重构是什么关系？请结合一位画家的写生实践谈谈你的理解。', ['后印象', '外国美术史'], '可谈塞尚从写生到结构重建的路径。'],
  ['试论巴洛克艺术与宗教改革、反宗教改革运动之间的关系。', ['巴洛克', '外国美术史'], '联系特伦托会议后教会对图像功能的要求，看是否落到具体作品。']
];

/**
 * 30 道假题：客观 18 + 名词 4 + 图像辨识 4 + 论述 4。
 * 论述 3 道、名词 4 道、图像辨识 4 道都超过题型上限，用来验证组题规则真的在卡上限。
 */
export function buildFakeQuestions() {
  const items = [];

  ALL_WORKS.forEach(([work, artist, period, school], index) => {
    const { options, answer } = optionsFor(artist, index);
    const origin = CN_WORKS.includes(ALL_WORKS[index]) ? '中国美术史' : '外国美术史';
    items.push({
      type: 'objective',
      stem: `「${work}」的作者是？`,
      options,
      answer,
      explanation: `《${work}》为${artist}所作，${period}时期，属${school}。`,
      difficulty: index % 3 === 0 ? '基础' : '进阶',
      tags: [period, school, artist, work, origin]
    });
  });

  for (const [stem, tags, explanation] of TERMS) {
    items.push({ type: 'term', stem, answer: '见解析', explanation, tags });
  }

  for (const [[work, artist, period, school], stem] of IMAGE_QUESTIONS) {
    const origin = CN_WORKS.some(([w]) => w === work) ? '中国美术史' : '外国美术史';
    // 图像辨识题同样要有 options —— T14-B 坏题防线会把「没 options 的图像题」挡在候选池外，
    // 这里的假题是拿来喂组题规则的，必须跟真实数据一致（否则等于自己造坏题）。
    const { options, answer } = optionsFor(artist, ALL_WORKS.findIndex(([w]) => w === work));
    items.push({
      type: 'image',
      stem,
      options,
      answer,
      explanation: `${work}，${artist}，${period}，${school}。`,
      tags: [period, school, artist, work, origin]
    });
  }

  for (const [stem, tags, reference] of ESSAYS) {
    items.push({
      type: 'essay',
      stem,
      answer: '参考要点',
      explanation: reference,
      difficulty: '挑战',
      tags
    });
  }

  return items;
}

export function resetQuestionBank() {
  const db = getDb();
  // 顺序要紧：`foreign_keys = ON`，引用 questions 的表必须先删，否则删题会因外键报错。
  // （review_queue 是 M3 才真正有数据的，之前一直是空的，所以旧顺序没暴露问题）
  db.exec(`
    DELETE FROM answers;
    DELETE FROM review_queue;
    DELETE FROM question_tags;
    DELETE FROM questions;
    DELETE FROM tags;
    DELETE FROM daily_sessions;
  `);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--clear')) {
    resetQuestionBank();
    console.log('题库已清空。');
    return;
  }

  if (args.includes('--reset')) {
    resetQuestionBank();
    console.log('题库已清空，准备重塞。');
  } else if (countQuestions() > 0) {
    console.log(`题库里已有 ${countQuestions()} 道题，跳过。要重塞请加 --reset。`);
    return;
  }

  const { inserted, skipped } = insertQuestions(buildFakeQuestions());
  console.log(`已塞入 ${inserted.length} 道开发期假题（跳过重复 ${skipped} 道）。`);
  console.log('注意：这是假题，正式出题（T3）接入后记得清空：node app/api/scripts/seed-questions.js --clear');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}