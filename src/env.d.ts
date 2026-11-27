/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_BACKEND_TARGET?: 'local' | 'cloud'
  readonly VITE_LOCAL_API_BASE?: string
  readonly VITE_DEFAULT_PROJECT_ID?: string
  readonly VITE_DEFAULT_PROJECT_NAME?: string
  // Cosmos 统一登录（本地开发兜底；线上由运行期 /config.js 提供，见 src/config.ts）
  readonly VITE_AUTH_FLOW?: string
  readonly VITE_AUTH_BASE_URL?: string
  readonly VITE_AUTH_REALM?: string
  readonly VITE_AUTH_CLIENT_ID?: string
  readonly VITE_COSMOS_ORIGIN?: string
  readonly VITE_BFF_BASE_URL?: string
}
