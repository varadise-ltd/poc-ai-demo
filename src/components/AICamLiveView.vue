<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listCameras, listScripts, snapshotUrl, streamUrl } from '../api'
import type { Camera, Script } from '../types'
import {
  clearEvents,
  liveEvents,
  loadCameras,
  loadDetectionEvents,
  loadScripts,
  selectedScript,
  selectedScriptRun,
  startSelectedScript,
  stopSelectedScript,
  store,
} from '../store'
import ResultDetailModal from './modals/ResultDetailModal.vue'
import HistoryModal from './modals/HistoryModal.vue'

const isRunning = computed(() => selectedScriptRun.value.status === 'running')

// ---------------------------------------------------------------------------
// Organization filter (server-side via GET /api/cameras?organization=)
// ---------------------------------------------------------------------------
const orgFilter = ref('')
const orgFilterLoading = ref(false)
// null = 未筛选（展示完整摄像机列表）；否则为后端按组织筛选的结果
const filteredCameras = ref<Camera[] | null>(null)
// 同一组织筛选也作用于检测脚本下拉（后端 GET /api/scripts?organization=）
const filteredScripts = ref<Script[] | null>(null)

// 组织机构下拉选项：取自摄像机与脚本列表的去重 organization 并集
const orgOptions = computed(() => {
  const orgs = new Set<string>()
  for (const c of store.cameras) {
    const org = (c.organization ?? '').trim()
    if (org) orgs.add(org)
  }
  for (const s of store.scripts) {
    const org = (s.organization ?? '').trim()
    if (org) orgs.add(org)
  }
  return [...orgs].sort()
})

// 摄像机 / 脚本下拉展示数据：筛选态用后端结果，否则用完整列表
const displayCameras = computed(() => filteredCameras.value ?? store.cameras)
const displayScripts = computed(() => filteredScripts.value ?? store.scripts)

