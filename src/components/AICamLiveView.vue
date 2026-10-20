<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchTenantAsset, getCraneLive, getFaceLive, getGateLive, getPortLive, getRoi, snapshotUrl, streamUrl } from '../api'
import type { CraneLiveInfo, FaceLiveInfo, GateLiveInfo, PortLiveInfo, RoiPolygon } from '../api'
import type { Camera, EventItem, Script } from '../types'
import { formatDisplayConfidence } from '../confidence'
import {
  clearEvents,
  loadCameraAI,
  loadCameras,
  loadHistoryEvents,
  loadDetectionEvents,
  loadScripts,
  refreshSelectedScriptRun,
  selectedScript,
  selectedScriptRun,
  store,
} from '../store'
import ResultDetailModal from './modals/ResultDetailModal.vue'
import HistoryModal from './modals/HistoryModal.vue'

// 后端 AI model 的真实运行状态：由 AI model 页的 Run/Stop 控制。
const isRunning = computed(() =>
  !selectionBusy.value && !selectionError.value &&
  availableScripts.value.some((script) => script.id === store.selectedScriptId) &&
  selectedScriptRun.value.status === 'running',
)

// 预览显示开关（纯前端）：Preview / Stop Preview 只控制是否显示预览画面，
// 与后端 AI model 是否 running 无关。后端 worker 只在 AI model 页手动 Stop
// 才停止，否则一直保持 running。
const previewing = ref(false)

// ---------------------------------------------------------------------------
// The active Org ID is supplied by the API client as X-Organization-Id.
// ---------------------------------------------------------------------------
const selectionLoading = ref(true)
const selectionBusy = computed(() => selectionLoading.value)
const selectionError = computed(() =>
  store.cameraError || store.scriptError || store.cameraAIError,
)
// null = 未筛选（展示完整摄像机列表）；否则为后端按组织筛选的结果
const filteredCameras = ref<Camera[] | null>(null)
// 同一组织筛选也作用于检测脚本下拉（后端 GET /api/scripts?organization=）
const filteredScripts = ref<Script[] | null>(null)

// 组织机构下拉选项：取自摄像机与脚本列表的去重 organization 并集
// 摄像机 / 脚本下拉展示数据：筛选态用后端结果，否则用完整列表
const displayCameras = computed(() => filteredCameras.value ?? store.cameras)
const displayScripts = computed(() => filteredScripts.value ?? store.scripts)

// 只有后端真正「已启用且可启用」的 AI model 才能被选择：即该摄像机存在一条
// enabled 的 camera×AI-model 关联（camera_ai 表），否则 Run 会被后端 409 拒绝。
const cameraModelIds = computed(
  () => new Set(store.cameraAI.filter((a) => a.camera === store.selectedCamera && a.enabled).map((a) => a.scriptId)),
)
const availableScripts = computed<Script[]>(() => {
  if (selectionBusy.value || selectionError.value || !store.selectedCamera) return []
  return displayScripts.value.filter((s) => cameraModelIds.value.has(s.id))
})

watch(() => store.activeOrgId, () => {
  filteredCameras.value = null
  filteredScripts.value = null
  syncSelectedCamera()
  syncSelectedModel()
})

function syncSelectedCamera(): void {
  if (selectionBusy.value || selectionError.value) return
  if (!displayCameras.value.some((camera) => camera.name === store.selectedCamera)) {
    store.selectedCamera = displayCameras.value[0]?.name ?? ''
  }
}

// 选中的 AI model 必须属于当前摄像机，否则自动切到第一个可用项。
function syncSelectedModel(): void {
  if (selectionBusy.value) return
  const ids = availableScripts.value.map((s) => s.id)
  if (!ids.includes(store.selectedScriptId)) {
    store.selectedScriptId = ids[0] ?? ''
  }
}

watch(displayCameras, syncSelectedCamera)
watch(availableScripts, syncSelectedModel)

