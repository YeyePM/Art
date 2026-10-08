// 常驻定时器：每分钟看一次"今天该不该发"，该发就发。
// 由 index.js 在服务启动时拉起——所以"开机自启 + 后台常驻"就是它一直在跑。
// 规则不在这，在 services/push.js。
import { config } from '../config.js';
import { runDailyPush } from '../services/push.js';

const TICK_MS = 60 * 1000;

async function tick() {
  try {
    const result = await runDailyPush();
    if (result.sent) console.log(`[push] 已发送：${result.body}`);
    else if (result.reason === 'notify_failed') console.warn('[push] 通知没能弹出，已记进 push_log');
  } catch (err) {
    // 推送出问题不能影响服务本身
    console.error('[push] 发送出错：', err?.message ?? err);
  }
}

/**
 * 启动推送定时器。返回 timer；关闭开关时不启动（返回 null）。
 * @param {{intervalMs?:number}} params
 */
export function startPushScheduler({ intervalMs = TICK_MS } = {}) {
  if (!config.push.enabled) {
    console.log('[push] 开关是关的，定时器不启动');
    return null;
  }

  // 启动时先看一次：开机时若已过 21:00 且还在窗口内，当天就能补上（窗外则跳过，不补发）
  tick();
  const timer = setInterval(tick, intervalMs);
  return timer;
}