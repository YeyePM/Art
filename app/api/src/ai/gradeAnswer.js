// 主观题（名词解释 / 论述）判分 —— 唯一碰"AI 判分"的地方
// 客观题 / 图像辨识题不走这里：答案是确定的选项字母，services/grading.js 直接比更准也更省。
// 判分标准写在 prompts/grade-answer.txt，这里只负责拼、调、解析、收口。
//
// 注意：**AI 判错是常态之一**（尤其流派/年代归属）。用户的判定是最终结果——
// 前端拿到这里的结论后可以改判，见 services/grading.js 的覆盖分支。
import { chatCompletion } from './zhipuClient.js';
import { buildGradeMessages } from './prompts.js';
import { parseJsonLoose } from './parseJson.js';

/**
 * 判一道主观题。
 * AI 调不通（超时 / 内容审核拦截）时**直接抛**，由 grading.js 决定怎么降级。
 *
 * @param {{type:string, stem:string, userAnswer:string, referenceAnswer:string}} params
 * @returns {Promise<{correct:boolean, comment:string, errors:string[], usage:object|null}>}
 */
export async function gradeSubjectiveAnswer({ type, stem, userAnswer, referenceAnswer } = {}) {
  const { system, user } = buildGradeMessages({ type, stem, userAnswer, referenceAnswer });
  const { content, usage } = await chatCompletion({ system, user });
  const parsed = parseJsonLoose(content);

  if (typeof parsed?.correct !== 'boolean') {
    const err = new Error('AI 判分返回里没有 correct 字段');
    err.status = 502;
    throw err;
  }

  return {
    correct: parsed.correct,
    comment: String(parsed.comment ?? '').trim(),
    errors: Array.isArray(parsed.errors) ? parsed.errors.map((item) => String(item).trim()).filter(Boolean) : [],
    usage
  };
}