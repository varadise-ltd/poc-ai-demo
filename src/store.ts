import { computed, reactive } from 'vue'
import * as api from './api'
import {
  cameraInputs as initialCameraInputs,
  cameraStatus as initialCameraStatus,
  events as initialEvents,
  historyEvents as initialHistoryEvents,
  scripts as initialScripts,
} from './data'
import type { Alert, Camera, CameraAI, CameraModelRun, EventItem, FaceData, FaceMeta, FaceValidation, HistoryEvent, Script, ScriptRun } from './types'

export type TabId = 'demo' | 'camera' | 'model' | 'dashboard' | 'face'
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

  // AI Cam Live view state
  running: false,
  overlay: true,
  previewPaused: false,
  previewShowLabels: true,

  // Runtime state
  scriptRuns: {} as Record<string, ScriptRun>,
  // Per-camera run state, keyed by `${scriptId}::${camera}` (AI model page).
  cameraRuns: {} as Record<string, CameraModelRun>,
  scriptLoading: false,
  scriptError: '',
  cameraStatus: { ...initialCameraStatus } as Record<string, 'online' | 'offline'>,
  cameraInputs: { ...initialCameraInputs } as Record<string, string>,

  // Camera management (SQLite-backed backend)
  cameras: [] as Camera[],
  cameraLoading: false,
  cameraError: '',

  // Face management
  deletingFaceId: null as number | null,
  editingFaceId: null as number | null,
  // 保存人脸后的后端校验结果提示。保存成功后弹窗一律关闭，告警改在列表中展示，
  // 避免用户误以为保存失败而重复提交。
  faceNotice: null as { name: string; summary: string; messages: string[] } | null,

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
  // 新建 AI model 必须选择一个内置场景作为检测器接线基座。
  newScriptBaseId: '',
  // 已被软删除的 AI model（可恢复）。仅在选择“已删除”视图时按需加载。
  deletedScripts: [] as Script[],

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

// 启停脚本（AI model 页）：一次启停该脚本下所有可操作的相机。
// 每台相机也可以单独在展开的 output stream 表格里 run/stop（toggleCameraRun）。
export async function toggleRun(id: string): Promise<void> {
  const script = store.scripts.find((s) => s.id === id)
  if (!script || !script.cameras.length) return
  await toggleScriptCameras(id)
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
    await api.stopScript(store.selectedScriptId, store.selectedCamera)
    store.scriptRuns[store.selectedScriptId] = { status: 'stopped' }
    store.running = false
  } catch (err) {
    throw err
  }
}

// ---------------------------------------------------------------------------
// Per-camera run control (AI model page)
// ---------------------------------------------------------------------------

/** Key for one AI model instance on one camera. */
export function cameraRunKey(scriptId: string, camera: string): string {
  return `${scriptId}::${camera}`
}

/** Run state of one camera; falls back to camera connectivity when unknown. */
export function cameraRun(scriptId: string, camera: string): CameraModelRun {
  return (
    store.cameraRuns[cameraRunKey(scriptId, camera)] ?? {
      script_id: scriptId,
      camera,
      status: 'stopped',
      camera_status: store.cameraStatus[camera] ?? 'offline',
      can_run: (store.cameraStatus[camera] ?? 'offline') === 'online',
      mode: 'REAL',
      health: 'stopped',
      message: '',
    }
  )
}

/** True when at least one camera of the AI model is running. */
export function scriptHasRunningCamera(scriptId: string): boolean {
  const prefix = `${scriptId}::`
  return Object.entries(store.cameraRuns).some(
    ([key, run]) => key.startsWith(prefix) && run.status === 'running',
  )
}

/** Load the per-camera run states for one AI model. */
export async function loadScriptCameraRuns(scriptId: string): Promise<void> {
  try {
    const runs = await api.listScriptCameras(scriptId)
    for (const run of runs) store.cameraRuns[cameraRunKey(scriptId, run.camera)] = run
  } catch {
    // Keep previously known state; the row falls back to camera connectivity.
  }
}

/** Load per-camera run states for every AI model (used on page load). */
export async function loadAllCameraRuns(): Promise<void> {
  await Promise.all(store.scripts.map((s) => loadScriptCameraRuns(s.id)))
}

