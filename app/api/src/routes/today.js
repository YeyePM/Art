// GET /api/today —— 当天 10 道题
// 这一层只校验参数、转调，不写业务；组装规则在 services/todaySession.js
// 红线（specs/01 第三节）：返回里**绝不出现答案与解析**，答案只在 POST /api/answers 给
import { Router } from 'express';
import { getTodayView } from '../services/todaySession.js';

const router = Router();

router.get('/today', async (req, res, next) => {
  try {
    res.json(await getTodayView());
  } catch (err) {
    next(err);
  }
});

export default router;