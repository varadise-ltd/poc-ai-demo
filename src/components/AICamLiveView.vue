<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getGateLive, listCameras, listScripts, snapshotUrl, streamUrl } from '../api'
import type { GateLiveInfo } from '../api'
import type { Camera, Script } from '../types'
import {
  clearEvents,
  liveEvents,
  loadCameraAI,
  loadCameras,
  loadHistoryEvents,
  loadDetectionEvents,
  loadScripts,
  refreshSelectedScriptRun,
  selectedScript,
  selectedScriptRun,
  startSelectedScript,
  stopSelectedScript,
  store,
} from '../store'
import ResultDetailModal from './modals/ResultDetailModal.vue'
import HistoryModal from './modals/HistoryModal.vue'

const isRunning = computed(() => selectedScriptRun.value.status === 'running')

// 预览没有自动停止：运行状态完全由用户控制（Preview / Stop Preview 按钮，或
// AI model 页的 Run/Stop）。离开页面也不会停止 worker，回到本页时只要 worker
// 仍在运行，预览与实时统计就会自动恢复显示。
async function stopPreview(): Promise<void> {
  stopPolling()
  try {
    await stopSelectedScript()
  } catch (err) {
    console.warn('stop preview failed', err)
  }
}

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

// 只有后端真正「已启用且可启用」的 AI model 才能被选择：即该摄像机存在一条
// enabled 的 camera×AI-model 关联（camera_ai 表），否则 Run 会被后端 409 拒绝。
const cameraModelIds = computed(
  () => new Set(store.cameraAI.filter((a) => a.camera === store.selectedCamera && a.enabled).map((a) => a.scriptId)),
)
const availableScripts = computed<Script[]>(() => {
  // 实例数据尚未加载时不要误判为空列表，退回完整目录。
  if (!store.cameraAI.length) return displayScripts.value
  return displayScripts.value.filter((s) => cameraModelIds.value.has(s.id))
})

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
    syncSelectedModel()
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    orgFilterLoading.value = false
  }
})

// 选中的 AI model 必须属于当前摄像机，否则自动切到第一个可用项。
function syncSelectedModel(): void {
  const ids = availableScripts.value.map((s) => s.id)
  if (ids.length && !ids.includes(store.selectedScriptId)) {
    store.selectedScriptId = ids[0]
  }
}

// 预览画面 URL：运行中显示 MJPEG 流；暂停时用快照冻结画面
const currentStreamUrl = computed(() => {
  if (!store.selectedScriptId) return ''
  if (store.previewPaused) {
    return snapshotUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
  }
  return streamUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
})

// 画面左下角显示当前预览的真实摄像机与分辨率（原先是写死的装饰文字）
const selectedCameraLabel = computed(() => {
  const camera = store.cameras.find((c) => c.name === store.selectedCamera)
  const resolution = (camera?.resolution ?? '').trim()
  return resolution ? `${store.selectedCamera} • ${resolution}` : store.selectedCamera
})

let pollTimer: number | null = null

async function togglePreview(): Promise<void> {
  if (isRunning.value) {
    await stopPreview()
  } else {
    try {
      await startSelectedScript()
      await loadPreviewHistory()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }
}

async function loadPreviewHistory(): Promise<void> {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  await loadHistoryEvents({
    scriptId: store.selectedScriptId,
    cameraId: store.selectedCamera,
    start: start.toISOString(),
    end: end.toISOString(),
  })
}

/**
 * Always-on poll of the engine's run state, detection events, and counting stats.
 *
 * The run state must be re-read even when this page currently believes the AI
 * model is stopped: a worker can be running because it was started elsewhere
 * (AI model page) or by an earlier visit, and only the engine knows. Polling
 * conditionally on ``isRunning`` created a deadlock — the page stayed on
 * "stopped" and never re-checked, so a running camera showed no preview.
 */
async function pollTick(): Promise<void> {
  await refreshSelectedScriptRun()
  if (!isRunning.value) return
  void loadDetectionEvents()
  void loadGateLive()
  if (isCountingScript.value && !store.historyEvents.length) void loadPreviewHistory()
}

function startPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  void pollTick()
  pollTimer = window.setInterval(() => void pollTick(), 2000)
}

function stopPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  gateLive.value = null
  gateLiveError.value = ''
}

// ---------------------------------------------------------------------------
// 人员计数实时统计（People Counting 预览）
// ---------------------------------------------------------------------------
// 统计口径与后端一致：ROI 内人数取 worker 最近一帧（检测器已按 ROI 过滤），
// 累计人数与 in/out 都来自后端持久化的 facts，与正式报表同源。
const gateLive = ref<GateLiveInfo | null>(null)
const gateLiveError = ref('')
const isCountingScript = computed(() => selectedScript.value?.isCounting === true)
const roiPeopleLabel = computed(() => (gateLive.value?.roi_configured ? 'People in ROI (now)' : 'People (now, whole frame)'))

const intervalHistory = computed(() => {
  if (!isCountingScript.value) return []
  const buckets = new Map<string, { period: string; detections: number; roi: number; in: number; out: number }>()
  for (const event of store.historyEvents) {
    if (event.camera !== store.selectedCamera || event.script !== selectedScript.value.name) continue
    const parsed = new Date(`${event.date}T${event.time}`)
    if (Number.isNaN(parsed.getTime())) continue
    parsed.setMinutes(Math.floor(parsed.getMinutes() / 10) * 10, 0, 0)
    const key = parsed.toISOString()
    const bucket = buckets.get(key) ?? {
      period: parsed.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
      detections: 0,
      roi: 0,
      in: 0,
      out: 0,
    }
    bucket.detections += 1
    if (event.name.toLowerCase().includes('entered roi')) bucket.roi += 1
    if (event.name.startsWith('IN ·')) bucket.in += 1
    if (event.name.startsWith('OUT ·')) bucket.out += 1
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) => b.period.localeCompare(a.period))
})

/**
 * People are being detected inside the ROI but no count line has ever been
 * crossed in this run.
 *
 * The usual cause is line placement, not a broken detector: a line drawn close
 * to the frame edge (or across a part of the scene nobody walks through) has no
 * crossing corridor, because a passage needs the *bounding-box centre* to move
 * from one side of the line to the other. The panel stayed silent about this
 * before, so the counters just sat at 0 with no explanation.
 */
const crossLineHint = computed(() => {
  const live = gateLive.value
  if (!live?.running || !live.run_id) return false
  const crossed = live.session.in + live.session.out
  return crossed === 0 && live.roi_people.session > 0
})

async function loadGateLive(): Promise<void> {
  if (!isCountingScript.value || !isRunning.value || !store.selectedCamera) {
    gateLive.value = null
    return
  }
  try {
    gateLive.value = await getGateLive(store.selectedCamera, store.selectedScriptId)
    gateLiveError.value = ''
  } catch (err) {
    gateLiveError.value = err instanceof Error ? err.message : String(err)
  }
}

watch([() => store.selectedCamera, () => store.selectedScriptId], () => {
  gateLive.value = null
  if (isRunning.value) {
    void loadGateLive()
    void loadPreviewHistory()
  }
})

// 切换摄像机后，下拉里只剩该摄像机可用（已启用）的 AI model。
watch(() => store.selectedCamera, () => syncSelectedModel())

// 运行状态与统计保持一致：worker 在别处（本页 Preview 或 AI model 页 Run）
// 启动/停止后，本页自动跟随，无需刷新页面。轮询本身一直运行（见 pollTick）。
watch(isRunning, (running) => {
  if (running) {
    void loadGateLive()
  } else {
    gateLive.value = null
  }
})

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
  await Promise.all([loadScripts(), loadCameras(), loadCameraAI()])
  syncSelectedModel()
  // Poll from mount: an already-running worker must show its preview and live
  // statistics immediately, and a worker started elsewhere must be picked up.
  startPolling()
})

