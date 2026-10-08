// 唯一碰智谱 HTTP 接口的地方。换服务商只改这个文件。
// 依据：specs/03-AI调用.md 第一 / 二 / 三节
import { config } from '../config.js';

// 这些状态码值得重试；其余 4xx 是请求本身有问题，重试没意义
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调一次对话补全，返回纯文本内容。
 *
 * 关于"省钱"（specs/03 第二节）：glm-5.3-flash **关不掉思考**——
 * 实测 thinking.type 只认 enabled，给 disabled / minimal 都会被 1210 拒掉。
 * 能做的是把思考压到最低档：reasoning_effort: 'low'。
 * 实测同一提示词：默认档输出 29842 tokens（思考 25774）/ 266 秒；
 * low 档输出 2785 tokens（思考 24）/ 71 秒 —— 成本约 1/10。
 *
 * 同时约束 JSON 输出：若该模型不吃 response_format，自动去掉参数重试一次，解析端再剥 ```json 包裹。
 *
 * @param {{system:string, user:string, maxAttempts?:number, timeoutMs?:number}} params
 * @returns {Promise<{content:string, usage:object|null, jsonMode:boolean}>}
 */
export async function chatCompletion({
  system,
  user,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const apiKey = config.zhipuApiKey;
  if (!apiKey) {
    throw new Error('没有配置 ZHIPU_API_KEY —— 应在项目根目录 .env 里（.gitignore 已挡住它）');
  }

  let jsonMode = true;
  let lastErr = null;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    const body = {
      model: config.ai.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: false,
      temperature: 0.8,
      // 关不掉思考，只能压到最低档（见上方说明）
      reasoning_effort: 'low',
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let outcome = null; // { retry:true, err } | { fatal:true, err } | { return:result }

    try {
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();

      if (res.ok) {
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content ?? '';
        if (content.trim()) {
          outcome = { return: { content, usage: data.usage ?? null, jsonMode } };
        } else {
          outcome = { retry: true, err: new Error('智谱返回了空内容') };
        }
      } else if (res.status === 400 && /1301|不安全或敏感内容/.test(text)) {
        // 内容审核偶发拦截（同一提示词时中时不中）：换一次重试通常就过，不当作硬错误
        outcome = { retry: true, err: new Error(`智谱内容审核拦截：${text.slice(0, 140)}`) };
      } else if (res.status === 400 && jsonMode && /response_format|json_object/i.test(text)) {
        // 该模型不支持强制 JSON：去掉参数再试，这次不计入重试次数
        jsonMode = false;
        attempt -= 1;
        outcome = { retry: true, err: null };
      } else {
        const err = new Error(`智谱返回 ${res.status}：${text.slice(0, 200)}`);
        outcome = RETRY_STATUS.has(res.status) ? { retry: true, err } : { fatal: true, err };
      }
    } catch (err) {
      const wrapped = err?.name === 'AbortError' ? new Error(`调用智谱超时（${timeoutMs / 1000} 秒）`) : err;
      outcome = { retry: true, err: wrapped };
    } finally {
      clearTimeout(timer);
    }

    if (outcome.return) return outcome.return;
    if (outcome.fatal) throw outcome.err;
    if (outcome.err) lastErr = outcome.err;
    if (attempt < maxAttempts) await sleep(800 * attempt);
  }

  throw lastErr ?? new Error('调用智谱失败');
}