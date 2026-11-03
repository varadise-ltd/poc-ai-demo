<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchTenantAsset, getCraneJobs, getCraneLive, getFaceLive, getGateLive, getPickupBayLive, getPortOverview, getRoi, isNormalizedRoiPoints, snapshotUrl, streamUrl } from '../api'
import type { CraneJob, CraneLiveInfo, FaceLiveInfo, GateLiveInfo, PickupBayLiveInfo, PortOverview, RoiPolygon } from '../api'
import type { Camera, EventItem, Script } from '../types'
import { formatDisplayConfidence } from '../confidence'
import {
  clearEvents,
  loadCameraAI,
  loadCameras,
  loadHistoryEvents,
  loadDetectionEvents,
  loadScriptCameraRuns,
  loadScripts,
  refreshSelectedScriptRun,
  scriptHasRunningCamera,
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
// Port panels are cross-camera. The selected preview camera may be the truck
// worker while the crane worker runs on the other assigned camera.
const isPortMonitoringRunning = computed(() =>
  !!store.selectedScriptId && scriptHasRunningCamera(store.selectedScriptId),
)

// 预览显示开关（纯前端）：Preview / Stop Preview 只控制是否显示预览画面，
// 与后端 AI model 是否 running 无关。后端 worker 只在 AI model 页手动 Stop
// 才停止，否则一直保持 running。
const previewing = ref(false)
const streamEpoch = ref(0)
const streamHasFrame = ref(false)
const streamConnectionError = ref(false)

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
  return streamUrl(
    store.selectedCamera,
    store.selectedScriptId,
    store.previewShowLabels,
    false,
    streamEpoch.value,
  )
})

const previewRois = ref<RoiPolygon[]>([])
const previewFrameWidth = ref(1280)
const previewFrameHeight = ref(720)

// ROI 以归一化坐标存储：渲染时按当前帧尺寸换算成像素（历史像素数据原样），
// 这样预览画面无论分辨率如何，虚线 ROI 都与实际帧边界对齐、不再漂移。
const previewRoisPixel = computed<RoiPolygon[]>(() =>
  previewRois.value.map((roi) => ({
    id: roi.id,
    points: isNormalizedRoiPoints(roi.points)
      ? roi.points.map(([x, y]) => [x * previewFrameWidth.value, y * previewFrameHeight.value] as [number, number])
      : roi.points,
  })),
)

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
  streamHasFrame.value = true
  streamConnectionError.value = false
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    // 只有真实分辨率变化（例如断流重连到不同分辨率的源）才更新，避免每帧都
    // 改写尺寸从而触发 previewRoisPixel 重算。
    if (
      image.naturalWidth !== previewFrameWidth.value ||
      image.naturalHeight !== previewFrameHeight.value
    ) {
      previewFrameWidth.value = image.naturalWidth
      previewFrameHeight.value = image.naturalHeight
    }
  }
}

function onPreviewFrameError(): void {
  // Do not replace the image source here. Replacing it while the browser is
  // reconnecting creates a reload loop and presents the whole video card as a
  // black frame. The browser keeps the MJPEG connection state and the card
  // background remains visible until the next valid frame arrives.
  streamConnectionError.value = true
}

// 画面左下角显示当前预览的真实摄像机与分辨率（原先是写死的装饰文字）
const selectedCameraLabel = computed(() => {
  const camera = store.cameras.find((c) => c.name === store.selectedCamera)
  const resolution = (camera?.resolution ?? '').trim()
  return resolution ? `${store.selectedCamera} • ${resolution}` : store.selectedCamera
})

let pollTimer: number | null = null
let craneJobsTimer: number | null = null
let pollInFlight = false

