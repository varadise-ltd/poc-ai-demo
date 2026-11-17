import { createApp } from 'vue'
import App from './App.vue'
import { initAuth } from './auth'
import { ensureTenantContextSynced } from './api'
import './style.css'

// 先完成 SSO 回调 / 会话恢复，再挂载应用：未登录时 App 只渲染登录页，
// 各页面 onMounted 里的 API 请求不会在登录前发出。
// 挂载前先把 Cosmos iframe 传入的 orgId/projectId（api.ts 入口已校验）
// 落库到后端（/api/orgs/sync-context：organizations/projects 行 + 权威名称），
// 保证后续所有页面的 API 请求都基于已持久化的同一租户键。失败不阻断挂载
// （TopBar onMounted 会重试；后端中间件也会 ensure_org/ensure_project 兜底）。
void initAuth()
  .then(() => ensureTenantContextSynced().catch((err) => {
    console.warn('[cosmos-chain] startup tenant sync failed (TopBar will retry)', err)
  }))
  .finally(() => {
    createApp(App).mount('#app')
  })