// 预览画面 URL：运行中显示 MJPEG 流；暂停时用快照冻结画面
const currentStreamUrl = computed(() => {
  if (!store.selectedScriptId) return ''
  if (store.previewPaused) {
    return snapshotUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels)
  }
  return streamUrl(store.selectedCamera, store.selectedScriptId, store.previewShowLabels, false)
})

const previewRois = ref<RoiPolygon[]>([])
const previewFrameWidth = ref(1280)
const previewFrameHeight = ref(720)

async function loadPreviewRoi(): Promise<void> {
  if (!store.selectedScriptId || !store.selectedCamera) {
    previewRois.value = []
    return
  }
  try {
    const roi = await getRoi(store.selectedScriptId, store.selectedCamera)
    previewRois.value = roi.rois.filter((polygon) => polygon.points.length >= 3)
  } catch {
    previewRois.value = []
  }
}

function onPreviewFrameLoad(event: Event): void {
  const image = event.target as HTMLImageElement
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    previewFrameWidth.value = image.naturalWidth
    previewFrameHeight.value = image.naturalHeight
  }
}

// 画面左下角显示当前预览的真实摄像机与分辨率（原先是写死的装饰文字）
const selectedCameraLabel = computed(() => {
  const camera = store.cameras.find((c) => c.name === store.selectedCamera)
  const resolution = (camera?.resolution ?? '').trim()
  return resolution ? `${store.selectedCamera} • ${resolution}` : store.selectedCamera
})

let pollTimer: number | null = null

async function togglePreview(): Promise<void> {
  // 仅切换预览显示，绝不启动/停止后端 AI model。后端 model 的运行状态
  // 只在 AI model 页通过 Run/Stop 改变。停止中的 model 不可预览（按钮已禁用）。
  if (!previewing.value && !isRunning.value) return
  previewing.value = !previewing.value
  if (previewing.value) {
    await loadPreviewRoi()
    await loadPreviewHistory()
  }
}

async function loadPreviewHistory(): Promise<void> {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  await loadHistoryEvents({
    scriptId: store.selectedScriptId,
    cameraId: monitorCamera.value,
    start: start.toISOString(),
    end: end.toISOString(),
  })
}

/**
 * 轮询只保留两类必要请求：
 * 1. 永远需要：探测 run 状态（worker 可能在别处被启动/停止，Preview 按钮要跟上）。
 * 2. 仅在真正预览时才需要：实时统计（检测事件 / 计数 / 人脸）。
 * 未 preview 时用低频间隔，只查 run 状态，不拉实时统计。
 */
const LIVE_POLL_MS = 5000
const IDLE_POLL_MS = 15000

async function pollTick(): Promise<void> {
  // 仅在 Live 页可见时轮询：切到其他 tab（v-show 常驻挂载）后台不发请求。
  if (store.activeTab !== 'demo') return
  await refreshSelectedScriptRun()
  // 实时统计只在真正预览时才需要，未 preview 时不拉，避免无谓轮询。
  if (!isRunning.value || !previewing.value) return
  void loadDetectionEvents()
  void loadGateLive()
  void loadFaceLive()
  void loadPortLive()
  void loadCraneLive()
  if (isCountingScript.value && !store.historyEvents.length) void loadPreviewHistory()
}

function restartPollTimer(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void pollTick(), previewing.value ? LIVE_POLL_MS : IDLE_POLL_MS)
}

function startPolling(): void {
  restartPollTimer()
  void pollTick()
}

// 预览开关切换时调整轮询节奏：预览中高频（5s），未预览低频（15s）。
watch(previewing, () => restartPollTimer())

function stopPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  gateLive.value = null
  gateLiveError.value = ''
  faceLive.value = null
  faceLiveError.value = ''
  portLive.value = null
  portLiveError.value = ''
  craneLive.value = null
  craneLiveError.value = ''
}

