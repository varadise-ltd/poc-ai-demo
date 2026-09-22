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

export interface Alert {
  timestamp: string
  script: string
  message: string
  image_url?: string | null
  severity: string
  camera?: string | null
  confidence?: string | null
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
