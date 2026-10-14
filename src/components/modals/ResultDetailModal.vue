<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../../store'
import { assetUrl } from '../../api'
import type { EventItem } from '../../types'

// The stored JPEG can be missing (retention prune, or an event predating
// snapshot support), so a failed load degrades to a placeholder instead of a
// broken-image icon.
const imageFailed = ref(false)
const snapshotSrc = computed(() => assetUrl(store.selectedEvent?.imageUrl))

watch(
  () => store.selectedEvent?.imageUrl,
  () => {
    imageFailed.value = false
  },
)

// Navigation list: durable history rows that carry a stored snapshot. This is
// the same set the History dialog paginates, so Previous/Next walks the photos
// the operator just searched for (mirrors Dashboard's Detection snapshot viewer).
const snapshotEvents = computed<EventItem[]>(() => store.historyEvents.filter((e) => e.imageUrl))

function eventKey(e: EventItem | null | undefined): string {
  if (!e) return ''
  return e.eventId ?? `${e.timestamp ?? ''}|${e.name}|${e.camera}`
}

const currentIndex = computed(() => {
  const ev = store.selectedEvent
  if (!ev) return -1
  const key = eventKey(ev)
  return snapshotEvents.value.findIndex((e) => eventKey(e) === key)
})

function closeResultDetail(): void {
  store.showResultDetail = false
  // History remains mounted with its original rows, filters and page number.
  // Re-open it instead of fetching or resetting anything.
  if (store.resultDetailFromHistory) {
    store.showHistory = true
    // Keep this marker set until HistoryModal observes showHistory=true and
    // skips its normal initialization/reset path.
    return
  }
  store.resultDetailFromHistory = false
}

function openFullSnapshot(): void {
  if (!snapshotSrc.value || imageFailed.value) return
  window.open(snapshotSrc.value, '_blank', 'noopener')
}

function step(delta: number): void {
  const list = snapshotEvents.value
  const idx = currentIndex.value
  if (idx < 0 || list.length === 0) return
  store.selectedEvent = list[(idx + delta + list.length) % list.length]
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showResultDetail }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <h2>Result detail</h2>
        <button class="icon-btn" @click="closeResultDetail">×</button>
      </div>
      <div class="detail-body">
        <div v-if="!store.selectedEvent" class="detail-empty">
          Select a result to view its snapshot and details.
        </div>
        <div v-else class="detail-content show">
          <div class="detail-image-stage">
            <button
              v-if="snapshotEvents.length > 1 && currentIndex >= 0"
              class="snapshot-side-button snapshot-side-button-left"
              title="Previous snapshot"
              aria-label="Previous snapshot"
              @click="step(-1)"
            >
              ‹
            </button>
            <div
              class="detail-image"
              :class="{ clickable: snapshotSrc && !imageFailed }"
              :title="snapshotSrc && !imageFailed ? 'Click to open full snapshot' : ''"
              @click="openFullSnapshot"
            >
              <img v-if="snapshotSrc && !imageFailed" :src="snapshotSrc" alt="Detection snapshot" @error="imageFailed = true" />
              <div v-else class="detail-image-empty">No snapshot stored for this detection.</div>
            </div>
            <button
              v-if="snapshotEvents.length > 1 && currentIndex >= 0"
              class="snapshot-side-button snapshot-side-button-right"
              title="Next snapshot"
              aria-label="Next snapshot"
              @click="step(1)"
            >
              ›
            </button>
          </div>
          <h3>{{ store.selectedEvent.name }}</h3>
          <ul class="detail-list">
            <li><span>Time</span><strong>{{ store.selectedEvent.time }}</strong></li>
            <li><span>Script</span><strong>{{ store.selectedEvent.script }}</strong></li>
            <li><span>Camera</span><strong>{{ store.selectedEvent.camera }}</strong></li>
            <li><span>Confidence</span><strong>{{ store.selectedEvent.confidence }}</strong></li>
            <li><span>Status</span><strong>{{ store.selectedEvent.ok ? 'Detected' : 'Needs review' }}</strong></li>
          </ul>
          <a v-if="snapshotSrc && !imageFailed" class="btn" :href="snapshotSrc" target="_blank" rel="noopener">
            Open full snapshot
          </a>
        </div>
      </div>
      <div v-if="snapshotEvents.length > 1 && currentIndex >= 0" class="snapshot-viewer-actions">
        <button class="btn" @click="step(-1)">← Previous</button>
        <span class="snapshot-viewer-count">{{ currentIndex + 1 }} / {{ snapshotEvents.length }}</span>
        <button class="btn" @click="step(1)">Next →</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-image {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #0d1117;
  min-height: 280px;
}

.detail-image-stage {
  position: relative;
  width: 100%;
  height: min(50vh, 420px);
  min-height: 280px;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: #0d1117;
  border-radius: 8px;
  overflow: hidden;
}

.detail-image-stage .detail-image {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.snapshot-side-button {
  position: absolute;
  z-index: 2;
  top: 50%;
  transform: translateY(-50%);
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: rgba(27, 55, 75, 0.78);
  font-size: 30px;
  line-height: 30px;
  cursor: pointer;
}

.snapshot-side-button:hover {
  background: rgba(27, 55, 75, 0.98);
}

.snapshot-side-button-left {
  left: 14px;
}

.snapshot-side-button-right {
  right: 14px;
}

.detail-image.clickable {
  cursor: zoom-in;
}

.detail-image img {
  width: 100%;
  height: 100%;
  /* Preserve the original camera frame ratio.  The dark stage may show
     letterbox/pillarbox space, but no evidence pixels are cropped or stretched. */
  object-fit: contain;
}

.detail-image-empty {
  color: #8b949e;
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
