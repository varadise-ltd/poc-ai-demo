<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  clearRoi as apiClearRoi,
  deleteGateConfig,
  getRoi,
  listGateConfigs,
  saveGateConfig,
  saveRoi as apiSaveRoi,
  snapshotUrl,
} from '../../api'
import { store, updateCameraAIRecord } from '../../store'

// ---------------------------------------------------------------------------
// Modal shell: Common / ROI setting tabs for one AI model instance on a camera
// ---------------------------------------------------------------------------
const instance = computed(() =>
  store.cameraAI.find((a) => a.iid === store.aiDetailIid) ?? null,
)
const script = computed(() =>
  store.scripts.find((s) => s.id === store.aiDetailScriptId) ?? null,
)
const cameraName = computed(() => store.aiDetailCamera ?? '')

const activeTab = ref<'common' | 'roi'>('common')

// Common tab editable state (synced from the instance when the modal opens)
const detailName = ref('')
const detailEnabled = ref(true)
const detailOutput = ref('')
const detailParams = ref<Record<string, number | boolean>>({})
const saving = ref(false)
const saveError = ref('')

function syncCommonFromInstance(): void {
  const inst = instance.value
  detailName.value = inst?.name ?? script.value?.name ?? ''
  detailEnabled.value = inst?.enabled !== false
  detailOutput.value = inst?.output ?? ''
  const defaults: Record<string, number | boolean> = {}
  for (const p of script.value?.params ?? []) defaults[p.key] = p.value
  detailParams.value = { ...defaults, ...(inst?.params ?? {}) }
}

