// 标记问题的规则层（M6）
// 依据：specs/01-接口契约.md「一之五」、specs/04-核心规则.md 第九节第 5 条
//
// 只做两件事：把这一次标记记进 flagged_items；如果是题，顺带把 questions.is_flagged 置 1
// （出题池按 is_flagged 过滤，见 db/questions.js 的 getCandidates）。
import { insertFlag, isValidTargetType, TARGET_TYPES } from '../db/flaggedItems.js';
import { setQuestionFlagged } from '../db/questions.js';

/**
 * @param {{targetType:string, targetId:number, note?:string}} params
 * @returns {{id:number}} 新标记记录的 id
 */
export function flagItem({ targetType, targetId, note } = {}) {
  if (!isValidTargetType(targetType)) {
    throw badRequest(`target_type 只能是 ${TARGET_TYPES.join(' / ')}（收到 ${targetType ?? '空'}）`);
  }

  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('target_id 必须是正整数');
  }

  const flagId = insertFlag({ targetType, targetId: id, note });

  // 题：同步置位，之后组题就绕开它
  if (targetType === 'question') setQuestionFlagged(id, true);

  return { id: flagId };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}