<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { assetUrl, listCameras, queryDashboard } from '../api'
import type { Camera, DashboardDefinition, DashboardQueryResult } from '../types'
import { displayFaceConfidence } from '../confidence'

const defaultDashboards: DashboardDefinition[] = [
  { id: 'crane', title: 'Crane Loading', subtitle: 'Crane + Truck monitoring' },
  { id: 'face', title: 'Face Recognition New', subtitle: 'Face Recognition New' },
  { id: 'inout', title: 'In / Out', subtitle: 'People Counting' },
  { id: 'ppe', title: 'PPE detection', subtitle: 'PPE detection' },
  { id: 'object', title: 'Object detection', subtitle: 'Human detection' },
  { id: 'segregation', title: 'Pedestrian / Vehicle', subtitle: 'Segregation' },
]

const dashboards = ref<DashboardDefinition[]>(defaultDashboards)
const cameras = ref<Camera[]>([])
const selectedId = ref('face')
const result = ref<DashboardQueryResult | null>(null)
const loading = ref(false)
const error = ref('')
const filters = ref({ cameraId: 'all', personName: 'all', matchStatus: 'all' as 'all' | 'matched' | 'unknown', violation: 'all' })
const rangePreset = ref('7d')
const customStart = ref('')
const customEnd = ref('')

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** When switching to a custom range, seed the inputs with the last 7 days. */
watch(rangePreset, (preset) => {
  if (preset === 'custom' && (!customStart.value || !customEnd.value)) {
    const now = new Date()
    const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
    customStart.value = formatLocalDate(from)
    customEnd.value = formatLocalDate(now)
  }
})

const customRangeError = computed(() => {
  if (rangePreset.value !== 'custom') return ''
  if (customStart.value && customEnd.value && customEnd.value < customStart.value) {
    return 'End date cannot be before start date'
  }
  return ''
})

const selectedDashboard = computed(() => dashboards.value.find((item) => item.id === selectedId.value))
const descriptions: Record<string, string> = {
  crane: 'Truck dwell and crane loading cycles from two complementary camera views.',
  face: 'Who was recognized from the face library, unknown visitors, and per-person records.',
  inout: 'People crossing configured count lines (add-line + direction), per line.',
  ppe: 'People not meeting PPE requirements, with per-violation detail.',
  object: 'Humans detected by the Human detection AI model, with per-detection detail.',
  segregation: 'People and vehicles detected by the Pedestrian / Vehicle Segregation AI model, with per-detection counts.',
}
let requestId = 0
const people = computed(() => {
  const values = new Set((result.value?.records ?? []).map((record) => record.person_name).filter(Boolean) as string[])
  return [...values].sort()
})
const violations = computed(() => {
  const values = new Set((result.value?.records ?? []).flatMap((record) => record.violations))
  return [...values].sort()
})
const visibleRecords = computed(() => (result.value?.records ?? []).slice(0, 100))

// --- Evidence snapshot viewer ---------------------------------------------
// Every detection record carries the annotated frame captured with its event,
// so the same thumbnail + full-view experience works on all four dashboards
// (Face / In-Out / PPE / Object). Records without a stored snapshot stay
// visible but the thumbnail is disabled instead of opening an empty lightbox.
const snapshotRecords = computed(() => visibleRecords.value.filter((record) => record.snapshot_url))
const viewerIndex = ref<number | null>(null)
const viewerRecord = computed(() =>
  viewerIndex.value == null ? null : snapshotRecords.value[viewerIndex.value] ?? null,
)

function openSnapshot(record: DashboardQueryResult['records'][number]): void {
  if (!record.snapshot_url) return
  const index = snapshotRecords.value.findIndex((item) => item.record_id === record.record_id)
  viewerIndex.value = index >= 0 ? index : null
}

function closeViewer(): void {
  viewerIndex.value = null
}

function stepViewer(delta: number): void {
  const total = snapshotRecords.value.length
  if (viewerIndex.value == null || total === 0) return
  viewerIndex.value = (viewerIndex.value + delta + total) % total
}

