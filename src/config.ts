// 运行期配置（方案 deploy/Cosmos-SSO-cmp-webapp-Migration-Plan.md §3.3）。
//
// 线上：nginx 镜像在容器启动时按环境变量渲染 /config.js（见 nginx.conf.template），
//       同一镜像可跑 dev / prod；默认 cmp-webapp，AUTH_FLOW=legacy 改 env 重启即回滚。
// 本地：public/config.js 为空对象，回退到 .env 的 VITE_* 变量（npm run dev）。

export type AuthFlow = 'legacy' | 'cmp-webapp'

export interface RuntimeConfig {
  /** cmp-webapp（默认）= 前端 PKCE / iframe token bridge；legacy = 后端 /auth/login（poc-ai-demo client，回滚用）。 */
  authFlow: AuthFlow
  /** Keycloak 根地址（含 /auth），如 https://cosmos-dev.varadise.cloud/auth。 */
  authBaseUrl: string
  authRealm: string
  authClientId: string
  /** 允许下发 token 的 Cosmos 母站 origin（与 nginx frame-ancestors 共用 COSMOS_PARENT_ORIGIN）。 */
  cosmosOrigins: string[]
  /** /auth/session、/auth/me 的前缀；空 = 同源（推荐，CSRF 校验要求同源）。 */
  bffBaseUrl: string
}

type RawConfig = Partial<Record<keyof RuntimeConfig, string>>

declare global {
  interface Window {
    __POC_CONFIG__?: RawConfig
  }
}

/** 未渲染的 envsubst 占位符（${X}）与空白都视为未配置。 */
function clean(value: string | undefined): string {
  const v = (value || '').trim()
  return v.startsWith('${') ? '' : v
}

function pick(runtime: string | undefined, build: string | undefined, fallback = ''): string {
  return clean(runtime) || clean(build) || fallback
}

export function loadRuntimeConfig(
  raw: RawConfig = (typeof window !== 'undefined' && window.__POC_CONFIG__) || {},
  env: ImportMetaEnv = import.meta.env,
): RuntimeConfig {
  // 默认 cmp-webapp（新模式）；只有显式 legacy 才回滚到后端 /auth/login。
  // 后端未开启 /auth/session 时 auth.ts 会自动回退 legacy，不会因此无法登录。
  const flow = pick(raw.authFlow, env.VITE_AUTH_FLOW, 'cmp-webapp')
  return {
    authFlow: flow === 'legacy' ? 'legacy' : 'cmp-webapp',
    authBaseUrl: pick(raw.authBaseUrl, env.VITE_AUTH_BASE_URL).replace(/\/+$/, ''),
    authRealm: pick(raw.authRealm, env.VITE_AUTH_REALM),
    authClientId: pick(raw.authClientId, env.VITE_AUTH_CLIENT_ID, 'cmp-webapp'),
    cosmosOrigins: pick(raw.cosmosOrigins, env.VITE_COSMOS_ORIGIN)
      .split(/[\s,]+/)
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    bffBaseUrl: pick(raw.bffBaseUrl, env.VITE_BFF_BASE_URL).replace(/\/+$/, ''),
  }
}

export const runtimeConfig: RuntimeConfig = loadRuntimeConfig()
