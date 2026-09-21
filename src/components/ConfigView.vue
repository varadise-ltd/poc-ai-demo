<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { clearRoi as apiClearRoi, getRoi, listCameras as apiListCameras, listScripts as apiListScripts, saveRoi as apiSaveRoi, snapshotUrl } from '../api'
import { loadCameras, loadFaces, loadScripts, removeCameraRecord, store } from '../store'
import type { Camera, Script } from '../types'
import ScriptDetailModal from './modals/ScriptDetailModal.vue'
import CameraEditorModal from './modals/CameraEditorModal.vue'
import FaceEditorModal from './modals/FaceEditorModal.vue'
import FaceDetailModal from './modals/FaceDetailModal.vue'
import DeleteFaceModal from './modals/DeleteFaceModal.vue'

type ConfigPanelId = 'cameraPanel' | 'scriptPanel' | 'facePanel' | 'roiPanel'

const activePanel = ref<ConfigPanelId>('cameraPanel')

const panelItems: { id: ConfigPanelId; label: string }[] = [
  { id: 'cameraPanel', label: 'Camera setting' },
  { id: 'scriptPanel', label: 'Object dectect setting' },
  { id: 'facePanel', label: 'Face Management' },
  { id: 'roiPanel', label: 'ROI Drawing' },
]

// ROI panel local state
const roiScriptId = ref(store.scripts[0]?.id ?? '')
const roiCamera = ref('')
// 已保存/已完成的 ROI 多边形（每个都有唯一 id，来自后端数据库）
interface RoiPolygonLocal {
  id: number | null
  points: [number, number][]
}
const roiPolygons = ref<RoiPolygonLocal[]>([])
// 当前正在绘制的多边形（尚未完成，双击后才会进入 roiPolygons）
const currentPoints = ref<[number, number][]>([])
const roiStatus = ref('')
const roiLoading = ref(false)
const roiSaving = ref(false)
const roiFrameKey = ref(0)
const roiImage = ref<HTMLImageElement | null>(null)
const roiNaturalW = ref(1280)
const roiNaturalH = ref(720)
// 绘图模式：点击「✏️ Drawing ROI」后开启，才允许在预览图上点击画点
const roiDrawing = ref(false)

// Detection object list (all scripts from backend /api/scripts)
const scriptOptions = computed(() => store.scripts)
// Camera list (all cameras from backend /api/cameras)
const cameraOptions = computed(() => store.cameras)

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

const roiFrameUrl = computed(() => {
  if (!roiCamera.value || !roiFrameKey.value) return ''
  return `${snapshotUrl(roiCamera.value, '', false)}&_=${roiFrameKey.value}`
})

const roiPointsString = computed(() => {
  const lines: string[] = []
  roiPolygons.value.forEach((poly, i) => {
    const label = `ROI ${i + 1}${poly.id !== null ? ` (id ${poly.id})` : ''}`
    lines.push(`${label}: ${poly.points.map((p) => `${p[0]},${p[1]}`).join(' ')}`)
  })
  if (currentPoints.value.length) {
    lines.push(`Drawing: ${currentPoints.value.map((p) => `${p[0]},${p[1]}`).join(' ')}`)
  }
  return lines.join('\n')
})

function ensureSelections(): boolean {
  if (!roiScriptId.value) {
    roiStatus.value = 'Please select a detection script.'
    return false
  }
  if (!roiCamera.value) {
    roiStatus.value = 'Please select a camera.'
    return false
  }
  return true
}

