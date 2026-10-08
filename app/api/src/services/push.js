// 推送规则层（唯一写推送规则的地方）
// 依据：specs/04-核心规则.md 第六节、docs/02-技术方案.md 第十一节、docs/03-MVP-Spec.md 第 3.4 节
//
// 一条推送要同时过四道关，任何一道不过就"不发"（宁可不发，也不发催办）：
//   ① 今天还没发过（同一天不重复发）
//   ② 在时间窗内、且已到点（09:00–22:00；到点默认 21:00）
//   ③ 当天内容已就绪，能取到一句 hook（发之前先生成今日题单）
//   ④ hook 不含催办话（硬防线）
import { config } from '../config.js';
import { hasPushOn, recordPush } from '../db/pushLog.js';
import { buildTodaySession } from './todaySession.js';
import { todayInShanghai } from './questionPicker.js';
import { sendNotification as defaultSend } from '../push/notifier.js';

// 硬防线：这些词一出现，说明文案退回"催办型"了，必须拦住
const URGING_PATTERNS = [
  /你还没做/,
  /还差\s*(?:\d+|几)?\s*题/,
  /连续要断了/,
  /进度\s*\d+\s*\/\s*\d+/
];

/** 文案里有没有催办话（纯函数，专供自测） */
export function containsUrging(text) {
  const value = String(text ?? '');
  return URGING_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 文案裁决（纯函数）：只认钩子型；空钩子或被硬防线拦住 → 不发。
 * 故意不做"命中就改写成别的句子"——手上没有备选钩子时，硬编一句反而可能变成催办。
 */
export function decideCopy(hook) {
  const body = String(hook ?? '').trim();
  if (!body) return { ok: false, reason: 'no_hook' };
  if (containsUrging(body)) return { ok: false, reason: 'urging' };
  return { ok: true, body };
}

const toMinutes = (hhmm) => {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return hour * 60 + minute;
};

/** 取此刻的 HH:MM（按 Asia/Shanghai） */
export function timeOfDay(now = new Date(), tz = config.timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(now);
}

/**
 * 到点与时间窗判断（纯函数，喂 HH:MM 便于自测）。
 * @returns {{ok:boolean, reason:'send'|'before_window'|'before_time'|'after_window'}}
 */
export function evaluateTiming({ nowHHMM, at, windowStart, windowEnd }) {
  const now = toMinutes(nowHHMM);
  if (now < toMinutes(windowStart)) return { ok: false, reason: 'before_window' };
  if (now > toMinutes(windowEnd)) return { ok: false, reason: 'after_window' };
  if (now < toMinutes(at)) return { ok: false, reason: 'before_time' };
  return { ok: true, reason: 'send' };
}

/** 点通知要打开的地址（今日页） */
export function todayPageUrl() {
  return config.push.url;
}

/**
 * 发一条当日推送（唯一入口）。
 *
 * @param {object} params
 *   date        指定日期（默认按 Asia/Shanghai 的今天）
 *   now         此刻（默认 new Date()）
 *   bypassWindow 手动测试用：跳过时间窗（但仍受"同一天不重复发"约束）
 *   send        注入的通知发送器（自测用）；不传走 push/notifier
 *   build       注入的"备好当天内容"函数（自测用）；不传走 todaySession
 * @returns {Promise<{sent:boolean, reason:string, date:string, body?:string}>}
 */
export async function runDailyPush({
  date,
  now = new Date(),
  bypassWindow = false,
  send,
  build = buildTodaySession
} = {}) {
  const day = date ?? todayInShanghai(now);

  if (hasPushOn(day)) return { sent: false, reason: 'already_sent', date: day };

  if (!bypassWindow) {
    const timing = evaluateTiming({
      nowHHMM: timeOfDay(now),
      at: config.push.at,
      windowStart: config.push.windowStart,
      windowEnd: config.push.windowEnd
    });
    if (!timing.ok) return { sent: false, reason: timing.reason, date: day };
  }

  // 发之前先确保当天内容已就绪——点进去不该看到加载转圈
  const session = await build({ date: day });

  const copy = decideCopy(session?.hook);
  if (!copy.ok) return { sent: false, reason: copy.reason, date: day };

  const notify = send ?? defaultSend;
  let delivered = true;
  try {
    await notify({ title: config.push.title, message: copy.body, url: todayPageUrl() });
  } catch {
    delivered = false;
  }

  // 失败也记一笔：日志里能看到"今天为什么没弹"，且不再反复重试（宁可不发，不催）
  recordPush({ date: day, body: copy.body, delivered });

  return { sent: delivered, reason: delivered ? 'sent' : 'notify_failed', date: day, body: copy.body };
}