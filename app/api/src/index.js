// 服务入口：应用组装在 app.js，这里只负责监听
import { config } from './config.js';
import { createApp } from './app.js';
import { startPushScheduler } from './push/scheduler.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`API 已启动：http://localhost:${config.port}`);
  console.log(`健康检查：http://localhost:${config.port}/api/health`);
  console.log(`今日题目：http://localhost:${config.port}/api/today`);
});

// M8：推送定时器随服务一起常驻（默认 21:00 发一条，09:00–22:00 时间窗）
startPushScheduler();