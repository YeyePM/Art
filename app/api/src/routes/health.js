import { Router } from 'express';

const router = Router();

// 接口只做参数校验与转调，业务逻辑不写在这里
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

export default router;