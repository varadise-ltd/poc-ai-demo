<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { backendLabel, ensureTenantContextSynced, getBackendMode, getDefaultOrgName, getDefaultProjectName, getInferenceDevice, getOrganization, getProject, type BackendMode } from '../api'
import { setActiveOrgId, store } from '../store'
import { auth, logout } from '../auth'

const backendMode = ref<BackendMode>(getBackendMode())
const backendStatus = ref(backendLabel())
const inferenceDevice = ref('')

async function refreshInferenceDevice(): Promise<void> {
  try {
    const info = await getInferenceDevice()
    inferenceDevice.value = info.mode === 'gpu'
      ? `GPU · ${info.device}`
      : `CPU · requested ${info.requested_device}`
  } catch {
    inferenceDevice.value = 'Unknown'
  }
}

// 展示层铁律：orgname 只展示明文 name，绝不显示 UUID。后端在 profile-service
// 未就绪时会用 org_id（UUID）兜底当 name；这里把 UUID 识别出来并回退到默认名。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function displayName(name: string | undefined | null, fallback: string): string {
  const v = (name || '').trim()
  return (!v || UUID_RE.test(v)) ? fallback : v
}

async function loadTenantContext(): Promise<void> {
  // orgId/projectId（UUID）仅用于传输/记录；展示必须解析成明文 name。
  // 三层解析：profile-service（权威）→ 后端本地 records → 默认名（绝不 UUID）。
  const defaultOrgName = getDefaultOrgName()
  const defaultProjectName = getDefaultProjectName()
  try {
    // 与 main.ts 启动落库共用同一次 sync-context 请求（记忆化）；启动失败时
    // 这里自动重试。后端已把 Cosmos orgId/projectId 持久化并解析权威名称。
    const synced = await ensureTenantContextSynced(store.activeOrgId, store.projectId)
    // 后端把组织名选择器（如回退值 'Varadise'）规范化为 UUID 租户键；前端采纳
    // 该规范键，保证下拉框 / 跨组织判断 / <img> 的 org_id 与后端同一个值。
    const canonicalOrgId = synced.organization?.org_id?.trim()
    if (canonicalOrgId && canonicalOrgId !== store.activeOrgId) {
      void setActiveOrgId(canonicalOrgId)
    }
    store.activeOrgName = displayName(synced.organization?.org_name, defaultOrgName)
    store.activeProjectName = displayName(synced.project?.project_name, defaultProjectName)
  } catch {
    // profile-service 不可用 → 回退本地 records。
  }
  if (!store.activeOrgName || store.activeOrgName === defaultOrgName) {
    try {
      const [org, selectedProject] = await Promise.all([
        getOrganization(store.activeOrgId),
        getProject(store.projectId),
      ])
      const orgName = displayName(org.org_name, defaultOrgName)
      const projectName = displayName(selectedProject.project_name, defaultProjectName)
      // 仅在拿到了真实明文名（非默认兜底）时才覆盖。
      if (orgName !== defaultOrgName) store.activeOrgName = orgName
      if (projectName !== defaultProjectName) store.activeProjectName = projectName
    } catch {
      // 解析失败：保持默认名。
      store.activeOrgName = store.activeOrgName || defaultOrgName
      store.activeProjectName = store.activeProjectName || defaultProjectName
    }
  }
  // 最终兜底：无论如何，展示层绝不出现 UUID。
  store.activeOrgName = displayName(store.activeOrgName, defaultOrgName)
  store.activeProjectName = displayName(store.activeProjectName, defaultProjectName)
  // 链路日志：租户名称解析结果（链路的末端「得到相应信息」）。与 api.ts 的
  // [cosmos-chain] init/req 日志、后端「tenant scope resolved」日志串成完整链路。
  console.info('[cosmos-chain] tenant name resolved', {
    orgId: store.activeOrgId,
    projectId: store.projectId,
    orgName: store.activeOrgName,
    projectName: store.activeProjectName,
  })
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    document.documentElement.requestFullscreen()
  }
}

onMounted(() => {
  refreshInferenceDevice()
  loadTenantContext()
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"></span>
      <div>
        COSMOS
        <small>AI CAM POC CENTER</small>
      </div>
    </div>
    <div class="top-actions">
      <label class="org-selector backend-selector" title="Controlled by VITE_BACKEND_TARGET in the frontend service environment">
        <span>Backend</span>
        <strong>{{ backendMode === 'local' ? 'Local GPU' : 'Cloud CPU' }}</strong>
        <small>{{ backendStatus }}</small>
      </label>
      <span class="language-chip" :title="'Inference device: ' + inferenceDevice">{{ inferenceDevice || 'Device…' }}</span>
      <span class="status"><span class="dot"></span> All systems operational</span>
      <span class="language-chip">EN</span>
      <button class="top-btn" @click="toggleFullscreen">Fullscreen</button>
      <span v-if="auth.enabled && auth.user" class="language-chip" :title="auth.user.email || auth.user.username">
        {{ auth.user.name || auth.user.username }}
      </span>
      <button v-if="auth.enabled && auth.user" class="top-btn" @click="logout">Sign out</button>
      <button class="top-menu" aria-label="More options">⋮</button>
    </div>
  </header>
</template>
