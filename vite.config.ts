import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 本地开发：把同源 /api 反向代理到后端，与 Docker/nginx 的行为一致。
    // 前端 .env 的 VITE_API_BASE 默认为空 → 走相对路径 /api，由这里转发；
    // 否则（无代理）Vite 会把 /api/* 当 SPA 回传 index.html，前端只能停在 seed 数据。
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
