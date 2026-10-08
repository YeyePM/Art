// GET /api/stats —— 连续打卡天数、总完成天数、正确率
// 这一层只校验参数、转调，不写业务；规则在 services/stats.js
import { Router } from 'express';
import { getStats } from '../services/stats.js';

const router = Router();

router.get('/stats', (req, res, next) => {
  try {
    res.json(getStats());
  } catch (err) {
    next(err);
  }
});

export default router;