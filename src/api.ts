// Backend API client for face management (SQLite-backed).

import type { Alert, Camera, CameraAI, CameraModelRun, DashboardQueryResult, FaceData, FaceMeta, FaceValidation, Script, ScriptParam, ScriptRun } from './types'
const BASE_URL: string = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

// Dashboard analytics (see /api/dashboard on the backend). The dashboard *list* is
// frontend-owned (DashboardView.vue) so the sidebar renders even when the API is down;
// only the per-dashboard query is fetched here.
export async function queryDashboard(
  dashboardId: string,
  filters: {
    start?: string
    end?: string
    cameraId?: string
    personName?: string
    matchStatus?: 'all' | 'matched' | 'unknown'
    violation?: string
  } = {},
): Promise<DashboardQueryResult> {
  const query = new URLSearchParams()
  if (filters.start) query.set('start', filters.start)
  if (filters.end) query.set('end', filters.end)
  if (filters.cameraId && filters.cameraId !== 'all') query.set('camera_id', filters.cameraId)
  if (filters.personName && filters.personName !== 'all') query.set('person_name', filters.personName)
  if (filters.matchStatus) query.set('match_status', filters.matchStatus)
  if (filters.violation && filters.violation !== 'all') query.set('violation', filters.violation)
  const qs = query.toString()
  return handle<DashboardQueryResult>(await fetch(`${BASE_URL}/api/dashboard/${encodeURIComponent(dashboardId)}/query${qs ? `?${qs}` : ''}`))
}

interface FaceRecord {
  id: number
  name: string
  image_name: string
  image_path: string
  has_embedding: boolean
  embedding_dim: number
  has_embedding_512: boolean
  embedding_512_dim: number
  width?: number | null
  height?: number | null
  face_count?: number | null
  created_at: string
  updated_at: string
}

interface FaceMutationResult extends FaceRecord {
  validation?: FaceValidation
}

export function faceImageUrl(id: number): string {
  return `${BASE_URL}/api/faces/${id}/image`
}

function toFaceData(r: FaceRecord): FaceData {
  return {
    id: r.id,
    name: r.name,
    imageName: r.image_name,
    image: faceImageUrl(r.id),
    hasEmbedding: r.has_embedding,
    hasEmbedding512: r.has_embedding_512,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    faceCount: r.face_count ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function getFaceMeta(): Promise<FaceMeta> {
  const res = await fetch(`${BASE_URL}/api/faces/meta`)
  return handle<FaceMeta>(res)
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? body.message ?? detail
    } catch {
      /* ignore parse errors */
    }
    throw new Error(String(detail))
  }
  return res.json() as Promise<T>
}

export async function listFaces(): Promise<FaceData[]> {
  const res = await fetch(`${BASE_URL}/api/faces`)
  const data = await handle<FaceRecord[]>(res)
  return data.map(toFaceData)
}

export interface FaceMutationOutcome {
  face: FaceData
  validation?: FaceValidation
}

export async function createFace(name: string, file: File): Promise<FaceMutationOutcome> {
  const form = new FormData()
  form.append('name', name)
  form.append('image', file)
  const res = await fetch(`${BASE_URL}/api/faces`, { method: 'POST', body: form })
  const data = await handle<FaceMutationResult>(res)
  return { face: toFaceData(data), validation: data.validation }
}

export async function updateFace(id: number, name?: string, file?: File): Promise<FaceMutationOutcome> {
  const form = new FormData()
  if (name !== undefined) form.append('name', name)
  if (file) form.append('image', file)
  const res = await fetch(`${BASE_URL}/api/faces/${id}`, { method: 'PUT', body: form })
  const data = await handle<FaceMutationResult>(res)
  return { face: toFaceData(data), validation: data.validation }
}

