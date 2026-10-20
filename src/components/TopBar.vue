<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listOrganizations } from '../api'
import { setActiveOrgId, store } from '../store'

const organizations = ref<{ org_id: string; name: string; status: 'active' | 'disabled' }[]>([])
const loading = ref(false)

async function loadOrganizations(): Promise<void> {
  loading.value = true
  try {
    organizations.value = (await listOrganizations()).filter((org) => org.status === 'active')
  } catch {
    organizations.value = []
  } finally {
    loading.value = false
  }
}

async function changeOrganization(): Promise<void> {
  await setActiveOrgId(store.activeOrgId)
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    document.documentElement.requestFullscreen()
  }
}

onMounted(loadOrganizations)
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
      <label class="org-selector">
        <span>Org</span>
        <select v-model="store.activeOrgId" :disabled="loading" @change="changeOrganization">
          <option v-if="!organizations.length" :value="store.activeOrgId">{{ store.activeOrgId }}</option>
          <option v-for="org in organizations" :key="org.org_id" :value="org.org_id">
            {{ org.name || org.org_id }}
          </option>
        </select>
      </label>
      <span class="status"><span class="dot"></span> All systems operational</span>
      <span class="language-chip">EN</span>
      <button class="top-btn" @click="toggleFullscreen">Fullscreen</button>
      <button class="top-menu" aria-label="More options">⋮</button>
    </div>
  </header>
</template>
