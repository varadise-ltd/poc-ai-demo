// Domain types for the AI Cam POC Center.

export type Kpi = [label: string, value: string, change: string]

export interface ScriptParam {
  key: string
  label: string
  value: number | boolean
  min: number
  max: number
  step: number
  type: 'float' | 'number' | 'checkbox'
  description: string
}

export interface Script {
  id: string
  name: string
  meta: string
  loaded: boolean
  cameras: string[]
  kpis: Kpi[]
  description?: string
  params?: ScriptParam[]
  organization?: string
  scenario?: string
  videoSource?: string
  rtmpOutput?: string
  /** Operator-created model (clones a built-in scenario's detector wiring). */
  custom?: boolean
  /** Soft-deleted model: hidden from the catalog, shown only in the restore list. */
  deleted?: boolean
  /** Counting script (People Counting / gate): supports count lines with in/out arrows. */
  isCounting?: boolean
}

export interface EventItem {
  time: string
  camera: string
  script: string
  name: string
  meta: string
  confidence: string
  ok: boolean
}

export interface HistoryEvent extends EventItem {
  date: string
}

export interface FaceData {
  id: number
  name: string
  imageName: string
  image: string
  hasEmbedding?: boolean
  hasEmbedding512?: boolean
  width?: number
  height?: number
  faceCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface FaceValidation {
  width: number
  height: number
  face_count: number
  detector: string
  warnings: string[]
  ok: boolean
}

export interface FaceMeta {
  active_dim: 128 | 512
  min_resolution: number
  available: Record<'128' | '512', boolean>
}

export type CameraStatus = 'online' | 'offline'

export interface Camera {
  id: number
  name: string
  rtmp: string
  status: CameraStatus
  resolution?: string
  rotate?: string
  organization?: string
  org_admin?: string
  createdAt?: string
  updatedAt?: string
}

export interface ScriptRun {
  status: 'running' | 'stopped'
  camera?: string
  pid?: number | null
}

/** One AI model running (or not) on one camera — mirrors the backend CameraModelRun. */
export interface CameraModelRun {
  script_id: string
  camera: string
  status: 'running' | 'stopped'
  camera_status: CameraStatus
  /** False for a disabled instance, an offline camera, or one already running. */
  can_run: boolean
  mode: string
  health: string
  /** Why the camera cannot run / why the last start attempt failed (empty when fine). */
  message: string
  /** Instance switch owned by the Camera page; a disabled instance cannot run. */
  enabled: boolean
  /** Effective annotated output stream (set on the Camera page, shown on both). */
  output: string
  /** Display name of this camera's instance of the AI model. */
  name: string
}

export interface Alert {
  timestamp: string
  script: string
  message: string
  image_url?: string | null
  severity: string
  camera?: string | null
  confidence?: string | null
  // Optional envelope fields the backend projects from the durable `events`
  // table (see models/schemas.py: Alert). Kept optional for older backends.
  event_id?: string | null
  event_type?: string | null
  mode?: string
  received_time?: string | null
}

// Per-camera AI model instance (index framework: cameraAI)
export interface CameraAI {
  iid: number
  camera: string
  scriptId: string
  name: string
  enabled: boolean
  output?: string
  params?: Record<string, number | boolean>
}

export interface DashboardDefinition {
  id: 'face' | 'inout' | 'ppe' | 'object'
  title: string
  subtitle: string
}

export interface DashboardRecord {
  record_id: string
  category: string
  event_time: string
  camera_id: string | null
  script_id: string
  person_name: string | null
  recognized: boolean | null
  status: string
  violation: string | null
  violations: string[]
  zone: string | null
  direction: string | null
  gate_id: string | null
  confidence: number | null
  message: string
  snapshot_url: string | null
  mode: string
}

export interface DashboardStat {
  label: string
  value: number
  tone: string
}

export interface DashboardQueryResult {
  dashboard_id: string
  total: number
  stats: DashboardStat[]
  records: DashboardRecord[]
}