export async function deleteFace(id: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/faces/${id}`, { method: 'DELETE' })
  await handle(res)
}

// ---------------------------------------------------------------------------
// Camera management (SQLite-backed)
// ---------------------------------------------------------------------------

interface CameraRecord {
  id: number
  name: string
  rtmp: string
  status: 'online' | 'offline'
  resolution?: string
  rotate?: string
  organization?: string
  org_admin?: string
  created_at?: string
  updated_at?: string
}

function toCamera(r: CameraRecord): Camera {
  return {
    id: r.id,
    name: r.name,
    rtmp: r.rtmp,
    status: r.status,
    resolution: r.resolution,
    rotate: r.rotate,
    organization: r.organization,
    org_admin: r.org_admin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listCameras(status?: string, organization?: string): Promise<Camera[]> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (organization) q.set('organization', organization)
  const qs = q.toString()
  const res = await fetch(`${BASE_URL}/api/cameras${qs ? `?${qs}` : ''}`)
  const data = await handle<CameraRecord[]>(res)
  return data.map(toCamera)
}

export async function createCamera(
  name: string,
  rtmp: string,
  status: 'online' | 'offline',
  resolution?: string,
  rotate?: string,
  organization?: string,
  org_admin?: string,
): Promise<Camera> {
  const res = await fetch(`${BASE_URL}/api/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rtmp, status, resolution, rotate, organization, org_admin }),
  })
  return toCamera(await handle<CameraRecord>(res))
}

export async function updateCamera(
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
): Promise<Camera> {
  const res = await fetch(`${BASE_URL}/api/cameras/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return toCamera(await handle<CameraRecord>(res))
}

export async function deleteCamera(id: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/cameras/${id}`, { method: 'DELETE' })
  await handle(res)
}

export interface CameraProbeResult {
  valid: boolean
  reachable: boolean
  stream_ok: boolean
  message: string
  width?: number
  height?: number
  fps?: number
}

export async function probeCamera(url: string): Promise<CameraProbeResult> {
  const res = await fetch(`${BASE_URL}/api/cameras/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return handle<CameraProbeResult>(res)
}

export interface CameraCheckResult {
  camera_id: number
  name: string
  status: 'online' | 'offline'
  probe: CameraProbeResult
}

export async function checkCameraStream(name: string): Promise<CameraCheckResult> {
  const res = await fetch(`${BASE_URL}/api/cameras/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return handle<CameraCheckResult>(res)
}

// ---------------------------------------------------------------------------
// Scripts (detection objects) & detection events
// ---------------------------------------------------------------------------

interface ScriptParamRecord {
  value: number | boolean
  min?: number
  max?: number
  step?: number
  label?: string
  description?: string
  type?: 'float' | 'number' | 'checkbox'
}

interface ScriptRecord {
  id: string
  name: string
  meta: string
  loaded: boolean
  description?: string | null
  cameras: string[]
  organization?: string | null
  scenario?: string | null
  params?: Record<string, ScriptParamRecord>
  kpis?: string[][]
  custom?: boolean
  deleted?: boolean
  is_counting?: boolean
  run?: { status: 'running' | 'stopped'; camera?: string | null; pid?: number | null }
}

function toScript(r: ScriptRecord): Script {
  const params: ScriptParam[] = Object.entries(r.params ?? {}).map(([key, p]) => ({
    key,
    label: p.label ?? key,
    value: p.value,
    min: p.min ?? 0,
    max: p.max ?? 100,
    step: p.step ?? 1,
    type: p.type ?? (typeof p.value === 'boolean' ? 'checkbox' : 'number'),
    description: p.description ?? '',
  }))
  return {
    id: r.id,
    name: r.name,
    meta: r.meta,
    loaded: r.loaded,
    cameras: r.cameras,
    kpis: (r.kpis ?? []).map((kpi) => [kpi[0] ?? '', kpi[1] ?? '', kpi[2] ?? ''] as [string, string, string]),
    description: r.description ?? undefined,
    organization: r.organization ?? undefined,
    scenario: r.scenario ?? undefined,
    custom: r.custom ?? false,
    deleted: r.deleted ?? false,
    isCounting: r.is_counting ?? false,
    params,
  }
}

export async function listScripts(
  status?: string,
  organization?: string,
  scenario?: string,
  includeDeleted = false,
): Promise<{ scripts: Script[]; runs: Record<string, ScriptRun> }> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (organization) q.set('organization', organization)
  if (scenario) q.set('scenario', scenario)
  if (includeDeleted) q.set('include_deleted', 'true')
  const qs = q.toString()
  const res = await fetch(`${BASE_URL}/api/scripts${qs ? `?${qs}` : ''}`)
  const data = await handle<ScriptRecord[]>(res)
  const scripts = data.map(toScript)
  const runs: Record<string, ScriptRun> = {}
  for (const r of data) {
    runs[r.id] = {
      status: r.run?.status ?? 'stopped',
      camera: r.run?.camera ?? undefined,
      pid: r.run?.pid ?? null,
    }
  }
  return { scripts, runs }
}

