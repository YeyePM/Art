import { postJson } from './client';
import type { AnswerResult } from './types';

/**
 * 交卷：拿回判定、解析与参考答案。
 * - 不传 self_grade = 正常交卷（同一题同一天重复提交是幂等的）
 * - 传 self_grade   = 改判（只对名词解释 / 论述有效；客观题带了会 400）
 */
export const submitAnswer = (body: {
  question_id: number;
  user_answer: string;
  self_grade?: boolean;
}): Promise<AnswerResult> => postJson<AnswerResult>('/api/answers', body);