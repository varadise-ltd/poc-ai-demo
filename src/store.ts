import { computed, reactive } from 'vue'
import * as api from './api'
import {
  cameraInputs as initialCameraInputs,
  cameraStatus as initialCameraStatus,
  events as initialEvents,
  historyEvents as initialHistoryEvents,
  scripts as initialScripts,
} from './data'
import type { Alert, Camera, CameraAI, EventItem, FaceData, FaceMeta, FaceValidation, GateConfig, HistoryEvent, PeopleCountReport, Script, ScriptRun } from './types'

export type TabId = 'demo' | 'people' | 'camera' | 'model' | 'dashboard' | 'face' | 'control' | 'config'

export const store = reactive({
  // Navigation
  activeTab: 'demo' as TabId,

  // Data collections
  scripts: initialScripts.map((s) => ({ ...s })) as Script[],
  events: initialEvents.map((e) => ({ ...e })) as EventItem[],
  historyEvents: initialHistoryEvents.map((e) => ({ ...e })) as HistoryEvent[],
  faceData: [] as FaceData[],
  faceLoading: false,
  faceError: '',
  faceMeta: null as FaceMeta | null,

  // Live detection results (from /api/alerts)
  detectionEvents: [] as EventItem[],

  // Selections
  selectedScriptId: 'helmet',
  selectedCamera: 'Site Entrance Camera',

  // Demo view state
  running: false,
  overlay: true,
  previewPaused: false,
  previewShowLabels: true,

  // Runtime state
  scriptRuns: {} as Record<string, ScriptRun>,
  scriptLoading: false,
  scriptError: '',
  cameraStatus: { ...initialCameraStatus } as Record<string, 'online' | 'offline'>,
  cameraInputs: { ...initialCameraInputs } as Record<string, string>,
  cameraOutputs: {} as Record<string, string>,

  // Camera management (SQLite-backed backend)
  cameras: [] as Camera[],
  cameraLoading: false,
  cameraError: '',
  gateConfigs: [] as GateConfig[],
  peopleReport: null as PeopleCountReport | null,
  peopleLoading: false,
  peopleError: '',
  peopleGranularity: 'hour' as 'hour' | 'day',
  peopleLocation: '',

  // Face management
  deletingFaceId: null as number | null,
  editingFaceId: null as number | null,

  // Modal visibility
  showResultDetail: false,
  showHistory: false,
  showControlDetail: false,
  showScriptDetail: false,
  showCameraEditor: false,
  showFaceEditor: false,
  showFaceDetail: false,
  showDeleteFace: false,
  showAiDetail: false,
  showAddAi: false,

  // Modal working state
  controlSelectedId: null as string | null,
  currentScriptDetailId: null as string | null,
  selectedEvent: null as EventItem | null,
  cameraEditorId: null as number | null,
  cameraEditorTitle: '',
  cameraEditorName: '',
  cameraEditorRtmp: '',
  cameraEditorResolution: '1920 × 1080',
  cameraEditorRotate: '0°',
  cameraEditorOrganization: '',
  cameraEditorOrgAdmin: '',
  cameraEditorChanged: false,
  cameraEditorMode: 'edit' as 'add' | 'edit',
  scriptDetailMode: 'edit' as 'add' | 'edit',
  newScriptName: '',
  newScriptDescription: '',

  // AI model instance detail (per camera, includes ROI setting tab)
  aiDetailCamera: null as string | null,
  aiDetailScriptId: null as string | null,
  aiDetailIid: null as number | null,

  // Per-camera AI model instances (index framework: cameraAI)
  cameraAI: [] as CameraAI[],
})

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

export const selectedScript = computed<Script>(
  () => store.scripts.find((s) => s.id === store.selectedScriptId) ?? store.scripts[0],
)

export const visibleEvents = computed<EventItem[]>(() => {
  const script = selectedScript.value
  return store.events.filter((e) => e.script === script.name && e.camera === store.selectedCamera)
})

export const liveEvents = computed<EventItem[]>(() => {
  const script = selectedScript.value
  return store.detectionEvents.filter((e) => e.script === script.name && e.camera === store.selectedCamera)
})

export const cameraList = computed<string[]>(() => Object.keys(store.cameraInputs))

export const loadedScripts = computed<Script[]>(() => store.scripts.filter((s) => s.loaded))