// ---------------------------------------------------------------------------
// 人员计数实时统计（People Counting 预览）
// ---------------------------------------------------------------------------
// 统计口径与后端一致：ROI 内人数取 worker 最近一帧（检测器已按 ROI 过滤），
// 累计人数与 in/out 都来自后端持久化的 facts，与正式报表同源。
const gateLive = ref<GateLiveInfo | null>(null)
const gateLiveError = ref('')
const isCountingScript = computed(() => selectedScript.value?.isCounting === true)
// Pedestrian / Vehicle 在 ROI 内计数（画 ROI，无 IN/OUT）：覆盖 ROI 计数模型
// （isRoiCounting）与旧的隔离线模型（isSegregation），只统计人员/交通工具数量。
const isSegregation = computed(() =>
  selectedScript.value?.isSegregation === true || selectedScript.value?.isRoiCounting === true,
)
const roiPeopleLabel = computed(() => (gateLive.value?.roi_configured ? 'People in ROI (now)' : 'People (now, whole frame)'))

// ---------------------------------------------------------------------------
// 人脸识别实时读数（仿照 People Counting 展示）
// ---------------------------------------------------------------------------
const faceLive = ref<FaceLiveInfo | null>(null)
const faceLiveError = ref('')
const isFaceScript = computed(() => selectedScript.value?.isFace === true)

// ---------------------------------------------------------------------------
// 港口实时读数（Port Terminal Truck 装卸區 + Port Quay Crane 吊具視角）
// ---------------------------------------------------------------------------
// ``port``（port_terminal）是计数脚本，IN/OUT 走 GatePipeline 计数面板；这里
// 额外展示装卸區佔用時長 + 装卸代理（静止启发）。``port_crane`` 非计数脚本，
// 这里展示 crane cycle 阶段（pick-up / landing / hatch / idle）。
const portLive = ref<PortLiveInfo | null>(null)
const portLiveError = ref('')
const craneLive = ref<CraneLiveInfo | null>(null)
const craneLiveError = ref('')
const isPortScript = computed(() => selectedScript.value?.isPort === true)
// 港口两类模型按 detector_type 区分（ROI 为核心）：port_terminal = 集卡装卸區
//（车辆进入/离开 ROI 计算停留时长，箭头仅示意）；port_crane = 岸橋吊具 cycle；
// port_combined = 一个模型同时覆盖 truck + crane 两块读数。
const isPortTruck = computed(() =>
  ['port_terminal', 'port_combined'].includes(selectedScript.value?.detectorType ?? ''),
)
const isPortCrane = computed(() =>
  ['port_crane', 'port_combined'].includes(selectedScript.value?.detectorType ?? ''),
)

async function loadPortLive(): Promise<void> {
  if (!isPortTruck.value || !isRunning.value || !store.selectedCamera) {
    portLive.value = null
    return
  }
  try {
    portLive.value = await getPortLive(store.selectedCamera, store.selectedScriptId)
    portLiveError.value = ''
  } catch (err) {
    portLiveError.value = err instanceof Error ? err.message : String(err)
  }
}

async function loadCraneLive(): Promise<void> {
  if (!isPortCrane.value || !isRunning.value || !store.selectedCamera) {
    craneLive.value = null
    return
  }
  try {
    craneLive.value = await getCraneLive(store.selectedCamera, store.selectedScriptId)
    craneLiveError.value = ''
  } catch (err) {
    craneLiveError.value = err instanceof Error ? err.message : String(err)
  }
}

async function loadFaceLive(): Promise<void> {
  if (!isFaceScript.value || !isRunning.value || !store.selectedCamera) {
    faceLive.value = null
    return
  }
  try {
    faceLive.value = await getFaceLive(store.selectedCamera, store.selectedScriptId)
    faceLiveError.value = ''
  } catch (err) {
    faceLiveError.value = err instanceof Error ? err.message : String(err)
  }
}

// ---------------------------------------------------------------------------
// Realtime monitoring scope
// ---------------------------------------------------------------------------
// The previewed camera is only one of the AI model's cameras, and every camera
// runs its own worker. The event lists below used to hard-filter on the
// previewed camera, so switching to another camera was the only way to see the
// others. Detection history spans every camera of the AI model, so give the
// monitoring lists the same choice (default: all cameras).
const monitorCamera = ref('all')
const monitorCameras = computed<string[]>(() => selectedScript.value?.cameras ?? [])

