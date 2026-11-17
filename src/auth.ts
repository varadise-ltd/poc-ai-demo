// Cosmos SSO（Keycloak OIDC）登录：Authorization Code Flow + PKCE（S256）。
//
// 与 varadise-twin-code 的 AI Gateway Cosmos SSO 方案一致：
//   - Cosmos Keycloak 是唯一身份提供者；本前端是一个独立的 OIDC client。
//   - 浏览器跳转到 Keycloak 登录页，账号 / 密码只在 Keycloak 输入，本应用永不接触密码。
//   - 允许角色（realm_access.roles）默认 cosmos-member / cosmos-admin，且必须带 orgCode。
//
// 纯 SPA 无法保管 client secret，因此 Keycloak 端应把 client 配置为 **public client**
// （Standard flow + PKCE S256，精确的 Redirect URI / Web Origins）。
//
// 安全边界：浏览器端只校验 iss / aud / exp / nonce / 角色 / orgCode，**不校验 JWT 签名**
// （浏览器端验签不构成安全边界）。目前后端仍由网络 ACL 保护；需要真正的 API 授权时，
// 由 poc-ai-service 用 Keycloak JWKS 校验 Authorization: Bearer（api.ts 已附带该头）。

import { reactive } from 'vue'

// ---------------------------------------------------------------------------
// 配置（Vite 构建期注入）
// ---------------------------------------------------------------------------
const env = import.meta.env

function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

// 总开关：SSO / 登录暂时全局停用。即使部署环境传入 VITE_AUTH_ENABLED=true
// （云端构建参数 / POC_AUTH_ENABLED）也不生效——不渲染登录页、不走 OIDC 流程、
// 不附带 Authorization 头。后续要恢复 SSO 时把这里改回 true 即可（其余代码未删）。
const AUTH_MASTER_ENABLED = false

export interface AuthConfig {
  enabled: boolean
  /** e.g. https://<keycloak-host>/realms/<realm> (Keycloak ≥17) or …/auth/realms/<realm>. */
  issuer: string
  clientId: string
  redirectUri: string
  postLogoutRedirectUri: string
  scope: string
  /** Empty list = no role check. */
  allowedRoles: string[]
  requireOrgCode: boolean
}