function currentRange(): { start: string; end: string } {
  if (rangePreset.value === 'custom') {
    const start = new Date(`${customStart.value}T00:00:00`)
    const end = new Date(`${customEnd.value}T23:59:59`)
    return { start: start.toISOString(), end: end.toISOString() }
  }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (rangePreset.value === '7d') start.setDate(start.getDate() - 6)
  if (rangePreset.value === '30d') start.setDate(start.getDate() - 29)
  if (rangePreset.value === 'mtd') start.setDate(1)
  const end = new Date()
  end.setHours(24, 0, 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

async function loadDashboard(): Promise<void> {
  const id = ++requestId
  loading.value = true
  error.value = ''
  result.value = null
  if (rangePreset.value === 'custom' && customRangeError.value) {
    error.value = customRangeError.value
    if (id === requestId) loading.value = false
    return
  }
  const { start, end } = currentRange()
  try {
    const response = await queryDashboard(selectedId.value, {
      ...filters.value,
      personName: filters.value.matchStatus === 'unknown' ? 'all' : filters.value.personName,
      start, end,
    })
    if (id === requestId) result.value = response
  } catch (err) {
    if (id === requestId) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (id === requestId) loading.value = false
  }
}

function resetFilters(): void {
  requestId++
  loading.value = false
  error.value = ''
  filters.value = { cameraId: 'all', personName: 'all', matchStatus: 'all', violation: 'all' }
  rangePreset.value = '7d'
  customStart.value = ''
  customEnd.value = ''
  result.value = null
}

async function selectDashboard(id: string): Promise<void> {
  selectedId.value = id
  resetFilters()
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

function statusLabel(record: DashboardQueryResult['records'][number]): string {
  if (record.direction) return record.direction.toUpperCase()
  if (record.category === 'segregation') return record.status === 'pedestrian' ? 'Person' : 'Vehicle'
  if (record.violations.length) return record.violations.join(', ')
  return record.status
}

/**
 * 置信度顯示：人臉識別 Dashboard 套用前端顯示提升（封頂 95%），其餘場景顯示原始值。
 * 這是純展示轉換，不影響後端存的原始數據。
 */
function displayConfidence(value: number | null): string {
  if (value == null) return '—'
  const shown = selectedId.value === 'face' ? displayFaceConfidence(value) : value
  return `${Math.round(shown * 100)}%`
}

onMounted(async () => {
  const [cameraResponse] = await Promise.allSettled([listCameras()])
  if (cameraResponse.status === 'fulfilled') cameras.value = cameraResponse.value
})

// ---------------------------------------------------------------------------
// Crane Loading dashboard (design preview, demo data)
// Truck Camera supplies entry/exit; Crane Camera supplies loading start/end.
// ---------------------------------------------------------------------------
interface CraneSession {
  id: string
  truckCamera: string
  craneCamera: string
  entry: string
  exit: string
  loadingStart: string
  loadingEnd: string
}

const craneCameras = ['Truck Camera 01', 'Gantry Crane Camera 01', 'Gantry Crane Camera 02']

function localISO(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function craneSeed(): CraneSession[] {
  const out: CraneSession[] = []
  let seed = 42
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const dwellPlan = [3, 6, 8, 11, 13, 16, 19, 22, 26, 31, 9, 14, 17, 21, 28, 35, 4, 7, 12, 18, 24, 29, 33, 38]
  let id = 0
  for (let day = 2; day <= 5; day++) {
    const perDay = 18 + Math.floor(rnd() * 8)
    for (let i = 0; i < perDay; i++) {
      id++
      const craneCam = id % 3 === 0 ? 'Gantry Crane Camera 02' : 'Gantry Crane Camera 01'
      const entry = new Date(2026, 9, day, 7 + Math.floor((i * 10) / perDay), Math.floor(rnd() * 55), Math.floor(rnd() * 60))
      const dwellSec = dwellPlan[id % dwellPlan.length] * 60 + Math.floor(rnd() * 59)
      const gapSec = (2 + Math.floor(rnd() * 3)) * 60 + Math.floor(rnd() * 59)
      const cycleSec = (3 + Math.floor(rnd() * 8)) * 60 + Math.floor(rnd() * 59)
      const loadingStart = new Date(entry.getTime() + gapSec * 1000)
      const loadingEnd = new Date(loadingStart.getTime() + cycleSec * 1000)
      const exit = new Date(entry.getTime() + dwellSec * 1000)
      out.push({
        id: `L-${String(id).padStart(3, '0')}`,
        truckCamera: 'Truck Camera 01',
        craneCamera: craneCam,
        entry: localISO(entry),
        exit: localISO(exit),
        loadingStart: localISO(loadingStart),
        loadingEnd: localISO(loadingEnd),
      })
    }
  }
  return out
}

const craneSessions: CraneSession[] = craneSeed()

const craneState = reactive({
  cameras: [...craneCameras] as string[],
  dwellBin: null as number | null,
  dwellPage: 1,
  cycleSessionId: null as string | null,
  trendDate: '',
})

const CRANE_PAGE_SIZE = 5
const DWELL_BINS = [0, 300, 600, 900, 1200, 1500, 1800, Infinity]

function diffSeconds(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m} min ${String(s).padStart(2, '0')} sec`
}

function fmtDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

function dwellBinLabel(i: number): string {
  return i >= 6 ? '≥30' : `${i * 5}–<${(i + 1) * 5}`
}

const craneFilteredSessions = computed(() =>
  craneSessions.filter((s) => craneState.cameras.includes(s.truckCamera) || craneState.cameras.includes(s.craneCamera)),
)

const craneTrendRows = computed(() =>
  craneFilteredSessions.value.filter((s) => !craneState.trendDate || s.loadingEnd.slice(0, 10) === craneState.trendDate),
)

const craneDateOptions = computed(() => {
  const dates = new Set(craneFilteredSessions.value.map((s) => s.loadingEnd.slice(0, 10)))
  return [...dates].sort()
})

const craneDwellDistribution = computed(() => {
  const rows = craneFilteredSessions.value
  const counts = DWELL_BINS.slice(0, 7).map((min, i) =>
    rows.filter((s) => {
      const d = diffSeconds(s.entry, s.exit)
      return d >= min && d < DWELL_BINS[i + 1]
    }).length,
  )
  const maxBin = Math.max(1, ...counts)
  return { counts, maxBin }
})

const craneSummary = computed(() => {
  const rows = craneFilteredSessions.value
  const dwell = rows.map((s) => diffSeconds(s.entry, s.exit))
  const cycles = rows.map((s) => diffSeconds(s.loadingStart, s.loadingEnd))
  const average = (values: number[]) =>
    values.length ? fmtDuration(Math.round(values.reduce((a, b) => a + b, 0) / values.length)) : '—'
  return { total: rows.length, avgDwell: average(dwell), avgCycle: average(cycles) }
})

// Loading cycle trend points (SVG scatter) + dwell drill + cycle drill.
const craneTrendPoints = computed(() => {
  const rows = craneTrendRows.value
  const total = rows.length
  return rows.map((s, i) => ({
    x: total <= 1 ? 360 : 55 + (i * 610) / (total - 1),
    y: 190 - (diffSeconds(s.loadingStart, s.loadingEnd) / 600) * 150,
    seconds: diffSeconds(s.loadingStart, s.loadingEnd),
    session: s,
    active: craneState.cycleSessionId === s.id,
  }))
})

const craneDwellMatches = computed(() => {
  if (craneState.dwellBin == null) return []
  const min = DWELL_BINS[craneState.dwellBin]
  const max = DWELL_BINS[craneState.dwellBin + 1]
  return craneFilteredSessions.value.filter((s) => {
    const d = diffSeconds(s.entry, s.exit)
    return d >= min && d < max
  })
})

const craneCycleMatch = computed(() => {
  if (!craneState.cycleSessionId) return null
  return craneFilteredSessions.value.find((s) => s.id === craneState.cycleSessionId) ?? null
})

function cranePaged(sessions: CraneSession[], page: number): CraneSession[] {
  const total = sessions.length
  const pages = Math.max(1, Math.ceil(total / CRANE_PAGE_SIZE))
  return sessions.slice((Math.min(page, pages) - 1) * CRANE_PAGE_SIZE, Math.min(page, pages) * CRANE_PAGE_SIZE)
}

function toggleCraneCamera(camera: string): void {
  if (craneState.cameras.includes(camera)) {
    craneState.cameras = craneState.cameras.filter((c) => c !== camera)
  } else {
    craneState.cameras = [...craneState.cameras, camera]
  }
}

function selectAllCraneCameras(): void {
  craneState.cameras = [...craneCameras]
}

function resetCraneFilters(): void {
  craneState.cameras = [...craneCameras]
  craneState.dwellBin = null
  craneState.dwellPage = 1
  craneState.cycleSessionId = null
  craneState.trendDate = ''
}

function selectCraneDwellBin(i: number): void {
  if (craneState.dwellBin === i) {
    craneState.dwellBin = null
  } else {
    craneState.dwellBin = i
    craneState.dwellPage = 1
  }
}

function selectCraneCycle(id: string): void {
  craneState.cycleSessionId = craneState.cycleSessionId === id ? null : id
}

function craneDrillPage(p: number): void {
  craneState.dwellPage = p
}

function setCraneTrendDate(value: string): void {
  craneState.trendDate = value
}

// Event list for a session (dwell scope = truck events, cycle scope = crane events).
function craneSessionEvents(session: CraneSession, scope: 'dwell' | 'cycle') {
  const dwell = diffSeconds(session.entry, session.exit)
  const cycle = diffSeconds(session.loadingStart, session.loadingEnd)
  if (scope === 'dwell') {
    return [
      { ts: session.exit, type: 'Truck Exit', cam: session.truckCamera, dur: dwell },
      { ts: session.entry, type: 'Truck Entry', cam: session.truckCamera, dur: null as number | null },
    ].sort((a, b) => b.ts.localeCompare(a.ts))
  }
  return [
    { ts: session.loadingEnd, type: 'Loading End', cam: session.craneCamera, dur: cycle },
    { ts: session.loadingStart, type: 'Loading Start', cam: session.craneCamera, dur: null as number | null },
  ].sort((a, b) => b.ts.localeCompare(a.ts))
}

const craneDwellEvents = computed(() => craneDwellMatches.value.flatMap((s) => craneSessionEvents(s, 'dwell')))
const craneCycleEvents = computed(() => (craneCycleMatch.value ? craneSessionEvents(craneCycleMatch.value, 'cycle') : []))

</script>

<template>
  <section class="dashboard-page">
    <div class="page-head">
      <div>
        <h1>Dashboards</h1>
        <p class="subtitle">Configurable analytics dashboards. Each AI model provides a dashboard template that is rendered by a shared engine.</p>
      </div>
    </div>

    <div class="config-layout dashboard-layout">
      <aside class="panel side-list">
        <div class="side-title">Dashboards</div>
        <button
          v-for="dashboard in dashboards"
          :key="dashboard.id"
          class="side-item dashboard-side-item"
          :class="{ active: dashboard.id === selectedId }"
          @click="selectDashboard(dashboard.id)"
        >
          <span>
            <strong>{{ dashboard.title }}</strong>
            <small>{{ dashboard.subtitle }}</small>
          </span>
        </button>
      </aside>

      <section class="panel config-content dashboard-content">
        <div v-if="selectedDashboard" class="dash-head">
          <div>
            <h2>{{ selectedDashboard.title }}</h2>
            <p class="subtitle">{{ descriptions[selectedId] }}</p>
          </div>
          <span class="pill" :class="{ gray: selectedId === 'crane' }">{{ selectedDashboard.subtitle }}</span>
        </div>

        <!-- ===================== Crane Loading dashboard ===================== -->
        <template v-if="selectedId === 'crane'">
          <p class="subtitle crane-note">
            Sample data: 02–05 Oct 2026. Camera selection includes linked truck/loading sessions; event history shows events from selected cameras only.
          </p>
          <div class="dash-filters">
            <div class="dash-filter crane-camera-filter">
              <label>Camera · multi-select</label>
              <details class="crane-camera-details">
                <summary class="crane-camera-display">
                  {{ craneState.cameras.length === craneCameras.length ? 'All cameras' : craneState.cameras.length ? `${craneState.cameras.length} cameras selected` : 'Select cameras' }}
                </summary>
                <div class="crane-camera-menu">
                  <label class="dash-check">
                    <input type="checkbox" :checked="craneState.cameras.length === craneCameras.length" @change="selectAllCraneCameras" />
                    All cameras
                  </label>
                  <label v-for="camera in craneCameras" :key="camera" class="dash-check">
                    <input type="checkbox" :checked="craneState.cameras.includes(camera)" @change="toggleCraneCamera(camera)" />
                    {{ camera }}
                  </label>
                </div>
              </details>
            </div>
            <button class="btn primary dashboard-search" @click="resetCraneFilters">Reset</button>
          </div>

          <div v-if="!craneState.cameras.length" class="dashboard-empty-state">
            Select at least one camera to view the loading sessions.
          </div>
          <template v-else>
            <div class="dash-stats">
              <div class="dash-stat">
                <div class="dash-stat-label">Truck visits</div>
                <div class="dash-stat-value">{{ craneSummary.total.toLocaleString() }}</div>
              </div>
              <div class="dash-stat good">
                <div class="dash-stat-label">Avg truck dwell time</div>
                <div class="dash-stat-value">{{ craneSummary.avgDwell }}</div>
              </div>
              <div class="dash-stat accent">
                <div class="dash-stat-label">Avg crane cycle time</div>
                <div class="dash-stat-value">{{ craneSummary.avgCycle }}</div>
              </div>
            </div>

            <section class="crane-card">
              <div class="dash-sec-head">
                <h3>Dwell time distribution</h3>
                <span class="dash-sec-sub">5-min buckets · click a bar to view matching sessions</span>
              </div>
              <div class="crane-trend dwell-trend">
                <div
                  v-for="(count, i) in craneDwellDistribution.counts"
                  :key="i"
                  class="crane-trend-col clickable"
                  :class="{ active: craneState.dwellBin === i }"
                  role="button"
                  tabindex="0"
                  @click="selectCraneDwellBin(i)"
                >
                  <div
                    class="crane-trend-bar dwell"
                    :style="{ height: `${Math.max(14, Math.round((count / craneDwellDistribution.maxBin) * 150))}px` }"
                  ></div>
                  <span>{{ dwellBinLabel(i) }}</span>
                  <strong>{{ count }}</strong>
                </div>
              </div>
              <div v-if="craneState.dwellBin != null" class="crane-drill">
                <div class="dash-sec-head">
                  <h3>Dwell {{ dwellBinLabel(craneState.dwellBin) }} min</h3>
                  <span class="dash-sec-sub">{{ craneDwellMatches.length }} record{{ craneDwellMatches.length === 1 ? '' : 's' }} · click the chart again to clear</span>
                </div>
                <div v-for="session in cranePaged(craneDwellMatches, craneState.dwellPage)" :key="'dwell-' + session.id" class="crane-session">
                  <div v-for="event in craneSessionEvents(session, 'dwell')" :key="event.type" class="crane-session-row">
                    <div class="frame-mini"></div>
                    <div class="crane-session-main">
                      <div class="crane-session-time">{{ fmtDateTime(event.ts) }}</div>
                      <div class="crane-session-cam">{{ event.cam }}</div>
                    </div>
                    <span class="dash-tag match">{{ event.type }}</span>
                    <span class="crane-session-dur">{{ fmtDuration(event.dur) }}</span>
                  </div>
                </div>
                <div v-if="!craneDwellMatches.length" class="detail-empty">No sessions in this bucket.</div>
                <div v-if="craneDwellMatches.length > CRANE_PAGE_SIZE" class="dash-pager">
                  <button class="btn" :disabled="craneState.dwellPage <= 1" @click="craneDrillPage(craneState.dwellPage - 1)">‹ Prev</button>
                  <span class="dash-page-info">Page {{ craneState.dwellPage }} / {{ Math.ceil(craneDwellMatches.length / CRANE_PAGE_SIZE) }}</span>
                  <button class="btn" :disabled="craneState.dwellPage >= Math.ceil(craneDwellMatches.length / CRANE_PAGE_SIZE)" @click="craneDrillPage(craneState.dwellPage + 1)">Next ›</button>
                </div>
              </div>
            </section>

            <section class="crane-card">
              <div class="dash-sec-head">
                <h3>Loading cycle trend</h3>
                <span class="dash-sec-sub">By loading end time · click a dot to view the session</span>
              </div>
              <div class="crane-trend-filter">
                <div class="dash-filter">
                  <label>Date</label>
                  <select @change="setCraneTrendDate(($event.target as HTMLSelectElement).value)">
                    <option value="">All dates</option>
                    <option v-for="date in craneDateOptions" :key="date" :value="date" :selected="craneState.trendDate === date">{{ date }}</option>
                  </select>
                </div>
              </div>
              <div v-if="craneTrendPoints.length" class="crane-line-chart">
                <svg viewBox="0 0 720 240" role="img" aria-label="Loading cycle duration in minutes by completion time">
                  <text x="14" y="20">min</text>
                  <line v-for="n in 6" :key="n" x1="45" :y1="190 - (n - 1) * 30" x2="690" :y2="190 - (n - 1) * 30" stroke="#e3e8ed" />
                  <text v-for="n in 6" :key="'t' + n" x="32" :y="194 - (n - 1) * 30" text-anchor="end">{{ (n - 1) * 2 }}</text>
                  <polyline fill="none" stroke="#f0b98c" stroke-width="1.6" :points="craneTrendPoints.map((p) => `${p.x},${p.y}`).join(' ')" />
                  <g
                    v-for="(point, i) in craneTrendPoints"
                    :key="point.session.id"
                    style="cursor: pointer"
                    @click="selectCraneCycle(point.session.id)"
                  >
                    <circle
                      :cx="point.x"
                      :cy="point.y"
                      :r="point.active ? 7 : 5"
                      :fill="point.active ? '#f47b20' : '#f47b20'"
                      :stroke="point.active ? '#0d2538' : '#fff'"
                      stroke-width="2"
                    >
                      <title>Cycle {{ fmtDuration(point.seconds) }} · {{ point.session.loadingEnd.slice(11, 16) }}</title>
                    </circle>
                    <text
                      v-if="craneState.cycleSessionId ? point.active : (i % Math.max(1, Math.ceil(craneTrendPoints.length / 10)) === 0 || i === craneTrendPoints.length - 1)"
                      :x="point.x"
                      y="213"
                      text-anchor="middle"
                      :class="point.active ? 'crane-x-active' : 'crane-x-dim'"
                    >
                      {{ point.session.loadingEnd.slice(11, 16) }}
                    </text>
                  </g>
                  <text x="370" y="237" text-anchor="middle">Loading end time</text>
                </svg>
              </div>
              <div v-else class="dash-empty">No completed loading cycles for this date.</div>
              <div v-if="craneCycleMatch" class="crane-drill">
                <div class="dash-sec-head">
                  <h3>Loading cycle {{ fmtDuration(diffSeconds(craneCycleMatch.loadingStart, craneCycleMatch.loadingEnd)) }} · {{ craneCycleMatch.loadingEnd.slice(11, 16) }}</h3>
                  <span class="dash-sec-sub">click the dot again to clear</span>
                </div>
                <div class="crane-session">
                  <div v-for="event in craneCycleEvents" :key="event.type" class="crane-session-row">
                    <div class="frame-mini"></div>
                    <div class="crane-session-main">
                      <div class="crane-session-time">{{ fmtDateTime(event.ts) }}</div>
                      <div class="crane-session-cam">{{ event.cam }}</div>
                    </div>
                    <span class="dash-tag loading">{{ event.type }}</span>
                    <span class="crane-session-dur">{{ fmtDuration(event.dur) }}</span>
                  </div>
                </div>
              </div>
            </section>
          </template>
        </template>
        <!-- =================== End Crane Loading dashboard =================== -->

        <template v-if="selectedId !== 'crane'">
        <div class="dash-filters">
          <div class="dash-filter dash-time-filter">
            <label>Time range</label>
            <div class="time-range-control">
              <span class="time-range-icon">◷</span>
              <select v-model="rangePreset">
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="mtd">Month to date</option>
                <option value="custom">Custom range</option>
              </select>
              <span class="time-range-caret">▾</span>
            </div>
            <div v-if="rangePreset === 'custom'" class="custom-range">
              <div class="custom-range-field">
                <label>Start date</label>
                <input v-model="customStart" type="date" :max="customEnd || undefined" />
              </div>
              <div class="custom-range-field">
                <label>End date</label>
                <input v-model="customEnd" type="date" :min="customStart || undefined" />
              </div>
            </div>
            <p v-if="customRangeError" class="custom-range-error">{{ customRangeError }}</p>
          </div>
          <div class="dash-filter">
            <label>Camera</label>
            <select v-model="filters.cameraId">
              <option value="all">All</option>
              <option v-for="camera in cameras" :key="camera.id" :value="camera.name">{{ camera.name }}</option>
            </select>
          </div>
          <div v-if="selectedId === 'face'" class="dash-filter">
            <label>Match status</label>
            <select v-model="filters.matchStatus">
              <option value="all">All</option>
              <option value="matched">Recognized</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div v-if="selectedId === 'face' && filters.matchStatus !== 'unknown'" class="dash-filter">
            <label>Person</label>
            <select v-model="filters.personName">
              <option value="all">All</option>
              <option v-for="person in people" :key="person" :value="person">{{ person }}</option>
            </select>
          </div>
          <div v-if="selectedId === 'ppe'" class="dash-filter">
            <label>Violation</label>
            <select v-model="filters.violation">
              <option value="all">All</option>
              <option v-for="item in violations" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>
          <button class="btn primary dashboard-search" :disabled="loading || Boolean(customRangeError)" @click="loadDashboard">{{ loading ? 'Loading…' : 'Search' }}</button>
          <button class="btn dashboard-reset" @click="resetFilters">Reset</button>
        </div>

        <div v-if="!result && !loading && !error" class="dashboard-empty-state">
          Set your filters and click Search to view results.
        </div>

        <p v-if="error" class="form-error dashboard-api-error" role="alert">Dashboard data is unavailable ({{ error }}). Check the configured API service; a 404 may mean the running backend has not loaded the Dashboard routes.</p>
        <div v-else-if="loading" class="detail-empty">Loading dashboard records…</div>
        <template v-else-if="result">
          <div class="dash-stats">
            <div v-for="stat in result.stats" :key="stat.label" class="dash-stat" :class="stat.tone">
              <div class="dash-stat-label">{{ stat.label }}</div>
              <div class="dash-stat-value">{{ stat.value.toLocaleString() }}</div>
            </div>
          </div>

          <div class="dash-sec-head">
            <h3>Detection records <span class="dash-count-pill good">{{ result.total }}</span></h3>
            <span class="dash-sec-sub">Showing up to 100 latest records</span>
          </div>
          <div class="dashboard-records">
            <div v-for="record in visibleRecords" :key="record.record_id" class="dashboard-record">
              <button
                type="button"
                class="dashboard-record-thumb"
                :class="{ empty: !record.snapshot_url }"
                :disabled="!record.snapshot_url"
                :title="record.snapshot_url ? 'View snapshot' : 'No snapshot stored for this record'"
                @click="openSnapshot(record)"
              >
                <img
                  v-if="record.snapshot_url"
                  :src="assetUrl(record.snapshot_url)"
                  :alt="`Snapshot for ${record.record_id}`"
                  loading="lazy"
                />
                <span v-else aria-hidden="true">—</span>
              </button>
              <div class="dashboard-record-time">{{ formatTime(record.event_time) }}</div>
              <div class="dashboard-record-main">
                <strong>{{ record.person_name || record.message }}</strong>
                <span>{{ record.camera_id || 'External source' }} · {{ record.zone || record.gate_id || record.category }}</span>
              </div>
              <span class="dash-tag" :class="record.status === 'unknown' || record.violations.length ? 'nomatch' : 'match'">{{ statusLabel(record) }}</span>
              <strong class="dashboard-confidence">{{ displayConfidence(record.confidence) }}</strong>
            </div>
            <div v-if="!visibleRecords.length" class="detail-empty">No records for the selected filters.</div>
          </div>
        </template>
        </template>
      </section>
    </div>

    <div class="detail-modal" :class="{ show: viewerRecord !== null }" @click.self="closeViewer">
      <div v-if="viewerRecord" class="detail-dialog panel snapshot-viewer" style="width: min(920px, 100%)">
        <div class="panel-title">
          <div>
            <h2>Detection snapshot</h2>
            <p class="subtitle">{{ formatTime(viewerRecord.event_time) }} · {{ viewerRecord.camera_id || 'External source' }}</p>
          </div>
          <button class="icon-btn" @click="closeViewer">×</button>
        </div>
        <div class="detail-body">
          <img
            class="snapshot-viewer-image"
            :src="assetUrl(viewerRecord.snapshot_url)"
            :alt="`Snapshot for ${viewerRecord.record_id}`"
          />
          <dl class="snapshot-viewer-meta">
            <div><dt>Time</dt><dd>{{ formatTime(viewerRecord.event_time) }}</dd></div>
            <div><dt>Camera</dt><dd>{{ viewerRecord.camera_id || 'External source' }}</dd></div>
            <div><dt>AI model</dt><dd>{{ viewerRecord.script_id }}</dd></div>
            <div><dt>Status</dt><dd>{{ statusLabel(viewerRecord) }}</dd></div>
            <div v-if="viewerRecord.person_name"><dt>Person</dt><dd>{{ viewerRecord.person_name }}</dd></div>
            <div><dt>Confidence</dt><dd>{{ displayConfidence(viewerRecord.confidence) }}</dd></div>
            <div v-if="viewerRecord.zone"><dt>Zone</dt><dd>{{ viewerRecord.zone }}</dd></div>
            <div v-if="viewerRecord.gate_id"><dt>Gate / line</dt><dd>{{ viewerRecord.gate_id }}</dd></div>
            <div v-if="viewerRecord.violations.length"><dt>Missing PPE</dt><dd>{{ viewerRecord.violations.join(', ') }}</dd></div>
            <div><dt>Mode</dt><dd>{{ viewerRecord.mode }}</dd></div>
            <div><dt>Message</dt><dd>{{ viewerRecord.message }}</dd></div>
            <div><dt>Record</dt><dd>{{ viewerRecord.record_id }}</dd></div>
          </dl>
        </div>
        <div v-if="snapshotRecords.length > 1" class="snapshot-viewer-actions">
          <button class="btn" @click="stepViewer(-1)">← Previous</button>
          <span class="snapshot-viewer-count">{{ (viewerIndex ?? 0) + 1 }} / {{ snapshotRecords.length }}</span>
          <button class="btn" @click="stepViewer(1)">Next →</button>
        </div>
      </div>
    </div>
  </section>
</template>
