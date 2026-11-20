// Backend API client for face management (SQLite-backed).

import { handleUnauthorized } from './auth'
import type { Alert, Camera, CameraAI, CameraModelRun, DashboardQueryResult, FaceData, FaceMeta, FaceValidation, Script, ScriptParam, ScriptRun } from './types'

// Backend routing is selected at frontend build time. Keep one simple switch:
//   VITE_BACKEND_TARGET=local -> explicit Local GPU endpoint
//   VITE_BACKEND_TARGET=cloud -> same-origin /api (no build-time base URL);
//     nginx routes /api to the runtime BACKEND_HOST env var.
const backendTarget = import.meta.env.VITE_BACKEND_TARGET?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
export type BackendMode = 'local' | 'cloud'
const BASE_URL: string = backendTarget === 'local'
  ? (import.meta.env.VITE_LOCAL_API_BASE?.trim() || 'https://internal-poc-aicctv-dev.varadise.cloud')
  : ''

export function getBackendMode(): BackendMode { return backendTarget }
export function backendLabel(): string { return backendTarget === 'local' ? 'Local GPU' : 'Cloud CPU' }

export interface InferenceDeviceInfo {
  requested_device: string
  device: string
  mode: 'cpu' | 'gpu'
  onnx_cuda_provider: boolean
  restart_required_to_change: boolean
}

export async function getInferenceDevice(): Promise<InferenceDeviceInfo> {
  const res = await request(`${BASE_URL}/api/runtime/device`)
  return handle<InferenceDeviceInfo>(res)
}

const ORG_STORAGE_KEY = 'cosmos.activeOrgId'
const PROJECT_STORAGE_KEY = 'cosmos.activeProjectId'
// 本 tab 的 Cosmos 锚点（从 Cosmos 进入时 URL 带的 orgId）。方案 v1.3 §4.6：
// 存 sessionStorage（每个 tab 独立，不跨 tab、不被 standalone 继承）。
const ANCHOR_STORAGE_KEY = 'cosmos.entryOrgId'
// 平台默认组织统一为 Varadise（方案 v1.3 决策 D2）。后端是唯一来源：真实键
// （可能已收敛为 UUID）以 GET /api/orgs 返回的 default_org_id 为准，这里只是
// 拿到后端答复之前的初始值（名称选择器，后端会规范化）。
const PLATFORM_DEFAULT_ORG = 'Varadise'
let DEFAULT_ORG_ID = PLATFORM_DEFAULT_ORG
const DEFAULT_PROJECT_ID = import.meta.env.VITE_DEFAULT_PROJECT_ID || 'default'
// 展示层的默认明文名称：无法从 profile-service 解析出 orgname/projectname 时，
// 用这个默认名代替 orgid/projectid 展示，**绝不**在 UI 上直接显示 UUID。
const DEFAULT_ORG_NAME = PLATFORM_DEFAULT_ORG
const DEFAULT_PROJECT_NAME = import.meta.env.VITE_DEFAULT_PROJECT_NAME || 'Default'

/**
 * 租户键合法性校验：Cosmos 母站 iframe 链接是 Go 模板，渲染失败时会把
 * ``{{.projectId}}`` / ``{{.orgId}}`` 等占位符**字面量**原样传进来。这类值
 * （以及 undefined/null/空串）绝不能当作租户键采用或写入 localStorage，
 * 否则 <img> 串流会带着假 project_id 请求后端，camera_in_scope 项目匹配
 * 失败 → 预览 404，且污染会跨刷新持续存在。
 */
function isValidTenantKey(value: string | null | undefined): value is string {
  const v = (value || '').trim()
  if (!v) return false
  if (v.includes('{{') || v.includes('}}') || v.includes('{%')) return false // 未渲染模板占位符
  if (v === 'undefined' || v === 'null') return false
  return true
}

function urlContext(name: string): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.get(name) || params.get(name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
  const value = raw?.trim() || ''
  if (!value) return null
  if (!isValidTenantKey(value)) {
    console.warn(`[cosmos-chain] ignored invalid tenant param ${name}=${raw} (unrendered template placeholder?)`)
    return null
  }
  return value
}

/** localStorage 里可能残留历史污染值（如 '{{.projectId}}'）：读出时同样校验并清除。 */
function storedTenantKey(storageKey: string): string | null {
  const raw = window.localStorage.getItem(storageKey)?.trim() || ''
  if (!raw) return null
  if (!isValidTenantKey(raw)) {
    console.warn(`[cosmos-chain] purged invalid cached tenant ${storageKey}=${raw}`)
    window.localStorage.removeItem(storageKey)
    return null
  }
  return raw
}

// Cosmos iframe 传入的 orgId / projectId 作为**页面初始化的租户键**（优先于
// 旧缓存与默认值）。后端会在启动期把 profile-service 全量 org sync 到本地库，
// 因此前端能把 UUID orgId 解析为 orgname 展示（如 React Ltd），preview /
// Dashboard / Camera / AI model 页面都初始化为该 org。
const URL_ORG_ID = urlContext('orgId') || urlContext('porgId')
const URL_PROJECT_ID = urlContext('projectId')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 本 tab 的 Cosmos 锚点：URL 的 orgId 是合法 UUID 时采用并写入 sessionStorage；
 * 否则沿用本 tab 之前记下的锚点（SPA 内跳转丢了 query 也不丢锚点）。
 * 只用于告诉后端「这个 tab 从哪个 Cosmos 组织进入」——后端据此计算可用组织集合 A，
 * 安全边界仍是后端的成员关系校验。
 */
let cosmosAnchor: string | null = (() => {
  if (typeof window === 'undefined') return null
  try {
    if (URL_ORG_ID && UUID_RE.test(URL_ORG_ID)) {
      window.sessionStorage.setItem(ANCHOR_STORAGE_KEY, URL_ORG_ID)
      return URL_ORG_ID
    }
    const stored = window.sessionStorage.getItem(ANCHOR_STORAGE_KEY)?.trim() || ''
    return UUID_RE.test(stored) ? stored : null
  } catch {
    return URL_ORG_ID && UUID_RE.test(URL_ORG_ID) ? URL_ORG_ID : null
  }
})()

export function getCosmosAnchor(): string | null { return cosmosAnchor }

/** 测试用：设置 / 清除锚点。 */
export function _setCosmosAnchorForTest(anchor: string | null): void {
  cosmosAnchor = anchor && UUID_RE.test(anchor) ? anchor : null
}

/** 后端答复的组织访问状态（方案 v1.3 §4）；null = 尚未获取 / 旧版后端。 */
export interface OrgAccessState {
  allowedOrgIds: string[]
  defaultOrgId: string
  cosmosOrgId: string | null
}
let orgAccess: OrgAccessState | null = null

export function getOrgAccess(): OrgAccessState | null { return orgAccess }

/** 测试用：重置后端答复的组织访问状态。 */
export function _resetOrgAccessForTest(): void {
  orgAccess = null
  DEFAULT_ORG_ID = PLATFORM_DEFAULT_ORG
}

/** Active tenant used by all API calls. The backend remains the authority. */
let activeOrgId = (() => {
  if (typeof window === 'undefined') return DEFAULT_ORG_ID
  // 优先级：Cosmos 锚点 > iframe orgId > 用户上次选择（localStorage）> 默认 Varadise。
  // 拿到后端的可用组织集合后由 applyOrgAccess() 校正到集合内。
  return cosmosAnchor || URL_ORG_ID || storedTenantKey(ORG_STORAGE_KEY) || DEFAULT_ORG_ID
})()
let activeProjectId = (() => {
  if (typeof window === 'undefined') return DEFAULT_PROJECT_ID
  return URL_PROJECT_ID || storedTenantKey(PROJECT_STORAGE_KEY) || DEFAULT_PROJECT_ID
})()

// 把 iframe 传入的租户持久化，保证刷新后仍保持该租户范围。
if (typeof window !== 'undefined') {
  if (URL_ORG_ID) window.localStorage.setItem(ORG_STORAGE_KEY, URL_ORG_ID)
  if (URL_PROJECT_ID) window.localStorage.setItem(PROJECT_STORAGE_KEY, URL_PROJECT_ID)
}

// ---------------------------------------------------------------------------
// Cosmos iframe → 前端 链路日志（[cosmos-chain]）
// ---------------------------------------------------------------------------
// 记录「母站 iframe 传入的 orgId/projectId → 前端解析出的 active org/project」
// 全过程的每一个环节，便于在浏览器控制台按 [cosmos-chain] 过滤排查租户串号。
// 每次 API 请求另发一行 [cosmos-chain]，携带 X-Request-ID 与后端日志串起同一条
// 请求链（后端 RequestLoggingMiddleware 沿用该 X-Request-ID）。
const CHAIN_TAG = '[cosmos-chain]'

/** 生成一个贯穿「前端 → 后端」的请求 id（后端沿用 X-Request-ID）。 */
function newChainRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

function chainLog(message: string, detail?: unknown): void {
  if (typeof console === 'undefined') return
  console.info(`${CHAIN_TAG} ${message}`, detail ?? '')
}

// 模块加载即打印一次「租户初始化」快照：iframe URL 原始参数、localStorage 缓存、
// 最终解析出的 active org/project，四者并排，一眼看出租户值从何而来。
if (typeof window !== 'undefined') {
  chainLog('tenant init', {
    backendTarget,
    urlOrgId: URL_ORG_ID ?? null,
    cosmosAnchor,
    urlProjectId: URL_PROJECT_ID ?? null,
    storedOrgId: window.localStorage.getItem(ORG_STORAGE_KEY) ?? null,
    storedProjectId: window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? null,
    activeOrgId,
    activeProjectId,
    defaultOrgId: DEFAULT_ORG_ID,
    defaultProjectId: DEFAULT_PROJECT_ID,
  })
}

export function getActiveOrgId(): string {
  return activeOrgId
}