function defaultAppUrl(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.origin}${import.meta.env.BASE_URL || '/'}`
}

export function readAuthConfig(): AuthConfig {
  const issuer = (env.VITE_OIDC_ISSUER || '').trim().replace(/\/+$/, '')
  return {
    enabled: AUTH_MASTER_ENABLED && String(env.VITE_AUTH_ENABLED || '').trim().toLowerCase() === 'true',
    issuer,
    clientId: (env.VITE_OIDC_CLIENT_ID || 'poc-ai-demo').trim(),
    redirectUri: (env.VITE_OIDC_REDIRECT_URI || '').trim() || defaultAppUrl(),
    postLogoutRedirectUri: (env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI || '').trim() || defaultAppUrl(),
    scope: (env.VITE_OIDC_SCOPE || 'openid profile email').trim(),
    allowedRoles: csv(env.VITE_OIDC_ALLOWED_ROLES, ['cosmos-member', 'cosmos-admin']),
    requireOrgCode: String(env.VITE_OIDC_REQUIRE_ORG_CODE ?? 'true').trim().toLowerCase() !== 'false',
  }
}

let config: AuthConfig = readAuthConfig()

/** Test hook: override the build-time configuration. */
export function _setAuthConfigForTest(next: Partial<AuthConfig>): void {
  config = { ...readAuthConfig(), ...next }
  discovery = null
}

// ---------------------------------------------------------------------------
// 状态（供 App / LoginView / TopBar 使用）
// ---------------------------------------------------------------------------
export interface AuthUser {
  sub: string
  username: string
  name: string
  email: string
  roles: string[]
  orgCode: string
}

export const auth = reactive({
  /** false 时整个应用不需要登录（iframe 嵌入 / 未配置 SSO 的部署）。 */
  enabled: config.enabled,
  ready: false,
  authenticated: false,
  busy: false,
  user: null as AuthUser | null,
  /** 'denied' = 账号有效但无 Cosmos 角色 / orgCode；'error' = 流程失败；'expired' = 会话过期。 */
  status: 'signed-out' as 'signed-out' | 'denied' | 'error' | 'expired',
  message: '',
})

interface TokenSet {
  access_token: string
  id_token: string
  refresh_token?: string
  /** epoch ms */
  expires_at: number
  refresh_expires_at?: number
}

interface PendingLogin {
  state: string
  nonce: string
  verifier: string
  returnUrl: string
  createdAt: number
}

const TOKEN_KEY = 'cosmos.auth.tokens'
const PENDING_KEY = 'cosmos.auth.pending'
const PENDING_MAX_AGE_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 60 * 1000
const CLOCK_SKEW_S = 60

let tokens: TokenSet | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// 工具：base64url / 随机数 / SHA-256（非安全上下文回退）
// ---------------------------------------------------------------------------
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecodeToString(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4)
  const bin = atob(padded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

// 纯 JS SHA-256：内网 http://<IP> 页面不是 secure context，crypto.subtle 不可用，
// 但 PKCE S256 仍需要摘要。crypto.getRandomValues 在非安全上下文可用。
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256Fallback(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const bitLen = data.length * 8
  const padLen = (((data.length + 9 + 63) >> 6) << 6)
  const msg = new Uint8Array(padLen)
  msg.set(data)
  msg[data.length] = 0x80
  const view = new DataView(msg.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padLen - 4, bitLen >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i])
  return out
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
    } catch {
      /* fall through */
    }
  }
  return base64UrlEncode(sha256Fallback(data))
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) throw new Error('Malformed token')
  return JSON.parse(base64UrlDecodeToString(part)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// OIDC discovery
// ---------------------------------------------------------------------------
interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
}

let discovery: Discovery | null = null

async function getDiscovery(): Promise<Discovery> {
  if (discovery) return discovery
  if (!config.issuer) throw new Error('SSO is not configured (VITE_OIDC_ISSUER is empty).')
  const res = await fetch(`${config.issuer}/.well-known/openid-configuration`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Cannot reach Cosmos SSO (${res.status}).`)
  const doc = (await res.json()) as Discovery
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('Invalid SSO discovery document.')
  if (doc.issuer && doc.issuer.replace(/\/+$/, '') !== config.issuer) {
    throw new Error('SSO issuer mismatch: check VITE_OIDC_ISSUER.')
  }
  discovery = doc
  return doc
}

// ---------------------------------------------------------------------------
// Token 存取
// ---------------------------------------------------------------------------
function saveTokens(next: TokenSet | null): void {
  tokens = next
  try {
    if (next) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

function loadStoredTokens(): TokenSet | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    return raw ? (JSON.parse(raw) as TokenSet) : null
  } catch {
    return null
  }
}

/** Access token for API calls (null when auth is disabled or signed out). */
export function getAccessToken(): string | null {
  if (!auth.enabled || !auth.authenticated || !tokens) return null
  return tokens.access_token
}

function toTokenSet(body: Record<string, unknown>, previous?: TokenSet | null): TokenSet {
  const now = Date.now()
  const expiresIn = Number(body.expires_in ?? 300)
  const refreshExpiresIn = body.refresh_expires_in !== undefined ? Number(body.refresh_expires_in) : undefined
  return {
    access_token: String(body.access_token ?? ''),
    // Keycloak 刷新时也返回 id_token；没有就沿用旧值（用于 logout 的 id_token_hint）。
    id_token: String(body.id_token ?? previous?.id_token ?? ''),
    refresh_token: body.refresh_token ? String(body.refresh_token) : previous?.refresh_token,
    expires_at: now + expiresIn * 1000,
    // Keycloak: refresh_expires_in = 0 表示离线 / 不过期。
    refresh_expires_at: refreshExpiresIn ? now + refreshExpiresIn * 1000 : undefined,
  }
}

// ---------------------------------------------------------------------------
// Claims 校验（iss / aud / exp / nonce / 角色 / orgCode）
// ---------------------------------------------------------------------------
export class AccessDeniedError extends Error {}

