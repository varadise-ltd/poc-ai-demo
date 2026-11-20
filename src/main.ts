import { createApp } from 'vue'
import App from './App.vue'
import { auth, initAuth } from './auth'
import { ensureTenantContextSynced, getOrgAccessError, initOrgAccess, noOrgAvailable, setActiveProjectId } from './api'
import { syncOrgAccessToStore } from './store'
import './style.css'

// 先完成 SSO 回调 / 会话恢复，再挂载应用：未登录时 App 只渲染登录页，
// 各页面 onMounted 里的 API 请求不会在登录前发出。
// 挂载前先把 Cosmos iframe 传入的 orgId/projectId（api.ts 入口已校验）
// 落库到后端（/api/orgs/sync-context：organizations/projects 行 + 权威名称），
// 保证后续所有页面的 API 请求都基于已持久化的同一租户键。失败不阻断挂载
// （TopBar onMounted 会重试；后端中间件也会 ensure_org/ensure_project 兜底）。
// 方案 v1.3 §4：先向后端取本会话的可用组织集合（Cosmos 锚点 + 被授权时的
// Varadise）并把活动组织校正到集合内；没有任何可用组织时不再发租户落库请求，
// App 渲染「未开通」提示。
void initAuth()
  .then(async () => {
    // SSO 已启用但尚未登录：只渲染登录页，不发任何业务 API（方案 v1.3 §5.8）。
    if (auth.enabled && !auth.authenticated) return
    await initOrgAccess()
    syncOrgAccessToStore()
    if (noOrgAvailable() || getOrgAccessError()) return
    return ensureTenantContextSynced().catch((err) => {
      // profile-service 明确拒绝该项目（不存在 / 不属于该组织）：回退默认项目，
      // 不再带着无效 projectId 请求（后端同样会把未登记项目回退为默认范围）。
      const msg = String((err as Error)?.message || '')
      if (/not found in profile-service|does not belong to the organization/i.test(msg)) {
        console.warn('[cosmos-chain] projectId rejected by backend, falling back to default project', msg)
        setActiveProjectId('')
        syncOrgAccessToStore()
        return
      }
      console.warn('[cosmos-chain] startup tenant sync failed (TopBar will retry)', err)
    })
  })
  .finally(() => {
    createApp(App).mount('#app')
  })