/** 展示用默认组织名（orgname 解析失败时的兜底明文名，非 UUID）。 */
export function getDefaultOrgName(): string { return DEFAULT_ORG_NAME }

/**
 * 某组织在名称解析失败时的兜底展示名。组织锁定后 A 里同时可能有「Cosmos 锚点组织」和
 * Varadise 两个组织：只有默认组织才能兜底成 'Varadise'，其他组织用中性名，
 * 避免把锚点组织误显示成 Varadise（用户会以为自己在平台默认组织里操作）。
 */
export function isDefaultOrg(orgId: string): boolean {
  const v = (orgId || '').trim()
  return !!v && (v === PLATFORM_DEFAULT_ORG || v === (orgAccess?.defaultOrgId ?? DEFAULT_ORG_ID))
}
export const NON_DEFAULT_ORG_FALLBACK_NAME = 'Cosmos Org'
export function orgFallbackName(orgId: string): string {
  return isDefaultOrg(orgId) ? DEFAULT_ORG_NAME : NON_DEFAULT_ORG_FALLBACK_NAME
}

/** 展示用默认项目名（projectname 解析失败时的兜底明文名）。 */
export function getDefaultProjectName(): string { return DEFAULT_PROJECT_NAME }

/**
 * 组织锁定（方案 v1.3 §4）：后端已答复可用组织集合 A 时恒为 true——所有组织下拉框
 * 只出现 A 中的组织（Cosmos 传入的组织 + 被授权时的 Varadise），切换只能在 A 内。
 * 旧版后端（没有 allowed_org_ids）沿用 11-17 版规则：活动 orgId 是 UUID 即锁定。
 */
export function isOrgLocked(): boolean {
  if (orgAccess) return true
  return UUID_RE.test(activeOrgId)
}

/** 把组织选择器规范化到后端的键（'Varadise' 名称 → default_org_id）。 */
function canonicalOrgId(orgId: string): string {
  const v = orgId.trim()
  if (orgAccess && v === PLATFORM_DEFAULT_ORG) return orgAccess.defaultOrgId
  return v
}

/** 该组织是否可以被选为活动组织（A 之内；旧版后端按 11-17 规则）。 */
export function canSelectOrg(orgId: string): boolean {
  const next = canonicalOrgId(orgId || '')
  if (!next) return false
  if (orgAccess) return orgAccess.allowedOrgIds.includes(next)
  return !(UUID_RE.test(activeOrgId) && next !== activeOrgId)
}

export function setActiveOrgId(orgId: string): void {
  const next = canonicalOrgId(orgId) || DEFAULT_ORG_ID
  if (next !== activeOrgId && !canSelectOrg(next)) {
    chainLog('org switch ignored (not in allowed orgs)', {
      activeOrgId, requested: next, allowed: orgAccess?.allowedOrgIds ?? null,
    })
    return
  }
  activeOrgId = next
  if (typeof window !== 'undefined') window.localStorage.setItem(ORG_STORAGE_KEY, activeOrgId)
}

/**
 * 采纳后端答复的组织访问状态，并把活动组织校正到 A 内：
 * 当前值仍在 A 中则保留，否则取 A[0]（有锚点时是锚点，否则是 Varadise）；
 * A 为空时活动组织置空（页面渲染「未开通」提示，不发业务请求）。
 */
export function applyOrgAccess(data: {
  allowed_org_ids?: string[] | null
  default_org_id?: string | null
  cosmos_org_id?: string | null
}, reconcile = true): OrgAccessState | null {
  if (!Array.isArray(data.allowed_org_ids)) return orgAccess  // 旧版后端
  const defaultOrgId = (data.default_org_id || PLATFORM_DEFAULT_ORG).trim()
  orgAccess = {
    allowedOrgIds: data.allowed_org_ids.map((o) => String(o).trim()).filter(Boolean),
    defaultOrgId,
    cosmosOrgId: data.cosmos_org_id ?? null,
  }
  DEFAULT_ORG_ID = defaultOrgId
  if (!reconcile) return orgAccess
  const current = canonicalOrgId(activeOrgId)
  const next = orgAccess.allowedOrgIds.includes(current) ? current : (orgAccess.allowedOrgIds[0] ?? '')
  if (next !== activeOrgId) chainLog('active org reconciled to allowed set', { from: activeOrgId, to: next })
  activeOrgId = next
  if (next && typeof window !== 'undefined') window.localStorage.setItem(ORG_STORAGE_KEY, next)
  return orgAccess
}

/**
 * 后端拒绝本会话访问组织（GET /api/orgs → 403）的原因：
 * - not_member：当前账号不是 Cosmos 传入组织的成员；
 * - membership_unavailable：暂时无法校验成员关系（profile-service 不可用）；
 * - not_allowed：所选组织不在可用集合内。
 */
export type OrgAccessError = 'not_member' | 'membership_unavailable' | 'not_allowed' | 'forbidden'
let orgAccessError: OrgAccessError | null = null

export function getOrgAccessError(): OrgAccessError | null { return orgAccessError }

/** 把后端 403 的 detail（如 ``NOT_MEMBER: …``）映射为前端原因码。 */
export function orgAccessErrorFromDetail(detail: unknown): OrgAccessError {
  const text = String(detail ?? '')
  if (text.startsWith('NOT_MEMBER')) return 'not_member'
  if (text.startsWith('MEMBERSHIP_UNAVAILABLE')) return 'membership_unavailable'
  if (text.startsWith('ORG_NOT_ALLOWED')) return 'not_allowed'
  return 'forbidden'
}

/** 启动时调用：GET /api/orgs 取可用组织集合并校正活动组织。失败（旧版后端 / 网络）返回 null。 */
export async function initOrgAccess(): Promise<OrgAccessState | null> {
  orgAccessError = null
  try {
    const res = await request(`${BASE_URL}/api/orgs`)
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown }
      orgAccessError = orgAccessErrorFromDetail(body.detail)
      chainLog('org access denied by backend', { activeOrgId, reason: orgAccessError, detail: body.detail })
      return orgAccess
    }
    if (!res.ok) return orgAccess
    return applyOrgAccess(await res.json())
  } catch (err) {
    console.warn('[cosmos-chain] org access init failed', err)
    return orgAccess
  }
}

/** 测试用：重置组织访问错误。 */
export function _resetOrgAccessErrorForTest(): void { orgAccessError = null }

/** 后端已答复且本会话没有任何可用组织（standalone 未开通 Varadise）。 */
export function noOrgAvailable(): boolean {
  return !!orgAccess && orgAccess.allowedOrgIds.length === 0
}

export function getActiveProjectId(): string { return activeProjectId }

export function setActiveProjectId(projectId: string): void {
  const raw = (projectId || '').trim()
  // 与 URL/localStorage 入口同一校验：未渲染模板占位符（'{{.projectId}}'）等
  // 非法值绝不采用，回退默认项目并清除污染缓存，保证后续所有请求（含 <img>
  // 串流）的 project_id 要么正确、要么缺省（default 通配）。
  const next = isValidTenantKey(raw) ? raw : DEFAULT_PROJECT_ID
  if (raw && next !== raw) {
    chainLog('ignored invalid project id', { requested: raw, fallback: next })
  }
  activeProjectId = next
  if (typeof window !== 'undefined') window.localStorage.setItem(PROJECT_STORAGE_KEY, activeProjectId)
}

/** 租户键校验（与 URL/localStorage 入口同一规则）：供 store/UI 层复用。 */
export function isValidTenantSelector(value: string | null | undefined): boolean {
  return isValidTenantKey(value)
}

