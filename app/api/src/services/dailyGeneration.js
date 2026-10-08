// 今日新题的生成与落库（唯一写规则的地方）
// 依据：specs/04-核心规则.md 第一节 ③④、第九节 1/3；specs/03-AI调用.md 第三节
// 只做三件事：按缺题数生成 → 算指纹去重后落库 → 把 hook 交回给调用方
import { generateDailyQuestions } from '../ai/generateQuestions.js';
import { insertQuestions } from '../db/questions.js';
import { ensureArtwork } from '../db/artworks.js';
import { cacheArtworkAndLink } from './artworkCache.js';

// 同一天已经生成过就不再调 AI（进程内的兜底；跨进程靠 questions.fingerprint 的 UNIQUE 约束挡）
const generatedByDate = new Map();

// 生成数量不足时最多再补一轮。specs/03 第三节：要有重试，但不能无限重试
const MAX_ROUNDS = 2;

const TYPES = ['essay', 'term', 'image', 'objective'];

/**
 * @param {{date:string, needMore:number, needMoreByType?:object, artworks?:Array<object>}} params
 * @returns {Promise<{
 *   hook:string|null, insertedIds:number[], inserted:number, skipped:number,
 *   requested:number, shortfall:number, reused:boolean, usage:object|null
 * }>}
 *   hook 交给 T4 写进 daily_sessions.hook（推送用）；这一层不碰 daily_sessions
 */
export async function generateAndStoreDailyQuestions({ date, needMore, needMoreByType = {}, artworks = [] } = {}) {
  const requested = Math.max(0, Number(needMore) || 0);
  const key = String(date ?? '');

  // 今天已经生成过：直接复用，不再花钱
  if (requested > 0) {
    const memo = generatedByDate.get(key);
    if (memo) return { ...memo, reused: true };
  }

  const result = {
    hook: null,
    insertedIds: [],
    inserted: 0,
    skipped: 0,
    requested,
    shortfall: requested,
    reused: false,
    generatedRaw: 0, // AI 实际给了几道（可能多于配额，会被裁掉）
    imagesCached: 0, // 这次顺手下载到本机的画作图张数（M5）
    usage: null // 本次调 AI 的用量合计（验收 / 记账用）
  };
  if (requested === 0) return result;

  const left = normalizeByType(needMoreByType, requested);

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const total = TYPES.reduce((acc, type) => acc + left[type], 0);
    if (total <= 0) break;

    const { hook, questions, usage } = await generateDailyQuestions({
      needMore: total,
      needMoreByType: { ...left },
      artworks
    });

    if (usage) result.usage = addUsage(result.usage, usage);
    if (hook && !result.hook) result.hook = hook;
    if (questions.length === 0) continue;

    // 模型会多给（实测要 10 道给了 11 道、图像辨识 3 道超了 1 道）：这里按配额硬裁，绝不膨胀
    const keep = trimToQuota(questions, left);
    if (keep.length === 0) continue;
    result.generatedRaw += questions.length;

    // 落库前先把行拼好，顺手记下这道题挂了哪件画（好去把图下载到本机）
    const rows = [];
    const pendingImages = new Map(); // artwork_id → 博物馆元数据（带图床地址）
    for (const question of keep) {
      const row = toInsertRow(question);
      rows.push(row);
      if (row.artwork_id && question.artwork) pendingImages.set(row.artwork_id, question.artwork);
    }

    const { inserted, skipped } = insertQuestions(rows);
    result.insertedIds.push(...inserted);
    result.inserted += inserted.length;
    result.skipped += skipped;

    // M5：图像辨识题的作品图下载到本机，并回填 questions.image_path。
    // 离线 / 图床挂了都只是返回 null，不阻塞出题（界面显示无图即可）。
    for (const [artworkId, artwork] of pendingImages) {
      const name = await cacheArtworkAndLink(artworkId, artwork);
      if (name) result.imagesCached += 1;
    }

    for (const question of keep) {
      if (left[question.type] > 0) left[question.type] -= 1;
    }
  }

  result.shortfall = Math.max(0, requested - result.inserted);
  // 只有补齐了才记住"今天已生成"；没补齐就留着，下次调用可以再补一轮
  if (result.shortfall === 0) generatedByDate.set(key, result);
  return result;
}

/**
 * 按配额硬裁模型的输出：每个题型最多要几道就给几道。
 * 实测模型并不总是守规矩（要 10 道给 11 道、图像辨识 3 道超了 1 道），
 * 靠提示词约束不住，必须在落库前裁掉，否则当日配额会膨胀。
 */
function trimToQuota(questions, quota) {
  const used = { objective: 0, term: 0, image: 0, essay: 0 };
  const kept = [];
  for (const question of questions) {
    const cap = quota[question.type] ?? 0;
    if (used[question.type] >= cap) continue;
    used[question.type] += 1;
    kept.push(question);
  }
  return kept;
}

/** 今天已经生成过多少（进程内），排查用 */
export function generatedTodayCount(date) {
  return generatedByDate.get(String(date ?? ''))?.inserted ?? 0;
}

/** 只测试用：忘掉某天的记忆 */
export function forgetGeneration(date) {
  generatedByDate.delete(String(date ?? ''));
}

/** 多轮调用的用量相加（验收时用来估算花了多少钱） */
function addUsage(acc, usage) {
  const base = acc ?? { prompt_tokens: 0, completion_tokens: 0 };
  return {
    prompt_tokens: (base.prompt_tokens ?? 0) + (usage.prompt_tokens ?? 0),
    completion_tokens: (base.completion_tokens ?? 0) + (usage.completion_tokens ?? 0),
    completion_tokens_details: {
      reasoning_tokens:
        (base.completion_tokens_details?.reasoning_tokens ?? 0) +
        (usage.completion_tokens_details?.reasoning_tokens ?? 0)
    }
  };
}

/** 按 needMoreByType 归一化；调用方没给分布时，全按客观题算 */
function normalizeByType(needMoreByType = {}, total) {
  const out = { objective: 0, term: 0, image: 0, essay: 0 };
  let sum = 0;
  for (const type of TYPES) {
    out[type] = Math.max(0, Number(needMoreByType?.[type]) || 0);
    sum += out[type];
  }
  if (sum === 0) out.objective = total;
  return out;
}

/** 题目 + 画作元数据 → questions 表能直接写的一行 */
function toInsertRow(question) {
  let artworkId = null;

  if (question.type === 'image' && question.artwork) {
    const artwork = question.artwork;
    artworkId = ensureArtwork({
      title: artwork.title ?? null,
      artist: artwork.artist ?? null,
      period: artwork.period ?? null,
      school: artwork.school ?? null,
      source_library: artwork.sourceLibrary ?? null,
      external_id: artwork.externalId ?? null
    });
  }

  return {
    type: question.type,
    stem: question.stem,
    options: question.options,
    answer: question.answer,
    explanation: question.explanation,
    difficulty: question.difficulty,
    tags: question.tags,
    source: 'ai',
    artwork_id: artworkId
  };
}