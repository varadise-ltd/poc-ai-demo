<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { assetUrl, listCameras, queryDashboard } from '../api'
import type { Camera, DashboardDefinition, DashboardQueryResult } from '../types'

const defaultDashboards: DashboardDefinition[] = [
  { id: 'face', title: 'Face Recognition New', subtitle: 'Face Recognition New' },
  { id: 'inout', title: 'In / Out', subtitle: 'People Counting' },
  { id: 'ppe', title: 'PPE detection', subtitle: 'PPE detection' },
  { id: 'object', title: 'Object detection', subtitle: 'Human detection' },
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
  face: 'Who was recognized from the face library, unknown visitors, and per-person records.',
  inout: 'People crossing configured count lines (add-line + direction), per line.',
  ppe: 'People not meeting PPE requirements, with per-violation detail.',
  object: 'Humans detected by the Human detection AI model, with per-detection detail.',
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
  if (record.violations.length) return record.violations.join(', ')
  return record.status
}

onMounted(async () => {
  const [cameraResponse] = await Promise.allSettled([listCameras()])
  if (cameraResponse.status === 'fulfilled') cameras.value = cameraResponse.value
})
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
          <span class="pill">{{ selectedDashboard.subtitle }}</span>
        </div>

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
              <strong class="dashboard-confidence">{{ record.confidence == null ? '—' : `${Math.round(record.confidence * 100)}%` }}</strong>
            </div>
            <div v-if="!visibleRecords.length" class="detail-empty">No records for the selected filters.</div>
          </div>
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
            <div><dt>Confidence</dt><dd>{{ viewerRecord.confidence == null ? '—' : `${Math.round(viewerRecord.confidence * 100)}%` }}</dd></div>
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