function requestInit(init: RequestInit = {}, requestId?: string): RequestInit {
  const headers = new Headers(init.headers)
  // 调用方显式传入的租户头（listProjects / saveProject / 跨组织 listCameras /
  // createCamera 的目标组织）必须保留，不能被 active 租户覆盖；否则后端看到
  // 的永远是当前组织（列错项目、或「头 ≠ org_id 查询参数」被中间件 400）。
  if (!headers.has('X-Organization-Id') && activeOrgId) headers.set('X-Organization-Id', activeOrgId)
  // 本 tab 的 Cosmos 锚点：后端据此计算可用组织集合 A（方案 v1.3 §4）。
  if (cosmosAnchor && !headers.has('X-Cosmos-Org-Id')) headers.set('X-Cosmos-Org-Id', cosmosAnchor)
  if (!headers.has('X-Project-Id')) headers.set('X-Project-Id', activeProjectId)
  // Cosmos SSO（方案 v1.3 §5）：token 只在 BFF 服务端；浏览器靠同源 HttpOnly 会话 cookie，
  // nginx auth_request 注入 Bearer。写请求必须带 CSRF 头（BFF 校验，跨站表单设不了自定义头）。
  if (!headers.has('X-POC-CSRF')) headers.set('X-POC-CSRF', '1')
  // 同理保留调用方的 X-Request-ID（runScriptCamera 等的 ui-run-… 关联 id）。
  if (requestId && !headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
  return { ...init, headers }
}

// 系统级兜底 1：集合端点统一带尾斜杠。platform nginx 对无尾斜杠的
// /api/<collection> 触发 directory redirect（301, Location 降级 http），
// https 页面直接 Mixed Content 拦截 → NetworkError（表现为「点 Filter 没反应」）。
// 后端已为所有 /api 集合注册双写法路由（app/core/routing.py），这里在唯一的
// request() 入口统一补斜杠，任何新增调用点自动获得保护，无需逐处修改。
const COLLECTION_PATHS = new Set([
  '/api/scripts', '/api/faces', '/api/cameras', '/api/camera-ai', '/api/alerts',
  '/api/orgs', '/api/projects', '/api/dashboard', '/api/roi', '/api/snapshots',
  '/api/stream',
])

function withTrailingSlash(input: RequestInfo | URL): RequestInfo | URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  // 相对（'/api/…'、'http(s)://…'）都能用同一正则拆出 path。
  const m = raw.match(/^([^?#]*)([?#].*)?$/)
  if (!m) return input
  const [, pathPart, rest = ''] = m
  const origin = pathPart.match(/^https?:\/\/[^/]+/)?.[0] ?? ''
  const path = pathPart.slice(origin.length)
  if (!COLLECTION_PATHS.has(path)) return input
  const fixed = `${origin}${path}/${rest}`
  if (typeof input === 'string') return fixed
  if (input instanceof URL) return new URL(fixed, typeof window !== 'undefined' ? window.location.href : undefined)
  return new Request(fixed, input)
}

// 系统级兜底 2：任何 API 请求最长 30s。没有超时的 fetch 在网络半开（代理挂起、
// 连接僵死）时会永远 pending，让页面按钮停在 “Filtering…/Saving…” 且 disabled，
// 同样表现为「点击无反应」。超时后抛错走各页面既有的错误展示路径。
const REQUEST_TIMEOUT_MS = 30_000

// 系统级兜底 3：404 时按「尾斜杠另一写法」重试一次。线上后端可能是旧版本
// （未注册双写法路由 / redirect_slashes 在 nginx 反代下 307 降级 http 被浏览器
// 拦截），集合端点带斜杠 404、不带斜杠反而命中（或反之）。这里在唯一的
// request() 入口做对称回退：仅对 404、仅重试一次、仅改写尾斜杠，其余语义
// （方法/头/体/租户）完全不变；成功即返回，失败仍抛原 404 走既有错误路径。
function toggleTrailingSlash(input: RequestInfo | URL): RequestInfo | URL | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const m = raw.match(/^([^?#]*)([?#].*)?$/)
  if (!m) return null
  const [, pathPart, rest = ''] = m
  const origin = pathPart.match(/^https?:\/\/[^/]+/)?.[0] ?? ''
  const path = pathPart.slice(origin.length)
  if (!path.startsWith('/api/') || path === '/api/') return null
  const toggled = path.endsWith('/') ? path.slice(0, -1) : `${path}/`
  const fixed = `${origin}${toggled}${rest}`
  if (typeof input === 'string') return fixed
  if (input instanceof URL) return new URL(fixed, typeof window !== 'undefined' ? window.location.href : undefined)
  return new Request(fixed, input)
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const finalInit = requestInit(init, newChainRequestId())
  const sentHeaders = new Headers(finalInit.headers)
  const requestId = sentHeaders.get('X-Request-ID') ?? ''
  if (!finalInit.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    finalInit.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }
  const finalInput = withTrailingSlash(input)
  const method = finalInit.method || 'GET'
  const url = typeof finalInput === 'string'
    ? finalInput
    : (finalInput instanceof URL ? finalInput.toString() : finalInput.url)
  // 每条请求一行链路日志：request id、方法、URL 与本次携带的租户头。
  chainLog(`req=${requestId} ${method} ${url} org=${sentHeaders.get('X-Organization-Id')} project=${sentHeaders.get('X-Project-Id')}`)
  const startedAt = performance.now()
  try {
    const res = await fetch(finalInput, finalInit)
    // 每条请求的响应状态与耗时（覆盖 JSON API、MJPEG 流、文件导出/下载等所有后端往返）。
    chainLog(`res=${requestId} status=${res.status} ms=${Math.round(performance.now() - startedAt)} ${redactUrl(url)}`)
    // 401 = 会话过期 / 被吊销（BFF 或后端拒绝）：重新走 Cosmos 登录流程。
    if (res.status === 401) handleUnauthorized()
    // 仅对无请求体的安全方法回退（GET/HEAD/OPTIONS）：POST 等的 body 可能是
    // 已被消耗的流，重发会抛错；且写操作 404 通常是资源不存在而非路由写法。
    if (res.status === 404 && ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      const alt = toggleTrailingSlash(finalInput)
      if (alt) {
        const altUrl = typeof alt === 'string' ? alt : (alt instanceof URL ? alt.toString() : alt.url)
        chainLog(`req=${requestId} 404 slash-fallback retry ${method} ${altUrl}`)
        // 重试沿用同一超时预算语义：新建一个独立 timeout，避免共享已耗尽的 signal。
        const retryInit: RequestInit = { ...finalInit }
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          retryInit.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }
        const retry = await fetch(alt, retryInit)
        if (retry.status !== 404) return retry
      }
    }
    return res
  } catch (err) {
    chainLog(`req=${requestId} error=${err instanceof Error ? err.name : String(err)} ms=${Math.round(performance.now() - startedAt)} ${redactUrl(url)}`)
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${redactUrl(url)}`)
    }
    throw err
  }
}

/** Absolute backend base URL currently in use (shown in error messages). */
export function apiBaseUrl(): string {
  if (BASE_URL) return BASE_URL
  if (typeof window !== 'undefined' && window.location?.hostname) {
    // Cloud mode uses same-origin /api, which is routed by nginx to
    // BACKEND_HOST. Report the browser-visible origin instead of exposing
    // an internal backend hostname that the browser cannot reach directly.
    return window.location.origin
  }
  // 无浏览器上下文（SSR/测试）时与 cloud 同源语义一致：空 = 相对 /api。
  return ''
}

/**
 * Absolute URL for a backend-relative asset.
 *
 * Detection snapshots come back as ``/api/snapshots/<file>.jpg`` (the backend
 * may also return an absolute S3/CDN URL); both must render in an ``<img>``.
 */
export function assetUrl(path: string | null | undefined): string {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  // <img> 无法带租户 header：后端相对资产 URL（快照等）若尚未携带租户
  // 查询参数，补上当前活动 org/project，保证 Cosmos 租户下鉴权命中。
  // 后端生成的 snapshot_url 已带 org_id/project_id，此时保持原样不覆盖。
  if (path.startsWith('/api/') && !/[?&](org_id|orgId)=/.test(path)) {
    const sep = path.includes('?') ? '&' : '?'
    let scoped = `${path}${sep}org_id=${encodeURIComponent(activeOrgId)}`
    if (isValidTenantKey(activeProjectId) && activeProjectId !== DEFAULT_PROJECT_ID && !/[?&](project_id|projectId)=/.test(path)) {
      scoped += `&project_id=${encodeURIComponent(activeProjectId)}`
    }
    return `${BASE_URL}${withAnchor(scoped)}`
  }
  return `${BASE_URL}${path.startsWith('/api/') ? withAnchor(path) : path}`
}

/** <img>/<video> 无法带请求头：把本 tab 的 Cosmos 锚点放进查询参数（方案 v1.3 §4.5）。 */
function withAnchor(url: string): string {
  if (!cosmosAnchor || /[?&]cosmos_org_id=/.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}cosmos_org_id=${encodeURIComponent(cosmosAnchor)}`
}

export interface OrganizationRecord {
  org_id: string
  /** UI-facing display name (org_id remains the stable internal scope key). */
  org_name: string
  source: string
  status: 'active' | 'disabled'
  /** Show/hide toggle for the org list (false = hidden from the list). */
  visible?: boolean
  last_synced_at?: string | null
}

export interface ProjectRecord {
  project_id: string
  org_id: string
  /** UI-facing display name (project_id remains the stable internal scope key). */
  project_name: string
  status?: string
  created_at?: string
  updated_at?: string
}

export async function listProjects(orgId = activeOrgId): Promise<ProjectRecord[]> {
  const res = await request(`${BASE_URL}/api/projects`, {
    headers: { 'X-Organization-Id': orgId },
  })
  return handle<ProjectRecord[]>(res)
}

export async function getOrganization(orgId = activeOrgId): Promise<OrganizationRecord> {
  return handle<OrganizationRecord>(await request(`${BASE_URL}/api/orgs/${encodeURIComponent(orgId)}`))
}

/** Save (upsert) an organization without calling profile-service. */
export async function saveOrganization(orgId: string, orgName = ''): Promise<OrganizationRecord> {
  const res = await request(`${BASE_URL}/api/orgs/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId, org_name: orgName, source: 'cosmos' }),
  })
  return handle<OrganizationRecord>(res)
}

/** Update the organization display name mapped to an org_id. */
export async function updateOrganization(orgId: string, orgName: string): Promise<OrganizationRecord> {
  const res = await request(`${BASE_URL}/api/orgs/${encodeURIComponent(orgId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_name: orgName }),
  })
  return handle<OrganizationRecord>(res)
}

export async function getProject(projectId = activeProjectId): Promise<ProjectRecord> {
  return handle<ProjectRecord>(await request(`${BASE_URL}/api/projects/${encodeURIComponent(projectId)}`))
}

/** Save (upsert) a project under the current organization. */
export async function saveProject(projectId: string, projectName = '', orgId = activeOrgId): Promise<ProjectRecord> {
  const res = await request(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': orgId },
    body: JSON.stringify({ project_id: projectId, project_name: projectName }),
  })
  return handle<ProjectRecord>(res)
}

/** Update the project display name mapped to a project_id. */
export async function updateProject(projectId: string, projectName: string): Promise<ProjectRecord> {
  const res = await request(`${BASE_URL}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: projectName }),
  })
  return handle<ProjectRecord>(res)
}

export async function syncTenantContext(orgId = activeOrgId, projectId = activeProjectId): Promise<{
  organization: OrganizationRecord
  project: ProjectRecord
}> {
  const res = await request(`${BASE_URL}/api/orgs/sync-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      org_id: orgId,
      project_id: projectId,
    }),
  })
  return handle(res)
}

// Cosmos 租户启动落库：iframe 传入的 orgId/projectId（入口已校验）必须在
// 任何业务 API 之前先 POST /api/orgs/sync-context 持久化到后端
// （organizations/projects 行 + profile-service 权威名称），后续所有接口
// （列表 / Run / <img> 串流 / 快照 / Dashboard）都基于同一租户键。
// 按 (org, project) 记忆化：main.ts 启动与 TopBar 名称解析共用同一次请求；
// 失败不缓存，下一次调用（TopBar）自动重试。
const tenantSyncCache = new Map<string, Promise<{ organization: OrganizationRecord; project: ProjectRecord }>>()