/** Start or stop exactly one camera of one AI model. */
export async function toggleCameraRun(scriptId: string, camera: string): Promise<void> {
  const current = cameraRun(scriptId, camera)
  const result =
    current.status === 'running'
      ? await api.stopScriptCamera(scriptId, camera)
      : await api.runScriptCamera(scriptId, camera)
  store.cameraRuns[cameraRunKey(scriptId, camera)] = result
  syncScriptRunFromCameras(scriptId)
}

/** Start/stop every camera of one AI model that can be toggled. */
export async function toggleScriptCameras(scriptId: string): Promise<void> {
  const script = store.scripts.find((s) => s.id === scriptId)
  if (!script) return
  const stopping = scriptHasRunningCamera(scriptId)
  for (const camera of script.cameras) {
    const run = cameraRun(scriptId, camera)
    if (stopping ? run.status === 'running' : run.can_run) {
      await toggleCameraRun(scriptId, camera)
    }
  }
}

/** Mirror the aggregate camera state into the script-level run state. */
function syncScriptRunFromCameras(scriptId: string): void {
  store.scriptRuns[scriptId] = {
    status: scriptHasRunningCamera(scriptId) ? 'running' : 'stopped',
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

// ---------------------------------------------------------------------------
// Camera × AI model assignments (one relation, shared by both pages)
// ---------------------------------------------------------------------------

/**
 * Effective output stream for one camera, preferring the URL saved on the
 * Camera page so both pages display the same thing.
 */
export function scriptOutput(scriptId: string, cam: string): string {
  return cameraRun(scriptId, cam).output || defaultOutput(scriptId, cam)
}

/** Cameras that can still be assigned to a script (not already assigned). */
export function availableStreamCameras(scriptId: string): string[] {
  const target = script(scriptId)
  if (!target) return []
  return cameraList.value.filter((c) => !target.cameras.includes(c))
}

function script(scriptId: string): Script | undefined {
  return store.scripts.find((s) => s.id === scriptId)
}

/**
 * Assign a camera to an AI model.
 *
 * Persists through `/api/scripts/{id}/cameras/{camera}`, which writes the same
 * relation row the Camera page creates — so the assignment survives a reload and
 * shows up there too. The catalog is reloaded because `script.cameras` is derived
 * from that relation.
 */
export async function addStreamCamera(scriptId: string, cam: string): Promise<void> {
  if (!cam) return
  await api.assignScriptCamera(scriptId, cam)
  await Promise.all([loadScripts(), loadCameraAI(), loadScriptCameraRuns(scriptId)])
}

/**
 * Unassign a camera from an AI model.
 *
 * Stops the camera's worker and drops its ROI on the backend, then refreshes both
 * pages so the leftover instance disappears from the Camera page as well.
 */
export async function removeStreamCamera(scriptId: string, cam: string): Promise<void> {
  await api.unassignScriptCamera(scriptId, cam)
  delete store.cameraRuns[cameraRunKey(scriptId, cam)]
  await Promise.all([loadScripts(), loadCameraAI()])
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

/**
 * Update a camera.
 *
 * A rename is cascaded by the backend across the camera × AI-model relation and
 * the ROI polygons, so the AI model page is reloaded here to pick the new name up
 * (a stale entry would otherwise keep pointing at the old one).
 */
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
  const previous = store.cameras.find((c) => c.id === id)
  const renamed = !!fields.name && !!previous && fields.name !== previous.name
  const cam = await api.updateCamera(id, fields)
  const idx = store.cameras.findIndex((c) => c.id === id)
  if (idx >= 0) store.cameras.splice(idx, 1, cam)
  syncCameraMaps()
  if (renamed) await refreshAssignments()
}

/**
 * Delete a camera.
 *
 * The backend drops every AI model of that camera, so both the instance list and
 * the AI model catalog are reloaded: leaving them behind would show phantom
 * assignments that can no longer be run.
 */
export async function removeCameraRecord(id: number): Promise<void> {
  await api.deleteCamera(id)
  const idx = store.cameras.findIndex((c) => c.id === id)
  if (idx >= 0) store.cameras.splice(idx, 1)
  syncCameraMaps()
  await refreshAssignments()
}

/**
 * Reload the shared camera × AI-model relation into both pages.
 *
 * The Camera page shows it as `cameraAI` instances, the AI model page as
 * `script.cameras`, and both are derived from the same table — so any mutation
 * made on either page has to refresh both to stay consistent.
 */
export async function refreshAssignments(): Promise<void> {
  await Promise.all([loadCameras(), loadCameraAI(), loadScripts(), loadAllCameraRuns()])
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

/**
 * Create a custom AI model. `baseScriptId` selects the built-in scenario whose
 * detector wiring (detector_type / model / classes / params) is cloned, because
 * that wiring is code-driven and the engine cannot run an invented model.
 */
export async function createScriptRecord(fields: {
  name: string
  baseScriptId: string
  description?: string
  organization?: string
  scenario?: string
}): Promise<Script> {
  const script = await api.createScript({
    name: fields.name,
    base_script_id: fields.baseScriptId,
    description: fields.description,
    organization: fields.organization,
    scenario: fields.scenario,
  })
  store.scripts.push(script)
  return script
}

/** Soft-deleted AI models, kept in sync so the restore list is always current. */
export async function loadDeletedScripts(): Promise<void> {
  try {
    store.deletedScripts = await api.listDeletedScripts()
  } catch {
    // 忽略加载错误，保留旧数据
  }
}

/**
 * Restore a soft-deleted AI model.
 *
 * Deletion only flags the model (`deleted=1`) and clears its runtime state, so
 * restoring re-adds the same catalog entry and reloading refills the list.
 */
export async function restoreScriptRecord(id: string): Promise<Script> {
  const script = await api.restoreScript(id)
  store.deletedScripts = store.deletedScripts.filter((s) => s.id !== id)
  await Promise.all([loadScripts(), loadDeletedScripts()])
  return script
}

/** Delete one AI model: drop its local state and refresh the catalog from the backend. */
export async function removeScriptRecord(id: string): Promise<void> {
  await api.deleteScript(id)
  const idx = store.scripts.findIndex((s) => s.id === id)
  if (idx >= 0) store.scripts.splice(idx, 1)
  store.cameraAI = store.cameraAI.filter((a) => a.scriptId !== id)
  // Drop every per-camera run state of the deleted model so a re-created model
  // with the same id cannot inherit stale Running/Stopped rows.
  const prefix = `${id}::`
  for (const key of Object.keys(store.cameraRuns)) {
    if (key.startsWith(prefix)) delete store.cameraRuns[key]
  }
  delete store.scriptRuns[id]
  // The backend hides it from the catalog; reload so filters and other views agree.
  // Keep the restore list in step so the model can be brought back from the UI.
  await Promise.all([loadScripts(), loadDeletedScripts()])
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

/**
 * Add an AI model to one camera (Camera page).
 *
 * The backend writes the same relation row the AI model page reads, so the
 * catalog and per-camera run states are reloaded: without it the AI model page
 * would still report "No camera" and refuse to Run.
 */
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
  await Promise.all([loadScripts(), loadScriptCameraRuns(inst.scriptId)])
  return inst
}

export async function updateCameraAIRecord(
  iid: number,
  fields: { name?: string; enabled?: boolean; output?: string; params?: Record<string, number | boolean> },
): Promise<void> {
  const inst = await api.updateCameraAI(iid, fields)
  const idx = store.cameraAI.findIndex((a) => a.iid === iid)
  if (idx >= 0) store.cameraAI.splice(idx, 1, inst)
  // Disabling an instance stops it on the backend, and the AI model page reads
  // `enabled` from the same row to decide whether Run is allowed.
  if (fields.enabled !== undefined) {
    await loadScriptCameraRuns(inst.scriptId)
  }
}

/**
 * Remove an AI model from one camera (Camera page).
 *
 * Also removes it from the AI model page's camera list, because that list is the
 * same relation — otherwise the model would keep showing a camera it no longer has.
 */
export async function removeCameraAIRecord(iid: number): Promise<void> {
  const inst = store.cameraAI.find((a) => a.iid === iid)
  await api.deleteCameraAI(iid)
  store.cameraAI = store.cameraAI.filter((a) => a.iid !== iid)
  if (inst) {
    delete store.cameraRuns[cameraRunKey(inst.scriptId, inst.camera)]
    await loadScripts()
  }
}