async function loadRoiForSelection(): Promise<void> {
  roiPolygons.value = []
  currentPoints.value = []
  roiDrawing.value = false
  selectedPoint.value = null
  pointMenu.value = null
  roiStatus.value = ''
  if (!roiScriptId.value || !roiCamera.value) return
  try {
    const roi = await getRoi(roiScriptId.value, roiCamera.value)
    roiPolygons.value = (roi.rois ?? []).map((r) => ({
      id: r.id ?? null,
      points: r.points.map((p) => [Number(p[0]), Number(p[1])]),
    }))
    if (roiPolygons.value.length) {
      // 已保存的 ROI 直接以「已完成」（绿色）状态呈现
      roiStatus.value = `Loaded ${roiPolygons.value.length} saved ROI polygon(s) for ${roiScriptId.value} · ${roiCamera.value}.`
    } else {
      roiStatus.value = 'No saved ROI for this script + camera.'
    }
  } catch (err) {
    roiStatus.value = err instanceof Error ? err.message : String(err)
  }
}

// Load Frame：从后端加载该组（script + camera）的实时帧，并同时载入已保存的 ROI
async function loadFrame(): Promise<void> {
  if (!ensureSelections()) return
  roiLoading.value = true
  roiDrawing.value = false
  currentPoints.value = []
  try {
    roiFrameKey.value += 1
    // 载入此组已保存的 ROI（若存在则以完成态叠加显示）
    await loadRoiForSelection()
    if (!roiPolygons.value.length) {
      roiStatus.value = 'Frame loaded — click ✏️ Drawing ROI to draw, then Save ROI to persist.'
    } else {
      roiStatus.value = `Frame loaded — showing ${roiPolygons.value.length} saved ROI polygon(s). Click ✏️ Drawing ROI to add more.`
    }
  } finally {
    roiLoading.value = false
  }
}

// Drawing ROI：切换绘图模式。开启后可连续绘制多个多边形，每个双击完成一个
function toggleDrawing(): void {
  if (!ensureSelections()) return
  if (roiFrameKey.value === 0) {
    roiStatus.value = 'Please click 📷 Load Frame first, then start drawing.'
    return
  }
  roiDrawing.value = !roiDrawing.value
  selectedPoint.value = null
  pointMenu.value = null
  if (roiDrawing.value) {
    currentPoints.value = []
    roiStatus.value = 'Drawing mode ON — click to add points · double-click to finish each ROI · double-click an existing ROI edge to add a point · then Save.'
  } else {
    currentPoints.value = []
    roiStatus.value = 'Drawing mode OFF.'
  }
}

function onFrameLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  roiNaturalW.value = img.naturalWidth
  roiNaturalH.value = img.naturalHeight
}

function addPoint(e: MouseEvent): void {
  const pt = pointFromEvent(e)
  if (!pt) return
  currentPoints.value = [...currentPoints.value, pt]
  roiStatus.value = `Added point (${pt[0]}, ${pt[1]}).`
}

// 单击立即加点；双击时浏览器会先派发两次 click（已各加一点），
// 因此双击处理里移除这两点、补加一个终点，再「完成当前多边形」。
function onCanvasClick(e: MouseEvent): void {
  pointMenu.value = null
  if (!roiDrawing.value) {
    roiStatus.value = 'Click ✏️ Drawing ROI to start drawing points.'
    return
  }
  addPoint(e)
}

function onCanvasDblClick(e: MouseEvent): void {
  if (!roiDrawing.value) return
  pointMenu.value = null
  // 双击 = 2 次 click，已各加一点；回退这 2 点，恢复双击前的状态
  const n = currentPoints.value.length
  currentPoints.value = currentPoints.value.slice(0, Math.max(0, n - 2))
  const inProgress = currentPoints.value.length > 0

  // 没有正在绘制的多边形时：优先在「已有 ROI」的边上插入一个点
  if (!inProgress) {
    if (insertPointOnEdge(e, true)) return
    roiStatus.value = 'Double-click near an existing ROI edge to add a point, or click to start drawing a new polygon.'
    return
  }

  // 正在绘制：双击结束当前多边形（补加终点并确认）
  addPoint(e)
  finalizeRoi()
}