export function ensureTenantContextSynced(
  orgId = activeOrgId,
  projectId = activeProjectId,
): Promise<{ organization: OrganizationRecord; project: ProjectRecord }> {
  const key = `${orgId}::${projectId}`
  let pending = tenantSyncCache.get(key)
  if (!pending) {
    pending = syncTenantContext(orgId, projectId).catch((err) => {
      tenantSyncCache.delete(key)
      throw err
    })
    tenantSyncCache.set(key, pending)
  }
  return pending
}

/**
 * 组织下拉框的唯一数据源（方案 v1.3 §4.6）：只返回本会话可用集合 A 中的组织
 * （Cosmos 传入的组织 + 被授权时的 Varadise）；后端已按 A 过滤，这里再兜底过滤一次。
 * 旧版后端：Cosmos 锁定时只返回传入 orgId 对应的这一个组织。
 */
export async function listOrganizations(includeHidden = false): Promise<OrganizationRecord[]> {
  const query = includeHidden ? '?include_hidden=true' : ''
  const res = await request(`${BASE_URL}/api/orgs${query}`)
  const data = await handle<{
    organizations: OrganizationRecord[]
    locked?: boolean
    allowed_org_ids?: string[]
    default_org_id?: string
    cosmos_org_id?: string | null
  }>(res)
  const orgs = data.organizations ?? []
  const access = applyOrgAccess(data, false)
  if (access && Array.isArray(data.allowed_org_ids)) {
    return orgs.filter((org) => access.allowedOrgIds.includes(org.org_id))
  }
  if (!isOrgLocked() && !data.locked) return orgs
  const own = orgs.filter((org) => org.org_id === activeOrgId)
  if (own.length) return own
  try {
    return [await getOrganization(activeOrgId)]
  } catch {
    return []
  }
}

/** Toggle whether an organization shows in the org list (visible = show / hide). */
export async function setOrgVisible(orgId: string, visible: boolean): Promise<OrganizationRecord> {
  const res = await request(`${BASE_URL}/api/orgs/${encodeURIComponent(orgId)}/visible`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible }),
  })
  return handle<OrganizationRecord>(res)
}

/** Batch set the visible organization set: listed ids are shown, the rest are hidden. */
export async function setOrgsVisible(orgIds: string[]): Promise<{
  visible_org_ids: string[]
  visible_count: number
  hidden_count: number
}> {
  const res = await request(`${BASE_URL}/api/orgs/visible`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_ids: orgIds }),
  })
  return handle(res)
}

export interface DashboardListResult {
  /** 当前活动组织的租户键（稳定 id）。 */
  org_id: string
  /** 当前活动组织的显示名称（orgname）。 */
  org_name: string
  dashboards: { id: string; title: string; subtitle: string }[]
}

export async function listDashboards(): Promise<DashboardListResult> {
  const res = await request(`${BASE_URL}/api/dashboard`)
  return handle<DashboardListResult>(res)
}

// Dashboard analytics (see /api/dashboard on the backend). The dashboard *list* is
// frontend-owned (DashboardView.vue) so the sidebar renders even when the API is down;
// only the per-dashboard query is fetched here.
export async function queryDashboard(
  dashboardId: string,
  filters: {
    start?: string
    end?: string
    cameraId?: string
    personName?: string
    matchStatus?: 'all' | 'matched' | 'unknown'
    violation?: string
    direction?: 'all' | 'in' | 'out'
    objectClass?: 'all' | 'pedestrian' | 'vehicle'
    limit?: number
    offset?: number
  } = {},
): Promise<DashboardQueryResult> {
  const query = new URLSearchParams()
  if (filters.start) query.set('start', filters.start)
  if (filters.end) query.set('end', filters.end)
  if (filters.cameraId && filters.cameraId !== 'all') query.set('camera_id', filters.cameraId)
  if (filters.personName && filters.personName !== 'all') query.set('person_name', filters.personName)
  if (filters.matchStatus) query.set('match_status', filters.matchStatus)
  if (filters.violation && filters.violation !== 'all') query.set('violation', filters.violation)
  if (filters.direction && filters.direction !== 'all') query.set('direction', filters.direction)
  if (filters.objectClass && filters.objectClass !== 'all') query.set('object_class', filters.objectClass)
  if (filters.limit !== undefined) query.set('limit', String(filters.limit))
  if (filters.offset !== undefined) query.set('offset', String(filters.offset))
  const qs = query.toString()
  return handle<DashboardQueryResult>(await request(`${BASE_URL}/api/dashboard/${encodeURIComponent(dashboardId)}/query${qs ? `?${qs}` : ''}`))
}

export interface CraneDashboardSession {
  id: string
  truck_camera: string | null
  crane_camera: string | null
  entry: string | null
  exit: string | null
  loading_start: string | null
  loading_end: string | null
  dwell_seconds: number | null
  cycle_seconds: number | null
  job_type: string | null
}

export interface CraneDashboardResult {
  stats: { label: string; value: number; tone?: string }[]
  stats_meta?: { valid_dwell_count: number; dwell_min_seconds: number; dwell_max_seconds: number }
  total: number
  dwell_distribution?: { counts: number[]; maxBin: number }
  trend?: CraneDashboardSession[]
  cameras?: string[]
  records: CraneDashboardSession[]
  sessions: CraneDashboardSession[]
}

export async function queryCraneDashboard(filters: {
  start?: string
  end?: string
  cameraId?: string
  projectId?: string
  dwellBin?: number | null
} = {}): Promise<CraneDashboardResult> {
  const query = new URLSearchParams()
  if (filters.start) query.set('start', filters.start)
  if (filters.end) query.set('end', filters.end)
  if (filters.cameraId && filters.cameraId !== 'all') query.set('camera_id', filters.cameraId)
  if (filters.projectId) query.set('project_id', filters.projectId)
  if (filters.dwellBin != null) query.set('dwell_bin', String(filters.dwellBin))
  const qs = query.toString()
  return handle<CraneDashboardResult>(await request(`${BASE_URL}/api/dashboard/crane/query${qs ? `?${qs}` : ''}`))
}

interface FaceRecord {
  id: number
  name: string
  org_id?: string
  org_name?: string
  project_name?: string
  image_name: string
  image_path: string
  has_embedding: boolean
  embedding_dim: number
  has_embedding_512: boolean
  embedding_512_dim: number
  width?: number | null
  height?: number | null
  face_count?: number | null
  thumbnail?: string | null
  embeddings?: FaceEmbeddingRecord[]
  created_at: string
  updated_at: string
}

interface FaceEmbeddingRecord {
  id: number
  angle: string
  image_name: string
  image_path: string
  has_embedding_512: boolean
  embedding_512_dim: number
  thumbnail?: string | null
  created_at: string
  updated_at: string
}

interface FaceMutationResult extends FaceRecord {
  validation?: FaceValidation
}

export function faceImageUrl(id: number): string {
  return `${BASE_URL}${withAnchor(`/api/faces/${id}/image?org_id=${encodeURIComponent(activeOrgId)}`)}`
}

export function faceEmbeddingImageUrl(faceId: number, embeddingId: number): string {
  return `${BASE_URL}${withAnchor(`/api/faces/${faceId}/embeddings/${embeddingId}/image?org_id=${encodeURIComponent(activeOrgId)}`)}`
}

