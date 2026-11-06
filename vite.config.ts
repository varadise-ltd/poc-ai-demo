import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 本地开发：把 cloud 模式的同源 /api 反向代理到本机后端，
    // 与 Docker/nginx 的行为一致；local 模式则由 VITE_LOCAL_API_BASE 直连。
    // 否则（无代理）Vite 会把 /api/* 当 SPA 回传 index.html，前端只能停在 seed 数据。
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
