import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// app/api/src → app/api → app → 项目根
export const ROOT_DIR = path.resolve(here, '..', '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const SCHEMA_FILE = path.join(here, 'db', 'schema.sql');

// 密钥只存项目根目录 .env，不进版本库
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// 第一版不建 settings 表，参数写在这里（specs/02-数据模型.md「settings 默认值」）
export const config = {
  port: Number(process.env.PORT) || 5178,
  zhipuApiKey: process.env.ZHIPU_API_KEY || '',

  dailyQuestionCount: 10,
  typeLimits: { essay: 1, term: 2, image: 2 },

  timezone: 'Asia/Shanghai',

  ai: {
    model: 'glm-5.3-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  },

  push: {
    enabled: true,
    // 通知标题（正式版文案；老叶 2026-10-08：全新的提醒叫"日拱一卒"）
    title: '日拱一卒',
    at: '21:00',
    windowStart: '09:00',
    windowEnd: '22:00',
    // 点通知要打开的地址（今日页）。前端已走独立路由（/today），改这一处即可
    url: `http://localhost:${Number(process.env.PORT) || 5178}/today`
  }
};