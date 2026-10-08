// POST /api/push/test —— 手动发一条推送（验收用）
// 这一层只校验参数、转调；规则在 services/push.js
import { Router } from 'express';
import { runDailyPush } from '../services/push.js';
import { todayInShanghai } from '../services/questionPicker.js';

const router = Router();

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * 造一个"今天 HH:MM（Asia/Shanghai）"的时刻，用来在验收时模拟到点。
 * 带 `at` = 走完整判断（时间窗外会被拦）；不带 `at` = 立即手动发一条。
 */
function simulatedNow(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return new Date(`${todayInShanghai()}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
}

router.post('/push/test', async (req, res, next) => {
  try {
    const { at } = req.body ?? {};

    if (at != null && !HHMM.test(String(at))) {
      const err = new Error('at 需要是 HH:MM 格式（例如 "21:00"）');
      err.status = 400;
      throw err;
    }

    const result = await runDailyPush({
      now: at == null ? new Date() : simulatedNow(String(at)),
      // 不带 at = 手动发一条，跳过时间窗；仍守"同一天不重复发"
      bypassWindow: at == null
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;