export async function updateScriptMeta(
  id: string,
  fields: { organization?: string; scenario?: string },
): Promise<{ organization?: string; scenario?: string }> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return handle<{ organization?: string; scenario?: string }>(res)
}

export async function runScript(id: string, camera?: string): Promise<ScriptRun> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera }),
  })
  return handle<ScriptRun>(res)
}

export async function stopScript(id: string, camera?: string): Promise<ScriptRun> {
  const query = camera ? `?camera=${encodeURIComponent(camera)}` : ''
  const res = await fetch(`${BASE_URL}/api/scripts/${id}/stop${query}`, { method: 'POST' })
  return handle<ScriptRun>(res)
}

// ---------------------------------------------------------------------------
// Per-camera run control (each camera of an AI model runs/stops on its own)
// ---------------------------------------------------------------------------

/** Per-camera run state, including whether the camera is online and startable. */
export async function listScriptCameras(scriptId: string): Promise<CameraModelRun[]> {
  const res = await fetch(`${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras`)
  return handle<CameraModelRun[]>(res)
}

/**
 * Assign a camera to an AI model.
 *
 * Writes the same relation row the Camera page creates through
 * `createCameraAI`, so the two pages stay interchangeable.
 */
export async function assignScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const res = await fetch(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}`,
    { method: 'POST' },
  )
  return handle<CameraModelRun>(res)
}

/** Unassign a camera from an AI model (stops its worker and drops its ROI). */
export async function unassignScriptCamera(scriptId: string, camera: string): Promise<void> {
  const res = await fetch(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}`,
    { method: 'DELETE' },
  )
  await handle(res)
}

export async function runScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const res = await fetch(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}/run`,
    { method: 'POST' },
  )
  return handle<CameraModelRun>(res)
}

export async function stopScriptCamera(scriptId: string, camera: string): Promise<CameraModelRun> {
  const res = await fetch(
    `${BASE_URL}/api/scripts/${encodeURIComponent(scriptId)}/cameras/${encodeURIComponent(camera)}/stop`,
    { method: 'POST' },
  )
  return handle<CameraModelRun>(res)
}

export async function stopAllScripts(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/scripts/stop-all`, { method: 'POST' })
  await handle(res)
}

export async function listAlerts(): Promise<Alert[]> {
  const res = await fetch(`${BASE_URL}/api/alerts`)
  return handle<Alert[]>(res)
}

// ---------------------------------------------------------------------------
// ROI
// ---------------------------------------------------------------------------

export interface RoiPolygon {
  id: number | null
  points: [number, number][]
}

export interface RoiInfo {
  script_id: string
  camera: string | null
  rois: RoiPolygon[]
}

function toRoiPolygon(r: { id?: number | null; points?: [number, number][] }): RoiPolygon {
  return {
    id: typeof r.id === 'number' ? r.id : null,
    points: (r.points ?? []).map((p) => [Number(p[0]), Number(p[1])] as [number, number]),
  }
}

