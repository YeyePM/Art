// 提示词装载与变量填充
// 模板文件放在 app/api/prompts/（可单独调整，不改代码）
// 定稿提示词见 specs/03-AI调用.md 第五节；变量只有两个：{N} 缺题数、{元数据} 博物馆元数据
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ai → src → app/api → prompts
const PROMPTS_DIR = path.resolve(here, '..', '..', 'prompts');

const TYPE_CN = { essay: '开放论述', term: '名词解释', image: '图像辨识', objective: '客观题' };
const TYPE_ORDER = ['essay', 'term', 'image', 'objective'];

export function loadDailyPromptTemplate() {
  return fs.readFileSync(path.join(PROMPTS_DIR, 'daily-questions.txt'), 'utf8');
}

export function loadGradePromptTemplate() {
  return fs.readFileSync(path.join(PROMPTS_DIR, 'grade-answer.txt'), 'utf8');
}

export function loadWeeklyPromptTemplate() {
  return fs.readFileSync(path.join(PROMPTS_DIR, 'weekly-batch.txt'), 'utf8');
}

/**
 * 填模板变量。
 * 用函数式替换：学生作答里若出现 `$&` 这类字符，字符串式 replace 会当替换模式解析，出脏数据。
 */
function fill(template, vars) {
  return Object.entries(vars).reduce((text, [key, value]) => text.replace(`{${key}}`, () => String(value ?? '')), template);
}

/** 把博物馆元数据排成清单给 AI 看（作者 / 年代一律以这里为准） */
export function formatArtworkMeta(artworks = []) {
  if (!artworks.length) return '（本次没有提供作品元数据）';

  return artworks
    .map((a, index) => {
      const parts = [`《${a.title ?? '无题'}》`];
      if (a.artist) parts.push(`作者：${a.artist}`);
      if (a.period) parts.push(`年代：${a.period}`);
      if (a.school) parts.push(`流派：${a.school}`);
      if (a.sourceLibrary) {
        parts.push(`来源：${a.sourceLibrary}${a.externalId != null ? ` #${a.externalId}` : ''}`);
      }
      return `${index + 1}. ${parts.join('｜')}`;
    })
    .join('\n');
}

/** 把 needMoreByType 说成一句人话，让模型严格按题型数量出题 */
export function formatQuota(needMoreByType = {}) {
  return TYPE_ORDER.filter((type) => (needMoreByType?.[type] ?? 0) > 0)
    .map((type) => `${TYPE_CN[type]} ${needMoreByType[type]} 道`)
    .join('、');
}

/**
 * 组装这次调用的两条消息。
 * system 就是定稿模板（只填两个变量）；user 只说清今天的题型配额，
 * 因为定稿模板只写了题型"上限"，没说今天各要几道——缺题数由 T2 算出来，必须照办。
 */
export function buildDailyMessages({ needMore = 0, needMoreByType = {}, artworks = [] } = {}) {
  const sum = TYPE_ORDER.reduce((acc, type) => acc + Math.max(0, Number(needMoreByType?.[type]) || 0), 0);
  const total = sum > 0 ? sum : Math.max(0, Number(needMore) || 0);

  const template = loadDailyPromptTemplate();
  const system = template.replace('{N}', String(total)).replace('{元数据}', formatArtworkMeta(artworks));

  const quota = formatQuota(needMoreByType);
  const user = quota
    ? `今天的配额是：${quota}（合计 ${total} 道）。请严格按这个数量分配题型，只输出 JSON。`
    : `今天生成 ${total} 道题，题型自定。请只输出 JSON。`;

  return { system, user };
}

/**
 * 组装主观题判分的两条消息（T5 用）。
 * @param {{type:string, stem:string, userAnswer:string, referenceAnswer:string}} params
 */
export function buildGradeMessages({ type, stem, userAnswer, referenceAnswer } = {}) {
  const system = fill(loadGradePromptTemplate(), {
    题型: TYPE_CN[type] ?? type,
    题干: stem,
    作答: userAnswer,
    参考答案: referenceAnswer
  });

  return { system, user: '请给这道题判分，并只输出 JSON。' };
}

/**
 * 组装"每周一批"的两条消息（T8 用）。
 * 变量只有一个：{已用书目}——把最近用过的书名喂回去，让 AI 轮换着取。
 * @param {{usedBooks?:string[]}} params
 */
export function buildWeeklyMessages({ usedBooks = [] } = {}) {
  const list = [...new Set(usedBooks.map((book) => String(book ?? '').trim()).filter(Boolean))];
  const system = fill(loadWeeklyPromptTemplate(), {
    已用书目: list.length ? list.join('、') : '（还没有用过，随便挑一本）'
  });

  return { system, user: '请给出本周的摘录与开放问题，只输出 JSON。' };
}