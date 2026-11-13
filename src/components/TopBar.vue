<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { backendLabel, getBackendMode, getDefaultOrgName, getDefaultProjectName, getInferenceDevice, getOrganization, getProject, syncTenantContext, type BackendMode } from '../api'
import { store } from '../store'

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
    const synced = await syncTenantContext(store.activeOrgId, store.projectId)
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
      <button class="top-menu" aria-label="More options">⋮</button>
    </div>
  </header>
</template>
