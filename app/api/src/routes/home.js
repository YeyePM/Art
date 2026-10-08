// GET /api/home —— 主界面三个板块的粗略概览
// 这一层只转调，不写业务；规则在 services/home.js
import { Router } from 'express';
import { getHomeView } from '../services/home.js';

const router = Router();

router.get('/home', async (req, res, next) => {
  try {
    res.json(await getHomeView());
  } catch (err) {
    next(err);
  }
});

export default router;