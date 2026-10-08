// 组题规则：算缺题数 + 按当日题型构成与中外混合补齐
// 依据：specs/04-核心规则.md 第一节「组装顺序」、第四节「覆盖范围与均衡」
// 这一层只讲规则，SQL 全在 db/ 里
import { config } from '../config.js';
import { getCandidates, getByIds, getUnflaggedIds } from '../db/questions.js';
import { inferOrigin } from './taxonomy.js';

/** 未完成题 + 到期复习题 + 新题 = 当日固定 10 道时的题型构成 */
export function dailyTypeTarget() {
  return { essay: config.typeLimits.essay, term: config.typeLimits.term, image: config.typeLimits.image };
}

/** 统计一组题里各题型的数量 */
export function countByType(questions = []) {
  const counts = { objective: 0, term: 0, image: 0, essay: 0 };
  for (const q of questions) {
    if (counts[q.type] !== undefined) counts[q.type] += 1;
  }
  return counts;
}

/** 统计中外各几道（判不出中外的计 unknown，不参与均衡） */
export function countOrigin(questions = []) {
  const counts = { cn: 0, foreign: 0, unknown: 0 };
  for (const q of questions) {
    counts[inferOrigin(q.tags) ?? 'unknown'] += 1;
  }
  return counts;
}

/** 某个题型的上限 */
function typeLimit(type) {
  return config.typeLimits[type] ?? Infinity;
}

/**
 * 算"当前有几题、还缺几题"。
 * 配额永不膨胀：昨日未完成题 + 到期复习题 已经够 10 就不再补。
 */
export function calcDeficit({ carryOverIds = [], dueReviewIds = [], quota = config.dailyQuestionCount } = {}) {
  const seen = new Set();
  let carryOver = 0;
  let review = 0;

  for (const id of carryOverIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    carryOver += 1;
  }
  for (const id of dueReviewIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    review += 1;
  }

  const have = Math.min(seen.size, quota);
  return { carryOver, review, have, need: Math.max(0, quota - have) };
}

/**
 * 产出（或补齐）当日题目。
 * 顺序：① 昨日未完成题优先 → ② 到期复习题 → ③ 从题库补足
 * 补足时守三条：题型构成（论述 1、名词 2、图像辨识 2，其余客观上限内）、中外混合、不按时间线排。
 *
 * @returns {{questionIds:number[], needMore:number, needMoreByType:object, counts:object, origins:object}}
 *   needMore > 0 表示题库不够，需要 T3 按 needMoreByType 生成对应题型。
 */
