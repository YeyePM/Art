// Express 应用的组装（不负责监听）
// 单独拆出来是为了开发期能拿真实 HTTP 打自己的接口自测（scripts/verify-t4.js）
import express from 'express';
import { getDb } from './db/index.js';
import { IMAGES_DIR } from './config.js';
import healthRouter from './routes/health.js';
import todayRouter from './routes/today.js';
import answersRouter from './routes/answers.js';
import statsRouter from './routes/stats.js';
import weeklyRouter from './routes/weekly.js';
import flagRouter from './routes/flag.js';
import homeRouter from './routes/home.js';
import pushRouter from './routes/push.js';

export function createApp() {
  // 先建表：/api/health 返回 ok 时，表一定已经齐了
  getDb();

  const app = express();

  app.use(express.json());

  app.use('/api', healthRouter);
  app.use('/api', todayRouter);
  app.use('/api', answersRouter);
  app.use('/api', statsRouter);
  app.use('/api', weeklyRouter);
  app.use('/api', flagRouter);
  app.use('/api', homeRouter);
  app.use('/api', pushRouter);

  // GET /api/images/{filename} —— 本机图片缓存。
  // 用 express.static 直接对外服务 data/images/：**断开外网也能看到画**（T9 的验收点），
  // 顺带天然防了路径穿越，不必自己拼文件名。
  app.use('/api/images', express.static(IMAGES_DIR, { index: false, maxAge: '1h' }));

  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在', path: req.path });
  });

  app.use((err, req, res, next) => {
    // services 抛的参数错误带 status: 400，照它出；其余一律 500
    const status = Number(err?.status) || 500;

    if (status >= 500) {
      console.error('[api error]', err);
      res.status(500).json({ error: '服务内部错误', message: err?.message ?? '未知错误' });
      return;
    }

    res.status(status).json({ error: String(err?.message ?? '请求有误') });
  });

  return app;
}