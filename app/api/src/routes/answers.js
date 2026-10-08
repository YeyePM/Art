// POST /api/answers —— 提交一道题、拿回判定与解析
// 这一层只校验参数、转调，判分规则在 services/grading.js
//
// 主观题会在这里等一次 AI 判分（十几秒），所以处理函数是 async。
//
// 红线（specs/01 第三节）：答案与解析**只在这个接口给**，包括主观题的参考答案，
// 也必须等提交之后才返回——否则前端能提前拿到答案，判定环节就失效了。
import { Router } from 'express';
import { submitAnswer } from '../services/grading.js';

const router = Router();

router.post('/answers', async (req, res, next) => {
  try {
    const { question_id: questionId, user_answer: userAnswer, self_grade: selfGrade } = req.body ?? {};
    res.json(await submitAnswer({ questionId, userAnswer, selfGrade }));
  } catch (err) {
    next(err);
  }
});

export default router;