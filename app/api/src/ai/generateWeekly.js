// AI 生成入口（每周一批）：拼提示词 → 调智谱 → 解析 JSON → 归一化成"摘录 + 开放问题"
// 这一层只负责"拿到内容"；何时该生成新批次、怎么落库的规则在 services/weeklyBatch.js
import { chatCompletion } from './zhipuClient.js';
import { buildWeeklyMessages } from './prompts.js';
import { parseJsonLoose } from './parseJson.js';

/**
 * @param {{usedBooks?:string[]}} params
 *   usedBooks：最近用过的书名，喂给提示词让 AI 轮换取书
 * @returns {Promise<{excerpt:object|null, openQuestion:object|null, usage:object|null}>}
 */
export async function generateWeeklyContent({ usedBooks = [] } = {}) {
  const { system, user } = buildWeeklyMessages({ usedBooks });
  const { content, usage } = await chatCompletion({ system, user });
  const parsed = parseJsonLoose(content);

  return {
    excerpt: normalizeExcerpt(parsed?.excerpt),
    openQuestion: normalizeOpenQuestion(parsed?.open_question),
    usage
  };
}

/** 摘录：书名 + 原文是硬要求，缺了就当没生成（宁可这周不出摘录，也不出半条） */
function normalizeExcerpt(item) {
  if (!item || typeof item !== 'object') return null;

  const bookTitle = String(item.book_title ?? '').trim();
  const sourceText = String(item.source_text ?? '').trim();
  if (!bookTitle || !sourceText) return null;

  return {
    bookTitle,
    chapter: String(item.chapter ?? '').trim() || null,
    sourceText,
    contactLine: String(item.contact_line ?? '').trim() || null
  };
}

/** 开放问题：题干是硬要求；参考思路可留空 */
function normalizeOpenQuestion(item) {
  if (!item || typeof item !== 'object') return null;

  const stem = String(item.stem ?? '').trim();
  if (!stem) return null;

  return {
    stem,
    referenceThoughts: String(item.reference_thoughts ?? '').trim() || null
  };
}