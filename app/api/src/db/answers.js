// 作答记录的读写 SQL
// T4（读）：算"昨日未完成"和当天进度。T5（M2 判分）：写入。
import { getDb } from './index.js';

/** 某天已经作答过的题目 id（去重） */
export function getAnsweredIdsOn(date) {
  return getDb()
    .prepare('SELECT DISTINCT question_id FROM answers WHERE session_date = ?')
    .all(date)
    .map((row) => row.question_id);
}

/**
 * 某天里，"这一组题"中还没作答的题（保持传入顺序）。
 * 昨日未完成 = 昨日题单 - 昨日已作答，由 T4 自己算（组题层故意不扫 daily_sessions）。
 */
export function filterUnanswered(questionIds = [], date) {
  const answered = new Set(getAnsweredIdsOn(date));
  return questionIds.map(Number).filter((id) => !answered.has(id));
}

/**
 * 写一条作答记录。
 * `session_date` 记的是**作答当天**（不是这道题原本属于哪天）——
 * 依据 specs/04 第三节：昨日未完成的题今天补做，计入今天的额度。
 *
 * `isCorrect` 是**最终判定**；主观题由 AI 先判（同时记 `aiCorrect` 留底），用户改判时用 updateAnswerVerdict。
 */
export function insertAnswer({
  questionId,
  sessionDate,
  userAnswer = null,
  isCorrect = false,
  isSelfGraded = false,
  aiCorrect = null,
  aiComment = null,
  aiErrors = []
} = {}) {
  const info = getDb()
    .prepare(`
      INSERT INTO answers (question_id, session_date, user_answer, is_correct, is_self_graded, ai_correct, ai_comment, ai_errors)
      VALUES (@question_id, @session_date, @user_answer, @is_correct, @is_self_graded, @ai_correct, @ai_comment, @ai_errors)
    `)
    .run({
      question_id: Number(questionId),
      session_date: sessionDate,
      user_answer: userAnswer,
      is_correct: isCorrect ? 1 : 0,
      is_self_graded: isSelfGraded ? 1 : 0,
      ai_correct: aiCorrect == null ? null : aiCorrect ? 1 : 0,
      ai_comment: aiComment,
      ai_errors: Array.isArray(aiErrors) && aiErrors.length ? JSON.stringify(aiErrors) : null
    });

  return Number(info.lastInsertRowid);
}

/**
 * 改判：把最终判定改成用户给的（AI 的原始判定留在 `ai_correct`，不动）。
 * 这是"AI 判错了我再给它反馈"的落地方式。
 */
export function updateAnswerVerdict({ id, isCorrect } = {}) {
  getDb()
    .prepare('UPDATE answers SET is_correct = ?, is_self_graded = 1 WHERE id = ?')
    .run(isCorrect ? 1 : 0, Number(id));
}

/** 某题某天的作答记录（防重复提交用）；没有返回 null */
export function getAnswer({ questionId, sessionDate } = {}) {
  const row = getDb()
    .prepare(`
      SELECT id, user_answer, is_correct, is_self_graded, ai_correct, ai_comment, ai_errors
        FROM answers
       WHERE question_id = ? AND session_date = ?
       ORDER BY id
       LIMIT 1
    `)
    .get(Number(questionId), sessionDate);

  if (!row) return null;
  return {
    id: row.id,
    userAnswer: row.user_answer,
    isCorrect: row.is_correct === 1,
    isSelfGraded: row.is_self_graded === 1,
    aiCorrect: row.ai_correct == null ? null : row.ai_correct === 1,
    aiComment: row.ai_comment,
    aiErrors: parseErrors(row.ai_errors)
  };
}

/** `ai_errors` 是 JSON 字符串存的，坏了就当没有，别把接口带崩 */
function parseErrors(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 正确率的分母与分子：按题型聚合（M4 统计用）。
 * → [{ type, total, correct }]，只含"有作答"的题型——补齐四种题型留给 services 层。
 */
export function getAccuracyRows() {
  return getDb()
    .prepare(`
      SELECT q.type           AS type,
             COUNT(*)         AS total,
             SUM(a.is_correct) AS correct
        FROM answers a
        JOIN questions q ON q.id = a.question_id
       GROUP BY q.type
    `)
    .all();
}