async function togglePreview(): Promise<void> {
  // 仅切换预览显示，绝不启动/停止后端 AI model。后端 model 的运行状态
  // 只在 AI model 页通过 Run/Stop 改变。停止中的 model 不可预览（按钮已禁用）。
  if (!previewing.value && !isRunning.value) return
  previewing.value = !previewing.value
  if (previewing.value) {
    streamEpoch.value += 1
    streamHasFrame.value = false
    streamConnectionError.value = false
    await loadPreviewRoi()
    await loadPreviewHistory()
    void loadCraneJobs()
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
// Preview status and event panels should follow the worker quickly. The video
// itself is an MJPEG stream; these intervals control the accompanying live
// statistics, not the camera frame rate.
const LIVE_POLL_MS = 1000
const CRANE_JOBS_POLL_MS = 1000
const IDLE_POLL_MS = 15000

async function pollTick(): Promise<void> {
  // 仅在 Live 页可见时轮询：切到其他 tab（v-show 常驻挂载）后台不发请求。
  if (store.activeTab !== 'demo') return
  // Do not start a second refresh while the previous network request is still
  // running. This keeps the shorter interval from creating request backlogs.
  if (pollInFlight) return
  pollInFlight = true
  try {
    await pollTickInternal()
  } finally {
    pollInFlight = false
  }
}

async function pollTickInternal(): Promise<void> {
  await refreshSelectedScriptRun()
  if (isPortScript.value) {
    // Refresh every assigned camera because the selected preview camera is not
    // necessarily the camera that owns the Crane worker.
    await loadScriptCameraRuns(store.selectedScriptId)
  }
  if (!isRunning.value && !isPortMonitoringRunning.value) return
  // 岸桥 crane 实时读数 + job 列表：只要相机 online + 模型 running 就持续刷新，
  // 不依赖是否在 preview（quay crane cycle 面板需在未 preview 时也展示 list）。
  if (isPortCrane.value && isPortMonitoringRunning.value) {
    void loadCraneLive()
    void loadCraneJobs()
  }
  // 跨相机港口总览同样在运行期间保持刷新（trucks + crane jobs 汇总）。
  if (isPortScript.value && isPortMonitoringRunning.value) {
    void loadPortOverview()
  }
  if (isPickupBayScript.value) void loadPickupBayLive()
  // 其余实时统计只在真正预览时才需要，未 preview 时不拉，避免无谓轮询。
  if (!previewing.value) return
  void loadDetectionEvents()
  void loadGateLive()
  void loadFaceLive()
  if (isCountingScript.value && !store.historyEvents.length) void loadPreviewHistory()
}

function restartPollTimer(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void pollTick(), previewing.value ? LIVE_POLL_MS : IDLE_POLL_MS)
  // 岸桥 job 列表独立高频刷新：只要 Crane 来源相机 online + 任一 Port
  // worker running 就刷新，无论当前 preview 选择哪台相机。
  if (craneJobsTimer) window.clearInterval(craneJobsTimer)
  craneJobsTimer = window.setInterval(() => {
    if (
      store.activeTab === 'demo' &&
      isPortMonitoringRunning.value &&
      isPortCrane.value &&
      craneSourceOnline.value
    ) {
      void loadCraneJobs()
    }
  }, CRANE_JOBS_POLL_MS)
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
  if (craneJobsTimer) {
    window.clearInterval(craneJobsTimer)
    craneJobsTimer = null
  }
  gateLive.value = null
  gateLiveError.value = ''
  faceLive.value = null
  faceLiveError.value = ''
  craneLive.value = null
  craneLiveError.value = ''
  craneJobs.value = []
  craneJobsError.value = ''
  portOverview.value = null
  portOverviewError.value = ''
  pickupBayLive.value = null
  pickupBayLiveError.value = ''
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
const craneLive = ref<CraneLiveInfo | null>(null)
const craneLiveError = ref('')
// 岸桥作业循环列表：每次「抓取集装箱 → 放置集装箱」一个 job，展示两个时间点
// （pick-up / landing）与对应时间差（每次装卸一个集装箱的耗时）。
const craneJobs = ref<CraneJob[]>([])
const craneJobsError = ref('')
const isPickupBayScript = computed(() => selectedScript.value?.isPickupBay === true || selectedScript.value?.detectorType === 'pickup_bay')
const isPortScript = computed(() => selectedScript.value?.isPort === true && !isPickupBayScript.value)
const pickupBayLive = ref<PickupBayLiveInfo | null>(null)
const pickupBayLiveError = ref('')
const pickupBayThreshold = computed(() => {
  const param = selectedScript.value?.params?.find((item) => item.key === 'STOP_TOO_LONG_THRESHOLD')
  return typeof param?.value === 'number' ? param.value : 120
})
const pickupBayOverdue = computed(() =>
  (pickupBayLive.value?.trucks ?? []).filter((vehicle) => (vehicle.dwell_seconds ?? 0) >= pickupBayThreshold.value),
)

async function loadPickupBayLive(): Promise<void> {
  if (!isPickupBayScript.value || !isRunning.value || !store.selectedCamera) {
    pickupBayLive.value = null
    return
  }
  try {
    pickupBayLive.value = await getPickupBayLive(store.selectedCamera, store.selectedScriptId)
    pickupBayLiveError.value = ''
  } catch (err) {
    pickupBayLiveError.value = err instanceof Error ? err.message : String(err)
  }
}
// 港口两类模型按 detector_type 区分（ROI 为核心）：port_terminal = 集卡装卸區
//（车辆进入/离开 ROI 计算停留时长，箭头仅示意）；port_crane = 岸橋吊具 cycle；
// port_combined = 一个模型同时覆盖 truck + crane 两块读数。
// Combined port monitoring is intentionally cross-camera: choosing the lane
// preview must still show the quay-crane panel, and choosing the quay preview
// must still show the truck overview. ``viewRole`` selects the worker's input,
// not which monitoring panels the operator may see.
const isPortCrane = computed(() =>
  ['port_crane', 'port_combined'].includes(selectedScript.value?.detectorType ?? ''),
)
// A combined model normally has one ``viewRole=crane`` assignment and one
// ``viewRole=truck`` assignment.  Always query Crane facts using the dedicated
// crane camera, even while the user is previewing the truck camera.  For a
// standalone Crane model or a legacy combined assignment without roles, fall
// back to the selected camera.
const craneSourceCamera = computed(() => {
  const scriptId = store.selectedScriptId
  if (!scriptId || !isPortCrane.value) return ''
  const instances = store.cameraAI.filter(
    (item) => item.scriptId === scriptId && item.enabled,
  )
  const craneInstance = instances.find(
    (item) => (item.viewRole ?? '').trim().toLowerCase() === 'crane',
  )
  if (craneInstance) return craneInstance.camera
  const selectedInstance = instances.find((item) => item.camera === store.selectedCamera)
  if ((selectedInstance?.viewRole ?? '').trim().toLowerCase() !== 'truck') {
    return store.selectedCamera
  }
  return instances.find((item) => (item.viewRole ?? '').trim().toLowerCase() !== 'truck')?.camera ?? ''
})
const craneSourceOnline = computed(
  () => store.cameraStatus[craneSourceCamera.value] === 'online',
)

async function loadCraneLive(): Promise<void> {
  if (!isPortCrane.value || !craneSourceCamera.value) {
    craneLive.value = null
    return
  }
  try {
    craneLive.value = await getCraneLive(craneSourceCamera.value, store.selectedScriptId)
    craneLiveError.value = ''
  } catch (err) {
    craneLiveError.value = err instanceof Error ? err.message : String(err)
  }
}

async function loadCraneJobs(): Promise<void> {
  if (!isPortCrane.value || !craneSourceCamera.value) {
    craneJobs.value = []
    return
  }
  try {
    craneJobs.value = await getCraneJobs(store.selectedScriptId, 20, craneSourceCamera.value)
    craneJobsError.value = ''
  } catch (err) {
    craneJobsError.value = err instanceof Error ? err.message : String(err)
  }
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const s = Math.round(value)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

function craneJobTypeLabel(jobType: string): string {
  switch (jobType) {
    case 'LOAD':
      return 'loading (onto trailer)'
    case 'DISCHARGE':
      return 'unloading (off trailer)'
    case 'HATCH':
      return 'hatch cover'
    default:
      return jobType
  }
}

// 跨相机港口总览：trucks（在 ROI 内 + 停留时长）+ crane jobs（抓取/放置 + 装货
// 时长）+ 时间窗融合。view_role 让同一 port_combined 模型可分挂在多台车道/岸桥
// 相机上，这里按 script_id 汇总所有相机的事实。
const portOverview = ref<PortOverview | null>(null)
const portOverviewError = ref('')

async function loadPortOverview(): Promise<void> {
  if (!isPortScript.value) {
    portOverview.value = null
    return
  }
  try {
    portOverview.value = await getPortOverview(store.selectedScriptId)
    portOverviewError.value = ''
  } catch (err) {
    portOverviewError.value = err instanceof Error ? err.message : String(err)
  }
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('en-GB', { hour12: false })
}

function formatSeconds(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '…' : `${value.toFixed(1)} s`
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
  streamEpoch.value += 1
  gateLive.value = null
  faceLive.value = null
  craneLive.value = null
  craneJobs.value = []
  portOverview.value = null
  streamHasFrame.value = false
  streamConnectionError.value = false
  if (isRunning.value || isPortMonitoringRunning.value) {
    void loadGateLive()
    void loadFaceLive()
    void loadPickupBayLive()
    void loadCraneLive()
    void loadCraneJobs()
    void loadPortOverview()
    void loadPreviewHistory()
  }
})

// 切换摄像机后，下拉里只剩该摄像机可用（已启用）的 AI model。
watch(() => store.selectedCamera, () => syncSelectedModel())
watch([() => store.selectedCamera, () => store.selectedScriptId], () => void loadPreviewRoi())

// 运行状态与统计保持一致：worker 在别处（本页 Preview 或 AI model 页 Run）
// 启动/停止后，本页自动跟随，无需刷新页面。轮询本身一直运行（见 pollTick）。
watch(isRunning, (running) => {
  if (running || isPortMonitoringRunning.value) {
    void loadGateLive()
    void loadFaceLive()
    void loadCraneLive()
    void loadCraneJobs()
    void loadPortOverview()
  } else if (!isPortMonitoringRunning.value) {
    gateLive.value = null
    faceLive.value = null
    craneLive.value = null
    craneJobs.value = []
    portOverview.value = null
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
              :class="{ 'video-frame-loading': !streamHasFrame }"
              @load="onPreviewFrameLoad"
              @error="onPreviewFrameError"
            />
            <div v-if="!streamHasFrame || streamConnectionError" class="video-stream-status" aria-live="polite">
              {{ streamConnectionError ? 'Reconnecting to camera…' : 'Connecting to camera…' }}
            </div>
            <svg
              v-if="previewRois.length"
              class="preview-roi-overlay"
              :viewBox="`0 0 ${previewFrameWidth} ${previewFrameHeight}`"
              preserveAspectRatio="xMidYMid meet"
              aria-label="Configured ROI boundary"
            >
              <polygon
                v-for="(roi, index) in previewRoisPixel"
                :key="roi.id ?? index"
                :points="roi.points.map(([x, y]) => `${x},${y}`).join(' ')"
                class="preview-roi-polygon"
              />
              <text
                v-for="(roi, index) in previewRoisPixel"
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

        <div v-if="isPortCrane" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · quay crane cycle</strong>
            <span class="subtitle">
              Top-down container motion: pick-up → landing, with per-container cycle time
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
                <span class="gate-live-label">Containers today</span>
                <strong class="gate-live-value">{{ craneLive.containers_today }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Containers completed (this run)</span>
                <strong class="gate-live-value in">{{ craneLive.containers_completed }}</strong>
              </div>
            </div>

            <p v-if="craneJobsError" class="subtitle" style="color: var(--red)">{{ craneJobsError }}</p>
            <div class="gate-live-lines">
              <div
                v-for="job in craneJobs"
                :key="job.id"
                class="gate-live-line crane-job-row"
              >
                <span class="gate-live-line-name">
                  <span class="crane-job-type">{{ craneJobTypeLabel(job.job_type) }}</span>
                  <span class="subtitle">{{ job.container_id }} · {{ job.target_class }}</span>
                </span>
                <span class="gate-live-line-dir">
                  <span class="subtitle">
                    #{{ job.container_sequence }} · pick-up {{ formatTime(job.pick_up_at) }}
                    · unloading/landing {{ formatTime(job.landing_at) }}
                    · <strong class="in">{{ formatDurationSeconds(job.duration_seconds) }}</strong>
                  </span>
                </span>
              </div>
            </div>
            <p v-if="!craneJobs.length" class="subtitle">
              No container cycles recorded yet — a pick-up followed by a landing will appear here
              with its measured time.
            </p>
          </template>
          <p v-else class="subtitle">
            {{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the
            AI model page, then the crane cycle will appear here.
          </p>
        </div>

        <div v-if="isPortScript" class="gate-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · Trunk cross-camera overview</strong>
            <span class="subtitle">
              Trucks in ROI + dwell time, with today and this-run totals across cameras
            </span>
          </div>
          <p v-if="portOverviewError" class="subtitle" style="color: var(--red)">{{ portOverviewError }}</p>
          <template v-if="portOverview">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">Trucks in ROI (all cameras)</span>
                <strong class="gate-live-value">{{ portOverview.trucks_in_roi }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Trucks today</span>
                <strong class="gate-live-value in">{{ portOverview.trucks_today }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Trucks this run</span>
                <strong class="gate-live-value">{{ portOverview.trucks_since_start }}</strong>
              </div>
            </div>
            <div v-if="portOverview.trucks.length" class="gate-live-lines">
              <div v-for="(t, i) in portOverview.trucks" :key="t.track_id ?? i" class="gate-live-line">
                <span class="gate-live-line-name">
                  truck #{{ t.track_id }} · {{ t.camera }}
                  <span class="subtitle">{{ t.vehicle_state === 'loading' ? 'loading' : (t.loaded ? 'loaded / exited' : 'in ROI (empty)') }}</span>
                  <span class="subtitle">key {{ t.visit_key ? t.visit_key.slice(0, 8) : '…' }}</span>
                  <span v-if="t.appearance?.enter" class="subtitle">app {{ t.appearance.enter.aspect_ratio }}:1 · {{ (t.appearance.enter.area_ratio ?? 0) * 100 | 0 }}%</span>
                  <span v-if="t.appearance?.enter?.ocr_text_ids?.length" class="subtitle">OCR {{ t.appearance.enter.ocr_text_ids.join(', ') }}</span>
                </span>
                <span class="gate-live-line-dir">
                    <span class="in">{{ t.vehicle_state === 'loading' ? 'loading proxy' : (t.loaded ? 'loaded / exited' : 'in ROI') }}</span>
                  <span class="subtitle">
                    in {{ t.entered_at ? formatTime(t.entered_at) : '…' }}
                    · out {{ t.exited_at ? formatTime(t.exited_at) : '—' }}
                    · dwell {{ formatSeconds(t.dwell_seconds) }}
                  </span>
                </span>
              </div>
            </div>
            <p v-if="!portOverview.trucks.length" class="subtitle">
              No truck visits recorded yet.
            </p>
          </template>
          <!-- The placeholder must state the real reason: "not running" is only
               one of them (a running model that is not being previewed loads
               its overview on demand, so the panel can still be empty). -->
          <p v-else-if="!isRunning" class="subtitle">
            {{ selectedScript.name }} is not running — start it from the AI model page to see the
            cross-camera truck + crane overview.
          </p>
          <p v-else class="subtitle">
            Loading the cross-camera truck + crane overview for {{ selectedScript.name }}…
          </p>
        </div>

        <div v-if="isPickupBayScript" class="gate-live pickup-bay-live">
          <div class="gate-live-head">
            <strong>{{ selectedScript.name }} · pickup bay dwell</strong>
            <span class="subtitle">Vehicle-only monitoring · no student or collector identification</span>
            <span v-if="pickupBayLive?.mode === 'MOCK'" class="gate-live-badge">DEMO</span>
          </div>
          <p v-if="pickupBayLiveError" class="subtitle" style="color: var(--red)">{{ pickupBayLiveError }}</p>
          <template v-if="pickupBayLive">
            <div class="gate-live-stats">
              <div class="gate-live-stat">
                <span class="gate-live-label">Vehicles in pickup bay</span>
                <strong class="gate-live-value">{{ pickupBayLive.trucks_in_roi }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Stop-too-long vehicles</span>
                <strong class="gate-live-value" :class="{ out: pickupBayOverdue.length }">{{ pickupBayOverdue.length }}</strong>
              </div>
              <div class="gate-live-stat">
                <span class="gate-live-label">Threshold</span>
                <strong class="gate-live-value">{{ pickupBayThreshold }}s</strong>
              </div>
            </div>
            <div v-if="pickupBayLive.trucks.length" class="gate-live-lines">
              <div v-for="(vehicle, index) in pickupBayLive.trucks" :key="vehicle.track_id ?? vehicle.entered_at ?? index" class="gate-live-line">
                <span class="gate-live-line-name">Vehicle #{{ vehicle.track_id ?? '—' }}<span class="subtitle">{{ vehicle.entered_at ? `entered ${formatTime(vehicle.entered_at)}` : 'tracking' }}</span></span>
                <span class="gate-live-line-dir" :class="{ 'pickup-bay-overdue': (vehicle.dwell_seconds ?? 0) >= pickupBayThreshold }">
                  <span :class="(vehicle.dwell_seconds ?? 0) >= pickupBayThreshold ? 'out' : 'in'">{{ (vehicle.dwell_seconds ?? 0) >= pickupBayThreshold ? 'STOP TOO LONG' : 'within threshold' }}</span>
                  <span class="subtitle">dwell {{ formatSeconds(vehicle.dwell_seconds) }}</span>
                </span>
              </div>
            </div>
            <p v-else class="subtitle">No vehicle is currently inside the pickup-bay ROI.</p>
          </template>
          <p v-else class="subtitle">{{ selectedScript.name }} is not running on {{ store.selectedCamera }} — start it from the AI model page.</p>
        </div>

        <!-- Detection result rows are intentionally not rendered here. Open
             History and click Search to query the durable results. -->
      </section>
    </div>

    <ResultDetailModal />
    <HistoryModal />
  </section>
</template>
