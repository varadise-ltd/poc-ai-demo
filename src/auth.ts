// Cosmos SSO：浏览器端只调用同源 /auth/*（由后端 poc-ai-service 统一提供，无独立 BFF 进程）。
//
// - 登录、换 token、密码直登、续期、登出全部由 poc-ai-service 的 /auth/* 完成；token 保存在
//   后端会话内存里，浏览器只持有 HttpOnly 会话 cookie，JS 永远拿不到 token。
// - /api 请求（含 <img> 视频流与快照）携带同源会话 cookie，写请求附带 CSRF 头 X-POC-CSRF。
// - 后端未启用 SSO（AUTH_MODE=off 或未配 COSMOS_SSO_CLIENT_SECRET → /auth/me 404）时视为无登录模式。
//
// 两种入口（§3.2 / §5.3）：
//   standalone：未登录 → 自动整页跳转 /auth/login → Cosmos（Keycloak）登录页（2 分钟内最多 2 次，
//               防止回调失败时无限跳转；超过后停在登录页）；
//   iframe    ：先 prompt=none 静默登录（iframe 内 302 链）；需要交互时显示按钮，
//               点击后 popup 登录，完成后 popup postMessage 通知本页。不跳转顶层窗口
//               （跨源 iframe 在没有用户手势时导航顶层会被浏览器拦截）。

import { reactive } from 'vue'

export interface AuthUser {
  sub: string
  username: string
  name: string
  email: string
  roles: string[]
}

export const auth = reactive({
  /** false = BFF 未启用（不需要登录）。 */
  enabled: false,
  ready: false,
  authenticated: false,
  busy: false,
  inIframe: false,
  /** 后端是否允许账号密码直登（COSMOS_SSO_PASSWORD_LOGIN，默认关闭）。 */
  passwordLogin: false,
  /** 后端要求登录（/api 返回 401），但本前端无法访问 /auth/*（部署未反代 /auth/）。 */
  misconfigured: false,
  user: null as AuthUser | null,
  /** 'denied' = 账号有效但无 Cosmos 角色；'error' = 流程失败；'expired' = 会话过期。 */
  status: 'signed-out' as 'signed-out' | 'denied' | 'error' | 'expired',
  message: '',
})

const SILENT_KEY = 'cosmos.auth.silentAttempts'
const SILENT_WINDOW_MS = 2 * 60 * 1000
const SILENT_MAX = 2

function inIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top
  } catch {
    return true // 跨源访问 window.top 抛错 = 在 iframe 里
  }
}

function currentPath(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete('sso_error')
  return `${url.pathname}${url.search}${url.hash}`
}

/** 2 分钟内的静默登录尝试次数（防止无限重定向，§5.3-g）。 */
function silentAttempts(): number[] {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(SILENT_KEY) || '[]') as number[]
    const now = Date.now()
    return raw.filter((t) => now - t < SILENT_WINDOW_MS)
  } catch {
    return []
  }
}

function recordSilentAttempt(): void {
  try {
    window.sessionStorage.setItem(SILENT_KEY, JSON.stringify([...silentAttempts(), Date.now()]))
  } catch {
    /* storage unavailable */
  }
}

function errorMessage(code: string): { status: typeof auth.status; message: string } {
  if (code === 'access_denied') {
    return { status: 'denied', message: 'Access denied: a valid Cosmos account (cosmos-member or cosmos-admin) is required.' }
  }
  if (code === 'login_required') return { status: 'signed-out', message: '' }
  return { status: 'error', message: 'Cosmos sign-in failed. Please try again.' }
}

async function fetchMe(): Promise<'ok' | 'unauthenticated' | 'disabled'> {
  let res: Response
  try {
    res = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    return 'disabled'
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { password_login?: boolean }
    auth.passwordLogin = body.password_login === true
    return 'unauthenticated'
  }
  const type = res.headers.get('content-type') || ''
  if (!res.ok || !type.includes('application/json')) return 'disabled' // 404 / SPA fallback = 未部署 BFF
  const body = (await res.json()) as { sub?: string; name?: string; email?: string; roles?: string[] }
  auth.user = {
    sub: String(body.sub || ''),
    username: String(body.name || ''),
    name: String(body.name || ''),
    email: String(body.email || ''),
    roles: Array.isArray(body.roles) ? body.roles.map(String) : [],
  }
  return 'ok'
}

/**
 * 挂载前调用：确认会话状态，必要时触发登录。
 * - BFF 未启用 → auth.enabled=false、authenticated=true（不需要登录）；
 * - 已登录 → authenticated=true；
 * - 未登录 → standalone 整页跳转登录；iframe 先静默登录，再不行显示「Sign in」按钮。
 */
export async function initAuth(): Promise<void> {
  auth.inIframe = inIframe()
  try {
    const state = await fetchMe()
    if (state === 'disabled') {
      auth.enabled = false
      auth.authenticated = true
      return
    }
    auth.enabled = true
    if (state === 'ok') {
      auth.authenticated = true
      auth.status = 'signed-out'
      auth.message = ''
      try { window.sessionStorage.removeItem(SILENT_KEY) } catch { /* ignore */ }
      return
    }
    auth.authenticated = false
    const ssoError = new URLSearchParams(window.location.search).get('sso_error')
    if (ssoError) {
      const e = errorMessage(ssoError)
      auth.status = e.status
      auth.message = e.message
      window.history.replaceState(null, '', currentPath())
      return // 显示登录页（iframe 的静默登录已失败 / 登录被拒）
    }
    startLogin(false)
  } finally {
    auth.ready = true
  }
}