// 完成当前多边形：追加到 roiPolygons 并清空 currentPoints，继续绘制下一个
function finalizeRoi(): void {
  if (currentPoints.value.length < 3) {
    roiStatus.value = 'ROI needs at least 3 points — add more points before finishing.'
    return
  }
  roiPolygons.value = [...roiPolygons.value, { id: null, points: [...currentPoints.value] }]
  currentPoints.value = []
  selectedPoint.value = null
  pointMenu.value = null
  roiStatus.value = `ROI #${roiPolygons.value.length} finalized — draw another (double-click to finish) or click 💾 Save ROI.`
}

function undoLastPoint(): void {
  if (!roiDrawing.value) {
    roiStatus.value = 'Enter ✏️ Drawing ROI mode first to undo points.'
    return
  }
  if (!currentPoints.value.length) {
    roiStatus.value = 'No points in the current polygon to undo.'
    return
  }
  currentPoints.value = currentPoints.value.slice(0, -1)
  roiStatus.value = 'Last point undone — continue drawing or double-click to finish.'
}

// Drag-to-move an existing ROI point: { poly, point }，poly === -1 表示当前绘制中的多边形
const draggingTarget = ref<{ poly: number; point: number } | null>(null)

// 选中态：左键点击选中一个 point，右键弹出删除提示
const selectedPoint = ref<{ poly: number; index: number } | null>(null)
// 删除提示菜单：位置用视口坐标（position: fixed）
const pointMenu = ref<{ poly: number; index: number; x: number; y: number } | null>(null)

function pointFromEvent(e: MouseEvent): [number, number] | null {
  const img = roiImage.value
  if (!img || !roiNaturalW.value || !roiNaturalH.value) return null
  const rect = img.getBoundingClientRect()
  const x = Math.round(((e.clientX - rect.left) / rect.width) * roiNaturalW.value)
  const y = Math.round(((e.clientY - rect.top) / rect.height) * roiNaturalH.value)
  const cx = Math.min(roiNaturalW.value, Math.max(0, x))
  const cy = Math.min(roiNaturalH.value, Math.max(0, y))
  return [cx, cy]
}

function startDragPoint(e: MouseEvent, poly: number, index: number): void {
  if (!roiDrawing.value) return
  if (e.button !== 0) return // 仅左键拖动顶点，中键/右键交给其它处理
  e.preventDefault()
  e.stopPropagation()
  draggingTarget.value = { poly, point: index }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', stopDragPoint)
}

function onDragMove(e: MouseEvent): void {
  const target = draggingTarget.value
  if (!target) return
  const pt = pointFromEvent(e)
  if (!pt) return
  if (target.poly === -1) {
    currentPoints.value = currentPoints.value.map((p, i) => (i === target.point ? pt : p))
  } else {
    roiPolygons.value = roiPolygons.value.map((poly, pi) =>
      pi === target.poly
        ? { ...poly, points: poly.points.map((p, i) => (i === target.point ? pt : p)) }
        : poly,
    )
  }
  roiStatus.value = `Moved point ${target.point + 1} to (${pt[0]}, ${pt[1]}).`
}

function stopDragPoint(): void {
  draggingTarget.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDragPoint)
}

// ------------------------------------------------------------------
// 选中 / 删除单个顶点：左键选中 → 右键弹提示 → 确认删除
// ------------------------------------------------------------------
function getPointCoords(poly: number, index: number): [number, number] | null {
  if (poly === -1) return currentPoints.value[index] ?? null
  return roiPolygons.value[poly]?.points[index] ?? null
}

function selectPoint(poly: number, index: number): void {
  selectedPoint.value = { poly, index }
  const pt = getPointCoords(poly, index)
  roiStatus.value = pt
    ? `Selected point ${index + 1} (${pt[0]}, ${pt[1]}) — right-click to delete it.`
    : ''
}

function onPointContextMenu(e: MouseEvent, poly: number, index: number): void {
  e.preventDefault()
  e.stopPropagation()
  selectPoint(poly, index)
  pointMenu.value = { poly, index, x: e.clientX, y: e.clientY }
}

function onCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (selectedPoint.value) {
    pointMenu.value = { ...selectedPoint.value, x: e.clientX, y: e.clientY }
    return
  }
  undoLastPoint()
}

function closePointMenu(): void {
  pointMenu.value = null
}

function confirmDeletePoint(): void {
  if (!pointMenu.value) return
  const { poly, index } = pointMenu.value
  if (poly === -1) {
    currentPoints.value = currentPoints.value.filter((_, i) => i !== index)
  } else {
    roiPolygons.value = roiPolygons.value.map((p, pi) =>
      pi === poly ? { ...p, points: p.points.filter((_, i) => i !== index) } : p,
    )
  }
  if (selectedPoint.value && selectedPoint.value.poly === poly && selectedPoint.value.index === index) {
    selectedPoint.value = null
  }
  roiStatus.value = `Deleted point ${index + 1}.`
  closePointMenu()
}

// ------------------------------------------------------------------
// 中键双击：在已有 ROI 多边形的某条边上插入一个新顶点（之后可拖动）
// ------------------------------------------------------------------
let lastMiddleDown = { time: 0, x: 0, y: 0 }

function onCanvasMouseDown(e: MouseEvent): void {
  if (e.button !== 1) return // 仅处理中键
  e.preventDefault() // 阻止浏览器自动滚动
  e.stopPropagation()
  if (!roiDrawing.value) return

  const now = performance.now()
  const dist = Math.hypot(e.clientX - lastMiddleDown.x, e.clientY - lastMiddleDown.y)
  if (now - lastMiddleDown.time < 450 && dist < 14) {
    // 中键双击
    lastMiddleDown = { time: 0, x: 0, y: 0 }
    if (!insertPointOnEdge(e)) {
      roiStatus.value = 'Middle double-click: click near an ROI edge to insert a point.'
    }
  } else {
    lastMiddleDown = { time: now, x: e.clientX, y: e.clientY }
  }
}

function pointToSegmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function insertPointOnEdge(e: MouseEvent, onlyExisting = false): boolean {
  const pt = pointFromEvent(e)
  if (!pt) return false
  const [cx, cy] = pt
  const threshold = 25 // 自然像素距离阈值（相对 1280×720）

  // 注意：不要在闭包里给外部 let 变量赋值——TS 控制流分析无法跟踪，
  // 会把 best 收窄为 null/never 导致构建报错。改为按返回值收集候选。
  type Candidate = { poly: number; index: number; dist: number }
  const bestIn = (polyIndex: number, points: [number, number][]): Candidate | null => {
    let local: Candidate | null = null
    for (let i = 0; i < points.length; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      const d = pointToSegmentDist(cx, cy, a[0], a[1], b[0], b[1])
      if (d <= threshold && (local === null || d < local.dist)) {
        local = { poly: polyIndex, index: i + 1, dist: d }
      }
    }
    return local
  }

  const candidates: Candidate[] = []
  roiPolygons.value.forEach((poly, pi) => {
    const c = bestIn(pi, poly.points)
    if (c) candidates.push(c)
  })
  // onlyExisting=true 时仅在已保存/已完成的多边形里寻找（用于左键双击加点到已有 ROI）
  if (!onlyExisting) {
    const c = bestIn(-1, currentPoints.value)
    if (c) candidates.push(c)
  }
  const best = candidates.length
    ? candidates.reduce((m, c) => (c.dist < m.dist ? c : m))
    : null

  if (!best) return false

  if (best.poly === -1) {
    const arr = [...currentPoints.value]
    arr.splice(best.index, 0, [cx, cy] as [number, number])
    currentPoints.value = arr
  } else {
    roiPolygons.value = roiPolygons.value.map((poly, pi) =>
      pi === best.poly
        ? {
            ...poly,
            points: [
              ...poly.points.slice(0, best.index),
              [cx, cy] as [number, number],
              ...poly.points.slice(best.index),
            ],
          }
        : poly,
    )
  }
  roiStatus.value = `Inserted point at (${cx}, ${cy}) into ROI edge — drag to adjust.`
  return true
}

