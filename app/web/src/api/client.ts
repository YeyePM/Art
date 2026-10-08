/**
 * 接口调用封装：所有后端请求都从这里走。
 * 后端出错时统一抛 Error（带 status），message 用后端给的中文说明，可直接显示。
 */
export type ApiError = Error & { status: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);

  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // 响应不是 JSON，用默认提示
    }
    throw Object.assign(new Error(message), { status: res.status }) as ApiError;
  }

  return (await res.json()) as T;
}

export const getJson = <T>(path: string): Promise<T> => request<T>(path);

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });