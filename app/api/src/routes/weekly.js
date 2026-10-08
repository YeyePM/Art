// 每周一批的接口：读当前批次 + 两个"写一句"入口
// 这一层只校验参数、转调；滚动 7 天的规则在 services/weeklyBatch.js
//
// 红线：图片一律走本机缓存（/api/images/），这里**不返回任何外链**。
import { Router } from 'express';
import { getWeeklyView, saveArtworkNote, saveOpenQuestionAnswer } from '../services/weeklyBatch.js';

const router = Router();

router.get('/weekly', async (req, res, next) => {
  try {
    res.json(await getWeeklyView());
  } catch (err) {
    next(err);
  }
});

router.post('/artworks/note', (req, res, next) => {
  try {
    const { artwork_id: artworkId, content } = req.body ?? {};
    res.json(saveArtworkNote({ artworkId, content }));
  } catch (err) {
    next(err);
  }
});

router.post('/open-questions/answer', (req, res, next) => {
  try {
    const { open_question_id: openQuestionId, content } = req.body ?? {};
    res.json(saveOpenQuestionAnswer({ openQuestionId, content }));
  } catch (err) {
    next(err);
  }
});

export default router;