export const selectedScriptRun = computed<ScriptRun>(() => {
  return store.scriptRuns[store.selectedScriptId] ?? { status: 'stopped' }
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function statusDot(status: string): string {
  return status
}

export function selectScript(id: string): void {
  store.selectedScriptId = id
  const script = selectedScript.value
  if (!script.cameras.includes(store.selectedCamera)) {
    store.selectedCamera = script.cameras[0]
  }
}

export function selectCamera(name: string): void {
  store.selectedCamera = name
}

export async function loadPeopleCounting(): Promise<void> {
  store.peopleLoading = true
  store.peopleError = ''
  try {
    const [gates, report] = await Promise.all([
      api.listGateConfigs(store.selectedCamera),
      api.getPeopleCountReport({ cameraId: store.selectedCamera, location: store.peopleLocation || undefined, granularity: store.peopleGranularity }),
    ])
    store.gateConfigs = gates
    store.peopleReport = report
  } catch (err) {
    store.peopleError = err instanceof Error ? err.message : String(err)
  } finally {
    store.peopleLoading = false
  }
}

// 启停脚本（Control 页）：运行 = 用第一个已分配 camera 启动后端检测；停止 = 停止后端检测
export async function toggleRun(id: string): Promise<void> {
  const script = store.scripts.find((s) => s.id === id)
  if (!script || !script.cameras.length) return

  const current = store.scriptRuns[id]?.status ?? 'stopped'
  if (current === 'running') {
    const run = await api.stopScript(id)
    store.scriptRuns[id] = { status: run.status, camera: run.camera }
  } else {
    const camera = store.scriptRuns[id]?.camera ?? script.cameras[0]
    const run = await api.runScript(id, camera)
    store.scriptRuns[id] = { status: run.status, camera: run.camera }
  }
}

// ---------------------------------------------------------------------------
// Scripts / live preview (backend-driven)
// ---------------------------------------------------------------------------

export async function loadScripts(): Promise<void> {
  store.scriptLoading = true
  store.scriptError = ''
  try {
    const { scripts, runs } = await api.listScripts()
    store.scripts = scripts
    store.scriptRuns = runs
    // 校正选中项，避免指向不存在的脚本
    if (!store.scripts.some((s) => s.id === store.selectedScriptId)) {
      store.selectedScriptId = store.scripts[0]?.id ?? 'helmet'
    }
  } catch (err) {
    store.scriptError = err instanceof Error ? err.message : String(err)
  } finally {
    store.scriptLoading = false
  }
}

export async function updateScriptMetaRecord(
  id: string,
  fields: { organization?: string; scenario?: string },
): Promise<void> {
  await api.updateScriptMeta(id, fields)
  const script = store.scripts.find((s) => s.id === id)
  if (script) {
    if (fields.organization !== undefined) script.organization = fields.organization
    if (fields.scenario !== undefined) script.scenario = fields.scenario
  }
}

export async function startSelectedScript(): Promise<void> {
  try {
    const run = await api.runScript(store.selectedScriptId, store.selectedCamera)
    store.scriptRuns[store.selectedScriptId] = { status: run.status, camera: run.camera }
    store.running = run.status === 'running'
  } catch (err) {
    store.running = false
    throw err
  }
}

export async function stopSelectedScript(): Promise<void> {
  try {
    await api.stopScript(store.selectedScriptId)
    store.scriptRuns[store.selectedScriptId] = { status: 'stopped' }
    store.running = false
  } catch (err) {
    throw err
  }
}

function alertToEvent(a: Alert): EventItem {
  const ok = a.severity === 'Info'
  return {
    time: (a.timestamp || '').split(' ')[1] ?? a.timestamp,
    camera: a.camera ?? '',
    script: a.script,
    name: a.message,
    meta: a.camera ?? '',
    confidence: a.confidence ?? '',
    ok,
  }
}

export async function loadDetectionEvents(): Promise<void> {
  try {
    const alerts = await api.listAlerts()
    store.detectionEvents = alerts.map(alertToEvent)
  } catch {
    // 忽略轮询错误，保留旧数据
  }
}

export function clearEvents(): void {
  store.events.splice(0, store.events.length)
}

export function defaultOutput(scriptId: string, cam: string): string {
  return `rtmp://demo.cosmos.local/annotated/${scriptId}/${cam.toLowerCase().replace(/\s+/g, '-')}`
}

export function setCameraOutput(key: string, value: string): void {
  store.cameraOutputs[key] = value
}

// ---------------------------------------------------------------------------
// Camera management (SQLite-backed backend)
// ---------------------------------------------------------------------------

function syncCameraMaps(): void {
  const inputs: Record<string, string> = {}
  const status: Record<string, 'online' | 'offline'> = {}
  for (const c of store.cameras) {
    inputs[c.name] = c.rtmp
    status[c.name] = c.status
  }
  store.cameraInputs = inputs
  store.cameraStatus = status
}

export async function loadCameras(): Promise<void> {
  store.cameraLoading = true
  store.cameraError = ''
  try {
    store.cameras = await api.listCameras()
    syncCameraMaps()
  } catch (err) {
    store.cameraError = err instanceof Error ? err.message : String(err)
  } finally {
    store.cameraLoading = false
  }
}

export async function addCameraRecord(
  name: string,
  rtmp: string,
  status: 'online' | 'offline',
  resolution?: string,
  rotate?: string,
  organization?: string,
  org_admin?: string,
): Promise<void> {
  const cam = await api.createCamera(name, rtmp, status, resolution, rotate, organization, org_admin)
  store.cameras.push(cam)
  syncCameraMaps()
}

export async function updateCameraRecord(
  id: number,
  fields: {
    name?: string
    rtmp?: string
    status?: 'online' | 'offline'
    resolution?: string
    rotate?: string
    organization?: string
    org_admin?: string
  },
): Promise<void> {
  const cam = await api.updateCamera(id, fields)
  const idx = store.cameras.findIndex((c) => c.id === id)
  if (idx >= 0) store.cameras.splice(idx, 1, cam)
  syncCameraMaps()
}

export async function removeCameraRecord(id: number): Promise<void> {
  await api.deleteCamera(id)
  const idx = store.cameras.findIndex((c) => c.id === id)
  if (idx >= 0) store.cameras.splice(idx, 1)
  syncCameraMaps()
}

// 将后端探测得到的摄像机状态（online/offline）同步到内存镜像
export function applyCameraStatus(name: string, status: 'online' | 'offline'): void {
  store.cameraStatus[name] = status
  const cam = store.cameras.find((c) => c.name === name)
  if (cam) cam.status = status
}

// 探测摄像机输入流并持久化其 online/offline 状态到后端与数据库
export async function checkCameraStatus(name: string): Promise<api.CameraCheckResult> {
  const res = await api.checkCameraStream(name)
  applyCameraStatus(name, res.status)
  return res
}

export function addStreamCamera(): void {
  const script = store.scripts.find((s) => s.id === store.currentScriptDetailId)
  if (!script) return
  const available = cameraList.value.filter((c) => !script.cameras.includes(c))
  if (!available.length) return
  const cam = available[0]
  script.cameras.push(cam)
  store.cameraOutputs[`${script.id}::${cam}`] = defaultOutput(script.id, cam)
}

export function removeStreamCamera(cam: string): void {
  const script = store.scripts.find((s) => s.id === store.currentScriptDetailId)
  if (!script) return
  const idx = script.cameras.indexOf(cam)
  if (idx < 0) return
  script.cameras.splice(idx, 1)
  delete store.cameraOutputs[`${script.id}::${cam}`]
}

// ---------------------------------------------------------------------------
// Face management (SQLite-backed backend)
// ---------------------------------------------------------------------------

export async function loadFaces(): Promise<void> {
  store.faceLoading = true
  store.faceError = ''
  try {
    const [faces, meta] = await Promise.all([api.listFaces(), api.getFaceMeta()])
    store.faceData = faces
    store.faceMeta = meta
  } catch (err) {
    store.faceError = err instanceof Error ? err.message : String(err)
  } finally {
    store.faceLoading = false
  }
}

export async function addFaceRecord(name: string, file: File): Promise<FaceValidation | undefined> {
  const { face, validation } = await api.createFace(name, file)
  store.faceData.unshift(face)
  return validation
}

export async function updateFaceRecord(id: number, name?: string, file?: File): Promise<FaceValidation | undefined> {
  const { face, validation } = await api.updateFace(id, name, file)
  const idx = store.faceData.findIndex((f) => f.id === id)
  if (idx >= 0) store.faceData.splice(idx, 1, face)
  return validation
}

export async function removeFaceRecord(id: number): Promise<void> {
  await api.deleteFace(id)
  const idx = store.faceData.findIndex((f) => f.id === id)
  if (idx >= 0) store.faceData.splice(idx, 1)
}

// ---------------------------------------------------------------------------
// AI model CRUD (backend-driven)
// ---------------------------------------------------------------------------

export async function createScriptRecord(fields: {
  name: string
  description?: string
  organization?: string
  scenario?: string
}): Promise<Script> {
  const script = await api.createScript(fields)
  store.scripts.push(script)
  return script
}

export async function removeScriptRecord(id: string): Promise<void> {
  await api.deleteScript(id)
  const idx = store.scripts.findIndex((s) => s.id === id)
  if (idx >= 0) store.scripts.splice(idx, 1)
  store.cameraAI = store.cameraAI.filter((a) => a.scriptId !== id)
}

// ---------------------------------------------------------------------------
// Per-camera AI model instances (index framework: cameraAI)
// ---------------------------------------------------------------------------

export async function loadCameraAI(): Promise<void> {
  try {
    store.cameraAI = await api.listCameraAI()
  } catch {
    // 忽略加载错误，保留旧数据
  }
}

export async function addCameraAIRecord(fields: {
  camera: string
  scriptId: string
  name?: string
  enabled?: boolean
  output?: string
  params?: Record<string, number | boolean>
}): Promise<CameraAI> {
  const inst = await api.createCameraAI(fields)
  store.cameraAI.push(inst)
  // 相机与脚本建立关联（若尚未关联）
  const script = store.scripts.find((s) => s.id === inst.scriptId)
  if (script && !script.cameras.includes(inst.camera)) script.cameras.push(inst.camera)
  return inst
}

export async function updateCameraAIRecord(
  iid: number,
  fields: { name?: string; enabled?: boolean; output?: string; params?: Record<string, number | boolean> },
): Promise<void> {
  const inst = await api.updateCameraAI(iid, fields)
  const idx = store.cameraAI.findIndex((a) => a.iid === iid)
  if (idx >= 0) store.cameraAI.splice(idx, 1, inst)
}

export async function removeCameraAIRecord(iid: number): Promise<void> {
  await api.deleteCameraAI(iid)
  store.cameraAI = store.cameraAI.filter((a) => a.iid !== iid)
}
