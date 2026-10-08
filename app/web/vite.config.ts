import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端地址（本机小服务，固定 5178）
const API_TARGET = 'http://localhost:5178';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 双击启动脚本后直接落在今日页（T8 做出主界面再改回 '/'）
    open: '/today',
    // 把 /api 转给后端 → 前后端同源，图片（/api/images/...）直接能显示，不用处理 CORS
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true }
    }
  }
});