/** Detection events of the selected AI model within the chosen camera scope. */
const monitorEvents = computed<EventItem[]>(() => {
  const script = selectedScript.value
  return store.detectionEvents.filter(
    (e) =>
      (e.script === script.name || e.script === script.id) &&
      (monitorCamera.value === 'all' || e.camera === monitorCamera.value),
  )
})

// Detailed detection rows are intentionally hidden on this page. Use History
// to search the durable events, paginate them, and inspect snapshots.
watch(monitorCamera, () => {
  if (isCountingScript.value && previewing.value) void loadPreviewHistory()
})

// ---------------------------------------------------------------------------
// 实时事件：直接逐条展示（不再按 5 分钟聚合）。点击任意一行打开 Result detail。
// ---------------------------------------------------------------------------
function openEventDetail(e: EventItem): void {
  store.selectedEvent = e
  store.resultDetailFromHistory = false
  store.showResultDetail = true
}

/** 渲染人脸识别结果的检测时刻（后端返回 UTC ISO 时间）。 */
function formatDetectedAt(value: string | null | undefined): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleTimeString([], { hour12: false })
}

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
  faceLive.value = null
  portLive.value = null
  craneLive.value = null
  if (isRunning.value) {
    void loadGateLive()
    void loadFaceLive()
    void loadPortLive()
    void loadCraneLive()
    void loadPreviewHistory()
  }
})

// 切换摄像机后，下拉里只剩该摄像机可用（已启用）的 AI model。
watch(() => store.selectedCamera, () => syncSelectedModel())
watch([() => store.selectedCamera, () => store.selectedScriptId], () => void loadPreviewRoi())

