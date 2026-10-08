// T12 验收：推送（M8）
//   node app/api/scripts/verify-t12.js
//
// 三段（**全程不花钱、不联网、不弹通知**——通知发送器与"备好当天内容"都注入假实现）：
//   ① 硬防线（纯函数）：催办话一律拦住，空钩子不发
//   ② 时间窗（纯函数）：09:00–22:00 之内、且到点才发
//   ③ 全流程：虚拟日期 + 注入内容，验证"到点发一条 / 同一天不重复 / 没钩子不发 / 通知失败只记不重试"
// 末尾另外真实弹一条演示通知（try/catch，不计入通过数），让你看到"点它进今日页"。
//
// 临时数据只有 push_log（虚拟日期），跑完即删，不动你真实的题库、作答、批次与打卡。
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { getPushLog } from '../src/db/pushLog.js';
import { containsUrging, decideCopy, evaluateTiming, runDailyPush, todayPageUrl } from '../src/services/push.js';
import { sendNotification } from '../src/push/notifier.js';
import { config } from '../src/config.js';

const V = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(96));
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (text) => [...String(text)].reduce((acc, ch) => acc + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (text, width) => (widthOf(text) < width ? text + ' '.repeat(width - widthOf(text)) : text);

const checks = [];
const check = (name, ok, detail = '') => checks.push([name, ok, detail]);

function cleanup() {
  const db = getDb();
  for (const day of V) db.prepare('DELETE FROM push_log WHERE date = ?').run(day);
}

function makeSpy({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (payload) => {
      calls.push(payload);
      if (fail) throw new Error('（自检）模拟通知服务挂了');
      return true;
    }
  };
}

async function main() {
  getDb();

  line('');
  line('T12 验收 · 推送（M8）');
  line('全程不花钱、不联网、不弹通知（发送器与内容都注入假实现）。');
  rule();

  cleanup();

  // ---------- ① 硬防线（纯函数） ----------
  line('');
  line('① 硬防线：这几句永远不许出现');
  const banned = ['你还没做今天的题', '还差 3 题就完成了', '还差几题', '连续要断了', '进度 6/10'];
  for (const text of banned) line(`   「${text}」→ ${containsUrging(text) ? '拦住' : '放行'}`);

  check('拦住「你还没做」', containsUrging('你还没做今天的题') === true);
  check('拦住「还差 N 题」', containsUrging('还差 3 题就完成了') === true);
  check('拦住「还差几题」', containsUrging('还差几题') === true);
  check('拦住「连续要断了」', containsUrging('连续要断了') === true);
  check('拦住「进度 X/10」', containsUrging('进度 6/10') === true);
  check('正常钩子放行', containsUrging('今天有一道题：德加为什么把画面停在"未完成"') === false);

  const emptyCopy = decideCopy('');
  const urgingCopy = decideCopy('你还没做，还差几题');
  const okCopy = decideCopy('今天有一道题：德加为什么把画面停在"未完成"');
  check('空钩子不发（no_hook）', emptyCopy.ok === false && emptyCopy.reason === 'no_hook', emptyCopy.reason);
  check('只有空格的钩子也不发', decideCopy('   ').ok === false);
  check('被拦住的钩子不发（urging）', urgingCopy.ok === false && urgingCopy.reason === 'urging', urgingCopy.reason);
  check('合格钩子原样采用', okCopy.ok === true && okCopy.body === '今天有一道题：德加为什么把画面停在"未完成"', okCopy.body ?? '');

  // ---------- ② 时间窗（纯函数） ----------
  line('');
  line('② 时间窗：09:00–22:00 之内、且已到点（默认 21:00）才发');
  const timing = (nowHHMM) => evaluateTiming({ nowHHMM, at: '21:00', windowStart: '09:00', windowEnd: '22:00' });
  for (const t of ['08:00', '09:30', '21:00', '21:59', '22:00', '22:01', '23:30']) {
    line(`   ${t} → ${timing(t).ok ? '发' : '不发（' + timing(t).reason + '）'}`);
  }
  check('08:00 在窗口外，不发', timing('08:00').ok === false && timing('08:00').reason === 'before_window');
  check('09:30 还没到点，不发', timing('09:30').ok === false && timing('09:30').reason === 'before_time');
  check('21:00 到点，发', timing('21:00').ok === true);
  check('21:59 仍在窗口内，发', timing('21:59').ok === true);
  check('22:00 是窗口末，发', timing('22:00').ok === true);
  check('22:01 过了窗口，不发（不补发）', timing('22:01').ok === false && timing('22:01').reason === 'after_window');
  check('23:30 深夜不发', timing('23:30').ok === false);

  // ---------- ③ 全流程（注入内容 + 注入发送器） ----------
  line('');
  line('③ 全流程：虚拟日期 + 注入内容（不调 AI、不联网）');
  const hook = '今天有一道题：德加为什么把画面停在"未完成"';
  const builder = (value) => async () => ({ hook: value });

  // a) 到点发一条（把"此刻"钉在 21:00，不然会跟着真实钟点走）
  const atNight = (day) => new Date(`${day}T21:00:00+08:00`);
  const spyA = makeSpy();
  const a = await runDailyPush({ date: V[0], now: atNight(V[0]), build: builder(hook), send: spyA.fn });
  line(`   ${V[0]}　${a.sent ? '已发' : '未发'}（${a.reason}）｜push_log：${getPushLog(V[0])?.body ?? '—'}`);
  check('到点发出一条', a.sent === true && a.reason === 'sent', a.reason);
  check('通知内容就是钩子', spyA.calls.length === 1 && spyA.calls[0].message === hook, spyA.calls[0]?.message ?? '—');
  check('落一条 push_log', getPushLog(V[0])?.body === hook, getPushLog(V[0])?.body ?? '—');
  check('delivered 记为真', getPushLog(V[0])?.delivered === true);

  // b) 同一天再触发，不重复发
  const b = await runDailyPush({ date: V[0], now: atNight(V[0]), build: builder(hook), send: spyA.fn });
  line(`   ${V[0]} 再触发一次　${b.sent ? '已发' : '未发'}（${b.reason}）`);
  check('同一天不重复发第二条', b.sent === false && b.reason === 'already_sent', b.reason);
  check('第二次没有再调通知', spyA.calls.length === 1, String(spyA.calls.length));

  // c) 空钩子不发
  const spyC = makeSpy();
  const c = await runDailyPush({ date: V[1], now: atNight(V[1]), build: builder(''), send: spyC.fn });
  line(`   ${V[1]} 无钩子　${c.sent ? '已发' : '未发'}（${c.reason}）`);
  check('没钩子宁可不发', c.sent === false && c.reason === 'no_hook', c.reason);
  check('没钩子不弹通知', spyC.calls.length === 0);
  check('没钩子不留 push_log', getPushLog(V[1]) === null);

  // d) 钩子是催办话也不发
  const spyD = makeSpy();
  const d = await runDailyPush({ date: V[2], now: atNight(V[2]), build: builder('你还没做，进度 3/10'), send: spyD.fn });
  line(`   ${V[2]} 催办文案　${d.sent ? '已发' : '未发'}（${d.reason}）`);
  check('催办文案被硬防线拦住', d.sent === false && d.reason === 'urging', d.reason);
  check('催办文案不弹通知', spyD.calls.length === 0);
  check('催办文案不留 push_log', getPushLog(V[2]) === null);

  // e) 通知服务挂了：只记一笔、不重试
  const spyE = makeSpy({ fail: true });
  const e = await runDailyPush({ date: V[3], now: atNight(V[3]), build: builder(hook), send: spyE.fn });
  line(`   ${V[3]} 通知失败　${e.sent ? '已发' : '未发'}（${e.reason}）`);
  check('通知失败不算发出', e.sent === false && e.reason === 'notify_failed', e.reason);
  check('通知失败也记一笔（排查用）', getPushLog(V[3])?.delivered === false);
  check('失败的那天不再重试（同一天不重复）', (await runDailyPush({ date: V[3], now: atNight(V[3]), build: builder(hook), send: spyE.fn })).reason === 'already_sent');

  // f) 全流程里的时间窗：到点前不发（这条没注入 bypassWindow）
  const spyF = makeSpy();
  const f = await runDailyPush({ date: V[4], now: new Date(`${V[4]}T10:00:00+08:00`), build: builder(hook), send: spyF.fn });
  line(`   ${V[4]} 10:00 触发　${f.sent ? '已发' : '未发'}（${f.reason}）`);
  check('没到点不发（全流程）', f.sent === false && f.reason === 'before_time', f.reason);
  check('没到点不留 push_log', getPushLog(V[4]) === null);

  // g) 手动测试口子：跳过时间窗照样发
  const spyG = makeSpy();
  const g = await runDailyPush({ date: V[5], now: new Date(`${V[5]}T10:00:00+08:00`), bypassWindow: true, build: builder(hook), send: spyG.fn });
  line(`   ${V[5]} 手动触发（跳过时间窗）　${g.sent ? '已发' : '未发'}（${g.reason}）`);
  check('手动触发可跳过时间窗', g.sent === true && g.reason === 'sent', g.reason);

  // ---------- ④ 真实接口 ----------
  line('');
  line('④ 起真实服务，打 POST /api/push/test');
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };

  const at10 = await post({ at: '10:00' });     // 到点前 → 不发（不调 AI、不弹通知）
  const badTime = await post({ at: 'abc' });    // 非法格式 → 400
  const badRange = await post({ at: '25:99' }); // 越界 → 400
  server.close();

  line(`   {at:"10:00"} → HTTP ${at10.status}　ok=${at10.body?.ok}　reason=${at10.body?.reason}`);
  line(`   {at:"abc"}   → HTTP ${badTime.status}　${badTime.body?.error ?? ''}`);
  line(`   {at:"25:99"} → HTTP ${badRange.status}　${badRange.body?.error ?? ''}`);

  check('POST /api/push/test 返回 200', at10.status === 200, `HTTP ${at10.status}`);
  check('响应带 ok:true', at10.body?.ok === true, String(at10.body?.ok));
  check('到点前不真发', at10.body?.sent !== true, at10.body?.reason ?? '');
  check('非法 at 返回 400', badTime.status === 400, `HTTP ${badTime.status}`);
  check('越界 at 返回 400', badRange.status === 400, `HTTP ${badRange.status}`);

  // ---------- ⑤ 清理 ----------
  line('');
  line('⑤ 清理临时 push_log');
  cleanup();
  const left = V.reduce((n, day) => n + (getPushLog(day) ? 1 : 0), 0);
  check('临时推送记录已清理干净', left === 0, String(left));

  // ---------- 结果 ----------
  line('');
  line('自检');
  rule();
  for (const [name, ok, detail] of checks) line(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 46)}${detail}`);
  rule();
  const passed = checks.filter(([, ok]) => ok).length;
  line(`通过 ${passed} / ${checks.length}`);

  // ---------- 演示：真弹一条通知（不计入通过数，失败也不影响验收） ----------
  line('');
  line('演示：下面真弹一条通知，点它应打开今日页');
  line(`   ${todayPageUrl()}`);
  try {
    await sendNotification({
      title: `${config.push.title}（测试通知）`,
      message: '这是一条测试通知，点它应打开今日页',
      url: todayPageUrl()
    });
    line('   已发出。没看到请看系统「专注助手 / 通知设置」。');
  } catch (err) {
    line(`   没能弹出（${err?.message ?? err}）。这不影响上面的自检结果。`);
  }
  line('');
  line('推送四道关：今天没发过 → 在时间窗内且到点 → 当天内容已就绪 → 钩子不含催办话。');
  rule();

  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    line('');
    line(`验收脚本出错：${err?.message ?? err}`);
    line('（临时数据可能没清干净，重跑一次即可）');
    process.exitCode = 1;
  });