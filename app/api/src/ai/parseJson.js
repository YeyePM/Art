// 解析 AI 返回的 JSON（specs/03-AI调用.md 第二节第 2 条）
// 模型即使被要求"不要用 markdown 包裹"，偶尔仍会包一层 ```json 或前面带一句客套话，这里统一剥掉。
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('AI 返回了空内容');

  let body = raw;

  // 1) 剥掉 ```json ... ``` / ``` ... ``` 包裹
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();

  try {
    return JSON.parse(body);
  } catch {
    // 2) 兜底：截取第一个 { 到最后一个 } 之间的内容
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        /* 落到下面的报错 */
      }
    }
    throw new Error(`AI 返回的不是合法 JSON：${raw.slice(0, 160)}`);
  }
}