watch(orgFilter, async (org) => {
  orgFilterLoading.value = true
  try {
    if (org) {
      const [cameras, scriptRes] = await Promise.all([
        listCameras(undefined, org),
        listScripts(undefined, org),
      ])
      filteredCameras.value = cameras
      filteredScripts.value = scriptRes.scripts
    } else {
      filteredCameras.value = null
      filteredScripts.value = null
    }
    // 若当前选中的摄像机 / 脚本不在筛选结果中，自动切换到第一个可用项
    const camNames = displayCameras.value.map((c) => c.name)
    if (camNames.length && !camNames.includes(store.selectedCamera)) {
      store.selectedCamera = camNames[0]
    }
    const scriptIds = displayScripts.value.map((s) => s.id)
    if (scriptIds.length && !scriptIds.includes(store.selectedScriptId)) {
      store.selectedScriptId = scriptIds[0]
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    orgFilterLoading.value = false
  }
})

// 预览画面 URL：运行中显示 MJPEG 流；暂停时用快照冻结画面
const currentStreamUrl = computed(() => {
  if (!store.selectedScriptId) return ''
  if (store.previewPaused) {
    return snapshotUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
  }
  return streamUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
})

let pollTimer: number | null = null

async function togglePreview(): Promise<void> {
  if (isRunning.value) {
    await stopSelectedScript()
    stopPolling()
  } else {
    await startSelectedScript()
    startPolling()
  }
}

function startPolling(): void {
  loadDetectionEvents()
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(loadDetectionEvents, 2000)
}

function stopPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function togglePause(): void {
  store.previewPaused = !store.previewPaused
}

function toggleLabels(): void {
  store.previewShowLabels = !store.previewShowLabels
}

async function snapshot(): Promise<void> {
  const url = snapshotUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${store.selectedScriptId}-${store.selectedCamera}-snapshot.jpg`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    document.documentElement.requestFullscreen()
  }
}

onMounted(async () => {
  await Promise.all([loadScripts(), loadCameras()])
})

onBeforeUnmount(() => {
  stopPolling()
})
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>AI Cam Live</h1>
        <p class="subtitle">Select a configured Script and Camera, then start the Script output stream.</p>
      </div>
      <div class="page-head-meta">
        <span class="eyebrow">LIVE WORKSPACE</span>
        <span class="page-head-meta-value">{{ isRunning ? 'Streaming now' : 'Ready to preview' }}</span>
      </div>
    </div>

    <div class="toolbar">
      <div class="field">
        <label>1 · Organization</label>
        <select v-model="orgFilter" :disabled="orgFilterLoading">
          <option value="">All organizations</option>
          <option v-for="org in orgOptions" :key="org" :value="org">{{ org }}</option>
        </select>
      </div>
      <div class="field">
        <label>2 · Select camera</label>
        <select v-model="store.selectedCamera">
          <option v-for="c in displayCameras" :key="c.id" :value="c.name">
            {{ c.name }} · {{ c.status }}
          </option>
        </select>
      </div>
      <div class="field">
        <label>3 · Select AI model</label>
        <select v-model="store.selectedScriptId">
          <option v-for="s in displayScripts" :key="s.id" :value="s.id">
            {{ s.name }} · {{ store.scriptRuns[s.id]?.status ?? 'stopped' }}
          </option>
        </select>
      </div>
      <div class="stream-state">
        <button
          class="btn"
          :class="isRunning ? 'dark' : 'primary'"
          @click="togglePreview"
        >
          {{ isRunning ? 'Stop Preview' : 'Preview' }}
        </button>
      </div>
    </div>

    <div class="demo-grid">
      <article class="panel video-card">
        <div class="video-head">
          <span>
            <strong>{{ selectedScript.name }}</strong> ·
            <strong>{{ store.selectedCamera }}</strong> output stream
          </span>
          <span class="live-badge">{{ isRunning ? 'LIVE' : 'OFFLINE' }}</span>
        </div>

        <div class="video">
          <img
            v-if="isRunning"
            :src="currentStreamUrl"
            alt="Live detection stream"
            class="video-frame"
          />
          <div v-else class="video-placeholder">
            <span>Click “Preview” to start the AI-detected stream.</span>
          </div>
        </div>

        <div class="video-foot">
          <button class="btn" :disabled="!isRunning" @click="togglePause">
            {{ store.previewPaused ? 'Resume' : 'Pause' }}
          </button>
          <button class="btn" :disabled="!isRunning" @click="snapshot">Snapshot</button>
          <button class="btn" :disabled="!isRunning" @click="toggleLabels">
            {{ store.previewShowLabels ? 'Hide labels' : 'Show labels' }}
          </button>
          <button class="btn" @click="toggleFullscreen">⛶</button>
        </div>
      </article>
    </div>

    <div class="lower-grid">
      <section class="panel events">
        <div class="panel-title">
          <div>
            <h2>Realtime monitoring</h2>
            <p class="subtitle">Results from the selected script and camera.</p>
          </div>
          <div style="display: flex; align-items: end; gap: 12px">
            <button class="btn" @click="store.showHistory = true">History</button>
            <button class="btn" @click="clearEvents">Clear</button>
          </div>
        </div>

        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">Detections</div>
            <div class="stat-value">{{ liveEvents.length }}</div>
          </div>
        </div>

        <div class="events-list">
          <template v-if="liveEvents.length">
            <div
              v-for="(e, i) in liveEvents"
              :key="i"
              class="event"
              @click="store.selectedEvent = e; store.showResultDetail = true"
            >
              <span class="event-time">{{ e.time }}</span>
              <span class="event-mark" :class="{ ok: e.ok }"></span>
              <div>
                <div class="event-name">{{ e.name }}</div>
                <div class="event-meta"><strong>{{ e.camera }}</strong> · {{ e.meta }}</div>
              </div>
              <span class="confidence">{{ e.confidence }}</span>
            </div>
          </template>
          <div v-else class="detail-empty">No results for the selected script and camera.</div>
        </div>
      </section>
    </div>

    <ResultDetailModal />
    <HistoryModal />
  </section>
</template>
