// 判分规则（唯一写"对错怎么算"的地方）
// 依据：specs/01-接口契约.md 第一节第 3 条 · 「一之二」（字段与流程）· 第三节（答案只在这个接口给）
//      specs/04-核心规则.md 第二节（遗忘曲线，M3 已接上：见 services/reviewQueue.js）
//
// 判定分两条路：
//   objective / image  客观题、图像辨识：答案是确定的选项字母，**直接比**，零延迟零成本。
//                      不交给 AI——更慢、还可能判飘。
//   term / essay       名词解释、论述：**先由 AI 判**（指出事实性硬错误 + 给点评），
//                      用户不认时可以改判（再提交一次带 self_grade），AI 的原始判定留底。
//
// 一次提交的完整分支（这是最容易改错的地方，先看这张表）：
//   self_grade 有 且 主观题  → 改判（或 AI 没判上时用户自己定）；已有记录就覆盖，没有就新建
//   self_grade 无            → 已有记录：幂等返回，**不再调 AI、不再花钱**
//                             客观题 / 图像辨识：直接比
//                             名词解释 / 论述：调 AI 判
//   AI 调不通                → **不落库**，返回 `correct: null`，交回前端让用户自己定
//
// 「最终判定」写下的那一刻，顺手更新复习队列（M3）：答错入队、答对推进/出队。
// 唯一的例外是幂等返回那条路——它只是把上次的结果再念一遍，**不许再推进一次间隔**。
//
// 「真的写下了作答」的分支还会顺手看一眼当天题单做完了没 → 做完了就打卡（M4，见 services/stats.js）。
// 幂等返回那条路不调（没写新作答，不可能刚好凑满）。
import { getWithAnswer } from '../db/questions.js';
import { getAnswer, insertAnswer, updateAnswerVerdict } from '../db/answers.js';
import { gradeSubjectiveAnswer } from '../ai/gradeAnswer.js';
import { todayInShanghai } from './questionPicker.js';
import { applyVerdictToReviewQueue, getNextReviewOn } from './reviewQueue.js';
import { maybeCheckIn } from './stats.js';

/** 有选项、能直接比的题型 */
const CHOICE_TYPES = new Set(['objective', 'image']);

/**
 * 提交一道题的作答：判分 + 落 `answers`。
 *
 * @param {{questionId:*, userAnswer:*, selfGrade:*, date?:string}} params
 * @returns {Promise<{correct:boolean|null, explanation:string, reference_answer:string,
 *                    ai_comment:string|null, ai_errors:string[], ai_failed?:boolean, next_review_at:null}>}
 *   `correct` 为 null 表示"没判上，等你定"——AI 调不通时才会出现，前端据此让用户自己判
 */
