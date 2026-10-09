<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getFaceLive, getGateLive, listCameras, listScripts, snapshotUrl, streamUrl } from '../api'
import type { FaceLiveInfo, GateLiveInfo } from '../api'
import type { Camera, EventItem, Script } from '../types'
import { displayFaceConfidence } from '../confidence'
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
const isRunning = computed(() => selectedScriptRun.value.status === 'running')

// 预览显示开关（纯前端）：Preview / Stop Preview 只控制是否显示预览画面，
// 与后端 AI model 是否 running 无关。后端 worker 只在 AI model 页手动 Stop
// 才停止，否则一直保持 running。
const previewing = ref(false)

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
  // 仅切换预览显示，绝不启动/停止后端 AI model。后端 model 的运行状态
  // 只在 AI model 页通过 Run/Stop 改变。停止中的 model 不可预览（按钮已禁用）。
  if (!previewing.value && !isRunning.value) return
  previewing.value = !previewing.value
  if (previewing.value) {
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
}

// ---------------------------------------------------------------------------
// 人员计数实时统计（People Counting 预览）
// ---------------------------------------------------------------------------
// 统计口径与后端一致：ROI 内人数取 worker 最近一帧（检测器已按 ROI 过滤），
// 累计人数与 in/out 都来自后端持久化的 facts，与正式报表同源。
const gateLive = ref<GateLiveInfo | null>(null)
const gateLiveError = ref('')
const isCountingScript = computed(() => selectedScript.value?.isCounting === true)
// Pedestrian / Vehicle Segregation：静态分界线，无 IN/OUT 语义，只统计人员/交通工具数量。
const isSegregation = computed(() => selectedScript.value?.isSegregation === true)
const roiPeopleLabel = computed(() => (gateLive.value?.roi_configured ? 'People in ROI (now)' : 'People (now, whole frame)'))

// ---------------------------------------------------------------------------
// 人脸识别实时读数（仿照 People Counting 展示）
// ---------------------------------------------------------------------------
const faceLive = ref<FaceLiveInfo | null>(null)
const faceLiveError = ref('')
const isFaceScript = computed(() => selectedScript.value?.isFace === true)

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

// The counting summary is built from durable history rows that are fetched per
// camera scope, so switching the scope must refetch them.
watch(monitorCamera, () => {
  if (isCountingScript.value) void loadPreviewHistory()
})

const intervalHistory = computed(() => {
  if (!isCountingScript.value) return []
  const buckets = new Map<
    string,
    { period: string; detections: number; roi: number; in: number; out: number; cameras: Set<string> }
  >()
  for (const event of store.historyEvents) {
    if (event.script !== selectedScript.value.name) continue
    if (monitorCamera.value !== 'all' && event.camera !== monitorCamera.value) continue
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
      cameras: new Set<string>(),
    }
    bucket.detections += 1
    if (event.camera) bucket.cameras.add(event.camera)
    if (event.name.toLowerCase().includes('entered roi')) bucket.roi += 1
    if (event.name.startsWith('IN ·')) bucket.in += 1
    if (event.name.startsWith('OUT ·')) bucket.out += 1
    buckets.set(key, bucket)
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({ ...b, key, cameraLabel: [...b.cameras].join(', ') }))
    .sort((a, b) => b.key.localeCompare(a.key))
})

// ---------------------------------------------------------------------------
// 实时事件按固定时间窗聚合（非计数脚本）
// ---------------------------------------------------------------------------
// 非计数脚本（如人脸识别）原本每个检测事件一行、大约每分钟一条；这里按
// LIVE_BUCKET_MINUTES 分钟一桶合并，减少列表行数，并在桶内汇总识别到的姓名。
const LIVE_BUCKET_MINUTES = 5

interface LiveEventBucket {
  startMs: number
  period: string
  count: number
  names: string[]
  cameras: Set<string>
  cameraLabel: string
  latest: EventItem | null
}

function extractDetectedName(eventName: string): string {
  // 人脸告警消息形如 "<Name> detected" / "Unknown detected"；抽取出姓名。
  const base = eventName.replace(/\s+detected\s*$/i, '').trim()
  if (!base || /unknown/i.test(base)) return ''
  return base
}

const liveEventBuckets = computed<LiveEventBucket[]>(() => {
  const minutes = LIVE_BUCKET_MINUTES
  const buckets = new Map<
    number,
    { count: number; names: Set<string>; cameras: Set<string>; latest: EventItem | null }
  >()
  for (const e of monitorEvents.value) {
    const ts = e.timestamp
    if (typeof ts !== 'number' || Number.isNaN(ts)) continue
    const start = Math.floor(ts / (minutes * 60000)) * (minutes * 60000)
    const bucket = buckets.get(start) ?? {
      count: 0,
      names: new Set<string>(),
      cameras: new Set<string>(),
      latest: null,
    }
    bucket.count += 1
    if (e.camera) bucket.cameras.add(e.camera)
    if (!bucket.latest || ts > (bucket.latest.timestamp ?? 0)) bucket.latest = e
    if (isFaceScript.value) {
      const name = extractDetectedName(e.name)
      if (name) bucket.names.add(name)
    }
    buckets.set(start, bucket)
  }
  return [...buckets.entries()]
    .map(([startMs, b]) => ({
      startMs,
      period: new Date(startMs).toLocaleTimeString([], { hour12: false }),
      count: b.count,
      names: [...b.names],
      cameras: b.cameras,
      cameraLabel: [...b.cameras].join(', '),
      latest: b.latest,
    }))
    .sort((a, b) => b.startMs - a.startMs)
})