export function pickDailyQuestions({
  carryOverIds = [],
  dueReviewIds = [],
  date,
  quota = config.dailyQuestionCount
} = {}) {
  const day = date ?? todayInShanghai();

  // ① + ② 已确定的题，顺序保留：昨日未完成题在最前。
  // 已被标记的题不再出现在每日题中——所以这里连"昨日未完成 / 到期复习"也一起滤掉（M6）。
  const picked = [];
  const seen = new Set();
  for (const id of getUnflaggedIds([...carryOverIds, ...dueReviewIds])) {
    if (seen.has(id)) continue;
    if (picked.length >= quota) break;
    seen.add(id);
    picked.push(id);
  }

  const baseLength = picked.length;
  const counts = countByType(getByIds(picked));
  const origins = countOrigin(getByIds(picked));

  // ③ 定当日题型构成：先扣掉已占用的名额，再均匀铺开
  const target = dailyTypeTarget();
  const want = {
    essay: Math.max(0, target.essay - counts.essay),
    term: Math.max(0, target.term - counts.term),
    image: Math.max(0, target.image - counts.image)
  };
  const plan = buildTypePlan(quota - baseLength, want);

  // 候选池：按日期做种子打乱，避免出现"按时间线排序"
  const candidates = getCandidates({ excludeIds: picked });
  const shuffled = seededShuffle(candidates, day);
  const pools = {
    cn: shuffled.filter((q) => inferOrigin(q.tags) === 'cn'),
    foreign: shuffled.filter((q) => inferOrigin(q.tags) === 'foreign'),
    unknown: shuffled.filter((q) => inferOrigin(q.tags) === null)
  };

  const takeFrom = (key, index) => {
    const [chosen] = pools[key].splice(index, 1);
    counts[chosen.type] += 1;
    origins[inferOrigin(chosen.tags) ?? 'unknown'] += 1;
    seen.add(chosen.id);
    picked.push(chosen.id);
  };

  for (const type of plan) {
    if (picked.length >= quota) break;
    // 中外混合：每一步先从当前偏少的那一侧找
    const order = origins.cn <= origins.foreign ? ['cn', 'foreign', 'unknown'] : ['foreign', 'cn', 'unknown'];

    // 优先按计划题型找
    let taken = false;
    for (const key of order) {
      const index = pools[key].findIndex((q) => q.type === type && counts[q.type] < typeLimit(q.type));
      if (index !== -1) {
        takeFrom(key, index);
        taken = true;
        break;
      }
    }
    if (taken) continue;

    // 该题型题库里没有：退让成任意没到上限的题，别让当日题数空着
    for (const key of order) {
      const index = pools[key].findIndex((q) => counts[q.type] < typeLimit(q.type));
      if (index !== -1) {
        takeFrom(key, index);
        break;
      }
    }
  }

  const remaining = Math.max(0, quota - picked.length);
  return {
    questionIds: picked,
    needMore: remaining,
    needMoreByType: planNeedMoreByType(counts, remaining, quota),
    counts,
    origins
  };
}

/** 同上，但把题对象一起带出来（排查 / 验证用） */
export function pickDailyQuestionsDetailed(options = {}) {
  const result = pickDailyQuestions(options);
  return { ...result, questions: getByIds(result.questionIds) };
}

/**
 * 还缺的题该按什么题型生成。
 * 先看离当日题型目标还差哪几类，再把剩余名额按"稀缺优先"分配过去。
 * 保证 sum(needMoreByType) === needMore，且不会让 T3 再去生成已经够了的题型。
 */
function planNeedMoreByType(counts, remaining, quota) {
  const result = { objective: 0, term: 0, image: 0, essay: 0 };
  if (remaining <= 0) return result;

  const target = dailyTypeTarget();
  const objectiveTarget = Math.max(0, quota - target.essay - target.term - target.image);

  let left = remaining;
  for (const type of ['essay', 'term', 'image']) {
    const take = Math.min(Math.max(0, target[type] - (counts[type] ?? 0)), left);
    result[type] = take;
    left -= take;
  }
  const objectiveDeficit = Math.max(0, objectiveTarget - (counts.objective ?? 0));
  result.objective = Math.min(objectiveDeficit, left);
  left -= result.objective;

  // 目标都补齐了还有名额空着（题库题型不全导致）：剩下的按客观题补
  result.objective += left;
  return result;
}

/**
 * 排一张题型计划表：先铺满客观题，再把论述/名词/图像辨识的名额均匀插进去，
 * 避免同类扎堆（不会出现"前 5 道全是名词"）。
 */
function buildTypePlan(size, want) {
  if (size <= 0) return [];
  const plan = new Array(size).fill('objective');

  const scarce = [];
  for (const type of ['essay', 'term', 'image']) {
    for (let i = 0; i < (want[type] ?? 0); i += 1) scarce.push(type);
  }
  const used = scarce.slice(0, size);
  used.forEach((type, i) => {
    const position = Math.floor(((i + 1) * size) / (used.length + 1));
    plan[Math.min(position, size - 1)] = type;
  });

  return plan;
}

/** 按 Asia/Shanghai 判今天 */
export function todayInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

// ---------- 确定性打乱：同一天结果稳定，不同天结果不同 ----------

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(list, seedText) {
  const random = mulberry32(hashSeed(String(seedText)));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}