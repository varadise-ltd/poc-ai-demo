<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listScripts as apiListScripts } from '../api'
import { loadScripts, removeScriptRecord, store, toggleRun } from '../store'
import type { Script } from '../types'
import ControlModal from './modals/ControlModal.vue'
import ScriptDetailModal from './modals/ScriptDetailModal.vue'

const controlSelected = computed(() =>
  store.scripts.find((s) => s.id === store.controlSelectedId),
)

// 行展开：显示该 AI model 分配的相机列表（index 框架的 controlExpanded 结构）
const controlExpanded = ref<Record<string, boolean>>({})

function toggleControlExpand(id: string): void {
  controlExpanded.value[id] = !controlExpanded.value[id]
}

async function onToggleRun(id: string): Promise<void> {
  try {
    await toggleRun(id)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

// Script filter (server-side filtering via GET /api/scripts?status=&organization=&scenario=)
const scriptFilterStatus = ref('')
const scriptFilterOrg = ref('')
const scriptFilterScenario = ref('')
const scriptFilterLoading = ref(false)
// null = 未筛选，展示完整列表；否则展示后端筛选结果
const filteredScripts = ref<Script[] | null>(null)

// 组织机构 / 使用场景下拉选项：取自当前完整脚本列表的去重值
const scriptOrgOptions = computed(() => {
  const orgs = new Set<string>()
  for (const s of store.scripts) {
    const org = (s.organization ?? '').trim()
    if (org) orgs.add(org)
  }
  return [...orgs].sort()
})

const scriptScenarioOptions = computed(() => {
  const scenarios = new Set<string>()
  for (const s of store.scripts) {
    const sc = (s.scenario ?? '').trim()
    if (sc) scenarios.add(sc)
  }
  return [...scenarios].sort()
})

// 列表展示数据：筛选态用后端结果，否则用完整列表
const displayedScripts = computed(() => filteredScripts.value ?? store.scripts)

async function applyScriptFilter(): Promise<void> {
  scriptFilterLoading.value = true
  try {
    const { scripts } = await apiListScripts(
      scriptFilterStatus.value || undefined,
      scriptFilterOrg.value || undefined,
      scriptFilterScenario.value || undefined,
    )
    filteredScripts.value = scripts
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    scriptFilterLoading.value = false
  }
}

function resetScriptFilter(): void {
  scriptFilterStatus.value = ''
  scriptFilterOrg.value = ''
  scriptFilterScenario.value = ''
  filteredScripts.value = null
}

function openScriptDetail(id: string): void {
  store.scriptDetailMode = 'edit'
  store.currentScriptDetailId = id
  store.showScriptDetail = true
}

async function removeScript(s: Script): Promise<void> {
  if (!window.confirm(`Delete the AI model "${s.name}"? This also removes its per-camera instances and cannot be undone.`)) return
  try {
    await removeScriptRecord(s.id)
    resetScriptFilter()
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

function addScript(): void {
  store.scriptDetailMode = 'add'
  store.currentScriptDetailId = null
  store.newScriptName = ''
  store.newScriptDescription = ''
  store.showScriptDetail = true
}

onMounted(async () => {
  await loadScripts()
})
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>AI model</h1>
        <p class="subtitle">Start and stop AI models, and review which cameras run each AI model.</p>
      </div>
    </div>

    <!-- Run control -->
    <div class="config-list">
      <div v-for="s in store.scripts" :key="s.id">
        <div class="config-row">
          <div>
            <div style="display: flex; align-items: center; gap: 10px">
              <button class="camera-expand-btn" @click="toggleControlExpand(s.id)">
                {{ controlExpanded[s.id] ? '−' : '+' }}
              </button>
              <button class="camera-link" @click="store.controlSelectedId = s.id; store.showControlDetail = true">
                {{ s.name }}
              </button>
              <span class="pill" :class="{ gray: (store.scriptRuns[s.id]?.status ?? 'stopped') !== 'running' }">
                {{ (store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'Running' : 'Stopped' }}
              </span>
            </div>
            <span>{{ s.meta }} · {{ s.cameras.length }} cameras</span>
          </div>
          <div class="row-actions">
            <span v-if="!s.cameras.length" class="pill gray" title="Assign a camera in the script settings before running">
              No camera
            </span>
            <button
              v-else
              class="btn"
              :class="(store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'dark' : 'primary'"
              @click="onToggleRun(s.id)"
            >
              {{ (store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'Stop' : 'Run' }}
            </button>
          </div>
        </div>
        <div v-if="controlExpanded[s.id]" class="camera-script-sub">
          <template v-if="s.cameras.length">
            <div v-for="cam in s.cameras" :key="cam" class="camera-script-row">
              <div style="flex: 1">
                <div class="script-name" style="font-size: 13px; font-weight: 650">{{ cam }}</div>
                <div class="script-meta">{{ store.cameraInputs[cam] ?? '—' }}</div>
              </div>
              <span class="pill" :class="{ gray: store.cameraStatus[cam] !== 'online' }">
                {{ store.cameraStatus[cam] === 'online' ? 'Online' : 'Offline' }}
              </span>
            </div>
          </template>
          <div v-else class="camera-script-empty">No cameras assigned to this AI model.</div>
        </div>
      </div>
    </div>

    <!-- AI model settings -->
    <section class="panel config-content" style="margin-top: 18px">
      <div class="config-head">
        <div>
          <h2>AI model setting</h2>
          <p class="subtitle">Review AI model status, descriptions, parameters and assigned cameras.</p>
        </div>
        <button class="btn primary" @click="addScript">+ Add AI model</button>
      </div>
      <div class="filter-bar">
        <div class="field">
          <label>Run status</label>
          <select v-model="scriptFilterStatus">
            <option value="">All statuses</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
          </select>
        </div>
        <div class="field">
          <label>Organization</label>
          <select v-model="scriptFilterOrg">
            <option value="">All organizations</option>
            <option v-for="org in scriptOrgOptions" :key="org" :value="org">{{ org }}</option>
          </select>
        </div>
        <div class="field">
          <label>Scenario</label>
          <select v-model="scriptFilterScenario">
            <option value="">All scenarios</option>
            <option v-for="sc in scriptScenarioOptions" :key="sc" :value="sc">{{ sc }}</option>
          </select>
        </div>
        <div class="filter-actions">
          <button class="btn primary" :disabled="scriptFilterLoading" @click="applyScriptFilter">
            {{ scriptFilterLoading ? 'Filtering…' : 'Filter' }}
          </button>
          <button class="btn" @click="resetScriptFilter">Reset</button>
        </div>
      </div>
      <div class="config-list">
        <div v-for="s in displayedScripts" :key="s.id" class="config-row">
          <div>
            <div style="display: flex; align-items: center; gap: 8px">
              <strong>{{ s.name }}</strong>
              <span class="pill" :class="{ gray: (store.scriptRuns[s.id]?.status ?? 'stopped') !== 'running' }">
                {{ (store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'Running' : 'Stopped' }}
              </span>
            </div>
            <span>{{ s.meta }} · Parameters configured</span>
            <span v-if="s.organization || s.scenario" class="subtitle">
              {{ s.organization || '—' }} · {{ s.scenario || '—' }}
            </span>
          </div>
          <div class="row-actions">
            <button class="btn" @click="openScriptDetail(s.id)">Detail</button>
            <button class="btn" @click="removeScript(s)">Delete</button>
          </div>
        </div>
        <div v-if="!displayedScripts.length" class="detail-empty">
          {{ filteredScripts ? 'No AI models match the current filters.' : 'No AI models available.' }}
        </div>
      </div>
      <div class="notice">
        Select an AI model to open its detail page. Each AI model can be enabled or disabled independently and can be
        assigned to multiple cameras.
      </div>
    </section>

    <ControlModal v-if="controlSelected" />
    <ScriptDetailModal />
  </section>
</template>