// Clear ROI 二次确认：删除后果严重，先弹出确认对话框，避免误删
const showClearRoiConfirm = ref(false)
const roiClearing = ref(false)
const roiClearError = ref('')

function askClearRoi(): void {
  if (!ensureSelections()) return
  if (!roiPolygons.value.length && !currentPoints.value.length) {
    roiStatus.value = 'No ROI loaded for this script + camera — nothing to clear.'
    return
  }
  roiClearError.value = ''
  showClearRoiConfirm.value = true
}

async function confirmClearRoi(): Promise<void> {
  if (!ensureSelections()) return
  roiClearing.value = true
  roiClearError.value = ''
  try {
    await apiClearRoi(roiScriptId.value, roiCamera.value)
    roiPolygons.value = []
    currentPoints.value = []
    roiDrawing.value = false
    selectedPoint.value = null
    pointMenu.value = null
    roiStatus.value = `ROI cleared for ${roiScriptId.value} · ${roiCamera.value} (backend + database).`
    showClearRoiConfirm.value = false
  } catch (err) {
    roiClearError.value = err instanceof Error ? err.message : String(err)
  } finally {
    roiClearing.value = false
  }
}

async function saveRoiLocal(): Promise<void> {
  if (!ensureSelections()) return
  if (!roiPolygons.value.length) {
    roiStatus.value = 'No finalized ROI to save — draw at least one polygon (double-click to finish).'
    return
  }
  roiSaving.value = true
  try {
    const polygons = roiPolygons.value.map((p) => p.points)
    const saved = await apiSaveRoi(roiScriptId.value, roiCamera.value, polygons)
    roiPolygons.value = saved.rois.map((r) => ({ id: r.id ?? null, points: r.points }))
    roiDrawing.value = false
    currentPoints.value = []
    selectedPoint.value = null
    pointMenu.value = null
    roiStatus.value = `Saved ${roiPolygons.value.length} ROI polygon(s) · ${roiScriptId.value} · ${roiCamera.value}`
  } catch (err) {
    roiStatus.value = err instanceof Error ? err.message : String(err)
  } finally {
    roiSaving.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadScripts(), loadFaces(), loadCameras()])
  if (!store.scripts.some((s) => s.id === roiScriptId.value)) {
    roiScriptId.value = store.scripts[0]?.id ?? ''
  }
  if (!store.cameras.some((c) => c.name === roiCamera.value)) {
    roiCamera.value = store.cameras[0]?.name ?? ''
  }
  await loadRoiForSelection()
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDragPoint)
})

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

function openScriptDetail(id: string): void {
  store.scriptDetailMode = 'edit'
  store.currentScriptDetailId = id
  store.showScriptDetail = true
}

function addScript(): void {
  store.scriptDetailMode = 'add'
  store.currentScriptDetailId = null
  store.newScriptName = ''
  store.newScriptDescription = ''
  store.showScriptDetail = true
}

function addFace(): void {
  store.editingFaceId = null
  store.showFaceEditor = true
}

function editFace(id: number): void {
  store.editingFaceId = id
  store.showFaceEditor = true
}

