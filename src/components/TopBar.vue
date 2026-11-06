<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { backendLabel, getBackendMode, getInferenceDevice, getOrganization, getProject, syncTenantContext, type BackendMode } from '../api'
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

async function loadTenantContext(): Promise<void> {
  // profile-service 是权威名称来源；失败时回退到后端本地落库的 records。
  try {
    const synced = await syncTenantContext(store.activeOrgId, store.projectId)
    store.activeOrgName = synced.organization?.name || store.activeOrgId
    store.activeProjectName = synced.project?.name || store.projectId
    return
  } catch {
    // profile-service 不可用 → 回退本地 records。
  }
  try {
    const [org, selectedProject] = await Promise.all([
      getOrganization(store.activeOrgId),
      getProject(store.projectId),
    ])
    store.activeOrgName = org.name || store.activeOrgId
    store.activeProjectName = selectedProject.name || store.projectId
  } catch {
    store.activeOrgName = store.activeOrgId
    store.activeProjectName = store.projectId
  }
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
