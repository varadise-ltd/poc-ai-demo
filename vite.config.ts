import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 本地开发：把同源 /api 与 /auth 统一反向代理到本机后端 poc-ai-service（8000），
    // 与线上 nginx 反代完全一致，仅需启动前后端 2 个进程（5173 + 8000）。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
      // /v1/me：Cosmos 统一方案的接口名（后端 /auth/me 的别名）
      '/v1': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
    },
  },
})
