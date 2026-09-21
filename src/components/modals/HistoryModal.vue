<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { selectedScript, store } from '../../store'

const start = ref('2026-09-08T00:00')
const end = ref('2026-09-11T23:59')
const cam = ref('all')

watch(
  () => store.showHistory,
  (show) => {
    if (show) {
      start.value = '2026-09-08T00:00'
      end.value = '2026-09-11T23:59'
      cam.value = 'all'
    }
  },
)

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
        </div>
        <div class="events-list">
          <template v-if="filtered.length">
            <div v-for="(e, i) in filtered" :key="i" class="event" @click="showDetail(e)">
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