function audienceIncludes(aud: unknown, clientId: string): boolean {
  if (Array.isArray(aud)) return aud.includes(clientId)
  return aud === clientId
}

function rolesFrom(claims: Record<string, unknown>): string[] {
  const realm = claims.realm_access as { roles?: unknown } | undefined
  return Array.isArray(realm?.roles) ? realm!.roles.map(String) : []
}

export function evaluateTokens(set: TokenSet, expectedNonce?: string): AuthUser {
  const idClaims = decodeJwtPayload(set.id_token)
  const accessClaims = (() => {
    try { return decodeJwtPayload(set.access_token) } catch { return {} as Record<string, unknown> }
  })()
  const nowS = Math.floor(Date.now() / 1000)
  const iss = String(idClaims.iss ?? '').replace(/\/+$/, '')
  if (iss !== config.issuer) throw new Error('ID token issuer does not match the configured Cosmos SSO.')
  if (!audienceIncludes(idClaims.aud, config.clientId)) throw new Error('ID token audience mismatch.')
  if (typeof idClaims.exp !== 'number' || idClaims.exp + CLOCK_SKEW_S < nowS) throw new Error('ID token has expired.')
  if (expectedNonce !== undefined && idClaims.nonce !== expectedNonce) throw new Error('ID token nonce mismatch.')

  // 角色 / orgCode 通常在 access token（mapper 也可写入 ID token），两者合并取。
  const roles = Array.from(new Set([...rolesFrom(accessClaims), ...rolesFrom(idClaims)]))
  const orgCode = String(accessClaims.orgCode ?? idClaims.orgCode ?? '').trim()
  if (config.allowedRoles.length && !roles.some((r) => config.allowedRoles.includes(r))) {
    throw new AccessDeniedError('Access denied: a valid Cosmos account (cosmos-member or cosmos-admin) is required.')
  }
  if (config.requireOrgCode && !orgCode) {
    throw new AccessDeniedError('Access denied: your Cosmos account has no organization (orgCode).')
  }
  const username = String(idClaims.preferred_username ?? accessClaims.preferred_username ?? '')
  return {
    sub: String(idClaims.sub ?? ''),
    username,
    name: String(idClaims.name ?? '') || username || String(idClaims.email ?? ''),
    email: String(idClaims.email ?? ''),
    roles,
    orgCode,
  }
}

// ---------------------------------------------------------------------------
// 流程
// ---------------------------------------------------------------------------
function setSignedIn(user: AuthUser): void {
  auth.user = user
  auth.authenticated = true
  auth.status = 'signed-out'
  auth.message = ''
  scheduleRefresh()
}

function setSignedOut(status: typeof auth.status, message = ''): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  saveTokens(null)
  auth.user = null
  auth.authenticated = false
  auth.status = status
  auth.message = message
}

/** Start the Keycloak login (full-page redirect). */
export async function login(): Promise<void> {
  auth.busy = true
  try {
    const doc = await getDiscovery()
    const pending: PendingLogin = {
      state: randomString(16),
      nonce: randomString(16),
      verifier: randomString(48),
      // 保留 iframe / 书签带来的 orgId / projectId 等查询参数，登录后回到原地址。
      returnUrl: window.location.href,
      createdAt: Date.now(),
    }
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
    const url = new URL(doc.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await pkceChallenge(pending.verifier),
      code_challenge_method: 'S256',
    }).toString()
    window.location.assign(url.toString())
  } catch (err) {
    auth.busy = false
    auth.status = 'error'
    auth.message = err instanceof Error ? err.message : String(err)
  }
}

