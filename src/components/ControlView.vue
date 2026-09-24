<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listScripts as apiListScripts } from '../api'
import {
  addStreamCamera,
  availableStreamCameras,
  cameraRun,
  loadAllCameraRuns,
  loadDeletedScripts,
  loadScriptCameraRuns,
  loadScripts,
  removeScriptRecord,
  restoreScriptRecord,
  removeStreamCamera,
  scriptHasRunningCamera,
  scriptOutput,
  store,
  toggleCameraRun,
  toggleRun,
} from '../store'
import type { Script } from '../types'
import ControlModal from './modals/ControlModal.vue'
import ScriptDetailModal from './modals/ScriptDetailModal.vue'

const controlSelected = computed(() =>
  store.scripts.find((s) => s.id === store.controlSelectedId),
)

// 行展开：显示该 AI model 的相机与 AI cam 输出串流（index 框架的 stream-map 融合到列表里）
const controlExpanded = ref<Record<string, boolean>>({})
// 每个 AI model 的「+ Add camera」下拉当前选中项
const streamAddSelection = ref<Record<string, string>>({})

function toggleControlExpand(id: string): void {
  controlExpanded.value[id] = !controlExpanded.value[id]
  if (controlExpanded.value[id]) void loadScriptCameraRuns(id)
}

function isRunning(id: string): boolean {
  return scriptHasRunningCamera(id)
}

// Per-camera Run/Stop. Each camera is an independent worker, so the response only
// reflects that camera; a refusal (offline camera, missing weights) surfaces the
// backend reason and the row keeps the last known state.
async function onToggleCameraRun(scriptId: string, camera: string): Promise<void> {
  try {
    await toggleCameraRun(scriptId, camera)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
    await loadScriptCameraRuns(scriptId)
  }
}

/** Whether one camera can be started (online and not already running). */
function cameraCanRun(scriptId: string, camera: string): boolean {
  return cameraRun(scriptId, camera).can_run
}

/** Tooltip for a camera's Status pill, including any backend failure reason. */
function cameraStatusTitle(scriptId: string, camera: string): string {
  const run = cameraRun(scriptId, camera)
  const parts = [`Camera link: ${run.camera_status}`, `AI model: ${run.status}`]
  if (!run.enabled) parts.push('Disabled for this camera on the Camera page')
  if (run.message) parts.push(run.message)
  return parts.join(' · ')
}

/** Status pill label: Disabled wins, then Running, then camera connectivity. */
function runPillLabel(scriptId: string, camera: string): string {
  const run = cameraRun(scriptId, camera)
  if (!run.enabled) return 'Disabled'
  if (run.status === 'running') return 'Running'
  return run.camera_status === 'online' ? 'Online' : 'Offline'
}

/** Why the Run/Stop button is enabled or not, in the operator's terms. */
function cameraRunTitle(scriptId: string, camera: string): string {
  const run = cameraRun(scriptId, camera)
  if (run.status === 'running') return 'Stop this camera'
  if (!run.enabled) return 'Disabled on the Camera page — enable it there to run'
  if (!run.can_run) return 'Camera is offline'
  return 'Run this camera'
}

// Poll the run state of every expanded AI model so a worker that exits on its own
// (unreachable camera, model that failed to load) is reflected without a reload.
let pollTimer: number | null = null

async function refreshExpandedCameraRuns(): Promise<void> {
  const ids = Object.entries(controlExpanded.value)
    .filter(([, expanded]) => expanded)
    .map(([id]) => id)
  await Promise.all(ids.map((id) => loadScriptCameraRuns(id)))
}

