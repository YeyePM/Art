// POST /api/flag —— 标记一道题 / 一件画 / 一段摘录 / 一个开放问题有问题
// 这一层只校验参数、转调，规则在 services/flagging.js
import { Router } from 'express';
import { flagItem } from '../services/flagging.js';

const router = Router();

router.post('/flag', (req, res, next) => {
  try {
    const { target_type: targetType, target_id: targetId, note } = req.body ?? {};
    flagItem({ targetType, targetId, note });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;