export async function getRoi(scriptId: string, camera: string): Promise<RoiInfo> {
  const q = new URLSearchParams({ camera })
  const res = await fetch(`${BASE_URL}/api/roi/${scriptId}?${q.toString()}`)
  const data = await handle<{ script_id: string; camera: string | null; rois?: RoiPolygon[]; points?: [number, number][] }>(res)
  // 兼容旧契约：旧后端返回单个 points，而非 rois
  const rois = data.rois?.length
    ? data.rois.map(toRoiPolygon)
    : data.points?.length
      ? [{ id: null, points: data.points.map((p) => [Number(p[0]), Number(p[1])] as [number, number]) }]
      : []
  return { script_id: data.script_id, camera: data.camera, rois }
}

export async function saveRoi(
  scriptId: string,
  camera: string,
  polygons: [number, number][][],
): Promise<RoiInfo> {
  const res = await fetch(`${BASE_URL}/api/roi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script_id: scriptId, camera, rois: polygons.map((points) => ({ points })) }),
  })
  const data = await handle<{ script_id: string; camera: string | null; rois: RoiPolygon[] }>(res)
  return {
    script_id: data.script_id,
    camera: data.camera,
    rois: (data.rois ?? []).map(toRoiPolygon),
  }
}

export async function clearRoi(scriptId: string, camera: string): Promise<void> {
  const q = new URLSearchParams({ camera })
  const res = await fetch(`${BASE_URL}/api/roi/${scriptId}?${q.toString()}`, { method: 'DELETE' })
  await handle(res)
}

// ---------------------------------------------------------------------------
// Gate (count line) configuration — people counting in/out lines with arrows
// ---------------------------------------------------------------------------

export interface GateConfigInfo {
  id?: number
  camera_id: string
  gate_id: string
  location: string
  line_start_x: number
  line_start_y: number
  line_end_x: number
  line_end_y: number
  enabled: number | boolean
  /** +1: crossing toward the positive side is IN; -1: negative side is IN. */
  arrow_sign: 1 | -1
}

export interface GateReport {
  summary: { gate_id: string; location: string; in: number; out: number; net: number; occupancy: number }[]
  trend: { period: string; gate_id: string; in: number; out: number; total: number }[]
  peaks: { period: string; gate_id: string; total: number }[]
  rows: Record<string, unknown>[]
  baseline_assumption: string
}

export async function listGateConfigs(cameraId?: string): Promise<GateConfigInfo[]> {
  const q = new URLSearchParams()
  if (cameraId) q.set('camera_id', cameraId)
  const qs = q.toString()
  const res = await fetch(`${BASE_URL}/api/gates/config${qs ? `?${qs}` : ''}`)
  const data = await handle<{ gates: GateConfigInfo[] }>(res)
  return data.gates ?? []
}

export async function saveGateConfig(gate: {
  camera_id: string
  gate_id: string
  location: string
  line_start_x: number
  line_start_y: number
  line_end_x: number
  line_end_y: number
  enabled?: boolean
  arrow_sign?: 1 | -1
}): Promise<GateConfigInfo> {
  const res = await fetch(`${BASE_URL}/api/gates/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, arrow_sign: 1, ...gate }),
  })
  const data = await handle<{ gate: GateConfigInfo }>(res)
  return data.gate
}

export async function deleteGateConfig(cameraId: string, gateId: string): Promise<void> {
  const res = await fetch(
    `${BASE_URL}/api/gates/config/${encodeURIComponent(cameraId)}/${encodeURIComponent(gateId)}`,
    { method: 'DELETE' },
  )
  await handle(res)
}

export async function getGateReport(filters: {
  cameraId?: string
  gateId?: string
  location?: string
  start?: string
  end?: string
  granularity?: 'hour' | 'day'
  role?: string
} = {}): Promise<GateReport> {
  const q = new URLSearchParams()
  if (filters.cameraId) q.set('camera_id', filters.cameraId)
  if (filters.gateId) q.set('gate_id', filters.gateId)
  if (filters.location) q.set('location', filters.location)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  if (filters.granularity) q.set('granularity', filters.granularity)
  if (filters.role) q.set('role', filters.role)
  const qs = q.toString()
  const res = await fetch(`${BASE_URL}/api/gates/report${qs ? `?${qs}` : ''}`)
  return handle<GateReport>(res)
}

