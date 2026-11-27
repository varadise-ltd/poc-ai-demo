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
//
// AUTH_FLOW=cmp-webapp（Cosmos 统一 client，方案 deploy/Cosmos-SSO-cmp-webapp-Migration-Plan.md）：
//   standalone：keycloak-js（PKCE S256）check-sso → 需要时整页跳 Keycloak（固定回跳 /，原路径存
//               sessionStorage，回跳后还原）；
//   iframe    ：向 Cosmos 母站 postMessage 请求 token（cosmosBridge.ts），5 秒无回应时回退上面的
//               legacy 流程（后端可用时）；
//   两种入口拿到 token 后都立即 POST /auth/session 换同源 HttpOnly 会话 —— /api 与 <img> 视频流
//   仍只靠 cookie，token 不长留 JS。会话没有 refresh token，到期前 90 秒用新 token 重新换。

import { reactive } from 'vue'
import type Keycloak from 'keycloak-js'
import { runtimeConfig, type AuthFlow, type RuntimeConfig } from './config'
import * as bridge from './cosmosBridge'

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
  /** 运行期登录方式（/config.js 的 AUTH_FLOW）。 */
  flow: 'legacy' as AuthFlow,
  /** 后端 /auth/login 是否可用（配了 poc-ai-demo secret）。 */
  codeLogin: true,
  /** 后端 POST /auth/session 是否可用（COSMOS_SSO_EXCHANGE_AZP）。 */
  tokenExchange: false,
  user: null as AuthUser | null,
  /** 'denied' = 账号有效但无 Cosmos 角色；'error' = 流程失败；'expired' = 会话过期。 */
  status: 'signed-out' as 'signed-out' | 'denied' | 'error' | 'expired',
  message: '',
})

const SILENT_KEY = 'cosmos.auth.silentAttempts'
const SILENT_WINDOW_MS = 2 * 60 * 1000
const SILENT_MAX = 2
const RETURN_KEY = 'cosmos.auth.returnTo'
/** iframe：等待母站下发 token 的时长，超时回退 legacy 流程。 */
const PARENT_TOKEN_TIMEOUT_MS = 5000
/** 会话（= access token）到期前多久用新 token 重新换会话；需大于后端 COSMOS_SSO_REFRESH_SKEW_SECONDS（60）。 */
const REFRESH_LEAD_SECONDS = 90

let cfg: RuntimeConfig = runtimeConfig

function bffUrl(path: string): string {
  return `${cfg.bffBaseUrl}${path}`
}

function credentialsMode(): RequestCredentials {
  return cfg.bffBaseUrl ? 'include' : 'same-origin'
}

/** 当前是否走 cmp-webapp token 换会话（配置要求 + 后端已开启）。 */
function cmpActive(): boolean {
  return auth.flow === 'cmp-webapp' && auth.tokenExchange
}

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
    return { status: 'denied', message: 'Access denied: a valid Cosmos account (Cosmos User or cosmos-admin) is required.' }
  }
  if (code === 'login_required') return { status: 'signed-out', message: '' }
  return { status: 'error', message: 'Cosmos sign-in failed. Please try again.' }
}

let sessionExpiresAt = 0

async function fetchMe(): Promise<'ok' | 'unauthenticated' | 'disabled'> {
  let res: Response
  try {
    res = await fetch(bffUrl('/auth/me'), { credentials: credentialsMode(), cache: 'no-store' })
  } catch (e) {
    console.warn('[auth] GET /auth/me failed (BFF unreachable / not reverse-proxied)', e)
    return 'disabled'
  }
  console.info('[auth] GET /auth/me -> status=%d content-type=%s', res.status, res.headers.get('content-type') || '')
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as {
      password_login?: boolean
      code_login?: boolean
      token_exchange?: boolean
    }
    auth.passwordLogin = body.password_login === true
    auth.codeLogin = body.code_login !== false // 旧后端没有该字段 = 只有 /auth/login
    auth.tokenExchange = body.token_exchange === true
    console.info('[auth] /auth/me -> 401 unauthenticated (password_login=%s)', auth.passwordLogin)
    return 'unauthenticated'
  }
  const type = res.headers.get('content-type') || ''
  if (!res.ok || !type.includes('application/json')) {
    console.warn('[auth] /auth/me -> disabled (404 or non-JSON: SSO/BFF not deployed)', { status: res.status, type })
    return 'disabled' // 404 / SPA fallback = 未部署 BFF
  }
  const body = (await res.json()) as {
    sub?: string
    name?: string
    email?: string
    roles?: string[]
    expires_at?: number
    token_exchange?: boolean
  }
  sessionExpiresAt = Number(body.expires_at) || 0
  if (typeof body.token_exchange === 'boolean') auth.tokenExchange = body.token_exchange
  setUser(body)
  console.info('[auth] /auth/me -> ok sub=%s', String(body.sub || ''))
  return 'ok'
}