export async function submitAnswer({ questionId, userAnswer, selfGrade, date } = {}) {
  const id = Number(questionId);
  if (!Number.isInteger(id)) throw badRequest('question_id 必须是整数');

  const question = getWithAnswer(id);
  if (!question) throw badRequest(`题目不存在：${questionId}`);

  // 四种题型都必须"先交卷"：交了自己的作答，才换得到判定与参考答案
  if (userAnswer == null || String(userAnswer).trim() === '') {
    throw badRequest('必须带 user_answer（先写下你的作答，才能看参考答案）');
  }

  const day = date ?? todayInShanghai();
  const existing = getAnswer({ questionId: id, sessionDate: day });
  const isChoice = CHOICE_TYPES.has(question.type);

  // ---------- ① 用户给了判定：改判 ----------
  if (selfGrade != null) {
    if (isChoice) throw badRequest('客观题 / 图像辨识题由系统直接判定，不需要 self_grade');
    const correct = parseSelfGrade(selfGrade);

    if (existing) {
      // 覆盖最终判定；AI 的原始判定与点评留着不动
      updateAnswerVerdict({ id: existing.id, isCorrect: correct });
      const nextReviewAt = applyVerdictToReviewQueue({ questionId: id, correct, date: day });
      return viewOf(question, {
        correct,
        aiComment: existing.aiComment,
        aiErrors: existing.aiErrors,
        nextReviewAt
      });
    }

    // AI 没判上时用户直接定（这时还没有任何记录）
    insertAnswer({ questionId: id, sessionDate: day, userAnswer: String(userAnswer), isCorrect: correct, isSelfGraded: true });
    maybeCheckIn({ date: day }); // 这一步真的写了作答，可能刚好凑满当天额度（M4）
    const nextReviewAt = applyVerdictToReviewQueue({ questionId: id, correct, date: day });
    return viewOf(question, { correct, aiComment: null, aiErrors: [], nextReviewAt });
  }

  // ---------- ② 已有记录、这次没带判定：幂等返回（不重复判、不再花钱、也不再推进间隔） ----------
  if (existing) {
    return viewOf(question, {
      correct: existing.isCorrect,
      aiComment: existing.aiComment,
      aiErrors: existing.aiErrors,
      nextReviewAt: getNextReviewOn(id)
    });
  }

  // ---------- ③ 客观题 / 图像辨识：直接比 ----------
  if (isChoice) {
    const correct = compareChoice(userAnswer, question.answer, question.options);
    insertAnswer({ questionId: id, sessionDate: day, userAnswer: String(userAnswer), isCorrect: correct });
    maybeCheckIn({ date: day }); // 作答之后看一眼当天的题单做完没（M4）
    const nextReviewAt = applyVerdictToReviewQueue({ questionId: id, correct, date: day });
    return viewOf(question, { correct, aiComment: null, aiErrors: [], nextReviewAt });
  }

  // ---------- ④ 名词解释 / 论述：调 AI 判 ----------
  try {
    const verdict = await gradeSubjectiveAnswer({
      type: question.type,
      stem: question.stem,
      userAnswer: String(userAnswer),
      referenceAnswer: question.answer
    });

    insertAnswer({
      questionId: id,
      sessionDate: day,
      userAnswer: String(userAnswer),
      isCorrect: verdict.correct,
      aiCorrect: verdict.correct,
      aiComment: verdict.comment,
      aiErrors: verdict.errors
    });

    maybeCheckIn({ date: day }); // 作答之后看一眼当天的题单做完没（M4）
    const nextReviewAt = applyVerdictToReviewQueue({ questionId: id, correct: verdict.correct, date: day });
    return viewOf(question, {
      correct: verdict.correct,
      aiComment: verdict.comment,
      aiErrors: verdict.errors,
      nextReviewAt
    });
  } catch (err) {
    // AI 没判上（超时 / 内容审核拦截）：**不落库**，交回前端让用户自己定。
    // 用户随后带 self_grade 再提交一次，就走分支 ① 落库（队列也在那时才动）。
    console.warn('[grading] AI 判分失败，降级为"等用户自定"：', err?.message ?? err);

    return {
      correct: null,
      explanation: question.explanation,
      reference_answer: question.answer,
      ai_comment: null,
      ai_errors: [],
      ai_failed: true,
      next_review_at: null
    };
  }
}

/**
 * 接口返回的形状（specs/01 第一节第 3 条）。
 * `next_review_at` 由 M3 的复习队列给出：答错是明天，复习答对是下一个节点，出队了就是 null。
 */
function viewOf(question, { correct, aiComment, aiErrors, nextReviewAt = null }) {
  return {
    correct,
    explanation: question.explanation,
    // 客观题 / 图像辨识题是正确选项的字母；名词解释 / 论述题是参考答案原文
    reference_answer: question.answer,
    ai_comment: aiComment ?? null,
    ai_errors: aiErrors ?? [],
    next_review_at: nextReviewAt ?? null
  };
}

/** 用户所选 vs 库里答案：两边都归一到选项字母再比 */
function compareChoice(userAnswer, expected, options) {
  const mine = normalizeChoice(userAnswer, options);
  const right = normalizeChoice(expected, options);
  return mine != null && mine === right;
}

/**
 * 把一道选择题的作答归一成选项字母。
 * 前端可能传 "B" / "b" / "B." / "B 引魂升天的丧葬用途"（整条选项），
 * AI 也偶发把答案写成整条选项文字而不是字母，所以两边都过这一道。
 * 认不出来返回 null（判为不通过，不抛错——脏输入不该把接口带崩）。
 */
function normalizeChoice(raw, options = []) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // "B" / "b" / "B." / "B、" / "B 选项内容" 都取首字母
  if (/^[A-Da-d](\s|[.、,，:：)）]|$)/.test(text)) return text.slice(0, 1).toUpperCase();

  // 传的是整条选项文字：带 "A " 前缀的、只有内容的，都认
  for (const option of Array.isArray(options) ? options : []) {
    const optionText = String(option).trim();
    const optionLetter = optionText.slice(0, 1).toUpperCase();
    if (!/^[A-D]$/.test(optionLetter)) continue;
    if (text === optionText || text === stripLetter(optionText)) return optionLetter;
  }

  return null;
}

/** 去掉选项前面的 "A " / "A." / "A、" 前缀 */
function stripLetter(optionText) {
  return optionText.replace(/^[A-Da-d]\s*[.、,，:：)）]?\s*/, '');
}

/** 用户的判定：只认这几种写法，别的当参数错误 */
function parseSelfGrade(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;

  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'correct') return true;
  if (text === 'false' || text === 'wrong') return false;

  throw badRequest('self_grade 只接受 true / false');
}

/** 参数错误 → 400（错误中间件照 err.status 出状态码） */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}