async function handleCallback(params: URLSearchParams): Promise<void> {
  const raw = sessionStorage.getItem(PENDING_KEY)
  sessionStorage.removeItem(PENDING_KEY)
  const pending = raw ? (JSON.parse(raw) as PendingLogin) : null
  const returnUrl = pending?.returnUrl || config.redirectUri
  // 无论成败，先把 code/state 从地址栏移除（不留在历史记录 / 日志里）。
  const clean = new URL(returnUrl, window.location.href)
  for (const key of ['code', 'state', 'session_state', 'iss', 'error', 'error_description']) clean.searchParams.delete(key)
  window.history.replaceState(null, '', clean.toString())

  if (params.get('error')) {
    const description = params.get('error_description') || params.get('error') || 'Login failed.'
    setSignedOut(params.get('error') === 'access_denied' ? 'denied' : 'error', description)
    return
  }
  if (!pending || pending.state !== params.get('state')) {
    setSignedOut('error', 'Login response did not match this browser session. Please sign in again.')
    return
  }
  if (Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
    setSignedOut('error', 'Login took too long. Please sign in again.')
    return
  }
  const doc = await getDiscovery()
  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') || '',
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: pending.verifier,
    }),
  })
  if (!res.ok) {
    setSignedOut('error', `Cosmos SSO rejected the login (${res.status}).`)
    return
  }
  const set = toTokenSet((await res.json()) as Record<string, unknown>)
  try {
    const user = evaluateTokens(set, pending.nonce)
    saveTokens(set)
    setSignedIn(user)
  } catch (err) {
    // 被拒绝时不保留 token；Keycloak 会话仍在，LoginView 提供「换账号」（登出），
    // 登出需要 id_token_hint，所以只单独记下 id_token。
    setSignedOut(err instanceof AccessDeniedError ? 'denied' : 'error', err instanceof Error ? err.message : String(err))
    lastDeniedIdToken = set.id_token
  }
}

let lastDeniedIdToken = ''

async function refresh(): Promise<boolean> {
  const current = tokens
  if (!current?.refresh_token) return false
  if (current.refresh_expires_at && current.refresh_expires_at <= Date.now()) return false
  try {
    const doc = await getDiscovery()
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: config.clientId,
      }),
    })
    if (!res.ok) return false
    const set = toTokenSet((await res.json()) as Record<string, unknown>, current)
    const user = evaluateTokens(set)
    saveTokens(set)
    setSignedIn(user)
    return true
  } catch {
    return false
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  if (!tokens) return
  const delay = Math.max(5_000, tokens.expires_at - Date.now() - REFRESH_SKEW_MS)
  refreshTimer = setTimeout(async () => {
    if (!(await refresh())) setSignedOut('expired', 'Your Cosmos session has expired. Please sign in again.')
  }, delay)
}

/**
 * Called once before the app mounts: completes a pending login callback, or
 * restores the session from sessionStorage (refreshing it when needed).
 */
export async function initAuth(): Promise<void> {
  auth.enabled = config.enabled
  if (!config.enabled) {
    auth.authenticated = true
    auth.ready = true
    return
  }
  try {
    const params = new URLSearchParams(window.location.search)
    if ((params.has('code') || params.has('error')) && params.has('state')) {
      await handleCallback(params)
      return
    }
    const stored = loadStoredTokens()
    if (!stored) return
    tokens = stored
    if (stored.expires_at - REFRESH_SKEW_MS > Date.now()) {
      try {
        setSignedIn(evaluateTokens(stored))
        return
      } catch {
        /* fall through to refresh */
      }
    }
    if (!(await refresh())) setSignedOut('expired', 'Your Cosmos session has expired. Please sign in again.')
  } catch (err) {
    setSignedOut('error', err instanceof Error ? err.message : String(err))
  } finally {
    auth.busy = false
    auth.ready = true
  }
}

/** Sign out locally and end the Keycloak SSO session. */
export async function logout(): Promise<void> {
  const idToken = tokens?.id_token || lastDeniedIdToken
  setSignedOut('signed-out')
  lastDeniedIdToken = ''
  try {
    const doc = await getDiscovery()
    if (doc.end_session_endpoint) {
      const url = new URL(doc.end_session_endpoint)
      url.search = new URLSearchParams({
        client_id: config.clientId,
        post_logout_redirect_uri: config.postLogoutRedirectUri,
        ...(idToken ? { id_token_hint: idToken } : {}),
      }).toString()
      window.location.assign(url.toString())
    }
  } catch {
    /* local sign-out already done */
  }
}
