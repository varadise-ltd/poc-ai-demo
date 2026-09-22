// Backend API client for face management (SQLite-backed).

import type { Alert, Camera, CameraAI, FaceData, FaceMeta, FaceValidation, GateConfig, PeopleCountReport, Script, ScriptParam, ScriptRun } from './types'

const BASE_URL: string = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

export async function listGateConfigs(cameraId?: string): Promise<GateConfig[]> {
  const query = cameraId ? `?camera_id=${encodeURIComponent(cameraId)}` : ''
  const data = await handle<{ gates: GateConfig[] }>(await fetch(`${BASE_URL}/api/gates/config${query}`))
  return data.gates
}

export async function getPeopleCountReport(filters: {
  cameraId?: string
  location?: string
  start?: string
  end?: string
  granularity?: 'hour' | 'day'
} = {}): Promise<PeopleCountReport> {
  const query = new URLSearchParams()
  if (filters.cameraId) query.set('camera_id', filters.cameraId)
  if (filters.location) query.set('location', filters.location)
  if (filters.start) query.set('start', filters.start)
  if (filters.end) query.set('end', filters.end)
  query.set('granularity', filters.granularity ?? 'hour')
  return handle<PeopleCountReport>(await fetch(`${BASE_URL}/api/gates/report?${query}`))
}

export function peopleCountExportUrl(filters: { cameraId?: string; location?: string; start?: string; end?: string; granularity?: 'hour' | 'day' } = {}): string {
  const query = new URLSearchParams()
  if (filters.cameraId) query.set('camera_id', filters.cameraId)
  if (filters.location) query.set('location', filters.location)
  if (filters.start) query.set('start', filters.start)
  if (filters.end) query.set('end', filters.end)
  query.set('granularity', filters.granularity ?? 'day')
  return `${BASE_URL}/api/gates/export?${query}`
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
    kpis: [],
    description: r.description ?? undefined,
    organization: r.organization ?? undefined,
    scenario: r.scenario ?? undefined,
    params,
  }
}

export async function listScripts(
  status?: string,
  organization?: string,
  scenario?: string,
): Promise<{ scripts: Script[]; runs: Record<string, ScriptRun> }> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (organization) q.set('organization', organization)
  if (scenario) q.set('scenario', scenario)
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

export async function stopScript(id: string): Promise<ScriptRun> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}/stop`, { method: 'POST' })
  return handle<ScriptRun>(res)
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

export async function createScript(fields: {
  name: string
  meta?: string
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

export async function deleteScript(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/scripts/${id}`, { method: 'DELETE' })
  await handle(res)
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
