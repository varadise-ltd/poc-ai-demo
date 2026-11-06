/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_BACKEND_TARGET?: 'local' | 'cloud'
  readonly VITE_LOCAL_API_BASE?: string
  readonly VITE_CLOUD_API_BASE?: string
}