async function saveCommon(): Promise<void> {
  if (!store.aiDetailIid) return
  saving.value = true
  saveError.value = ''
  try {
    await updateCameraAIRecord(store.aiDetailIid, {
      name: detailName.value.trim() || script.value?.name,
      enabled: detailEnabled.value,
      output: detailOutput.value,
      params: detailParams.value,
    })
    close()
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

// 参数格式化（与 AI model setting 的 ScriptDetailModal 一致）
function formatParamValue(value: number | boolean | undefined, type: string): string {
  if (value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (type === 'float') return value.toFixed(2)
  return String(value)
}

function setParam(key: string, value: number | boolean): void {
  detailParams.value = { ...detailParams.value, [key]: value }
}

function close(): void {
  store.showAiDetail = false
  store.aiDetailCamera = null
  store.aiDetailScriptId = null
  store.aiDetailIid = null
}

// ---------------------------------------------------------------------------
// ROI drawing state (migrated from the old ROI Drawing panel; the
// script + camera pair is fixed by this modal instead of dropdowns)
// ---------------------------------------------------------------------------
interface RoiPolygonLocal {
  id: number | null
  points: [number, number][]
}
const roiPolygons = ref<RoiPolygonLocal[]>([])
const currentPoints = ref<[number, number][]>([])
const roiStatus = ref('')
const roiLoading = ref(false)
const roiSaving = ref(false)
const roiFrameKey = ref(0)
const roiImage = ref<HTMLImageElement | null>(null)
const roiNaturalW = ref(1280)
const roiNaturalH = ref(720)
const roiDrawing = ref(false)

const roiFrameUrl = computed(() => {
  if (!cameraName.value || !roiFrameKey.value) return ''
  return `${snapshotUrl(cameraName.value, '', false)}&_=${roiFrameKey.value}`
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

async function loadRoiForSelection(): Promise<void> {
  roiPolygons.value = []
  currentPoints.value = []
  roiDrawing.value = false
  lineDrawing.value = false
  lineStartPoint.value = null
  gateLines.value = []
  selectedPoint.value = null
  pointMenu.value = null
  roiStatus.value = ''
  if (!store.aiDetailScriptId || !cameraName.value) return
  try {
    const roi = await getRoi(store.aiDetailScriptId, cameraName.value)
    roiPolygons.value = (roi.rois ?? []).map((r) => ({
      id: r.id ?? null,
      points: r.points.map((p) => [Number(p[0]), Number(p[1])]),
    }))
    if (roiPolygons.value.length) {
      roiStatus.value = `Loaded ${roiPolygons.value.length} saved ROI polygon(s).`
    } else {
      roiStatus.value = 'No saved ROI for this AI model + camera.'
    }
  } catch (err) {
    roiStatus.value = err instanceof Error ? err.message : String(err)
  }
}

async function loadFrame(): Promise<void> {
  roiLoading.value = true
  roiDrawing.value = false
  currentPoints.value = []
  try {
    roiFrameKey.value += 1
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

function toggleDrawing(): void {
  if (roiFrameKey.value === 0) {
    roiStatus.value = 'Please click 📷 Load Frame first, then start drawing.'
    return
  }
  lineDrawing.value = false
  lineStartPoint.value = null
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
  // Counting scripts: load saved count lines once the real frame size is known
  // (normalized coords -> pixel coords conversion needs naturalW/H).
  if (isCountingScript.value && !gateLines.value.length) {
    void loadGateLines()
  }
}

function pointFromEvent(e: MouseEvent): [number, number] | null {
  const img = roiImage.value
  if (!img || !roiNaturalW.value || !roiNaturalH.value) return null
  const rect = img.getBoundingClientRect()
  if (!img.complete || !img.naturalWidth || rect.width <= 0 || rect.height <= 0) {
    roiStatus.value = 'Frame is not ready — load a camera frame before drawing.'
    return null
  }
  const x = Math.round(((e.clientX - rect.left) / rect.width) * roiNaturalW.value)
  const y = Math.round(((e.clientY - rect.top) / rect.height) * roiNaturalH.value)
  const cx = Math.min(roiNaturalW.value, Math.max(0, x))
  const cy = Math.min(roiNaturalH.value, Math.max(0, y))
  return [cx, cy]
}

function addPoint(e: MouseEvent): void {
  const pt = pointFromEvent(e)
  if (!pt) return
  currentPoints.value = [...currentPoints.value, pt]
  roiStatus.value = `Added point (${pt[0]}, ${pt[1]}).`
}

function onCanvasClick(e: MouseEvent): void {
  pointMenu.value = null
  if (lineDrawing.value) {
    onLineCanvasClick(e)
    return
  }
  if (!roiDrawing.value) {
    roiStatus.value = 'Click ✏️ Drawing ROI to start drawing points.'
    return
  }
  addPoint(e)
}

function onCanvasDblClick(e: MouseEvent): void {
  if (lineDrawing.value) return
  if (!roiDrawing.value) return
  pointMenu.value = null
  const n = currentPoints.value.length
  currentPoints.value = currentPoints.value.slice(0, Math.max(0, n - 2))
  const inProgress = currentPoints.value.length > 0

  if (!inProgress) {
    if (insertPointOnEdge(e, true)) return
    roiStatus.value = 'Double-click near an existing ROI edge to add a point, or click to start drawing a new polygon.'
    return
  }

  addPoint(e)
  finalizeRoi()
}

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

// Drag-to-move an existing ROI point: poly === -1 表示当前绘制中的多边形
const draggingTarget = ref<{ poly: number; point: number } | null>(null)
const selectedPoint = ref<{ poly: number; index: number } | null>(null)
const pointMenu = ref<{ poly: number; index: number; x: number; y: number } | null>(null)

function startDragPoint(e: MouseEvent, poly: number, index: number): void {
  if (!roiDrawing.value) return
  if (e.button !== 0) return
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

// 中键双击：在已有 ROI 边上插入顶点
let lastMiddleDown = { time: 0, x: 0, y: 0 }

function onCanvasMouseDown(e: MouseEvent): void {
  if (e.button !== 1) return
  e.preventDefault()
  e.stopPropagation()
  if (!roiDrawing.value) return

  const now = performance.now()
  const dist = Math.hypot(e.clientX - lastMiddleDown.x, e.clientY - lastMiddleDown.y)
  if (now - lastMiddleDown.time < 450 && dist < 14) {
    lastMiddleDown = { time: 0, x: 0, y: 0 }
    if (!insertPointOnEdge(e)) {
      roiStatus.value = 'Middle double-click: click near an ROI edge to insert a point.'
    }
  } else {
    lastMiddleDown = { time: now, x: e.clientX, y: e.clientY }
  }
}

function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
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
  const threshold = 25

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

// ---------------------------------------------------------------------------
// Count line (gate) drawing — only for counting scripts (People Counting).
// 用户画一条线 + 箭头方向（IN 侧）；后端 GatePipeline 按穿越方向统计进出。
// ---------------------------------------------------------------------------
interface GateLineLocal {
  gateId: string
  location: string
  start: [number, number] // pixel coords on the natural-size frame
  end: [number, number]
  arrowSign: 1 | -1 // +1: crossing toward the positive side is IN
  saved: boolean
}
const isCountingScript = computed(() => script.value?.isCounting === true)
const gateLines = ref<GateLineLocal[]>([])
const lineDrawing = ref(false)
const lineStartPoint = ref<[number, number] | null>(null)
const gateSaving = ref(false)
const gateLoading = ref(false)

function toggleLineDrawing(): void {
  if (roiFrameKey.value === 0) {
    roiStatus.value = 'Please click 📷 Load Frame first, then draw the count line.'
    return
  }
  lineDrawing.value = !lineDrawing.value
  lineStartPoint.value = null
  if (lineDrawing.value) {
    roiDrawing.value = false
    currentPoints.value = []
    roiStatus.value = 'Count line mode ON — click two points on the frame to draw the line. The arrow points at the IN side; use ⇄ Flip to reverse.'
  } else {
    roiStatus.value = 'Count line mode OFF.'
  }
}

function onLineCanvasClick(e: MouseEvent): void {
  const pt = pointFromEvent(e)
  if (!pt) return
  if (!lineStartPoint.value) {
    lineStartPoint.value = pt
    roiStatus.value = `Line start (${pt[0]}, ${pt[1]}) — click the end point.`
    return
  }
  const start = lineStartPoint.value
  if (Math.hypot(pt[0] - start[0], pt[1] - start[1]) < 10) {
    roiStatus.value = 'Line too short — click a farther end point.'
    return
  }
  const nextId = gateLines.value.length + 1
  gateLines.value = [
    ...gateLines.value,
    {
      gateId: `line-${nextId}`,
      location: `Line ${nextId}`,
      start,
      end: pt,
      arrowSign: 1,
      saved: false,
    },
  ]
  lineStartPoint.value = null
  roiStatus.value = `Count line #${nextId} added — drag endpoints to adjust, ⇄ Flip to reverse IN/OUT, then 💾 Save Lines.`
}

/** 箭头单位法向量（指向 IN 侧）；与后端 draw_overlay 相同的约定。 */
function arrowVector(line: GateLineLocal): { nx: number; ny: number; mx: number; my: number } {
  const dx = line.end[0] - line.start[0]
  const dy = line.end[1] - line.start[1]
  const len = Math.hypot(dx, dy) || 1
  // 正侧单位法向 = (-dy, dx)/len；arrowSign=-1 时翻转指向负侧。
  let nx = -dy / len
  let ny = dx / len
  if (line.arrowSign <= 0) {
    nx = -nx
    ny = -ny
  }
  return { nx, ny, mx: (line.start[0] + line.end[0]) / 2, my: (line.start[1] + line.end[1]) / 2 }
}

function arrowTip(line: GateLineLocal): [number, number] {
  const { nx, ny, mx, my } = arrowVector(line)
  const len = Math.max(28, Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]) * 0.22)
  return [mx + nx * len, my + ny * len]
}

function arrowTail(line: GateLineLocal): [number, number] {
  const { nx, ny, mx, my } = arrowVector(line)
  const len = Math.max(28, Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]) * 0.22)
  return [mx + nx * len * 0.35, my + ny * len * 0.35]
}

function flipGateLine(index: number): void {
  gateLines.value = gateLines.value.map((line, i) =>
    i === index ? { ...line, arrowSign: (line.arrowSign === 1 ? -1 : 1) as 1 | -1 } : line,
  )
  roiStatus.value = `Line #${index + 1} direction flipped — the arrow now marks the new IN side. Save to apply.`
}

async function removeGateLine(index: number): Promise<void> {
  const line = gateLines.value[index]
  gateLines.value = gateLines.value.filter((_, i) => i !== index)
  if (line?.saved) {
    try {
      await deleteGateConfig(cameraName.value, line.gateId)
      roiStatus.value = `Line "${line.gateId}" deleted from backend & database.`
    } catch (err) {
      roiStatus.value = roiErrorMessage(err)
    }
  } else {
    roiStatus.value = `Line #${index + 1} removed (was not saved yet).`
  }
}

async function loadGateLines(): Promise<void> {
  if (!isCountingScript.value || !cameraName.value) return
  gateLoading.value = true
  try {
    const gates = await listGateConfigs(cameraName.value)
    gateLines.value = gates
      .filter((g) => g.enabled)
      .map((g) => ({
        gateId: g.gate_id,
        location: g.location,
        start: [Math.round(g.line_start_x * roiNaturalW.value), Math.round(g.line_start_y * roiNaturalH.value)] as [number, number],
        end: [Math.round(g.line_end_x * roiNaturalW.value), Math.round(g.line_end_y * roiNaturalH.value)] as [number, number],
        arrowSign: g.arrow_sign === -1 ? -1 : 1,
        saved: true,
      }))
    if (gateLines.value.length) {
      roiStatus.value = (roiStatus.value ? `${roiStatus.value} ` : '') + `Loaded ${gateLines.value.length} saved count line(s).`
    }
  } catch (err) {
    roiStatus.value = roiErrorMessage(err)
  } finally {
    gateLoading.value = false
  }
}

async function saveGateLines(): Promise<void> {
  if (!isCountingScript.value || gateSaving.value) return
  if (!gateLines.value.length) {
    roiStatus.value = 'No count line to save — enable ✏️ Draw Line and click two points first.'
    return
  }
  gateSaving.value = true
  try {
    const savedLines: GateLineLocal[] = []
    for (const line of gateLines.value) {
      const gate = await saveGateConfig({
        camera_id: cameraName.value,
        gate_id: line.gateId,
        location: line.location || line.gateId,
        line_start_x: line.start[0] / roiNaturalW.value,
        line_start_y: line.start[1] / roiNaturalH.value,
        line_end_x: line.end[0] / roiNaturalW.value,
        line_end_y: line.end[1] / roiNaturalH.value,
        enabled: true,
        arrow_sign: line.arrowSign,
      })
      savedLines.push({
        gateId: gate.gate_id,
        location: gate.location,
        start: line.start,
        end: line.end,
        arrowSign: gate.arrow_sign === -1 ? -1 : 1,
        saved: true,
      })
    }
    gateLines.value = savedLines
    lineDrawing.value = false
    lineStartPoint.value = null
    roiStatus.value = `Saved ${savedLines.length} count line(s) for ${cameraName.value} — running workers hot-reload the new lines & arrow directions.`
  } catch (err) {
    roiStatus.value = roiErrorMessage(err)
  } finally {
    gateSaving.value = false
  }
}

// Drag count-line endpoints while in line mode.
const draggingLine = ref<{ index: number; point: 'start' | 'end' } | null>(null)

function startDragLinePoint(e: MouseEvent, index: number, point: 'start' | 'end'): void {
  if (!lineDrawing.value) return
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  draggingLine.value = { index, point }
  window.addEventListener('mousemove', onDragLineMove)
  window.addEventListener('mouseup', stopDragLinePoint)
}

function onDragLineMove(e: MouseEvent): void {
  const target = draggingLine.value
  if (!target) return
  const pt = pointFromEvent(e)
  if (!pt) return
  gateLines.value = gateLines.value.map((line, i) =>
    i === target.index ? { ...line, [target.point]: pt } : line,
  )
}

function stopDragLinePoint(): void {
  draggingLine.value = null
  window.removeEventListener('mousemove', onDragLineMove)
  window.removeEventListener('mouseup', stopDragLinePoint)
}

// Clear ROI 二次确认
const showClearRoiConfirm = ref(false)
const roiClearing = ref(false)
const roiClearError = ref('')

function askClearRoi(): void {
  if (!roiPolygons.value.length && !currentPoints.value.length) {
    roiStatus.value = 'No ROI loaded for this AI model + camera — nothing to clear.'
    return
  }
  roiClearError.value = ''
  showClearRoiConfirm.value = true
}

async function confirmClearRoi(): Promise<void> {
  if (!store.aiDetailScriptId || roiClearing.value || roiSaving.value) return
  roiClearing.value = true
  roiClearError.value = ''
  try {
    await apiClearRoi(store.aiDetailScriptId, cameraName.value)
    roiPolygons.value = []
    currentPoints.value = []
    roiDrawing.value = false
    selectedPoint.value = null
    pointMenu.value = null
    roiStatus.value = `ROI cleared for ${store.aiDetailScriptId} · ${cameraName.value} (backend + database).`
    showClearRoiConfirm.value = false
  } catch (err) {
    roiClearError.value = roiErrorMessage(err)
  } finally {
    roiClearing.value = false
  }
}

async function saveRoiLocal(): Promise<void> {
  if (!store.aiDetailScriptId || roiSaving.value || roiClearing.value) return
  if (currentPoints.value.length) {
    if (currentPoints.value.length < 3) {
      roiStatus.value = 'ROI needs at least 3 points. Add more points before saving.'
      return
    }
    finalizeRoi()
  }
  if (!roiPolygons.value.length) {
    roiStatus.value = 'No finalized ROI to save — draw at least one polygon (double-click to finish).'
    return
  }
  if (roiPolygons.value.some((polygon) =>
    polygon.points.length < 3 || polygon.points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))) {
    roiStatus.value = 'Invalid ROI coordinates — load a frame and redraw the ROI.'
    return
  }
  roiSaving.value = true
  try {
    const polygons = roiPolygons.value.map((p) => p.points)
    const saved = await apiSaveRoi(store.aiDetailScriptId, cameraName.value, polygons)
    roiPolygons.value = saved.rois.map((r) => ({ id: r.id ?? null, points: r.points }))
    roiDrawing.value = false
    currentPoints.value = []
    selectedPoint.value = null
    pointMenu.value = null
    roiStatus.value = `Saved ${roiPolygons.value.length} ROI polygon(s) · ${store.aiDetailScriptId} · ${cameraName.value}`
    // The ROI is persisted and the detector reload has been requested.
    // Close the same modal for every camera/model combination.
    close()
  } catch (err) {
    roiStatus.value = roiErrorMessage(err)
  } finally {
    roiSaving.value = false
  }
}

function roiErrorMessage(err: unknown): string {
  return err instanceof TypeError
    ? 'Cannot reach backend. Ensure the local API on port 8000 is running, then retry. Changes have not been confirmed saved.'
    : err instanceof Error ? err.message : String(err)
}

// 打开 modal 时重置状态并载入该组合的 ROI + 实例配置
watch(
  () => store.showAiDetail,
  async (show) => {
    if (!show) return
    activeTab.value = 'common'
    roiFrameKey.value = 0
    syncCommonFromInstance()
    await loadRoiForSelection()
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDragPoint)
  window.removeEventListener('mousemove', onDragLineMove)
  window.removeEventListener('mouseup', stopDragLinePoint)
})
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showAiDetail }" aria-hidden="true">
    <div class="detail-dialog panel" style="width: min(680px, 100%)">
      <div class="panel-title">
        <div>
          <h2>{{ instance?.name ?? script?.name ?? 'AI model' }}</h2>
          <p class="subtitle">
            Configure this AI model instance for <strong>{{ cameraName }}</strong>.
          </p>
        </div>
        <button class="icon-btn" @click="close">×</button>
      </div>

      <div class="modal-tabs">
        <button class="modal-tab" :class="{ active: activeTab === 'common' }" @click="activeTab = 'common'">
          Common
        </button>
        <button class="modal-tab" :class="{ active: activeTab === 'roi' }" @click="activeTab = 'roi'">
          ROI setting
        </button>
      </div>

      <div class="detail-body">
        <!-- Common tab -->
        <div v-show="activeTab === 'common'">
          <div class="config-section">
            <h3>General</h3>
            <div class="form-grid">
              <div class="field full">
                <label>Custom name</label>
                <input v-model="detailName" placeholder="Custom name" />
              </div>
              <div class="field">
                <label>Based on AI model</label>
                <input :value="script?.name ?? store.aiDetailScriptId ?? ''" disabled />
              </div>
              <div class="field">
                <label>Enabled</label>
                <select v-model="detailEnabled">
                  <option :value="true">Enabled</option>
                  <option :value="false">Disabled</option>
                </select>
              </div>
            </div>
          </div>
          <div class="config-section">
            <h3>Output stream</h3>
            <div class="form-grid">
              <div class="field full">
                <label>Output stream (AI cam)</label>
                <input v-model="detailOutput" placeholder="rtmp://…" />
              </div>
            </div>
          </div>
          <div class="config-section">
            <h3>🎛️ Detection Parameters</h3>
            <div v-if="script?.params?.length" class="form-grid">
              <div v-for="p in script.params" :key="p.key" class="field full">
                <label>{{ p.label }}</label>
                <template v-if="p.type === 'checkbox'">
                  <div class="param-row checkbox-row">
                    <input
                      type="checkbox"
                      :checked="Boolean(detailParams[p.key] ?? p.value)"
                      @change="setParam(p.key, ($event.target as HTMLInputElement).checked)"
                    />
                    <strong class="param-value">{{ formatParamValue(detailParams[p.key] ?? p.value, p.type) }}</strong>
                    <span class="subtitle">{{ p.description }}</span>
                  </div>
                </template>
                <template v-else>
                  <input
                    type="range"
                    :value="Number(detailParams[p.key] ?? p.value)"
                    :min="p.min"
                    :max="p.max"
                    :step="p.step"
                    class="param-range"
                    @input="setParam(p.key, Number(($event.target as HTMLInputElement).value))"
                  />
                  <div class="param-row">
                    <strong class="param-value">{{ formatParamValue(detailParams[p.key] ?? p.value, p.type) }}</strong>
                    <span class="subtitle">{{ p.description }}</span>
                  </div>
                </template>
              </div>
            </div>
            <p v-else class="subtitle">This AI model has no configurable parameters.</p>
          </div>
          <p v-if="saveError" class="subtitle" style="color: var(--red)">{{ saveError }}</p>
          <div class="actions" style="justify-content: flex-end; margin-top: 6px">
            <button class="btn" @click="close">Cancel</button>
            <button class="btn primary" :disabled="saving" @click="saveCommon">
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>

        <!-- ROI setting tab -->
        <div v-show="activeTab === 'roi'">
          <div class="config-section">
            <h3>Region of interest</h3>
            <p class="subtitle" style="margin-bottom: 12px">
              Define the region of interest for this AI model on <strong>{{ cameraName }}</strong>.
            </p>
            <div class="roi-toolbar">
              <button
                class="btn primary"
                :disabled="roiLoading"
                title="Load a frame from the camera and fetch the saved ROI"
                @click="loadFrame"
              >
                📷 Load Frame
              </button>
              <button
                class="btn danger"
                title="Delete the saved ROI from backend and database (requires confirmation)"
                @click="askClearRoi"
              >
                🗑 Clear ROI
              </button>
              <button
                class="btn"
                :class="{ 'drawing-active': roiDrawing }"
                title="Enter drawing mode to draw ROI points on the frame"
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
            <div v-if="isCountingScript" class="roi-toolbar">
              <button
                class="btn"
                :class="{ 'drawing-active': lineDrawing }"
                :disabled="gateLoading"
                title="Draw a count line with an IN-direction arrow (people counting)"
                @click="toggleLineDrawing"
              >
                ↔️ Draw Count Line
              </button>
              <button
                class="btn primary"
                :disabled="gateSaving || !gateLines.length"
                title="Save count lines + arrow directions to backend and database"
                @click="saveGateLines"
              >
                {{ gateSaving ? 'Saving…' : '💾 Save Lines' }}
              </button>
              <span v-for="(line, i) in gateLines" :key="line.gateId" class="gate-line-chip">
                <strong>{{ line.location || line.gateId }}</strong>
                <button class="btn" title="Flip the IN/OUT arrow direction" @click="flipGateLine(i)">⇄ Flip</button>
                <button class="btn danger" title="Delete this count line" @click="removeGateLine(i)">🗑</button>
              </span>
            </div>
            <div class="roi-hint">
              <template v-if="lineDrawing">
                ↔️ Count line mode — click two points to draw the line · drag endpoints to adjust · ⇄ Flip reverses the IN/OUT arrow · 💾 Save Lines persists to backend &amp; database · the arrow always points toward the IN side
              </template>
              <template v-else-if="roiDrawing">
                ✏️ Drawing mode — click to add points · double-click to finish each ROI · double-click an existing ROI edge to add a point · click a point to select it · right-click to delete the selected point · then 💾 Save ROI
              </template>
              <template v-else>
                ⌖ 📷 Load Frame fetches the frame + saved ROIs · 🗑 Clear ROI deletes them all · ✏️ Drawing ROI lets you draw multiple ROIs · 💾 Save ROI persists all to backend &amp; database
              </template>
            </div>

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
                <defs>
                  <marker id="gate-arrow-head" viewBox="0 0 10 10" refX="8" refY="5"
                          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#00c8ff" />
                  </marker>
                </defs>
                <!-- Count lines with IN-direction arrows (people counting) -->
                <g v-for="(line, li) in gateLines" :key="'gate' + li">
                  <line
                    :x1="line.start[0]" :y1="line.start[1]"
                    :x2="line.end[0]" :y2="line.end[1]"
                    class="gate-line"
                  />
                  <line
                    :x1="arrowTail(line)[0]" :y1="arrowTail(line)[1]"
                    :x2="arrowTip(line)[0]" :y2="arrowTip(line)[1]"
                    class="gate-arrow"
                    marker-end="url(#gate-arrow-head)"
                  />
                  <text :x="arrowTip(line)[0]" :y="arrowTip(line)[1] - 10" class="gate-arrow-label">
                    IN → {{ line.location || line.gateId }}
                  </text>
                  <circle
                    :cx="line.start[0]" :cy="line.start[1]" r="8"
                    class="roi-point gate-endpoint"
                    @mousedown.prevent.stop="startDragLinePoint($event, li, 'start')"
                  />
                  <circle
                    :cx="line.end[0]" :cy="line.end[1]" r="8"
                    class="roi-point gate-endpoint"
                    @mousedown.prevent.stop="startDragLinePoint($event, li, 'end')"
                  />
                </g>
                <!-- In-progress line while drawing -->
                <line
                  v-if="lineStartPoint"
                  :x1="lineStartPoint[0]" :y1="lineStartPoint[1]"
                  :x2="lineStartPoint[0]" :y2="lineStartPoint[1]"
                  class="gate-line pending"
                />
                <circle
                  v-if="lineStartPoint"
                  :cx="lineStartPoint[0]" :cy="lineStartPoint[1]" r="8"
                  class="roi-point gate-endpoint"
                />
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

            <div v-else class="roi-drop" @click="loadFrame">
              <div class="roi-drop-icon">⇪</div>
              <div class="roi-drop-title">Load Frame</div>
              <div class="roi-drop-or">— or —</div>
              <div class="roi-drop-sub">Click to load a frame from {{ cameraName }}</div>
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
        </div>
      </div>
    </div>
  </div>

  <!-- Clear ROI confirmation dialog -->
  <div class="detail-modal" :class="{ show: showClearRoiConfirm }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <h2>⚠️ Clear this ROI?</h2>
        <button class="icon-btn" :disabled="roiClearing" @click="showClearRoiConfirm = false">×</button>
      </div>
      <div class="detail-body">
        <p class="subtitle">
          You are about to <strong>permanently delete</strong> the saved ROI of
          <strong>{{ store.aiDetailScriptId }}</strong> · <strong>{{ cameraName }}</strong>
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
          <button class="btn danger-solid" :disabled="roiClearing" @click="confirmClearRoi">
            {{ roiClearing ? 'Clearing…' : '🗑 Yes, delete the ROI' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