/**
 * 发起登录。
 * - standalone + 非用户触发：自动整页跳转 Cosmos 登录页（2 分钟内最多 2 次；之后停在 LoginView，
 *   避免回调失败 / redirect_uri 未登记时无限跳转）；
 * - standalone + 用户点击：整页跳转 /auth/login → Keycloak 标准登录页；
 * - iframe + 非用户触发：先尝试 prompt=none 静默登录（2 分钟内最多 2 次）；
 * - iframe + 用户点击：打开 popup 登录（有用户手势，不会被拦截）。
 */
export function startLogin(userInitiated: boolean): void {
  const returnTo = encodeURIComponent(currentPath())
  if (!auth.inIframe) {
    if (!userInitiated) {
      if (silentAttempts().length >= SILENT_MAX) return // 停在登录页，由用户点击
      recordSilentAttempt()
    }
    auth.busy = true
    window.location.assign(`/auth/login?return_to=${returnTo}`)
    return
  }
  if (!userInitiated) {
    if (silentAttempts().length >= SILENT_MAX) return // 显示按钮
    recordSilentAttempt()
    auth.busy = true
    window.location.assign(`/auth/login?prompt=none&return_to=${returnTo}`)
    return
  }
  openPopupLogin()
}

function openPopupLogin(): void {
  const popup = window.open('/auth/login?mode=popup&return_to=%2F', 'cosmos-sso', 'width=520,height=680')
  if (!popup) {
    auth.status = 'error'
    auth.message = 'Pop-up blocked. Please allow pop-ups for this site, or open POC in a new tab.'
    return
  }
  auth.busy = true
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return
    const data = event.data as { type?: string; ok?: boolean; error?: string } | null
    if (!data || data.type !== 'poc-auth-done') return
    window.removeEventListener('message', onMessage)
    auth.busy = false
    if (data.ok) {
      try { window.sessionStorage.removeItem(SILENT_KEY) } catch { /* ignore */ }
      window.location.reload() // 带上新会话重新初始化（租户 / 组织集合）
    } else {
      const e = errorMessage(data.error || 'login_failed')
      auth.status = e.status
      auth.message = e.message
    }
  }
  window.addEventListener('message', onMessage)
}

/** LoginView 按钮：用户触发的登录。 */
export function login(): void {
  startLogin(true)
}

/**
 * username/password 登录（Keycloak Direct Grant）。
 * 前端页面直接提交账号密码给 BFF，BFF 换 token 后建会话。成功返回 true。
 */
export async function loginWithPassword(username: string, password: string): Promise<boolean> {
  auth.busy = true
  try {
    const res = await fetch('/auth/login-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-POC-CSRF': '1' },
      body: JSON.stringify({ username, password }),
    })
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    if (res.ok) {
      auth.authenticated = true
      auth.status = 'signed-out'
      auth.message = ''
      try { window.sessionStorage.removeItem(SILENT_KEY) } catch { /* ignore */ }
      return true
    }
    const code = body.detail || 'login_failed'
    if (code === 'invalid_credentials') {
      auth.status = 'error'
      auth.message = 'Invalid username or password.'
    } else if (code === 'access_denied') {
      auth.status = 'denied'
      auth.message = 'Access denied: a valid Cosmos account (cosmos-member or cosmos-admin) is required.'
    } else {
      auth.status = 'error'
      auth.message = 'Cosmos sign-in failed. Please try again.'
    }
    return false
  } catch {
    auth.status = 'error'
    auth.message = 'Sign-in failed. Please try again.'
    return false
  } finally {
    auth.busy = false
  }
}

/**
 * 登出。standalone：清 BFF 会话并结束 Keycloak 会话（回到首页会再次引导登录）；
 * iframe：只清本地会话，不结束 Keycloak 会话（避免把母站 Cosmos 一起登出，§5.6）。
 */
export async function logout(): Promise<void> {
  auth.busy = true
  try {
    const local = auth.inIframe ? '?local=1' : ''
    const res = await fetch(`/auth/logout${local}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-POC-CSRF': '1' },
    })
    const body = res.ok ? ((await res.json()) as { redirect?: string | null }) : { redirect: null }
    auth.authenticated = false
    auth.user = null
    if (body.redirect) {
      window.location.assign(body.redirect)
      return
    }
    window.location.reload()
  } finally {
    auth.busy = false
  }
}

/** api.ts 收到 401（会话过期 / 被吊销）时调用：重新走登录流程。 */
let handlingUnauthorized = false
export function handleUnauthorized(): void {
  // 前端认为 SSO 未启用（/auth/me 不可达），后端却要求登录：部署没有反代 /auth/*。
  if (!auth.enabled) {
    if (!auth.misconfigured) {
      console.error('[auth] backend requires sign-in but /auth/* is not reachable from this frontend')
      auth.misconfigured = true
    }
    return
  }
  // 已在登录页（尚未登录）/ 已在处理中：不再重复触发登录。
  if (!auth.authenticated || handlingUnauthorized) return
  handlingUnauthorized = true
  auth.authenticated = false
  auth.user = null
  auth.status = 'expired'
  auth.message = 'Your Cosmos session has expired. Please sign in again.'
  startLogin(false)
}

/** 测试用：重置状态。 */
export function _resetAuthForTest(): void {
  auth.enabled = false
  auth.ready = false
  auth.authenticated = false
  auth.busy = false
  auth.inIframe = false
  auth.passwordLogin = false
  auth.misconfigured = false
  auth.user = null
  auth.status = 'signed-out'
  auth.message = ''
  handlingUnauthorized = false
}