function openBucket(bucket: LiveEventBucket): void {
  if (!bucket.latest) return
  store.selectedEvent = bucket.latest
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
  if (isRunning.value) {
    void loadGateLive()
    void loadFaceLive()
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
    void loadFaceLive()
  } else {
    gateLive.value = null
    faceLive.value = null
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
        <span class="page-head-meta-value">{{ previewing ? 'Streaming now' : 'Ready to preview' }}</span>
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
          :class="previewing ? 'dark' : 'primary'"
          :disabled="!isRunning"
          :title="!isRunning ? 'This AI model is stopped — start it on the AI model page first' : ''"
          @click="togglePreview"
        >
          {{ previewing ? 'Stop Preview' : 'Preview' }}
        </button>
        <span v-if="!isRunning" class="field-hint">
          This AI model is stopped — start it on the AI model page to preview.
        </span>
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
          <img
            v-if="previewing"
            :src="currentStreamUrl"
            alt="Live detection stream"
            class="video-frame"
          />
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
            <button class="btn" @click="clearEvents">Clear</button>
          </div>
        </div>

        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">Detections</div>
            <div class="stat-value">{{ monitorEvents.length }}</div>
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
              People and vehicles are counted as they appear in view (cumulative per run / today / all-time).
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

        <div v-if="isFaceScript" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · face recognition</strong>
            <span class="subtitle">
              Cumulative session counts; recognized people deduplicated per 5-minute window
            </span>
            <span v-if="faceLive?.mode === 'MOCK'" class="gate-live-badge">DEMO</span>
          </div>
          <p v-if="faceLiveError" class="subtitle" style="color: var(--red)">{{ faceLiveError }}</p>
          <template v-if="faceLive && faceLive.running">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">Faces detected (this run)</span>
                <strong class="gate-live-value">{{ faceLive.detections }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Recognized (this run)</span>
                <strong class="gate-live-value in">{{ faceLive.recognized }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Unknown (this run)</span>
                <strong class="gate-live-value out">{{ faceLive.unknown }}</strong>
              </div>
            </div>
            <div v-if="faceLive.people.length" class="gate-live-lines">
              <div v-for="p in faceLive.people" :key="p.name" class="gate-live-line">
                <span class="gate-live-line-name">{{ p.name }}</span>
                <span class="gate-live-line-dir">
                  <span class="in">{{ (displayFaceConfidence(p.confidence) * 100).toFixed(1) }}%</span>
                  <span v-if="p.count" class="subtitle">×{{ p.count }}</span>
                  <span v-if="p.last_seen_at" class="subtitle">{{ formatDetectedAt(p.last_seen_at) }}</span>
                </span>
              </div>
            </div>
            <p v-else class="subtitle">
              No registered person is in view — unrecognized faces are not matched to any name.
            </p>
          </template>
          <p v-else class="subtitle">
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the
            AI model page, then recognized names will appear here.
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
                  <template v-if="monitorCamera === 'all' && bucket.cameraLabel">
                    <strong>{{ bucket.cameraLabel }}</strong> ·
                  </template>
                  ROI entries {{ bucket.roi }} · IN {{ bucket.in }} · OUT {{ bucket.out }} · events {{ bucket.detections }}
                </div>
              </div>
            </div>
          </div>
          <div v-else class="detail-empty">No counting history for the selected camera scope.</div>
        </div>
        <div v-else class="events-list">
          <template v-if="liveEventBuckets.length">
            <div
              v-for="bucket in liveEventBuckets"
              :key="bucket.startMs"
              class="event"
              @click="openBucket(bucket)"
            >
              <span class="event-time">{{ bucket.period }}</span>
              <span class="event-mark ok"></span>
              <div>
                <div class="event-name">
                  {{ LIVE_BUCKET_MINUTES }}-minute summary · {{ bucket.count }} event{{ bucket.count === 1 ? '' : 's' }}
                </div>
                <div class="event-meta">
                  <template v-if="isFaceScript && bucket.names.length">
                    <strong>{{ bucket.names.join(', ') }}</strong>
                  </template>
                  <template v-else>
                    <strong>{{ bucket.cameraLabel || store.selectedCamera }}</strong> · {{ bucket.latest?.meta ?? '' }}
                  </template>
                </div>
              </div>
              <span v-if="bucket.latest" class="confidence">{{ bucket.latest.confidence }}</span>
            </div>
          </template>
          <div v-else class="detail-empty">No results for the selected script and camera scope.</div>
        </div>
      </section>
    </div>

    <ResultDetailModal />
    <HistoryModal />
  </section>
</template>