function openDeleteFace(id: number): void {
  store.deletingFaceId = id
  store.showDeleteFace = true
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>Configuration</h1>
        <p class="subtitle">Manage cameras, scripts, script details, ROI drawing and face data.</p>
      </div>
    </div>

    <div class="config-layout">
      <aside class="panel side-list">
        <div class="side-title">Settings</div>
        <div
          v-for="item in panelItems"
          :key="item.id"
          class="side-item"
          :class="{ active: activePanel === item.id }"
          @click="activePanel = item.id"
        >
          {{ item.label }}
        </div>
      </aside>

      <section class="panel config-content">
        <!-- Camera panel -->
        <div id="cameraPanel" class="config-panel" :class="{ active: activePanel === 'cameraPanel' }">
          <div class="config-head">
            <div>
              <h2>Camera setting</h2>
              <p class="subtitle">Add, edit and manage multiple camera sources.</p>
            </div>
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
            <div v-for="cam in displayedCameras" :key="cam.id" class="config-row">
              <div>
                <button class="camera-link" @click="openCameraEditor(cam)">{{ cam.name }}</button>
                <span>{{ cam.rtmp }}</span>
                <span v-if="cam.organization || cam.org_admin" class="subtitle">
                  {{ cam.organization || '—' }} · {{ cam.org_admin || '—' }}
                </span>
              </div>
              <span class="pill" :class="{ gray: cam.status !== 'online' }">
                {{ cam.status === 'online' ? 'Connected' : 'Offline' }}
              </span>
              <div class="row-actions">
                <button class="btn" @click="openCameraEditor(cam)">Edit</button>
                <button class="btn" @click="removeCamera(cam)">Delete</button>
              </div>
            </div>
            <div v-if="!displayedCameras.length" class="detail-empty">
              {{ filteredCameras ? 'No cameras match the current filters.' : 'No cameras available.' }}
            </div>
          </div>
        </div>

        <!-- Script panel -->
        <div id="scriptPanel" class="config-panel" :class="{ active: activePanel === 'scriptPanel' }">
          <div class="config-head">
            <div>
              <h2>Object dectect setting</h2>
              <p class="subtitle">Review script status, descriptions, parameters and assigned cameras.</p>
            </div>
            <button class="btn primary" @click="addScript">+ Add script</button>
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
              </div>
            </div>
            <div v-if="!displayedScripts.length" class="detail-empty">
              {{ filteredScripts ? 'No scripts match the current filters.' : 'No scripts available.' }}
            </div>
          </div>
          <div class="notice">
            Select a Script to open its detail page. Each Script can be enabled or disabled independently and can be
            assigned to multiple cameras.
          </div>
        </div>

        <!-- Face panel -->
        <div id="facePanel" class="config-panel" :class="{ active: activePanel === 'facePanel' }">
          <div class="config-head">
            <div>
              <h2>Face Management</h2>
              <p class="subtitle">
                Active embedding:
                <strong>{{ store.faceMeta?.active_dim ?? '—' }}-d</strong>
                <span v-if="store.faceMeta">
                  (128-d: {{ store.faceMeta.available['128'] ? 'ready' : 'missing' }} ·
                  512-d: {{ store.faceMeta.available['512'] ? 'ready' : 'missing' }})
                </span>
              </p>
            </div>
            <button class="btn primary" @click="addFace">+ Add face data</button>
          </div>
          <div v-if="store.faceLoading" class="detail-empty">Loading face data…</div>
          <div v-else-if="store.faceError" class="detail-empty" style="color: var(--red)">{{ store.faceError }}</div>
          <div v-else class="config-list">
            <div v-for="face in store.faceData" :key="face.id" class="config-row face-row">
              <div class="face-identity">
                <img class="face-avatar" :src="face.image" :alt="`${face.name} avatar`" />
                <button class="face-link" @click="editFace(face.id)">{{ face.name }}</button>
                <span class="pill" :class="{ gray: !face.hasEmbedding }">128d{{ face.hasEmbedding ? ' ✓' : ' ✗' }}</span>
                <span class="pill" :class="{ gray: !face.hasEmbedding512 }">512d{{ face.hasEmbedding512 ? ' ✓' : ' ✗' }}</span>
                <span v-if="face.faceCount !== undefined" class="subtitle">{{ face.faceCount }} face(s) · {{ face.width }}×{{ face.height }}</span>
              </div>
              <div class="row-actions">
                <button class="btn" @click="editFace(face.id)">Edit</button>
                <button class="btn" @click="openDeleteFace(face.id)">Delete</button>
              </div>
            </div>
            <div v-if="!store.faceData.length" class="detail-empty">No face data available.</div>
          </div>
        </div>

        <!-- ROI panel -->
        <div id="roiPanel" class="config-panel" :class="{ active: activePanel === 'roiPanel' }">
          <div class="config-head">
            <div>
              <h2>ROI Drawing</h2>
              <p class="subtitle">Define regions of interest for each script and camera.</p>
            </div>
          </div>
          <div class="form-grid" style="margin-bottom: 20px">
            <div class="field">
              <label>Dectect Object Script</label>
              <select v-model="roiScriptId" @change="loadRoiForSelection">
                <option v-for="s in scriptOptions" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Camera list</label>
              <select v-model="roiCamera" @change="loadRoiForSelection">
                <option v-for="c in cameraOptions" :key="c.id" :value="c.name">
                  {{ c.name }} · {{ c.status }}
                </option>
              </select>
            </div>
          </div>
          <div class="roi-toolbar">
            <button
              class="btn primary"
              :disabled="roiLoading"
              title="Load a frame from the camera and fetch the saved ROI of this script + camera"
              @click="loadFrame"
            >
              📷 Load Frame
            </button>
            <button
              class="btn danger"
              title="Delete the saved ROI of this script + camera from backend and database (requires confirmation)"
              @click="askClearRoi"
            >
              🗑 Clear ROI
            </button>
            <button
              class="btn"
              :class="{ 'drawing-active': roiDrawing }"
              :title="roiDrawing ? 'Drawing mode ON — click to add points, double-click to finish, double-click an existing ROI edge to add a point' : 'Enter drawing mode to draw ROI points on the frame'"
              @click="toggleDrawing"
            >
              ✏️ Drawing ROI
            </button>
            <button
              class="btn primary"
              :disabled="roiSaving"
              title="Save the drawn ROI to backend and database"
              @click="saveRoiLocal"
            >
              💾 Save ROI
            </button>
          </div>
          <div class="roi-hint">
            <template v-if="roiDrawing">
              ✏️ Drawing mode — click to add points · double-click to finish each ROI · double-click an existing ROI edge to add a point · click a point to select it · right-click to delete the selected point · then 💾 Save ROI
            </template>
            <template v-else>
              ⌖ 📷 Load Frame fetches the frame + saved ROIs · 🗑 Clear ROI deletes them all · ✏️ Drawing ROI lets you draw multiple ROIs · 💾 Save ROI persists all to backend &amp; database
            </template>
          </div>

          <!-- Loaded frame with multiple ROI polygons overlay (static, no animation) -->
          <div
            v-if="roiFrameKey > 0"
            class="roi-canvas-wrap"
            :class="{ drawing: roiDrawing }"
            @click="onCanvasClick"
            @dblclick="onCanvasDblClick"
            @contextmenu="onCanvasContextMenu"
            @mousedown="onCanvasMouseDown"
          >
            <img
              ref="roiImage"
              :src="roiFrameUrl"
              class="roi-frame"
              alt="ROI frame"
              draggable="false"
              @load="onFrameLoad"
            />
            <svg class="roi-overlay" :viewBox="`0 0 ${roiNaturalW} ${roiNaturalH}`">
              <!-- 已保存/已完成的多边形（绿色） -->
              <g v-for="(poly, pi) in roiPolygons" :key="pi">
                <polygon
                  :points="poly.points.map((p) => `${p[0]},${p[1]}`).join(' ')"
                  class="roi-polygon finalized"
                />
                <circle
                  v-for="(p, i) in poly.points"
                  :key="i"
                  :cx="p[0]"
                  :cy="p[1]"
                  r="7"
                  class="roi-point"
                  :class="{
                    dragging: draggingTarget && draggingTarget.poly === pi && draggingTarget.point === i,
                    selected: selectedPoint && selectedPoint.poly === pi && selectedPoint.index === i,
                  }"
                  @mousedown.prevent.stop="startDragPoint($event, pi, i)"
                  @click.stop="selectPoint(pi, i)"
                  @contextmenu.prevent.stop="onPointContextMenu($event, pi, i)"
                />
              </g>
              <!-- 当前正在绘制的多边形（橙色） -->
              <polygon
                v-if="currentPoints.length"
                :points="currentPoints.map((p) => `${p[0]},${p[1]}`).join(' ')"
                class="roi-polygon"
              />
              <circle
                v-for="(p, i) in currentPoints"
                :key="'c' + i"
                :cx="p[0]"
                :cy="p[1]"
                r="7"
                class="roi-point"
                :class="{
                  dragging: draggingTarget && draggingTarget.poly === -1 && draggingTarget.point === i,
                  selected: selectedPoint && selectedPoint.poly === -1 && selectedPoint.index === i,
                }"
                @mousedown.prevent.stop="startDragPoint($event, -1, i)"
                @click.stop="selectPoint(-1, i)"
                @contextmenu.prevent.stop="onPointContextMenu($event, -1, i)"
              />
            </svg>

            <!-- 顶点删除提示菜单 -->
            <div
              v-if="pointMenu"
              class="roi-point-menu"
              :style="{ left: pointMenu.x + 'px', top: pointMenu.y + 'px' }"
              @mousedown.stop
              @click.stop
              @dblclick.stop
              @contextmenu.stop
            >
              <div class="roi-point-menu-title">Delete point {{ pointMenu.index + 1 }}?</div>
              <div class="roi-point-menu-actions">
                <button class="btn" @click="closePointMenu">Cancel</button>
                <button class="btn danger-solid" @click="confirmDeletePoint">Delete</button>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div v-else class="roi-drop" @click="loadFrame">
            <div class="roi-drop-icon">⇪</div>
            <div class="roi-drop-title">Load Frame</div>
            <div class="roi-drop-or">— or —</div>
            <div class="roi-drop-sub">Click to load a frame from the selected camera</div>
          </div>

          <div class="roi-status-row">
            <div class="field">
              <label>Current ROI Points</label>
              <textarea :value="roiPointsString" readonly rows="2"></textarea>
            </div>
            <div class="field">
              <label>ROI Status</label>
              <textarea v-model="roiStatus" readonly rows="2"></textarea>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Clear ROI confirmation dialog: explain the serious consequences before deleting -->
    <div class="detail-modal" :class="{ show: showClearRoiConfirm }">
      <div class="detail-dialog panel">
        <div class="panel-title">
          <h2>⚠️ Clear this ROI?</h2>
          <button class="icon-btn" :disabled="roiClearing" @click="showClearRoiConfirm = false">×</button>
        </div>
        <div class="detail-body">
          <p class="subtitle">
            You are about to <strong>permanently delete</strong> the saved ROI of
            <strong>{{ roiScriptId }}</strong> · <strong>{{ roiCamera }}</strong>
            ({{ roiPolygons.length }} polygon(s)) from the backend service and database.
          </p>
          <ul class="roi-clear-warning">
            <li>This action <strong>cannot be undone</strong> — the ROI points will be lost and must be redrawn manually.</li>
            <li>The detection engine will reload immediately: without an ROI, the script detects over the
              <strong>entire frame</strong>, which may cause false alerts or missed events.</li>
            <li>Any running detection that relies on this ROI will change behavior right away.</li>
          </ul>
          <p v-if="roiClearError" class="subtitle" style="color: var(--red)">{{ roiClearError }}</p>
          <div class="actions" style="justify-content: flex-end; margin-top: 22px">
            <button class="btn" :disabled="roiClearing" @click="showClearRoiConfirm = false">Cancel</button>
            <button
              class="btn danger-solid"
              :disabled="roiClearing"
              @click="confirmClearRoi"
            >
              {{ roiClearing ? 'Clearing…' : '🗑 Yes, delete the ROI' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <ScriptDetailModal />
    <CameraEditorModal />
    <FaceEditorModal />
    <FaceDetailModal />
    <DeleteFaceModal />
  </section>
</template>
