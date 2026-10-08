import raw from '../../mock/today.json';
import { getJson } from './client';
import type { TodayResponse } from './types';

/** 离线开发（不启后端）时把 VITE_USE_MOCK=1 打开；默认走真实接口 */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1';

/** GET /api/today —— 当天第一次打开要凑齐 10 题，可能要几十秒 */
export const loadToday = (): Promise<TodayResponse> =>
  USE_MOCK ? Promise.resolve(raw as unknown as TodayResponse) : getJson<TodayResponse>('/api/today');