function toFaceData(r: FaceRecord): FaceData {
  return {
    id: r.id,
    name: r.name,
    orgId: r.org_id,
    imageName: r.image_name,
    image: faceImageUrl(r.id),
    thumbnail: r.thumbnail ?? undefined,
    hasEmbedding: r.has_embedding,
    hasEmbedding512: r.has_embedding_512,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    faceCount: r.face_count ?? undefined,
    embeddings: (r.embeddings ?? []).map((e) => ({
      id: e.id,
      angle: e.angle,
      imageName: e.image_name,
      image: faceEmbeddingImageUrl(r.id, e.id),
      thumbnail: e.thumbnail ?? undefined,
      hasEmbedding512: e.has_embedding_512,
    })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface FaceImageInput {
  file: File
  angle: string
}

export async function getFaceMeta(): Promise<FaceMeta> {
  const res = await request(`${BASE_URL}/api/faces/meta`)
  return handle<FaceMeta>(res)
}

/**
 * 遮蔽 URL 中的敏感信息（供前端日志与只读展示使用，避免把摄像机凭据打进
 * 浏览器控制台或直接显示在界面上）。
 *
 * 1. 用户信息：rtsp://user:pass@host/… -> rtsp://user:******@host/…
 *    （用户名保留、密码替换为 ``******``；无密码的裸 ``user@`` 也一并遮蔽）。
 * 2. 查询参数中的敏感键：?token=… / ?password=… / ?pass=… / ?key=… / ?auth=…
 *    -> 值替换为 ``******``。
 *
 * 仅用于「展示/日志」；首次输入配置（CameraEditorModal）直接编辑原始 URL，
 * 因此不受影响。
 */
export function redactUrl(url: string): string {
  if (!url) return url
  let out = url.replace(/(\/\/[^/@:]*):([^@]*)@/g, (_m, user: string, _pass: string) => `${user}:******@`)
  out = out.replace(/(\/\/[^/@]+)@/g, '$1:******@')
  // 查询参数中的敏感键值
  out = out.replace(/([?&](?:token|password|pass|key|auth|access[_-]?key|secret))=([^&#]*)/gi, '$1=******')
  return out
}

/**
 * Correlation id for one UI action, sent as ``X-Request-ID``.
 *
 * The backend request-logging middleware reuses a caller-provided
 * ``X-Request-ID``, so the browser line and the backend ``-->`` / ``<--`` lines
 * (plus every business log emitted while handling it) carry the same id. That is
 * what makes a single Run click traceable end to end.
 */
function newRequestId(action: string, scriptId: string, camera?: string): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36)
  return `ui-${action}-${scriptId}-${camera ? camera.replace(/\s+/g, '_') : 'all'}-${suffix}`
}

async function handle<T>(res: Response): Promise<T> {
  // 统一记录每一次后端 API 请求的响应状态，便于在浏览器控制台排障。
  // requestId 由后端 request-logging 中间件回填，可与后端日志逐条对应。
  const requestId = res.headers.get('X-Request-ID')
  console.log(`[api] ${res.status} ${redactUrl(res.url)}${requestId ? ` requestId=${requestId}` : ''}`)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? body.message ?? detail
    } catch {
      /* ignore parse errors */
    }
    console.error(`[api] request failed: ${res.status} ${redactUrl(res.url)} — ${detail}`)
    throw new Error(String(detail))
  }
  return res.json() as Promise<T>
}

export async function listFaces(): Promise<FaceData[]> {
  const res = await request(`${BASE_URL}/api/faces`)
  const data = await handle<FaceRecord[]>(res)
  return data.map(toFaceData)
}

export interface FaceMutationOutcome {
  face: FaceData
  validation?: FaceValidation
}

/** 新建人脸人员。targetOrgId 为显式目标组织（Add face data 的 Organization
 *  选择）：作为 form 字段 org_id 传给后端 _resolve_target_org，允许与当前
 *  active org 不同，且不改变页面当前组织视图。缺省沿用 active org（旧行为）。 */
export async function createFace(
  name: string,
  images: FaceImageInput[],
  targetOrgId?: string,
): Promise<FaceMutationOutcome> {
  const form = new FormData()
  form.append('name', name)
  for (const { file, angle } of images) {
    form.append('images', file)
    form.append('angles', angle)
  }
  const org = (targetOrgId || '').trim()
  if (org && org !== activeOrgId) form.append('org_id', org)
  const res = await request(`${BASE_URL}/api/faces`, { method: 'POST', body: form })
  const data = await handle<FaceMutationResult>(res)
  return { face: toFaceData(data), validation: data.validation }
}

export async function updateFace(id: number, name?: string, images?: FaceImageInput[]): Promise<FaceMutationOutcome> {
  const form = new FormData()
  if (name !== undefined) form.append('name', name)
  if (images && images.length) {
    for (const { file, angle } of images) {
      form.append('images', file)
      form.append('angles', angle)
    }
  }
  const res = await request(`${BASE_URL}/api/faces/${id}`, { method: 'PUT', body: form })
  const data = await handle<FaceMutationResult>(res)
  return { face: toFaceData(data), validation: data.validation }
}

export async function deleteFace(id: number): Promise<void> {
  const res = await request(`${BASE_URL}/api/faces/${id}`, { method: 'DELETE' })
  await handle(res)
}

// ---------------------------------------------------------------------------
// Camera management (SQLite-backed)
// ---------------------------------------------------------------------------

interface CameraRecord {
  id: string
  name: string
  rtmp: string
  status: 'online' | 'offline'
  resolution?: string
  rotate?: string
  organization?: string
  org_id?: string
  org_name?: string
  project_id?: string
  project_name?: string
  org_admin?: string
  deleted?: boolean
  created_at?: string
  updated_at?: string
}

function toCamera(r: CameraRecord): Camera {
  return {
    id: r.id,
    name: r.name,
    rtmp: r.rtmp,
    status: r.status,
    resolution: r.resolution,
    rotate: r.rotate,
    organization: r.organization,
    orgId: r.org_id ?? r.organization,
    orgName: r.org_name,
    projectId: r.project_id,
    projectName: r.project_name,
    org_admin: r.org_admin,
    deleted: r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listCameras(status?: string, organization?: string): Promise<Camera[]> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  // 显式组织（跨组织选摄像机，如 Add AI Model / AI model Filter）：查询参数与
  // X-Organization-Id 头必须指向同一组织，否则后端中间件判为冲突返回 400。
  if (organization) q.set('org_id', organization)
  const qs = q.toString()
  const res = await request(
    `${BASE_URL}/api/cameras${qs ? `?${qs}` : ''}`,
    organization ? { headers: { 'X-Organization-Id': organization } } : undefined,
  )
  const data = await handle<CameraRecord[]>(res)
  return data.map(toCamera)
}

export async function createCamera(
  name: string,
  rtmp: string,
  status: 'online' | 'offline',
  resolution?: string,
  rotate?: string,
  org_admin?: string,
  project_id?: string,
  orgId?: string,
): Promise<Camera> {
  console.log(`[api] createCamera name=${name} status=${status} org=${orgId ?? activeOrgId} rtmp=${redactUrl(rtmp)}`)
  // 后端按 X-Organization-Id 决定新摄像机归属；Add camera 选择的目标组织经头传入。
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (orgId) headers['X-Organization-Id'] = orgId
  // 跨组织新增：当前 X-Project-Id 属于原组织，不能带进目标组织（后端未选项目时
  // 用请求头项目落库，会写出「B 组织摄像机挂 A 组织项目」）。改用所选项目或默认项目。
  if (orgId && orgId !== activeOrgId) headers['X-Project-Id'] = project_id || DEFAULT_PROJECT_ID
  const res = await request(`${BASE_URL}/api/cameras`, {
    method: 'POST',
    headers,
      body: JSON.stringify({ name, rtmp, status, resolution, rotate, org_admin, project_id }),
  })
  return toCamera(await handle<CameraRecord>(res))
}

export async function updateCamera(
  id: string,
  fields: {
    name?: string
    rtmp?: string
    status?: 'online' | 'offline'
    resolution?: string
    rotate?: string
    org_id?: string
    org_name?: string
    org_admin?: string
    project_id?: string
  },
): Promise<Camera> {
  console.log(`[api] updateCamera id=${id} fields=${JSON.stringify({ ...fields, rtmp: fields.rtmp ? redactUrl(fields.rtmp) : undefined })}`)
  const res = await request(`${BASE_URL}/api/cameras/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return toCamera(await handle<CameraRecord>(res))
}

export async function deleteCamera(id: string): Promise<void> {
  const res = await request(`${BASE_URL}/api/cameras/${id}`, { method: 'DELETE' })
  await handle(res)
}

export interface CameraProbeResult {
  valid: boolean
  reachable: boolean
  stream_ok: boolean
  message: string
  width?: number
  height?: number
  fps?: number
}

export async function probeCamera(url: string): Promise<CameraProbeResult> {
  console.log(`[api] probeCamera url=${redactUrl(url)}`)
  const res = await request(`${BASE_URL}/api/cameras/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return handle<CameraProbeResult>(res)
}

export interface CameraCheckResult {
  camera_id: string
  name: string
  status: 'online' | 'offline'
  probe: CameraProbeResult
}

export async function checkCameraStream(name: string): Promise<CameraCheckResult> {
  const res = await request(`${BASE_URL}/api/cameras/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return handle<CameraCheckResult>(res)
}

// ---------------------------------------------------------------------------
// Scripts (detection objects) & detection events
// ---------------------------------------------------------------------------

interface ScriptParamRecord {
  value: number | boolean
  min?: number
  max?: number
  step?: number
  label?: string
  description?: string
  type?: 'float' | 'number' | 'checkbox'
}

interface ScriptRecord {
  id: string
  name: string
  meta: string
  loaded: boolean
  description?: string | null
  cameras: string[]
  organization?: string | null
  org_id?: string | null
  scenario?: string | null
  params?: Record<string, ScriptParamRecord>
  kpis?: string[][]
  custom?: boolean
  deleted?: boolean
  is_counting?: boolean
  is_segregation?: boolean
  is_roi_counting?: boolean
  is_face?: boolean
  is_port?: boolean
  detector_type?: string
  run?: { status: 'running' | 'stopped'; camera?: string | null; pid?: number | null }
}

function toScript(r: ScriptRecord): Script {
  const params: ScriptParam[] = Object.entries(r.params ?? {}).map(([key, p]) => ({
    key,
    label: p.label ?? key,
    value: p.value,
    min: p.min ?? 0,
    max: p.max ?? 100,
    step: p.step ?? 1,
    type: p.type ?? (typeof p.value === 'boolean' ? 'checkbox' : 'number'),
    description: p.description ?? '',
  }))
  return {
    id: r.id,
    name: r.id === 'face_yolo' ? 'Face Recognition New' : r.name,
    meta: r.meta,
    loaded: r.loaded,
    cameras: r.cameras,
    kpis: (r.kpis ?? []).map((kpi) => [kpi[0] ?? '', kpi[1] ?? '', kpi[2] ?? ''] as [string, string, string]),
    description: r.description ?? undefined,
    organization: r.organization ?? undefined,
    orgId: r.org_id ?? r.organization ?? undefined,
    scenario: r.scenario ?? undefined,
    custom: r.custom ?? false,
    deleted: r.deleted ?? false,
    isCounting: r.is_counting ?? false,
    isSegregation: r.is_segregation ?? false,
    isRoiCounting: r.is_roi_counting ?? false,
    isFace: r.is_face ?? false,
    isPort: r.is_port ?? false,
    isPickupBay: r.detector_type === 'pickup_bay',
    detectorType: r.detector_type ?? undefined,
    params,
  }
}

/**
 * AI model 目录。``organization`` = Filter 的 Organization（org_id，与
 * X-Organization-Id 指向同一组织）；``camera`` = camera ↔ AI model 关系过滤
 * （摄像机名称或 UUID，只返回指派到该摄像机的 AI model）。
 */
export async function listScripts(
  status?: string,
  organization?: string,
  scenario?: string,
  includeDeleted = false,
  camera?: string,
): Promise<{ scripts: Script[]; runs: Record<string, ScriptRun> }> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (organization) q.set('org_id', organization)
  if (scenario) q.set('scenario', scenario)
  if (camera) q.set('camera', camera)
  if (includeDeleted) q.set('include_deleted', 'true')
  const qs = q.toString()
  // 集合端点统一带尾斜杠：platform nginx 对无尾斜杠的 /api/scripts 触发
  // directory redirect（301, Location 降级 http），与 http→https 308 及后端
  // redirect_slashes 307 构成死循环 → NetworkError。带斜杠可直达后端 200。
  const res = await request(`${BASE_URL}/api/scripts/${qs ? `?${qs}` : ''}`)
  const data = await handle<ScriptRecord[]>(res)
  const scripts = data.map(toScript)
  const runs: Record<string, ScriptRun> = {}
  for (const r of data) {
    runs[r.id] = {
      status: r.run?.status ?? 'stopped',
      camera: r.run?.camera ?? undefined,
      pid: r.run?.pid ?? null,
    }
  }
  return { scripts, runs }
}

/**
 * 全部内置（static）AI model（含软删除），供 Add AI Model 的
 * 「Base AI model (detector wiring to clone)」下拉使用。
 *
 * 软删除的内置模型仍保留完整检测器接线，可继续作为克隆基座；用户自建的
 * custom 模型不可作基座（后端 is_static 校验），故后端已在响应中排除。
 */
export async function listBaseModels(): Promise<Script[]> {
  const res = await request(`${BASE_URL}/api/scripts/base-models`)
  const data = await handle<ScriptRecord[]>(res)
  return data.map(toScript)
}

export async function updateScriptMeta(
  id: string,
  fields: { organization?: string; scenario?: string },
): Promise<{ organization?: string; scenario?: string }> {
  const res = await request(`${BASE_URL}/api/scripts/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: fields.scenario }),
  })
  return handle<{ organization?: string; scenario?: string }>(res)
}

export async function runScript(id: string, camera?: string): Promise<ScriptRun> {
  const requestId = newRequestId('run', id, camera)
  console.log(`[run] AI model run requested: script=${id} camera=${camera ?? 'all'} requestId=${requestId}`)
  const res = await request(`${BASE_URL}/api/scripts/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
    body: JSON.stringify({ camera }),
  })
  return handle<ScriptRun>(res)
}

export async function stopScript(id: string, camera?: string): Promise<ScriptRun> {
  const requestId = newRequestId('stop', id, camera)
  console.log(`[run] AI model stop requested: script=${id} camera=${camera ?? 'all'} requestId=${requestId}`)
  const query = camera ? `?camera=${encodeURIComponent(camera)}` : ''
  const res = await request(`${BASE_URL}/api/scripts/${id}/stop${query}`, {
    method: 'POST',
    headers: { 'X-Request-ID': requestId },
  })
  return handle<ScriptRun>(res)
}

/**
 * Lightweight live run state for one AI model on one camera.
 *
 * The engine is the source of truth, so polling this keeps a long-running
 * preview honest: it stays "running" while the worker lives, and flips to
 * "stopped" the moment the worker exits (offline camera, model not ready).
 */
export async function getScriptStatus(id: string, camera?: string): Promise<ScriptRun> {
  const q = new URLSearchParams()
  if (camera) q.set('camera', camera)
  const qs = q.toString()
  const res = await request(`${BASE_URL}/api/scripts/${encodeURIComponent(id)}/status${qs ? `?${qs}` : ''}`)
  return handle<ScriptRun>(res)
}

// ---------------------------------------------------------------------------
// Per-camera run control (each camera of an AI model runs/stops on its own)
// ---------------------------------------------------------------------------

/** Per-camera run state, including whether the camera is online and startable. */
export async function listScriptCameras(scriptId: string): Promise<CameraModelRun[]> {
  const res = await request(`${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras`)
  return handle<CameraModelRun[]>(res)
}

/**
 * Assign a camera to an AI model.
 *
 * Writes the same relation row the Camera page creates through
 * `createCameraAI`, so the two pages stay interchangeable.
 */
export async function assignScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const res = await request(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}`,
    { method: 'POST' },
  )
  return handle<CameraModelRun>(res)
}

/** Unassign a camera from an AI model (stops its worker and drops its ROI). */
export async function unassignScriptCamera(scriptId: string, camera: string): Promise<void> {
  const res = await request(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}`,
    { method: 'DELETE' },
  )
  await handle(res)
}

export async function runScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const requestId = newRequestId('run', scriptId, camera)
  const startedAt = performance.now()
  console.log(`[run] AI model RUN requested: script=${scriptId} camera="${camera}" requestId=${requestId}`)
  try {
    const res = await request(
      `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}/run`,
      { method: 'POST', headers: { 'X-Request-ID': requestId } },
    )
    const result = await handle<CameraModelRun>(res)
    console.log(
      `[run] AI model RUN started: script=${scriptId} camera="${camera}" status=${result.status} ` +
        `cameraStatus=${result.camera_status} mode=${result.mode} elapsed=${(performance.now() - startedAt).toFixed(0)}ms requestId=${requestId}`,
    )
    return result
  } catch (err) {
    // The refusal reason (offline camera, no count line, worker died) matters
    // for support: log it with the correlation id before rethrowing to the UI.
    console.error(
      `[run] AI model RUN failed: script=${scriptId} camera="${camera}" elapsed=${(performance.now() - startedAt).toFixed(0)}ms ` +
        `requestId=${requestId} error=${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}

export async function stopScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const requestId = newRequestId('stop', scriptId, camera)
  const startedAt = performance.now()
  console.log(`[run] AI model STOP requested: script=${scriptId} camera="${camera}" requestId=${requestId}`)
  try {
    const res = await request(
      `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}/stop`,
      { method: 'POST', headers: { 'X-Request-ID': requestId } },
    )
    const result = await handle<CameraModelRun>(res)
    console.log(
      `[run] AI model STOP done: script=${scriptId} camera="${camera}" status=${result.status} ` +
        `elapsed=${(performance.now() - startedAt).toFixed(0)}ms requestId=${requestId}`,
    )
    return result
  } catch (err) {
    console.error(
      `[run] AI model STOP failed: script=${scriptId} camera="${camera}" elapsed=${(performance.now() - startedAt).toFixed(0)}ms ` +
        `requestId=${requestId} error=${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}

export async function stopAllScripts(): Promise<void> {
  const res = await request(`${BASE_URL}/api/scripts/stop-all`, { method: 'POST' })
  await handle(res)
}

export async function listAlerts(scriptId?: string): Promise<Alert[]> {
  const q = scriptId ? `?script_id=${encodeURIComponent(scriptId)}` : ''
  const res = await request(`${BASE_URL}/api/alerts${q}`)
  return handle<Alert[]>(res)
}

/**
 * Durable detection history for one AI model, camera, and UTC time window.
 *
 * The unfiltered ``/api/alerts`` call returns the newest rows of *every* model,
 * which cannot back the History dialog's per-script date filter.
 */
export async function listHistoryEvents(filters: {
  scriptId?: string
  cameraId?: string
  /** Inclusive UTC ISO bound. */
  start?: string
  /** Exclusive UTC ISO bound. */
  end?: string
  limit?: number
  offset?: number
} = {}): Promise<Alert[]> {
  const q = new URLSearchParams()
  if (filters.scriptId) q.set('script_id', filters.scriptId)
  if (filters.cameraId && filters.cameraId !== 'all') q.set('camera_id', filters.cameraId)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  if (filters.limit) q.set('limit', String(filters.limit))
  if (filters.offset) q.set('offset', String(filters.offset))
  const res = await request(`${BASE_URL}/api/alerts?${q.toString()}`)
  return handle<Alert[]>(res)
}

/**
 * Total matching events for the History dialog's pagination.
 *
 * Uses the same filters as ``listHistoryEvents`` so the page indicator can
 * never disagree with the rows actually returned by the backend.
 */
export async function countHistoryEvents(filters: {
  scriptId?: string
  cameraId?: string
  start?: string
  end?: string
} = {}): Promise<number> {
  const q = new URLSearchParams()
  if (filters.scriptId) q.set('script_id', filters.scriptId)
  if (filters.cameraId && filters.cameraId !== 'all') q.set('camera_id', filters.cameraId)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  const res = await request(`${BASE_URL}/api/alerts/count?${q.toString()}`)
  const data = await handle<{ total: number }>(res)
  return data.total ?? 0
}

// ---------------------------------------------------------------------------
// ROI
// ---------------------------------------------------------------------------

export interface RoiPolygon {
  id: number | null
  points: [number, number][]
}

export interface RoiInfo {
  script_id: string
  camera: string | null
  rois: RoiPolygon[]
}

function toRoiPolygon(r: { id?: number | null; points?: [number, number][] }): RoiPolygon {
  return {
    id: typeof r.id === 'number' ? r.id : null,
    points: (r.points ?? []).map((p) => [Number(p[0]), Number(p[1])] as [number, number]),
  }
}

/**
 * 判断 ROI 点集是否为归一化坐标（落在 [0,1] 的容差带内）。
 *
 * 历史 ROI 保存的是 ``Math.round`` 得到的整数像素坐标（真实 ROI 必有坐标 > 1），
 * 新数据保存的是浮点归一化坐标（0..1），因此用「是否全部在 [0,1] 内」即可区分。
 * 前端显示时据此把归一化坐标按当前帧尺寸换算成像素，像素数据则原样使用。
 *
 * 容差是必要的：ROI 编辑器的「扩展画布」允许在帧边缘外补点，保存的归一化坐标
 * 可能略小于 0 或略大于 1（如 1.004）。若严格限定 [0,1]，这类 ROI 会被误判为
 * 历史像素坐标，导致设置编辑器与 Preview 都把它画成左上角 1px 的小多边形。
 */
export function isNormalizedRoiPoints(points: [number, number][]): boolean {
  if (!points.length) return false
  const tol = 0.25
  return points.every(
    ([x, y]) =>
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= -tol &&
      x <= 1 + tol &&
      y >= -tol &&
      y <= 1 + tol,
  )
}

export async function getRoi(scriptId: string, camera: string): Promise<RoiInfo> {
  const q = new URLSearchParams({ camera })
  const res = await request(`${BASE_URL}/api/roi/${scriptId}?${q.toString()}`)
  const data = await handle<{ script_id: string; camera: string | null; rois?: RoiPolygon[]; points?: [number, number][] }>(res)
  // 兼容旧契约：旧后端返回单个 points，而非 rois
  const rois = data.rois?.length
    ? data.rois.map(toRoiPolygon)
    : data.points?.length
      ? [{ id: null, points: data.points.map((p) => [Number(p[0]), Number(p[1])] as [number, number]) }]
      : []
  return { script_id: data.script_id, camera: data.camera, rois }
}

export async function saveRoi(
  scriptId: string,
  camera: string,
  polygons: [number, number][][],
): Promise<RoiInfo> {
  console.log(`[api] saveRoi script=${scriptId} camera=${camera} polygons=${polygons.length}`)
  const res = await request(`${BASE_URL}/api/roi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script_id: scriptId, camera, rois: polygons.map((points) => ({ points })) }),
  })
  const data = await handle<{ script_id: string; camera: string | null; rois: RoiPolygon[] }>(res)
  return {
    script_id: data.script_id,
    camera: data.camera,
    rois: (data.rois ?? []).map(toRoiPolygon),
  }
}

