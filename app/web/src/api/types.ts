export type QuestionType = 'objective' | 'term' | 'image' | 'essay';

export type Difficulty = '基础' | '进阶' | '挑战';

/** 一道题（对应 GET /api/today 的 questions[]） */
export type Question = {
  id: number;
  type: QuestionType;
  stem: string;
  /** 选项带字母前缀，形如 "A 吴道子"；名词解释与开放论述为 null */
  options: string[] | null;
  difficulty: Difficulty;
  /** 只有图像辨识题有，可能为 null（图没下好） */
  image_url: string | null;
  is_review: boolean;
  tags: string[];
};

/** AI 没跑通时后端给的人话提示；正常为 null */
export type Notice = { code: string; message: string } | null;

/** GET /api/today */
export type TodayResponse = {
  date: string;
  questions: Question[];
  progress: { done: number; total: number };
  checked_in: boolean;
  notice: Notice;
};

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  objective: '客观',
  term: '名词解释',
  image: '图像辨识',
  essay: '开放论述'
};

/** POST /api/answers 的返回 */
export type AnswerResult = {
  /** null = AI 没判上，交回前端让用户自己定 */
  correct: boolean | null;
  explanation: string | null;
  /** 客观 / 图像辨识是正确选项字母；名词解释 / 论述是参考答案原文 */
  reference_answer: string | null;
  /** 只有主观题有，否则 null */
  ai_comment: string | null;
  /** 事实性硬错误，每条一句 */
  ai_errors: string[];
  /** AI 调不通时有这个字段（correct 也是 null） */
  ai_failed?: boolean;
  next_review_at: string | null;
};