/** Assign a camera to this AI model (persisted; the Camera page sees it too). */
async function onAddStreamCamera(scriptId: string): Promise<void> {
  const cam = streamAddSelection.value[scriptId]
  if (!cam) return
  try {
    await addStreamCamera(scriptId, cam)
    streamAddSelection.value[scriptId] = ''
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

/** Unassign a camera from this AI model (stops its worker, drops its ROI). */
async function onRemoveStreamCamera(scriptId: string, cam: string): Promise<void> {
  if (!window.confirm(`Remove "${cam}" from this AI model? Its worker is stopped and its ROI is cleared.`))
    return
  try {
    await removeStreamCamera(scriptId, cam)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
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
  if (
    !window.confirm(
      `Delete the AI model "${s.name}"? It stops on every camera and its per-camera instances are removed. You can restore it afterwards from the "Deleted" list.`,
    )
  )
    return
  try {
    await removeScriptRecord(s.id)
    resetScriptFilter()
    // The model no longer exists, so drop any view state pointing at it.
    if (store.controlSelectedId === s.id) store.controlSelectedId = null
    if (store.currentScriptDetailId === s.id) store.currentScriptDetailId = null
    delete controlExpanded.value[s.id]
    delete streamAddSelection.value[s.id]
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Deleted AI models (soft delete + restore)
// ---------------------------------------------------------------------------

const showDeleted = ref(false)
const deletedLoading = ref(false)

async function toggleDeleted(): Promise<void> {
  showDeleted.value = !showDeleted.value
  if (!showDeleted.value) return
  deletedLoading.value = true
  try {
    await loadDeletedScripts()
  } finally {
    deletedLoading.value = false
  }
}

async function restoreScript(s: Script): Promise<void> {
  try {
    await restoreScriptRecord(s.id)
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
  // Base scenario defaults to the first built-in AI model (see ScriptDetailModal).
  store.newScriptBaseId = ''
  store.showScriptDetail = true
}

onMounted(async () => {
  await loadScripts()
  // Per-camera run state drives the Run/Stop buttons and their Online/Offline link.
  await loadAllCameraRuns()
  // Keeps the "Deleted (n)" badge honest before the restore panel is ever opened.
  await loadDeletedScripts()
  pollTimer = window.setInterval(refreshExpandedCameraRuns, 3000)
})

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
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

    <!-- Single list only: run control and AI model settings are merged. Expanding a row
         edits that AI model's Camera output streams. Previously this page rendered the
         same catalog twice (a run-control list plus an "AI model setting" table). -->
    <section class="panel config-content">
      <div class="config-head">
        <div>
          <h2>AI model setting</h2>
          <p class="subtitle">Review AI model status, descriptions, parameters and assigned cameras.</p>
        </div>
        <div class="row-actions">
          <button class="btn" @click="toggleDeleted">
            Deleted ({{ store.deletedScripts.length }})
          </button>
          <button class="btn primary" @click="addScript">+ Add AI model</button>
        </div>
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

      <!-- Soft-deleted AI models: restoring re-adds the very same catalog entry,
           because deletion only flags the model and clears its runtime state. -->
      <div v-if="showDeleted" class="deleted-panel">
        <div class="deleted-head">
          <h3>Deleted AI models</h3>
          <span class="subtitle">
            {{ deletedLoading ? 'Loading…' : 'Restore brings the model back with its detector wiring intact.' }}
          </span>
        </div>
        <p v-if="!deletedLoading && !store.deletedScripts.length" class="subtitle deleted-empty">
          No deleted AI model.
        </p>
        <div v-for="d in store.deletedScripts" :key="d.id" class="deleted-row">
          <div>
            <strong>{{ d.name }}</strong>
            <span class="subtitle">{{ d.id }} · {{ d.organization || '—' }} · {{ d.scenario || '—' }}</span>
          </div>
          <button class="btn primary" @click="restoreScript(d)">Restore</button>
        </div>
      </div>

      <div class="config-list">
        <div v-for="s in displayedScripts" :key="s.id">
          <div class="config-row">
            <div>
              <div class="ai-model-title">
                <button class="camera-expand-btn" @click="toggleControlExpand(s.id)">
                  {{ controlExpanded[s.id] ? '−' : '+' }}
                </button>
                <button class="camera-link" @click="store.controlSelectedId = s.id; store.showControlDetail = true">
                  {{ s.name }}
                </button>
                <span class="pill" :class="{ gray: !isRunning(s.id) }">
                  {{ isRunning(s.id) ? 'Running' : 'Stopped' }}
                </span>
              </div>
              <span>{{ s.meta }} · {{ s.cameras.length }} cameras</span>
              <span v-if="s.description" class="script-desc">{{ s.description }}</span>
              <span v-if="s.organization || s.scenario" class="subtitle">
                {{ s.organization || '—' }} · {{ s.scenario || '—' }}
              </span>
              <div v-if="s.kpis.length" class="script-kpis">
                <span v-for="kpi in s.kpis" :key="kpi[0]" class="script-kpi">
                  <small>{{ kpi[0] }}</small>
                  <strong>{{ kpi[1] }}</strong>
                  <em>{{ kpi[2] }}</em>
                </span>
              </div>
            </div>
            <div class="row-actions">
              <span v-if="!s.cameras.length" class="pill gray" title="Assign a camera before running">
                No camera
              </span>
              <button
                v-else
                class="btn"
                :class="isRunning(s.id) ? 'dark' : 'primary'"
                :title="isRunning(s.id) ? 'Stop every camera of this AI model' : 'Run on every online camera'"
                @click="onToggleRun(s.id)"
              >
                {{ isRunning(s.id) ? 'Stop all' : 'Run all' }}
              </button>
              <button class="btn" @click="openScriptDetail(s.id)">Detail</button>
              <button class="btn" @click="removeScript(s)">Delete</button>
            </div>
          </div>
          <div v-if="controlExpanded[s.id]" class="camera-script-sub">
            <div class="stream-map">
              <div class="stream-map-row head">
                <div>Camera</div>
                <div>Input stream (raw)</div>
                <div>Output stream (AI cam)</div>
                <div></div>
                <div>Status</div>
                <div>Run</div>
                <div></div>
              </div>
              <div v-for="cam in s.cameras" :key="cam" class="stream-map-row">
                <div class="stream-cam" :title="cam">{{ cam }}</div>
                <div class="stream-in" :title="store.cameraInputs[cam] ?? ''">{{ store.cameraInputs[cam] ?? '—' }}</div>
                <!-- Read-only: the annotated stream is derived from the AI model + camera -->
                <div class="stream-out" :title="scriptOutput(s.id, cam)">
                  <span class="stream-out-value">{{ scriptOutput(s.id, cam) }}</span>
                </div>
                <!-- flexible spacer: keeps Status/Run anchored to the right -->
                <div></div>
                <div class="stream-status">
                  <!-- Run state is linked to connectivity: offline cameras cannot run. -->
                  <span
                    class="pill"
                    :class="cameraRun(s.id, cam).enabled && cameraRun(s.id, cam).status === 'running' ? '' : 'gray'"
                    :title="cameraStatusTitle(s.id, cam)"
                  >
                    {{ runPillLabel(s.id, cam) }}
                  </span>
                </div>
                <div class="stream-run">
                  <button
                    class="btn btn-xs"
                    :class="cameraRun(s.id, cam).status === 'running' ? 'dark' : 'primary'"
                    :disabled="cameraRun(s.id, cam).status !== 'running' && !cameraCanRun(s.id, cam)"
                    :title="cameraRunTitle(s.id, cam)"
                    @click="onToggleCameraRun(s.id, cam)"
                  >
                    {{ cameraRun(s.id, cam).status === 'running' ? 'Stop' : 'Run' }}
                  </button>
                </div>
                <button class="icon-btn stream-del" title="Remove camera" @click="onRemoveStreamCamera(s.id, cam)">×</button>
              </div>
              <div v-if="!s.cameras.length" class="camera-script-empty">No cameras assigned to this AI model.</div>
              <div v-if="availableStreamCameras(s.id).length" class="stream-map-add">
                <select v-model="streamAddSelection[s.id]">
                  <option value="">Select a camera…</option>
                  <option v-for="c in availableStreamCameras(s.id)" :key="c" :value="c">{{ c }}</option>
                </select>
                <button class="btn" :disabled="!streamAddSelection[s.id]" @click="onAddStreamCamera(s.id)">+ Add camera</button>
              </div>
              <div v-else class="subtitle" style="margin-top: 8px">All cameras are assigned to this AI model.</div>
            </div>
          </div>
        </div>
        <div v-if="!displayedScripts.length" class="detail-empty">
          {{ filteredScripts ? 'No AI models match the current filters.' : 'No AI models available.' }}
        </div>
      </div>
      <div class="notice">
        Expand an AI model to edit the AI cam output stream of each assigned camera. Opening the
        model name shows its runtime detail; <strong>Detail</strong> opens the configuration
        (description, parameters and cameras).
      </div>
    </section>

    <ControlModal v-if="controlSelected" />
    <ScriptDetailModal />
  </section>
</template>
