// 唯一碰桌面通知的地方（node-notifier）。
// 规则在 services/push.js，这里只负责"把一条通知弹出去"。
import notifier from 'node-notifier';

/**
 * 弹一条 Windows 桌面通知；点通知打开 url（今日页）。
 * @param {{title:string, message:string, url?:string}} params
 * @returns {Promise<boolean>}
 */
export function sendNotification({ title, message, url }) {
  return new Promise((resolve, reject) => {
    notifier.notify(
      {
        title,
        message,
        open: url ?? undefined, // 点通知直接打开今日页
        wait: false,
        timeout: 30
      },
      (err) => (err ? reject(err) : resolve(true))
    );
  });
}