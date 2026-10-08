// AI 生成入口：拼提示词 → 调智谱 → 解析 JSON → 归一化成题目数组
// 这一层只负责"拿到题"，按缺题数生成 / 落库 / 去重的规则在 services/dailyGeneration.js
import { chatCompletion } from './zhipuClient.js';
import { buildDailyMessages } from './prompts.js';
import { parseJsonLoose } from './parseJson.js';

const TYPES = new Set(['objective', 'term', 'image', 'essay']);
const DIFFICULTIES = new Set(['基础', '进阶', '挑战']);

/**
 * @param {{needMore:number, needMoreByType?:object, artworks?:Array<object>}} params
 *   artworks：图像辨识题的博物馆元数据，作者与年代以它为准（AI 只写风格依据与干扰项）
 * @returns {Promise<{hook:string|null, questions:Array<object>, usage:object|null}>}
 */
export async function generateDailyQuestions({ needMore, needMoreByType = {}, artworks = [] } = {}) {
  if (!(needMore > 0)) return { hook: null, questions: [], usage: null };

  const { system, user } = buildDailyMessages({ needMore, needMoreByType, artworks });
  const { content, usage, jsonMode } = await chatCompletion({ system, user });
  const parsed = parseJsonLoose(content);

  const hook = typeof parsed?.hook === 'string' && parsed.hook.trim() ? parsed.hook.trim() : null;
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];

  // 图像辨识题按顺序挂上博物馆元数据（第 1 道配第 1 件作品）
  const questions = [];
  let imageIndex = 0;
  for (const item of raw) {
    const question = normalizeQuestion(item);
    if (!question) continue;
    if (question.type === 'image') {
      question.artwork = artworks[imageIndex] ?? null;
      imageIndex += 1;
    }
    questions.push(question);
  }

  return { hook, questions, usage, jsonMode };
}

/** 把 AI 给的一条题捏成能直接落库的形状；捏不成（缺题干 / 缺答案 / 选项不够）就丢掉 */
function normalizeQuestion(item) {
  if (!item || typeof item !== 'object') return null;

  const type = String(item.type ?? '').trim();
  if (!TYPES.has(type)) return null;

  const stem = String(item.stem ?? '').trim();
  const answer = String(item.answer ?? '').trim();
  if (!stem || !answer) return null;

  let options = null;
  if (type === 'objective' || type === 'image') {
    const list = Array.isArray(item.options)
      ? item.options.map((option) => String(option).trim()).filter(Boolean)
      : [];
    if (list.length < 4) return null; // 客观题 / 图像辨识题必须 4 个选项
    options = list.slice(0, 4);
  }

  return {
    type,
    stem,
    options,
    answer,
    explanation: String(item.explanation ?? '').trim(),
    difficulty: DIFFICULTIES.has(item.difficulty) ? item.difficulty : '进阶',
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : []
  };
}