export async function clearRoi(scriptId: string, camera: string): Promise<void> {
  console.log(`[api] clearRoi script=${scriptId} camera=${camera}`)
  const q = new URLSearchParams({ camera })
  const res = await request(`${BASE_URL}/api/roi/${scriptId}?${q.toString()}`, { method: 'DELETE' })
  await handle(res)
}

// ---------------------------------------------------------------------------
// Gate-line configuration — directional counting or static segregation boundary.
// ---------------------------------------------------------------------------

export interface GateConfigInfo {
  id?: number
  camera_id: string
  script_id: string
  gate_id: string
  location: string
  line_start_x: number
  line_start_y: number
  line_end_x: number
  line_end_y: number
  enabled: number | boolean
  /** +1: crossing toward the positive side is IN; -1: negative side is IN. */
  arrow_sign: 1 | -1
  positive_role: 'pedestrian' | 'vehicle'
  negative_role: 'pedestrian' | 'vehicle'
}

export interface GateReport {
  summary: { gate_id: string; location: string; in: number; out: number; net: number; occupancy: number }[]
  trend: { period: string; gate_id: string; in: number; out: number; total: number }[]
  peaks: { period: string; gate_id: string; total: number }[]
  rows: Record<string, unknown>[]
  baseline_assumption: string
}

