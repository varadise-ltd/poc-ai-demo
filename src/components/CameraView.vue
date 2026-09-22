<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listCameras as apiListCameras } from '../api'
import {
  addCameraAIRecord,
  loadCameraAI,
  loadCameras,
  loadScripts,
  removeCameraAIRecord,
  removeCameraRecord,
  store,
  updateCameraAIRecord,
} from '../store'
import type { Camera, CameraAI } from '../types'
import CameraEditorModal from './modals/CameraEditorModal.vue'
import AiDetailModal from './modals/AiDetailModal.vue'
import AddAiModal from './modals/AddAiModal.vue'

// Camera filter (server-side filtering via GET /api/cameras?status=&organization=)
const cameraFilterStatus = ref('')
const cameraFilterOrg = ref('')
const cameraFilterLoading = ref(false)
// null = 未筛选，展示完整列表；否则展示后端筛选结果
const filteredCameras = ref<Camera[] | null>(null)

// 组织机构下拉选项：取自当前完整摄像机列表的去重 organization
const cameraOrgOptions = computed(() => {
  const orgs = new Set<string>()
  for (const c of store.cameras) {
    const org = (c.organization ?? '').trim()
    if (org) orgs.add(org)
  }
  return [...orgs].sort()
})

// 列表展示数据：筛选态用后端结果，否则用完整列表
const displayedCameras = computed(() => filteredCameras.value ?? store.cameras)

async function applyCameraFilter(): Promise<void> {
  cameraFilterLoading.value = true
  try {
    filteredCameras.value = await apiListCameras(
      cameraFilterStatus.value || undefined,
      cameraFilterOrg.value || undefined,
    )
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    cameraFilterLoading.value = false
  }
}

function resetCameraFilter(): void {
  cameraFilterStatus.value = ''
  cameraFilterOrg.value = ''
  filteredCameras.value = null
}

// 相机展开：显示该相机下配置的 AI model 实例（参考 index 框架的展开结构）
const cameraExpanded = ref<Record<string, boolean>>({})

function toggleCameraExpand(name: string): void {
  cameraExpanded.value[name] = !cameraExpanded.value[name]
}

// 每个相机下的 AI model 实例：来自后端 camera_ai（index 的 cameraAI 结构）
function cameraInstances(camName: string): CameraAI[] {
  return store.cameraAI.filter((a) => a.camera === camName)
}