export function gateReportExportUrl(filters: {
  cameraId?: string
  start?: string
  end?: string
  granularity?: 'hour' | 'day'
} = {}): string {
  const q = new URLSearchParams()
  if (filters.cameraId) q.set('camera_id', filters.cameraId)
  if (filters.start) q.set('start', filters.start)
  if (filters.end) q.set('end', filters.end)
  if (filters.granularity) q.set('granularity', filters.granularity)
  const qs = q.toString()
  return `${BASE_URL}/api/gates/export${qs ? `?${qs}` : ''}`
}

// ---------------------------------------------------------------------------
// Stream URLs (MJPEG preview + snapshot)
// ---------------------------------------------------------------------------

export function streamUrl(camera: string, scriptId: string, annotate: boolean): string {
  const q = new URLSearchParams({ camera, script_id: scriptId, annotate: String(annotate) })
  return `${BASE_URL}/api/stream?${q.toString()}`
}

export function snapshotUrl(camera: string, scriptId: string, annotate: boolean): string {
  const q = new URLSearchParams({ camera, script_id: scriptId, annotate: String(annotate) })
  return `${BASE_URL}/api/stream/snapshot?${q.toString()}`
}

// ---------------------------------------------------------------------------
// AI model CRUD
// ---------------------------------------------------------------------------

/**
 * Create a custom AI model. The backend clones the detector wiring of
 * `base_script_id` (a built-in scenario), so it is required.
 */
export async function createScript(fields: {
  name: string
  base_script_id: string
  description?: string
  organization?: string
  scenario?: string
}): Promise<Script> {
  const res = await fetch(`${BASE_URL}/api/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return toScript(await handle<ScriptRecord>(res))
}

/** Soft-delete one AI model (restorable through `restoreScript`). */
export async function deleteScript(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}`, { method: 'DELETE' })
  await handle(res)
}

/** Bring a soft-deleted AI model back into the catalog. */
export async function restoreScript(id: string): Promise<Script> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}/restore`, { method: 'POST' })
  return toScript(await handle<ScriptRecord>(res))
}

/** Soft-deleted AI models only (candidates for restore). */
export async function listDeletedScripts(): Promise<Script[]> {
  const { scripts } = await listScripts(undefined, undefined, undefined, true)
  return scripts.filter((s) => s.deleted)
}

// ---------------------------------------------------------------------------
// Per-camera AI model instances
// ---------------------------------------------------------------------------

interface CameraAIRecord {
  iid: number
  camera: string
  script_id: string
  name: string
  enabled: boolean
  output?: string
  params?: Record<string, number | boolean>
}

function toCameraAI(r: CameraAIRecord): CameraAI {
  return { iid: r.iid, camera: r.camera, scriptId: r.script_id, name: r.name, enabled: r.enabled, output: r.output, params: r.params }
}

export async function listCameraAI(): Promise<CameraAI[]> {
  const res = await fetch(`${BASE_URL}/api/camera-ai`)
  const data = await handle<CameraAIRecord[]>(res)
  return data.map(toCameraAI)
}

export async function createCameraAI(fields: {
  camera: string
  scriptId: string
  name?: string
  enabled?: boolean
  output?: string
  params?: Record<string, number | boolean>
}): Promise<CameraAI> {
  const res = await fetch(`${BASE_URL}/api/camera-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera: fields.camera, script_id: fields.scriptId, name: fields.name, enabled: fields.enabled, output: fields.output, params: fields.params }),
  })
  return toCameraAI(await handle<CameraAIRecord>(res))
}

export async function updateCameraAI(
  iid: number,
  fields: { name?: string; enabled?: boolean; output?: string; params?: Record<string, number | boolean> },
): Promise<CameraAI> {
  const res = await fetch(`${BASE_URL}/api/camera-ai/${iid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return toCameraAI(await handle<CameraAIRecord>(res))
}

export async function deleteCameraAI(iid: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/camera-ai/${iid}`, { method: 'DELETE' })
  await handle(res)
}