export async function listGateConfigs(cameraId?: string, scriptId?: string): Promise<GateConfigInfo[]> {
  const q = new URLSearchParams()
  if (cameraId) q.set('camera_id', cameraId)
  if (scriptId) q.set('script_id', scriptId)
  const qs = q.toString()
  const res = await request(`${BASE_URL}/api/gates/config${qs ? `?${qs}` : ''}`)
  const data = await handle<{ gates: GateConfigInfo[] }>(res)
  return data.gates ?? []
}

export async function saveGateConfig(gate: {
  camera_id: string
  script_id?: string
  gate_id: string
  location: string
  line_start_x: number
  line_start_y: number
  line_end_x: number
  line_end_y: number
  enabled?: boolean
  arrow_sign?: 1 | -1
  positive_role?: 'pedestrian' | 'vehicle'
  negative_role?: 'pedestrian' | 'vehicle'
}): Promise<GateConfigInfo> {
  console.log(`[api] saveGateConfig camera=${gate.camera_id} script=${gate.script_id} gate=${gate.gate_id} location=${gate.location}`)
  const res = await request(`${BASE_URL}/api/gates/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, arrow_sign: 1, positive_role: 'pedestrian', negative_role: 'vehicle', ...gate }),
  })
  const data = await handle<{ gate: GateConfigInfo }>(res)
  return data.gate
}

export async function deleteGateConfig(cameraId: string, gateId: string, scriptId?: string): Promise<void> {
  console.log(`[api] deleteGateConfig camera=${cameraId} script=${scriptId} gate=${gateId}`)
  const q = scriptId ? `?script_id=${encodeURIComponent(scriptId)}` : ''
  const res = await request(
    `${BASE_URL}/api/gates/config/${encodeURIComponent(cameraId)}/${encodeURIComponent(gateId)}${q}`,
    { method: 'DELETE' },
  )
  await handle(res)
}

export async function getGateReport(filters: {
  cameraId?: string
  gateId?: string
  location?: string
  start?: string
  end?: string
  granularity?: 'hour' | 'day'
  role?: string
} = {}): Promise<GateReport> {
  const q = new URLSearchParams()
  if (filters.cameraId) q.set('camera_id', filters.cameraId)
  if (filters.gateId) q.set('gate_id', filters.gateId)
  if (filters.location) q.set('location', filters.location)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  if (filters.granularity) q.set('granularity', filters.granularity)
  if (filters.role) q.set('role', filters.role)
  const qs = q.toString()
  const res = await request(`${BASE_URL}/api/gates/report${qs ? `?${qs}` : ''}`)
  return handle<GateReport>(res)
}

export function gateReportExportUrl(filters: {
  cameraId?: string
  start?: string
  end?: string
  granularity?: 'hour' | 'day'
} = {}): string {
  const q = new URLSearchParams()
  if (filters.cameraId) q.set('camera_id', filters.cameraId)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  if (filters.granularity) q.set('granularity', filters.granularity)
  const qs = q.toString()
  return `${BASE_URL}/api/gates/export${qs ? `?${qs}` : ''}`
}

/** One count line's live counters (in/out follow the drawn arrow). */
export interface GateLiveLine {
  gate_id: string
  location: string
  arrow_sign: 1 | -1
  in: number
  out: number
  net: number
  person_in: number
  person_out: number
  day_in: number
  day_out: number
}

export interface GateLiveTotals {
  in: number
  out: number
  net: number
  person_in: number
  person_out: number
}

/** Cumulative people seen inside the ROI (now / session / day / all-time). */
export interface GateRoiPeople {
  now: number
  session: number
  day: number
  total: number
}

/** Cumulative vehicles seen inside the ROI (now / session / day / all-time). */
export interface GateRoiVehicles {
  now: number
  session: number
  day: number
  total: number
}

/** Live people-counting readout for the preview panel. */
export interface GateLiveInfo {
  camera_id: string
  script_id: string | null
  running: boolean
  /** Pedestrian / Vehicle Segregation: static boundary, no IN/OUT semantics. */
  is_segregation: boolean
  mode: string
  roi_configured: boolean
  /** People detected inside the drawn ROI on the worker's latest frame. */
  people_in_roi: number
  /** Vehicles detected inside the drawn ROI on the worker's latest frame. */
  vehicles_in_roi: number
  detections: number
  run_id: string | null
  updated_at: string | null
  /** Cumulative ROI people count, backed by the durable presence facts. */
  roi_people: GateRoiPeople
  /** Cumulative ROI vehicle count, backed by the durable presence facts. */
  roi_vehicles: GateRoiVehicles
  session: GateLiveTotals
  day: GateLiveTotals & { start: string; end: string }
  lines: GateLiveLine[]
}

export async function getGateLive(cameraId: string, scriptId?: string): Promise<GateLiveInfo> {
  const q = new URLSearchParams({ camera_id: cameraId })
  if (scriptId) q.set('script_id', scriptId)
  const res = await request(`${BASE_URL}/api/gates/live?${q.toString()}`)
  return handle<GateLiveInfo>(res)
}

/** One recognized person, deduplicated by name within a 5-minute window. */
export interface FaceLivePerson {
  name: string
  confidence: number
  /** Number of times recognized within the current 5-minute window. */
  count?: number
  /** UTC ISO timestamp of the first recognition in this window. */
  first_seen_at?: string
  /** UTC ISO timestamp of the most recent recognition in this window. */
  last_seen_at?: string
  /** @deprecated superseded by last_seen_at; kept for older backends. */
  detected_at?: string
}

/** Live face-recognition readout for the preview panel. */
export interface FaceLiveInfo {
  camera_id: string
  script_id: string | null
  running: boolean
  mode: string
  updated_at: string | null
  detections: number
  recognized: number
  unknown: number
  people: FaceLivePerson[]
}

export async function getFaceLive(cameraId: string, scriptId?: string): Promise<FaceLiveInfo> {
  const q = new URLSearchParams({ camera_id: cameraId })
  if (scriptId) q.set('script_id', scriptId)
  const res = await request(`${BASE_URL}/api/faces/live?${q.toString()}`)
  return handle<FaceLiveInfo>(res)
}

// ---------------------------------------------------------------------------
// Port / quay-crane live readouts
// ---------------------------------------------------------------------------

/** Live quay-crane cycle readout (Axxon spreader view). */
export interface CraneLiveInfo {
  camera_id: string
  script_id: string | null
  running: boolean
  mode: string
  state: string
  spreaders: number
  containers: number
  hatches: number
  updated_at: string | null
  containers_today: number
  containers_completed: number
}

export async function getCraneLive(cameraId: string, scriptId?: string): Promise<CraneLiveInfo> {
  const q = new URLSearchParams({ camera_id: cameraId })
  if (scriptId) q.set('script_id', scriptId)
  const res = await request(`${BASE_URL}/api/port/crane/live?${q.toString()}`)
  return handle<CraneLiveInfo>(res)
}

/** One crane-cycle job: pick-up → landing with the measured container duration. */
export interface CraneJob {
  id: number
  camera_id: string
  script_id: string
  run_id: string
  job_type: string
  target_class: string
  pick_up_at: string
  landing_at: string
  duration_seconds: number | null
  confidence: number
  mode: string
  container_id: string
  container_sequence: number
  containers_completed: number
}

export async function getCraneJobs(scriptId?: string, limit = 20, cameraId?: string): Promise<CraneJob[]> {
  const q = new URLSearchParams()
  if (scriptId) q.set('script_id', scriptId)
  if (cameraId) q.set('camera_id', cameraId)
  q.set('limit', String(limit))
  const res = await request(`${BASE_URL}/api/port/crane/jobs?${q.toString()}`)
  return handle<{ jobs: CraneJob[] }>(res).then((r) => r.jobs)
}

/** Cross-camera port overview: trucks in ROI + cumulative counters. */
export interface PortOverview {
  trucks_in_roi: number
  trucks_today: number
  trucks_since_start: number
  trucks: {
    track_id: number | null
    visit_key: string | null
    camera: string
    entered_at: string | null
    exited_at: string | null
    dwell_seconds: number | null
    dwell: string | null
    active: boolean
    vehicle_state: 'empty' | 'loading' | 'loaded' | 'unknown'
    loaded: boolean
    loading: boolean
    appearance: {
      enter: { aspect_ratio: number | null; area_ratio: number | null; histogram_dim: number; ocr_text_ids?: string[] } | null
      exit: { aspect_ratio: number | null; area_ratio: number | null; histogram_dim: number; ocr_text_ids?: string[] } | null
    } | null
  }[]
}

/** Live pickup-bay readout; the backend reuses the port live contract. */
export interface PickupBayLiveInfo {
  camera_id: string
  script_id: string | null
  running: boolean
  mode: string
  trucks_in_roi: number
  updated_at: string | null
  trucks: {
    track_id: number | null
    entered_at: string | null
    dwell_seconds: number | null
    dwell: string | null
    loading: boolean
    vehicle_state: string
    confidence?: number | null
  }[]
}

export async function getPickupBayLive(cameraId: string, scriptId?: string): Promise<PickupBayLiveInfo> {
  const q = new URLSearchParams({ camera_id: cameraId })
  if (scriptId) q.set('script_id', scriptId)
  const res = await request(`${BASE_URL}/api/port/live?${q.toString()}`)
  return handle<PickupBayLiveInfo>(res)
}

export async function getPortOverview(scriptId?: string, limit = 50): Promise<PortOverview> {
  const q = new URLSearchParams()
  if (scriptId) q.set('script_id', scriptId)
  q.set('limit', String(limit))
  const res = await request(`${BASE_URL}/api/port/overview?${q.toString()}`)
  return handle<PortOverview>(res)
}

// ---------------------------------------------------------------------------
// Stream URLs (MJPEG preview + snapshot)
// ---------------------------------------------------------------------------

export function streamUrl(
  camera: string,
  scriptId: string,
  annotate: boolean,
  roiOverlay = true,
  cacheBust?: string | number,
): string {
  const q = new URLSearchParams({
    camera,
    script_id: scriptId,
    annotate: String(annotate),
    roi_overlay: String(roiOverlay),
    org_id: activeOrgId,
  })
  // Cosmos projectId 已在入口校验（占位符/undefined 绝不采用）并随启动
  // ensureTenantContextSynced 落库；<img> 无法带 header，合法且非 default
  // 时随 URL 传给后端。后端项目维度宽松（_require_media_camera）：与摄像机
  // 归属不一致时屏蔽回退 default 通配，preview 仍可用；组织隔离由 org_id
  // 严格保证。default 本身即通配范围，无需携带。
  if (isValidTenantKey(activeProjectId) && activeProjectId !== DEFAULT_PROJECT_ID) {
    q.set('project_id', activeProjectId)
  }
  if (cosmosAnchor) q.set('cosmos_org_id', cosmosAnchor)
  if (cacheBust !== undefined) q.set('stream_nonce', String(cacheBust))
  const url = `${BASE_URL}/api/stream?${q.toString()}`
  // MJPEG 实时流由 <img> 原生加载，无法走 request()：在此记录媒体流请求（外部接收）。
  console.info(`[media] stream request camera=${camera} script=${scriptId} annotate=${annotate}`, redactUrl(url))
  return url
}

export function snapshotUrl(camera: string, scriptId: string, annotate: boolean): string {
  const q = new URLSearchParams({ camera, script_id: scriptId, annotate: String(annotate), org_id: activeOrgId })
  // 与 streamUrl 同一策略：合法且非 default 的 projectId 随 URL 传入后端。
  if (isValidTenantKey(activeProjectId) && activeProjectId !== DEFAULT_PROJECT_ID) {
    q.set('project_id', activeProjectId)
  }
  if (cosmosAnchor) q.set('cosmos_org_id', cosmosAnchor)
  const url = `${BASE_URL}/api/stream/snapshot?${q.toString()}`
  console.info(`[media] snapshot request camera=${camera} script=${scriptId}`, redactUrl(url))
  return url
}

export interface StreamProbeResult {
  ok: boolean
  /** HTTP status; 0 when the request never reached the backend (network/CORS/timeout). */
  status: number
  /** Human-readable reason, taken from the backend `detail` when available. */
  message: string
}

/**
 * Diagnose a stream URL that an `<img>` failed to load.
 *
 * An `<img>` error event carries no status code or body, so the UI cannot tell
 * "camera offline" from "403 wrong org" from "gateway timeout". This opens the
 * same URL with fetch (with tenant headers), reads only the response headers
 * (or the error body), then aborts so the MJPEG connection is not left open.
 */
export async function probeStream(url: string, timeoutMs = 8000): Promise<StreamProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await request(url, { signal: controller.signal, cache: 'no-store' })
    if (res.ok) {
      const type = res.headers.get('content-type') ?? ''
      controller.abort()
      if (type && !/multipart|image\//i.test(type)) {
        return { ok: false, status: res.status, message: `Unexpected stream content-type "${type}" (check the /api proxy route).` }
      }
      return { ok: true, status: res.status, message: '' }
    }
    let message = res.statusText || `HTTP ${res.status}`
    try {
      const text = await res.text()
      try {
        const body = JSON.parse(text) as { detail?: unknown; message?: unknown }
        const detail = body.detail ?? body.message
        if (typeof detail === 'string' && detail) message = detail
        else if (detail) message = JSON.stringify(detail)
      } catch {
        if (text.trim() && text.length < 300) message = text.trim()
      }
    } catch { /* body unreadable */ }
    return { ok: false, status: res.status, message }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      message: aborted ? 'Stream did not respond in time.' : 'Cannot reach the stream endpoint (network error).',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchTenantAsset(url: string): Promise<Response> {
  return request(url)
}

// ---------------------------------------------------------------------------
// AI model CRUD
// ---------------------------------------------------------------------------

/**
 * Create a custom AI model. The backend clones the detector wiring of
 * `base_script_id` (a built-in scenario), so it is required.
 *
 * `orgIds` allows a model to belong to MULTIPLE organizations (multi-org);
 * `camera` optionally assigns the new model to one camera immediately.
 */
export async function createScript(fields: {
  name: string
  base_script_id: string
  description?: string
  scenario?: string
  org_ids?: string[]
  camera?: string
}): Promise<Script> {
  // 带尾斜杠：绕过 platform nginx 对无斜杠 /api/scripts 的 directory redirect
  // 301（Location 降级 http）造成的 301↔308↔307 死循环（fetch → NetworkError）。
  const res = await request(`${BASE_URL}/api/scripts/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return toScript(await handle<ScriptRecord>(res))
}

/** Soft-delete one AI model (restorable through `restoreScript`). */
export async function deleteScript(id: string): Promise<void> {
  const res = await request(`${BASE_URL}/api/scripts/${id}`, { method: 'DELETE' })
  await handle(res)
}

/** Bring a soft-deleted AI model back into the catalog. */
export async function restoreScript(id: string): Promise<Script> {
  const res = await request(`${BASE_URL}/api/scripts/${id}/restore`, { method: 'POST' })
  return toScript(await handle<ScriptRecord>(res))
}

/** Soft-deleted AI models only (candidates for restore). */
export async function listDeletedScripts(): Promise<Script[]> {
  const { scripts } = await listScripts(undefined, undefined, undefined, true)
  return scripts.filter((s) => s.deleted)
}

// ---------------------------------------------------------------------------
// Per-camera AI model instances
// ---------------------------------------------------------------------------

interface CameraAIRecord {
  iid: number
  camera: string
  script_id: string
  name: string
  enabled: boolean
  output?: string
  params?: Record<string, number | boolean>
  view_role?: string
}

function toCameraAI(r: CameraAIRecord): CameraAI {
  return { iid: r.iid, camera: r.camera, scriptId: r.script_id, name: r.name, enabled: r.enabled, output: r.output, params: r.params, viewRole: r.view_role ?? '' }
}

export async function listCameraAI(): Promise<CameraAI[]> {
  const res = await request(`${BASE_URL}/api/camera-ai`)
  const data = await handle<CameraAIRecord[]>(res)
  return data.map(toCameraAI)
}

export async function createCameraAI(fields: {
  camera: string
  scriptId: string
  name?: string
  enabled?: boolean
  output?: string
  params?: Record<string, number | boolean>
  viewRole?: string
}): Promise<CameraAI> {
  const res = await request(`${BASE_URL}/api/camera-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera: fields.camera, script_id: fields.scriptId, name: fields.name, enabled: fields.enabled, output: fields.output, params: fields.params, view_role: fields.viewRole }),
  })
  return toCameraAI(await handle<CameraAIRecord>(res))
}

export async function updateCameraAI(
  iid: number,
  fields: { name?: string; enabled?: boolean; output?: string; params?: Record<string, number | boolean>; viewRole?: string },
): Promise<CameraAI> {
  const res = await request(`${BASE_URL}/api/camera-ai/${iid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fields.name, enabled: fields.enabled, output: fields.output, params: fields.params, view_role: fields.viewRole }),
  })
  return toCameraAI(await handle<CameraAIRecord>(res))
}

export async function deleteCameraAI(iid: number): Promise<void> {
  const res = await request(`${BASE_URL}/api/camera-ai/${iid}`, { method: 'DELETE' })
  await handle(res)
}