async function onToggleInstance(inst: CameraAI): Promise<void> {
  try {
    await updateCameraAIRecord(inst.iid, { enabled: !inst.enabled })
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

// ⋯ 菜单（单实例，点击外部关闭）
const aiMenu = ref<{ iid: number; camera: string } | null>(null)

function toggleAiMenu(e: MouseEvent, inst: CameraAI): void {
  e.stopPropagation()
  aiMenu.value = aiMenu.value?.iid === inst.iid ? null : { iid: inst.iid, camera: inst.camera }
}

function closeAiMenu(): void {
  aiMenu.value = null
}

async function onDeleteInstance(inst: CameraAI): Promise<void> {
  closeAiMenu()
  if (!window.confirm(`Delete the AI model "${inst.name}" from ${inst.camera}? This removes its custom configuration and cannot be undone.`)) return
  try {
    await removeCameraAIRecord(inst.iid)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

function openCameraEditor(cam: Camera): void {
  store.cameraEditorMode = 'edit'
  store.cameraEditorId = cam.id
  store.cameraEditorTitle = cam.name
  store.cameraEditorName = cam.name
  store.cameraEditorRtmp = cam.rtmp
  store.cameraEditorResolution = cam.resolution ?? '1920 × 1080'
  store.cameraEditorRotate = cam.rotate ?? '0°'
  store.cameraEditorOrganization = cam.organization ?? ''
  store.cameraEditorOrgAdmin = cam.org_admin ?? ''
  store.cameraEditorChanged = false
  store.showCameraEditor = true
}

function addCamera(): void {
  store.cameraEditorMode = 'add'
  store.cameraEditorId = null
  store.cameraEditorTitle = ''
  store.cameraEditorName = ''
  store.cameraEditorRtmp = ''
  store.cameraEditorResolution = '1920 × 1080'
  store.cameraEditorRotate = '0°'
  store.cameraEditorOrganization = ''
  store.cameraEditorOrgAdmin = ''
  store.cameraEditorChanged = false
  store.showCameraEditor = true
}

async function removeCamera(cam: Camera): Promise<void> {
  if (!window.confirm(`Remove "${cam.name}"? This cannot be undone.`)) return
  try {
    await removeCameraRecord(cam.id)
    resetCameraFilter()
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

// AI model 实例详情（Common / ROI setting）
function openAiDetail(inst: CameraAI): void {
  closeAiMenu()
  store.aiDetailCamera = inst.camera
  store.aiDetailScriptId = inst.scriptId
  store.aiDetailIid = inst.iid
  store.showAiDetail = true
}

// Add AI modal
const addAiCamera = ref('')

function openAddAi(camName: string): void {
  addAiCamera.value = camName
  store.showAddAi = true
}

async function onConfirmAddAi(payload: { scriptId: string; name: string; enabled: boolean; output: string; params: Record<string, number | boolean> }): Promise<void> {
  try {
    await addCameraAIRecord({
      camera: addAiCamera.value,
      scriptId: payload.scriptId,
      name: payload.name,
      enabled: payload.enabled,
      output: payload.output,
      params: payload.params,
    })
    cameraExpanded.value[addAiCamera.value] = true
    store.showAddAi = false
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

onMounted(async () => {
  await Promise.all([loadCameras(), loadScripts(), loadCameraAI()])
})
</script>

<template>
  <section @click="closeAiMenu">
    <div class="page-head">
      <div>
        <h1>Camera setting</h1>
        <p class="subtitle">Register raw cameras by pasting the RTMP address assigned by CCTV Hub.</p>
      </div>
    </div>

    <section class="panel config-content">
      <div class="config-head">
        <p class="subtitle">Add, edit and manage multiple camera sources.</p>
        <button class="btn primary" @click="addCamera">+ Add camera</button>
      </div>
      <div class="camera-filter-bar">
        <div class="field">
          <label>Status</label>
          <select v-model="cameraFilterStatus">
            <option value="">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
        </div>
        <div class="field">
          <label>Organization</label>
          <select v-model="cameraFilterOrg">
            <option value="">All organizations</option>
            <option v-for="org in cameraOrgOptions" :key="org" :value="org">{{ org }}</option>
          </select>
        </div>
        <div class="filter-actions">
          <button class="btn primary" :disabled="cameraFilterLoading" @click="applyCameraFilter">
            {{ cameraFilterLoading ? 'Filtering…' : 'Filter' }}
          </button>
          <button class="btn" @click="resetCameraFilter">Reset</button>
        </div>
      </div>
      <div v-if="store.cameraLoading" class="detail-empty">Loading cameras…</div>
      <div v-else-if="store.cameraError" class="detail-empty" style="color: var(--red)">{{ store.cameraError }}</div>
      <div v-else class="config-list">
        <div v-for="cam in displayedCameras" :key="cam.id">
          <div class="config-row">
            <div>
              <div style="display: flex; align-items: center; gap: 10px">
                <button class="camera-expand-btn" @click="toggleCameraExpand(cam.name)">
                  {{ cameraExpanded[cam.name] ? '−' : '+' }}
                </button>
                <button class="camera-link" @click="openCameraEditor(cam)">{{ cam.name }}</button>
                <span class="pill" :class="{ gray: cam.status !== 'online' }">
                  {{ cam.status === 'online' ? 'Connected' : 'Offline' }}
                </span>
              </div>
              <span>{{ cam.rtmp }}</span>
              <span v-if="cam.organization || cam.org_admin" class="subtitle">
                {{ cam.organization || '—' }} · {{ cam.org_admin || '—' }}
              </span>
            </div>
            <div class="row-actions">
              <button class="btn" @click="openCameraEditor(cam)">Edit</button>
              <button class="btn" @click="removeCamera(cam)">Delete</button>
            </div>
          </div>
          <div v-if="cameraExpanded[cam.name]" class="camera-script-sub">
            <template v-if="cameraInstances(cam.name).length">
              <div v-for="inst in cameraInstances(cam.name)" :key="inst.iid" class="camera-script-row">
                <span class="switch" :class="{ off: !inst.enabled }" @click="onToggleInstance(inst)"></span>
                <div style="flex: 1">
                  <button class="camera-link" @click="openAiDetail(inst)">{{ inst.name }}</button>
                  <div class="script-meta">Based on {{ store.scripts.find((s) => s.id === inst.scriptId)?.name || inst.scriptId }}</div>
                </div>
                <span class="pill" :class="{ gray: (store.scriptRuns[inst.scriptId]?.status ?? 'stopped') !== 'running' }">
                  {{ (store.scriptRuns[inst.scriptId]?.status ?? 'stopped') === 'running' ? 'Running' : 'Stopped' }}
                </span>
                <div class="ai-menu-wrap">
                  <button class="icon-btn ai-menu-btn" title="More" @click="toggleAiMenu($event, inst)">⋯</button>
                  <div v-if="aiMenu?.iid === inst.iid" class="ai-menu" @click.stop>
                    <button class="ai-menu-item danger" @click="onDeleteInstance(inst)">Delete</button>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="camera-script-empty">No AI models configured for this camera.</div>
            <div class="camera-ai-add">
              <button class="btn" @click="openAddAi(cam.name)">+ Add AI</button>
            </div>
          </div>
        </div>
        <div v-if="!displayedCameras.length" class="detail-empty">
          {{ filteredCameras ? 'No cameras match the current filters.' : 'No cameras available.' }}
        </div>
      </div>
    </section>

    <CameraEditorModal />
    <AiDetailModal />
    <AddAiModal v-if="store.showAddAi" :camera="addAiCamera" @confirm="onConfirmAddAi" />
  </section>
</template>