function setUser(body: { sub?: string; name?: string; email?: string; roles?: string[] }): void {
  auth.user = {
    sub: String(body.sub || ''),
    username: String(body.name || ''),
    name: String(body.name || ''),
    email: String(body.email || ''),
    roles: Array.isArray(body.roles) ? body.roles.map(String) : [],
  }
}

/**
 * 挂载前调用：确认会话状态，必要时触发登录。
 * - BFF 未启用 → auth.enabled=false、authenticated=true（不需要登录）；
 * - 已登录 → authenticated=true；
 * - 未登录 → standalone 整页跳转登录；iframe 先静默登录，再不行显示「Sign in」按钮。
 */
export async function initAuth(): Promise<void> {
  auth.inIframe = inIframe()
  auth.flow = cfg.authFlow
  console.info('[auth] initAuth start inIframe=%s flow=%s href=%s', auth.inIframe, auth.flow, window.location.href)
  if (auth.flow === 'cmp-webapp' && auth.inIframe) {
    bridge.installBridge(cfg.cosmosOrigins)
    // 母站刷新 token 后主动推送：已登录时静默换新会话（登录过程中的 token 由 waitForParentToken 处理）。
    bridge.onParentToken((token) => {
      if (auth.authenticated && cmpActive()) void exchangeSession(token)
    })
  }
  try {
    const state = await fetchMe()
    if (state === 'disabled') {
      auth.enabled = false
      auth.authenticated = true
      console.info('[auth] initAuth -> SSO disabled, running without login')
      return
    }
    auth.enabled = true
    if (state === 'ok') {
      auth.authenticated = true
      auth.status = 'signed-out'
      auth.message = ''
      try { window.sessionStorage.removeItem(SILENT_KEY) } catch { /* ignore */ }
      console.info('[auth] initAuth -> already authenticated')
      if (cmpActive()) scheduleRefresh(sessionExpiresAt)
      return
    }
    auth.authenticated = false
    if (auth.flow === 'cmp-webapp' && !auth.tokenExchange) {
      console.warn('[auth] AUTH_FLOW=cmp-webapp but backend /auth/session is disabled (COSMOS_SSO_EXCHANGE_AZP): using legacy sign-in')
    }
    if (cmpActive()) {
      auth.passwordLogin = false // cmp-webapp 是 public client，不走 Direct Grant
      await startCmpLogin(false)
      return
    }
    const ssoError = new URLSearchParams(window.location.search).get('sso_error')
    if (ssoError) {
      const e = errorMessage(ssoError)
      auth.status = e.status
      auth.message = e.message
      window.history.replaceState(null, '', currentPath())
      console.warn('[auth] initAuth -> sso_error in URL: %s', ssoError)
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
  if (cmpActive()) {
    void startCmpLogin(userInitiated)
    return
  }
  startLegacyLogin(userInitiated)
}

function startLegacyLogin(userInitiated: boolean): void {
  if (!auth.codeLogin) {
    console.warn('[auth] backend /auth/login is disabled (no COSMOS_SSO_CLIENT_SECRET): staying on login view')
    return
  }
  const returnTo = encodeURIComponent(currentPath())
  if (!auth.inIframe) {
    if (!userInitiated) {
      if (silentAttempts().length >= SILENT_MAX) {
        console.warn('[auth] startLogin standalone: silent retry limit reached, staying on login view')
        return // 停在登录页，由用户点击
      }
      recordSilentAttempt()
    }
    auth.busy = true
    console.info('[auth] startLogin standalone -> redirect /auth/login?return_to=%s', returnTo)
    window.location.assign(`/auth/login?return_to=${returnTo}`)
    return
  }
  if (!userInitiated) {
    if (silentAttempts().length >= SILENT_MAX) {
      console.warn('[auth] startLogin iframe: silent retry limit reached, showing Sign-in button')
      return // 显示按钮
    }
    recordSilentAttempt()
    auth.busy = true
    console.info('[auth] startLogin iframe -> silent prompt=none /auth/login')
    window.location.assign(`/auth/login?prompt=none&return_to=${returnTo}`)
    return
  }
  console.info('[auth] startLogin iframe -> popup login')
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
    if (event.origin !== window.location.origin) {
      console.warn('[auth] ignored cross-origin postMessage', { origin: event.origin, expected: window.location.origin })
      return
    }
    const data = event.data as { type?: string; ok?: boolean; error?: string } | null
    if (!data || data.type !== 'poc-auth-done') return
    console.info('[auth] popup sign-in result received', { ok: !!data.ok, error: data.error || '' })
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
      auth.message = 'Access denied: a valid Cosmos account (Cosmos User or cosmos-admin) is required.'
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
    if (cmpActive()) {
      await logoutCmp()
      return
    }
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
  if (cmpActive()) {
    // 换来的会话随 token 到期：先静默拿新 token 重换，不打断页面（视频流等会自行重连）。
    void refreshCmpSession().then((ok) => {
      handlingUnauthorized = false
      if (ok) return
      auth.authenticated = false
      auth.user = null
      auth.status = 'expired'
      auth.message = 'Your Cosmos session has expired. Please sign in again.'
      void startCmpLogin(false)
    })
    return
  }
  auth.authenticated = false
  auth.user = null
  auth.status = 'expired'
  auth.message = 'Your Cosmos session has expired. Please sign in again.'
  startLogin(false)
}

// ---------------------------------------------------------------------------
// AUTH_FLOW=cmp-webapp：前端取 token（keycloak-js / 母站）→ POST /auth/session 换同源会话
// ---------------------------------------------------------------------------

let kc: Keycloak | null = null
let kcInit: Promise<boolean> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | undefined

/** 懒加载 keycloak-js 并 check-sso（只初始化一次；legacy 模式完全不加载该库）。 */
async function keycloak(): Promise<{ kc: Keycloak; authenticated: boolean }> {
  if (!cfg.authBaseUrl || !cfg.authRealm) throw new Error('AUTH_BASE_URL / AUTH_REALM is not configured')
  if (!kcInit) {
    kcInit = (async () => {
      const { default: KeycloakCtor } = await import('keycloak-js')
      kc = new KeycloakCtor({ url: cfg.authBaseUrl, realm: cfg.authRealm, clientId: cfg.authClientId })
      return kc.init({
        onLoad: 'check-sso',
        pkceMethod: 'S256',
        checkLoginIframe: false,
        silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
      })
    })()
    kcInit.catch(() => { kcInit = null }) // 失败（Keycloak 不可达）允许下次重试
  }
  const authenticated = await kcInit
  return { kc: kc as Keycloak, authenticated }
}

type ExchangeResult = 'ok' | 'denied' | 'error'

/** 用 access token 换同源 HttpOnly 会话（token 只出现在这一个请求头里）。 */
async function exchangeSession(token: string): Promise<ExchangeResult> {
  let res: Response
  try {
    res = await fetch(bffUrl('/auth/session'), {
      method: 'POST',
      credentials: credentialsMode(),
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'X-POC-CSRF': '1' },
    })
  } catch (e) {
    console.warn('[auth] POST /auth/session failed', e)
    return 'error'
  }
  const body = (await res.json().catch(() => ({}))) as {
    detail?: string
    sub?: string
    name?: string
    email?: string
    roles?: string[]
    expires_at?: number
  }
  if (res.ok) {
    setUser(body)
    sessionExpiresAt = Number(body.expires_at) || 0
    scheduleRefresh(sessionExpiresAt)
    console.info('[auth] /auth/session -> ok sub=%s expires_at=%s', String(body.sub || ''), sessionExpiresAt)
    return 'ok'
  }
  // invalid_audience / invalid_azp = Keycloak 或后端配置问题（见方案 §5.1），便于控制台直接定位。
  console.warn('[auth] /auth/session -> %d %s', res.status, body.detail || '')
  return res.status === 403 ? 'denied' : 'error'
}

function scheduleRefresh(expiresAt: number): void {
  clearTimeout(refreshTimer)
  if (!expiresAt) return
  const delay = Math.max(5_000, expiresAt * 1000 - Date.now() - REFRESH_LEAD_SECONDS * 1000)
  refreshTimer = setTimeout(() => {
    void refreshCmpSession().then((ok) => {
      if (!ok) console.warn('[auth] session refresh failed; the next 401 will ask to sign in again')
    })
  }, delay)
}

/** 静默取 token（不跳转、不弹窗）：standalone 用 keycloak-js 续期，iframe 向母站请求。 */
async function obtainTokenSilently(): Promise<string | null> {
  if (auth.inIframe) return bridge.waitForParentToken(PARENT_TOKEN_TIMEOUT_MS, 'poc:token-request')
  try {
    const state = await keycloak()
    if (!state.authenticated) return null
    await state.kc.updateToken(REFRESH_LEAD_SECONDS + 30)
    return state.kc.token || null
  } catch (e) {
    console.warn('[auth] keycloak-js silent token failed', e)
    return null
  }
}

async function refreshCmpSession(): Promise<boolean> {
  const token = await obtainTokenSilently()
  if (!token) return false
  return (await exchangeSession(token)) === 'ok'
}

function applyExchangeResult(result: ExchangeResult): void {
  if (result === 'ok') {
    auth.authenticated = true
    auth.status = 'signed-out'
    auth.message = ''
    try { window.sessionStorage.removeItem(SILENT_KEY) } catch { /* ignore */ }
    restoreReturnTo()
    return
  }
  auth.authenticated = false
  const e = errorMessage(result === 'denied' ? 'access_denied' : 'login_failed')
  auth.status = e.status
  auth.message = e.message
}

/** 登录回跳固定到 /（Keycloak 只登记精确 redirect URI），原路径 + orgId 存起来。 */
function saveReturnTo(): void {
  try { window.sessionStorage.setItem(RETURN_KEY, currentPath()) } catch { /* ignore */ }
}

/**
 * 回到登录前的页面。api.ts 在模块加载时就读取了 URL 的 orgId/projectId，
 * 所以带租户参数时用 location.replace 重新加载（会话 cookie 已就绪，不会再次登录）。
 */
function restoreReturnTo(): void {
  let target = ''
  try {
    target = window.sessionStorage.getItem(RETURN_KEY) || ''
    window.sessionStorage.removeItem(RETURN_KEY)
  } catch { /* ignore */ }
  if (!target || !target.startsWith('/') || target.startsWith('//') || target === currentPath()) return
  console.info('[auth] restoring pre-login location %s', target)
  window.location.replace(target)
}

async function startCmpLogin(userInitiated: boolean): Promise<void> {
  auth.busy = true
  try {
    if (auth.inIframe) {
      const token = await bridge.waitForParentToken(PARENT_TOKEN_TIMEOUT_MS, userInitiated ? 'poc:token-request' : 'poc:ready')
      if (token) {
        applyExchangeResult(await exchangeSession(token))
        return
      }
      console.warn('[auth] no token from the Cosmos parent within %dms', PARENT_TOKEN_TIMEOUT_MS)
      if (auth.codeLogin) {
        auth.busy = false
        startLegacyLogin(userInitiated) // 回退：prompt=none 静默 / 按钮 popup
        return
      }
      auth.status = 'error'
      auth.message = 'Cosmos did not provide a sign-in for this page. Please reload Cosmos and try again.'
      return
    }

    let state: { kc: Keycloak; authenticated: boolean }
    try {
      state = await keycloak()
    } catch (e) {
      console.error('[auth] keycloak-js init failed (AUTH_BASE_URL / Web Origins?)', e)
      auth.status = 'error'
      auth.message = 'Cosmos sign-in is unavailable. Please try again later.'
      return
    }
    if (state.authenticated) {
      const token = await obtainTokenSilently()
      if (token) {
        applyExchangeResult(await exchangeSession(token))
        return
      }
    }
    if (!userInitiated) {
      if (silentAttempts().length >= SILENT_MAX) {
        console.warn('[auth] startCmpLogin: automatic redirect limit reached, staying on login view')
        return
      }
      recordSilentAttempt()
    }
    saveReturnTo()
    console.info('[auth] startCmpLogin -> keycloak-js login (client=%s)', cfg.authClientId)
    await state.kc.login({ redirectUri: `${window.location.origin}/` })
  } finally {
    auth.busy = false
  }
}

async function logoutCmp(): Promise<void> {
  clearTimeout(refreshTimer)
  // 只清 POC 会话；Keycloak 会话由 keycloak-js 结束（standalone），iframe 不登出母站。
  await fetch(bffUrl('/auth/logout?local=1'), {
    method: 'POST',
    credentials: credentialsMode(),
    headers: { 'X-POC-CSRF': '1' },
  }).catch((e) => console.warn('[auth] POST /auth/logout failed', e))
  auth.authenticated = false
  auth.user = null
  if (!auth.inIframe) {
    try {
      const state = await keycloak()
      if (state.authenticated) {
        await state.kc.logout({ redirectUri: `${window.location.origin}/` })
        return
      }
    } catch (e) {
      console.warn('[auth] keycloak-js logout failed', e)
    }
  }
  window.location.reload()
}

/** 测试用：覆盖运行期配置。 */
export function _setAuthConfigForTest(overrides: Partial<RuntimeConfig>): void {
  cfg = { ...runtimeConfig, ...overrides }
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
  auth.flow = 'legacy'
  auth.codeLogin = true
  auth.tokenExchange = false
  auth.user = null
  auth.status = 'signed-out'
  auth.message = ''
  handlingUnauthorized = false
  cfg = runtimeConfig
  kc = null
  kcInit = null
  sessionExpiresAt = 0
  clearTimeout(refreshTimer)
  bridge._resetBridgeForTest()
}