onBeforeUnmount(() => {
  // 只停止轮询：worker 继续运行，回到本页后预览会自动恢复（与用户的
  // 「没有手动 Stop 就一直保持 running」预期一致）。
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
        <select v-model="store.selectedScriptId" :disabled="!availableScripts.length">
          <option v-for="s in availableScripts" :key="s.id" :value="s.id">
            {{ s.name }} · {{ store.scriptRuns[s.id]?.status ?? 'stopped' }}
          </option>
        </select>
        <span v-if="!availableScripts.length" class="field-hint">
          No AI model is enabled on {{ store.selectedCamera }} — assign one in the Camera page.
        </span>
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
          <span class="video-caption">{{ selectedCameraLabel }}</span>
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

        <div v-if="isCountingScript" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · live counting</strong>
            <span class="subtitle">
              ROI + count-line statistics from the running AI model
            </span>
            <span v-if="gateLive?.mode === 'MOCK'" class="gate-live-badge">DEMO</span>
          </div>
          <p v-if="gateLive?.mode === 'MOCK'" class="subtitle">
            The camera is unavailable, so this run uses demo frames. Demo crossings are excluded
            from the counters (and from the stored report).
          </p>
          <p v-if="gateLiveError" class="subtitle" style="color: var(--red)">{{ gateLiveError }}</p>
          <template v-if="gateLive && gateLive.running && gateLive.run_id">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">{{ roiPeopleLabel }}</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.now }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">People in ROI (this run)</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.session }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">People today (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.day }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">People total (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.total }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">IN (this run)</span>
                <strong class="gate-live-value in">{{ gateLive.session.in }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">OUT (this run)</span>
                <strong class="gate-live-value out">{{ gateLive.session.out }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">IN / OUT today</span>
                <strong class="gate-live-value">
                  {{ gateLive.day.in }} / {{ gateLive.day.out }}
                </strong>
              </div>
            </div>
            <div v-if="gateLive.lines.length" class="gate-live-lines">
              <div v-for="line in gateLive.lines" :key="line.gate_id" class="gate-live-line">
                <span class="gate-live-line-name">{{ line.location || line.gate_id }}</span>
                <span class="gate-live-line-dir">
                  <span class="in">IN {{ line.in }}</span>
                  <span class="out">OUT {{ line.out }}</span>
                  <span class="subtitle">net {{ line.net }}</span>
                </span>
              </div>
            </div>
            <p class="subtitle">
              IN = crossing along the drawn arrow (OUT → IN), OUT = crossing against it.
              Counts come from the same facts as the stored report.
            </p>
            <p v-if="crossLineHint" class="subtitle" style="color: var(--yellow, #d29922)">
              {{ gateLive.roi_people.session }} person(s) were detected inside the ROI this run, but
              nobody has crossed a count line yet. A line can only count a passage when a person’s
              box centre travels from one side of it to the other — redraw the line across the
              actual walking path (a line hugging the frame edge, or the ROI border, is never
              crossed). Use “Draw count line” on the AI model page.
            </p>
          </template>
          <p v-else-if="gateLive && gateLive.running" class="subtitle">
            Waiting for the running worker to report its first frame…
          </p>          <p v-else class="subtitle">
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — click “Preview” to
            start it and watch the ROI people count and IN/OUT totals.
          </p>
        </div>

        <div v-if="isCountingScript" class="events-list">
          <div v-if="intervalHistory.length" class="count-interval-list">
            <div v-for="bucket in intervalHistory" :key="bucket.period" class="event">
              <span class="event-time">{{ bucket.period }}</span>
              <span class="event-mark ok"></span>
              <div>
                <div class="event-name">10-minute people-counting summary</div>
                <div class="event-meta">
                  ROI entries {{ bucket.roi }} · IN {{ bucket.in }} · OUT {{ bucket.out }} · events {{ bucket.detections }}
                </div>
              </div>
            </div>
          </div>
          <div v-else class="detail-empty">No counting history for the selected camera.</div>
        </div>
        <div v-else class="events-list">
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
