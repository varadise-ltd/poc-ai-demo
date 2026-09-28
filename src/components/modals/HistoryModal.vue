<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { selectedScript, store, loadHistoryEvents } from '../../store'
import { assetUrl } from '../../api'

/** Default window: the last 7 days, so real detections are visible on open. */
function defaultRange(): { start: string; end: string } {
  const now = new Date()
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const local = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { start: local(from), end: local(now) }
}

const initial = defaultRange()
const start = ref(initial.start)
const end = ref(initial.end)
const cam = ref('all')
const loading = ref(false)

/**
 * History is the durable backend record for the selected AI model.
 *
 * The date range is sent as a UTC ISO window because the backend stores
 * ``event_time`` in UTC; the ``datetime-local`` inputs are local wall-clock.
 */
async function reload(): Promise<void> {
  loading.value = true
  try {
    await loadHistoryEvents({
      scriptId: store.selectedScriptId,
      cameraId: cam.value,
      start: start.value ? new Date(start.value).toISOString() : undefined,
      end: end.value ? new Date(end.value).toISOString() : undefined,
    })
  } finally {
    loading.value = false
  }
}

watch(
  () => store.showHistory,
  (show) => {
    if (show) {
      const range = defaultRange()
      start.value = range.start
      end.value = range.end
      cam.value = 'all'
      void reload()
    }
  },
)

watch([start, end, cam], () => {
  if (store.showHistory) void reload()
})

const filtered = computed(() => {
  const s = selectedScript.value
  return store.historyEvents.filter((e) => {
    const dt = `${e.date}T${e.time.slice(0, 5)}`
    const matchesCamera = cam.value === 'all' || e.camera === cam.value
    const matchesStart = !start.value || dt >= start.value
    const matchesEnd = !end.value || dt <= end.value
    return e.script === s.name && matchesCamera && matchesStart && matchesEnd
  })
})

function showDetail(e: (typeof store.historyEvents)[number]): void {
  store.selectedEvent = e
  store.showHistory = false
  store.showResultDetail = true
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showHistory }">
    <div class="detail-dialog panel" style="width: min(680px, 100%)">
      <div class="panel-title">
        <div>
          <h2>Detection history</h2>
          <p class="subtitle">{{ selectedScript.name }}</p>
        </div>
        <button class="icon-btn" @click="store.showHistory = false">×</button>
      </div>
      <div class="detail-body">
        <div class="form-grid">
          <div class="field">
            <label>Start</label>
            <input v-model="start" type="datetime-local" />
          </div>
          <div class="field">
            <label>End</label>
            <input v-model="end" type="datetime-local" />
          </div>
          <div class="field full">
            <label>Camera</label>
            <select v-model="cam">
              <option value="all">All cameras</option>
              <option v-for="c in selectedScript.cameras" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
        </div>
        <div class="stat-row" style="margin-top: 16px">
          <div class="stat">
            <div class="stat-label">Detections</div>
            <div class="stat-value">{{ filtered.length }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">With snapshot</div>
            <div class="stat-value">{{ filtered.filter((e) => e.imageUrl).length }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ loading ? 'Loading…' : 'Source' }}</div>
            <div class="stat-value" style="font-size: 13px">Backend records</div>
          </div>
        </div>
        <div class="events-list">
          <template v-if="filtered.length">
            <div v-for="(e, i) in filtered" :key="i" class="event" @click="showDetail(e)">
              <img v-if="e.imageUrl" class="event-thumb" :src="assetUrl(e.imageUrl)" alt="" />
              <span v-else class="event-thumb event-thumb-empty"></span>
              <span class="event-time">{{ e.date }}<br />{{ e.time }}</span>
              <span class="event-mark" :class="{ ok: e.ok }"></span>
              <div>
                <div class="event-name">{{ e.name }}</div>
                <div class="event-meta"><strong>{{ e.camera }}</strong> · {{ e.meta }}</div>
              </div>
              <span class="confidence">{{ e.confidence }}</span>
            </div>
          </template>
          <div v-else class="detail-empty">No history for the selected range and camera.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-thumb {
  width: 56px;
  height: 36px;
  border-radius: 4px;
  object-fit: cover;
  background: #0d1117;
  flex: none;
}

.event-thumb-empty {
  border: 1px dashed #30363d;
}
</style>
