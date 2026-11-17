/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_BACKEND_TARGET?: 'local' | 'cloud'
  readonly VITE_LOCAL_API_BASE?: string
  readonly VITE_DEFAULT_ORG_ID?: string
  readonly VITE_DEFAULT_ORG_NAME?: string
  readonly VITE_DEFAULT_PROJECT_ID?: string
  readonly VITE_DEFAULT_PROJECT_NAME?: string
  /** 'true' 启用 Cosmos SSO 登录页（独立部署）；iframe 嵌入 Cosmos 时保持关闭。
   *  注意：当前 src/auth.ts 的 AUTH_MASTER_ENABLED=false 总开关强制停用，本变量暂不生效。 */
  readonly VITE_AUTH_ENABLED?: string
  readonly VITE_OIDC_ISSUER?: string
  readonly VITE_OIDC_CLIENT_ID?: string
  readonly VITE_OIDC_REDIRECT_URI?: string
  readonly VITE_OIDC_POST_LOGOUT_REDIRECT_URI?: string
  readonly VITE_OIDC_SCOPE?: string
  readonly VITE_OIDC_ALLOWED_ROLES?: string
  readonly VITE_OIDC_REQUIRE_ORG_CODE?: string
}
