<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { peopleCountExportUrl } from '../api'
import { loadPeopleCounting, store } from '../store'

const locations = computed(() => {
  const values = new Set(store.gateConfigs.map((gate) => gate.location))
  return ['', ...values]
})
const summaries = computed(() => store.peopleReport?.summary ?? [])
const trend = computed(() => store.peopleReport?.trend ?? [])
const peaks = computed(() => store.peopleReport?.peaks ?? [])
const totalIn = computed(() => summaries.value.reduce((total, item) => total + item.in, 0))
const totalOut = computed(() => summaries.value.reduce((total, item) => total + item.out, 0))
const occupancy = computed(() => summaries.value.reduce((total, item) => total + item.occupancy, 0))
const maxTrend = computed(() => Math.max(1, ...trend.value.map((item) => item.total)))

function exportReport(): void {
  window.open(peopleCountExportUrl({
    cameraId: store.selectedCamera,
    location: store.peopleLocation || undefined,
    granularity: store.peopleGranularity,
  }), '_blank')
}

onMounted(loadPeopleCounting)
watch(() => [store.selectedCamera, store.peopleLocation, store.peopleGranularity], loadPeopleCounting)
</script>

<template>
  <section class="people-page">
    <div class="page-head">
      <div>
        <h1>People Counting</h1>
        <p class="subtitle">Lobby, staircase, and back / toilet door in/out counts and occupancy analytics.</p>
      </div>
      <button class="btn primary" :disabled="store.peopleLoading" @click="loadPeopleCounting">
        {{ store.peopleLoading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div class="toolbar people-toolbar">
      <div class="field">
        <label>Camera</label>
        <select v-model="store.selectedCamera">
          <option v-for="camera in store.cameras" :key="camera.id" :value="camera.name">{{ camera.name }}</option>
        </select>
      </div>
      <div class="field">
        <label>Location</label>
        <select v-model="store.peopleLocation">
          <option v-for="location in locations" :key="location" :value="location">{{ location || 'All locations' }}</option>
        </select>
      </div>
      <div class="field">
        <label>Report period</label>
        <select v-model="store.peopleGranularity">
          <option value="hour">Hourly</option>
          <option value="day">Daily</option>
        </select>
      </div>
      <button class="btn" @click="exportReport">Export CSV</button>
    </div>

    <p v-if="store.peopleError" class="error">{{ store.peopleError }}</p>

    <div class="stat-row people-stats">
      <div class="stat"><div class="stat-label">Current occupancy</div><div class="stat-value">{{ occupancy }}</div></div>
      <div class="stat"><div class="stat-label">Entered</div><div class="stat-value">{{ totalIn }}</div></div>
      <div class="stat"><div class="stat-label">Exited</div><div class="stat-value">{{ totalOut }}</div></div>
      <div class="stat"><div class="stat-label">Peak period</div><div class="stat-value">{{ peaks[0]?.period ?? '—' }}</div></div>
    </div>

    <div class="people-grid">
      <article class="panel">
        <div class="panel-title"><div><h2>Occupancy by area</h2><p class="subtitle">Live derived occupancy from durable passage facts.</p></div></div>
        <div class="area-list">
          <div v-for="item in summaries" :key="`${item.camera_id}-${item.location}`" class="area-row">
            <div><strong>{{ item.location }}</strong><small>{{ item.gate_id }}</small></div>
            <span class="area-count">{{ item.occupancy }}</span>
            <span class="area-flow">↑ {{ item.in }} · ↓ {{ item.out }}</span>
          </div>
          <p v-if="!summaries.length" class="empty">No passage facts in the selected range.</p>
        </div>
      </article>

      <article class="panel">
        <div class="panel-title"><div><h2>Trend</h2><p class="subtitle">{{ store.peopleGranularity }} traffic volume and occupancy.</p></div></div>
        <div class="trend-list">
          <div v-for="item in trend" :key="item.period" class="trend-row">
            <span>{{ item.period }}</span>
            <div class="trend-track"><i :style="{ width: `${(item.total / maxTrend) * 100}%` }"></i></div>
            <strong>{{ item.total }}</strong>
          </div>
          <p v-if="!trend.length" class="empty">No trend data available.</p>
        </div>
      </article>
    </div>

    <article class="panel report-panel">
      <div class="panel-title"><div><h2>{{ store.peopleGranularity === 'hour' ? 'Hourly' : 'Daily' }} report</h2><p class="subtitle">Peak periods are ranked by total movement.</p></div></div>
      <div class="table-wrap">
        <table><thead><tr><th>Period</th><th>In</th><th>Out</th><th>Total movement</th><th>Occupancy</th></tr></thead>
          <tbody><tr v-for="item in trend" :key="item.period"><td>{{ item.period }}</td><td>{{ item.in }}</td><td>{{ item.out }}</td><td>{{ item.total }}</td><td>{{ item.occupancy }}</td></tr></tbody>
        </table>
      </div>
    </article>
  </section>
</template>