// 运行状态与统计保持一致：worker 在别处（本页 Preview 或 AI model 页 Run）
// 启动/停止后，本页自动跟随，无需刷新页面。轮询本身一直运行（见 pollTick）。
watch(isRunning, (running) => {
  if (running) {
    void loadGateLive()
    void loadFaceLive()
    void loadPortLive()
    void loadCraneLive()
  } else {
    gateLive.value = null
    faceLive.value = null
    portLive.value = null
    craneLive.value = null
    // 模型已停止：预览随之关闭（停止中的 model 不可预览）。
    previewing.value = false
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
    const res = await fetchTenantAsset(url)
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
  selectionLoading.value = false
  syncSelectedCamera()
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
        <span class="page-head-meta-value">{{ previewing ? 'Streaming now' : 'Ready to preview' }}</span>
      </div>
    </div>

    <div class="toolbar live-toolbar">
      <div class="field">
        <label for="live-organization">1 · Active Org ID</label>
        <input id="live-organization" :value="store.activeOrgId" readonly />
      </div>
      <div class="field">
        <label for="live-camera">2 · Select camera</label>
        <select id="live-camera" v-model="store.selectedCamera" :disabled="selectionBusy || !!selectionError || !displayCameras.length" :title="store.selectedCamera">
          <option v-if="selectionBusy" :value="store.selectedCamera">Loading cameras...</option>
          <option v-else-if="selectionError" :value="store.selectedCamera">Unable to load cameras</option>
          <option v-else-if="!displayCameras.length" value="">No cameras available</option>
          <option v-for="c in displayCameras" :key="c.id" :value="c.name">
            {{ c.name }} · {{ c.status }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="live-model">3 · Select AI model</label>
        <select id="live-model" v-model="store.selectedScriptId" :disabled="selectionBusy || !availableScripts.length" :title="selectedScript.name" aria-describedby="live-selection-hint">
          <option v-if="selectionBusy" :value="store.selectedScriptId">Loading AI models...</option>
          <option v-else-if="selectionError" value="">Unable to load AI models</option>
          <option v-else-if="!availableScripts.length" value="">No enabled AI models</option>
          <option v-for="s in availableScripts" :key="s.id" :value="s.id">
            {{ s.name }} · {{ store.scriptRuns[s.id]?.status ?? 'stopped' }}
          </option>
        </select>
      </div>
      <div id="live-selection-hint" class="live-selection-hint" aria-live="polite">
        <span v-if="selectionBusy" class="subtitle">Loading cameras and AI models...</span>
        <span v-else-if="selectionError" class="field-hint">Unable to load camera or AI model lists: {{ selectionError }}</span>
        <span v-else-if="!displayCameras.length" class="field-hint">No cameras available.</span>
        <span v-else-if="!availableScripts.length" class="field-hint">
          No AI model is enabled on {{ store.selectedCamera }} — assign one in the Camera page.
        </span>
        <span v-else-if="!isRunning" class="field-hint">
          This AI model is stopped — start it on the AI model page to preview.
        </span>
      </div>
      <div class="stream-state">
        <button
          class="btn"
          :class="previewing ? 'dark' : 'primary'"
          :disabled="!isRunning"
          :title="!isRunning ? 'This AI model is stopped — start it on the AI model page first' : ''"
          @click="togglePreview"
        >
          {{ previewing ? 'Stop Preview' : 'Preview' }}
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
          <span class="live-badge">{{ previewing ? 'LIVE' : 'OFFLINE' }}</span>
        </div>

        <div class="video">
          <div v-if="previewing" class="video-stage">
            <img
              :src="currentStreamUrl"
              alt="Live detection stream"
              class="video-frame"
              @load="onPreviewFrameLoad"
            />
            <svg
              v-if="previewRois.length"
              class="preview-roi-overlay"
              :viewBox="`0 0 ${previewFrameWidth} ${previewFrameHeight}`"
              preserveAspectRatio="xMidYMid meet"
              aria-label="Configured ROI boundary"
            >
              <polygon
                v-for="(roi, index) in previewRois"
                :key="roi.id ?? index"
                :points="roi.points.map(([x, y]) => `${x},${y}`).join(' ')"
                class="preview-roi-polygon"
              />
              <text
                v-for="(roi, index) in previewRois"
                :key="`label-${roi.id ?? index}`"
                :x="roi.points[0]?.[0] ?? 0"
                :y="Math.max(24, (roi.points[0]?.[1] ?? 24) - 8)"
                class="preview-roi-label"
              >ROI {{ index + 1 }}</text>
            </svg>
          </div>
          <div v-else class="video-placeholder">
            <span v-if="!isRunning">This AI model is stopped — start it on the AI model page, then click “Preview”.</span>
            <span v-else>Click “Preview” to view the AI-detected stream.</span>
          </div>
          <span class="video-caption">{{ selectedCameraLabel }}</span>
        </div>

        <div class="video-foot">
          <button class="btn" :disabled="!previewing" @click="togglePause">
            {{ store.previewPaused ? 'Resume' : 'Pause' }}
          </button>
          <button class="btn" :disabled="!previewing" @click="snapshot">Snapshot</button>
          <button class="btn" :disabled="!previewing" @click="toggleLabels">
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
            <p class="subtitle">Results from the selected script and camera scope.</p>
          </div>
          <div style="display: flex; align-items: end; gap: 12px">
            <label class="monitor-scope">
              <span>Camera</span>
              <select v-model="monitorCamera">
                <option value="all">All cameras</option>
                <option v-for="c in monitorCameras" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
            <button class="btn" @click="store.showHistory = true">History</button>
          </div>
        </div>

        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">Detections</div>
            <div class="stat-value">{{ monitorEvents.length }}</div>
            <span class="subtitle">
              Live statistics from the running AI model · detailed results are available in History
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
              <div class="gate-live-stat" v-if="isSegregation">
                <span class="gate-live-label">Vehicles (now)</span>
                <strong class="gate-live-value">{{ gateLive.roi_vehicles.now }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">{{ isSegregation ? 'People (this run)' : 'People in ROI (this run)' }}</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.session }}</strong>
              </div>
              <div class="gate-live-stat" v-if="isSegregation">
                <span class="gate-live-label">Vehicles (this run)</span>
                <strong class="gate-live-value">{{ gateLive.roi_vehicles.session }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">People today (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.day }}</strong>
              </div>
              <div class="gate-live-stat" v-if="isSegregation">
                <span class="gate-live-label">Vehicles today (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_vehicles.day }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">People total (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_people.total }}</strong>
              </div>
              <div class="gate-live-stat" v-if="isSegregation">
                <span class="gate-live-label">Vehicles total (cumulative)</span>
                <strong class="gate-live-value">{{ gateLive.roi_vehicles.total }}</strong>
              </div>
              <template v-if="!isSegregation">
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
              </template>
            </div>
            <div v-if="!isSegregation && gateLive.lines.length" class="gate-live-lines">
              <div v-for="line in gateLive.lines" :key="line.gate_id" class="gate-live-line">
                <span class="gate-live-line-name">{{ line.location || line.gate_id }}</span>
                <span class="gate-live-line-dir">
                  <span class="in">IN {{ line.in }}</span>
                  <span class="out">OUT {{ line.out }}</span>
                  <span class="subtitle">net {{ line.net }}</span>
                </span>
              </div>
            </div>
            <p v-if="!isSegregation" class="subtitle">
              IN = crossing along the drawn arrow (OUT → IN), OUT = crossing against it.
              Counts come from the same facts as the stored report.
            </p>
            <p v-else class="subtitle">
              People and vehicles inside the ROI are counted once per appearance —
              static / slow-moving objects detected across multiple frames are deduplicated.
            </p>
            <p v-if="!isSegregation && crossLineHint" class="subtitle" style="color: var(--yellow, #d29922)">
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
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the
            AI model page, then the ROI people/vehicle counts{{ isSegregation ? '' : ' and IN/OUT totals' }} will appear here.
          </p>
        </div>

        <div v-if="isPortTruck" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · loading bay</strong>
            <span class="subtitle">
              Truck bay occupancy + loading/unloading proxy (stationary heuristic, not pick-up/landing)
            </span>
            <span v-if="portLive?.mode === 'MOCK'" class="gate-live-badge">DEMO</span>
          </div>
          <p v-if="portLiveError" class="subtitle" style="color: var(--red)">{{ portLiveError }}</p>
          <template v-if="portLive && portLive.running">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">Trucks in loading bay (now)</span>
                <strong class="gate-live-value">{{ portLive.trucks_in_roi }}</strong>
              </div>
            </div>
            <div v-if="portLive.trucks.length" class="gate-live-lines">
              <div v-for="(t, i) in portLive.trucks" :key="t.track_id ?? i" class="gate-live-line">
                <span class="gate-live-line-name">truck #{{ t.track_id }}</span>
                <span class="gate-live-line-dir">
                  <span class="in">{{ t.loading ? 'loading proxy' : 'in bay' }}</span>
                  <span class="subtitle">{{ t.dwell ?? '…' }}</span>
                </span>
              </div>
            </div>
            <p v-else class="subtitle">No truck is currently inside the loading bay.</p>
          </template>
          <p v-else class="subtitle">
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the
            AI model page, then bay occupancy will appear here.
          </p>
        </div>

        <div v-if="isPortCrane" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · quay crane cycle</strong>
            <span class="subtitle">
              Open-vocabulary spreader / container / hatch + virtual PLC state machine
            </span>
            <span v-if="craneLive?.mode === 'MOCK'" class="gate-live-badge">DEMO</span>
          </div>
          <p v-if="craneLiveError" class="subtitle" style="color: var(--red)">{{ craneLiveError }}</p>
          <template v-if="craneLive && craneLive.running">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">Crane cycle state</span>
                <strong class="gate-live-value">{{ craneLive.state }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Spreader</span>
                <strong class="gate-live-value in">{{ craneLive.spreaders }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Container</span>
                <strong class="gate-live-value">{{ craneLive.containers }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Hatch</span>
                <strong class="gate-live-value out">{{ craneLive.hatches }}</strong>
              </div>
            </div>
          </template>
          <p v-else class="subtitle">
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the
            AI model page, then the crane cycle will appear here.
          </p>
        </div>

        <!-- Detection result rows are intentionally not rendered here. Open
             History and click Search to query the durable results. -->
      </section>
    </div>

    <ResultDetailModal />
    <HistoryModal />
  </section>
</template>
