<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../../store'
import { assetUrl } from '../../api'

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
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showResultDetail }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <h2>Result detail</h2>
        <button class="icon-btn" @click="store.showResultDetail = false">×</button>
      </div>
      <div class="detail-body">
        <div v-if="!store.selectedEvent" class="detail-empty">
          Select a result to view its snapshot and details.
        </div>
        <div v-else class="detail-content show">
          <div class="detail-image">
            <img v-if="snapshotSrc && !imageFailed" :src="snapshotSrc" alt="Detection snapshot" @error="imageFailed = true" />
            <div v-else class="detail-image-empty">No snapshot stored for this detection.</div>
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
    </div>
  </div>
</template>

<style scoped>
.detail-image {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #0d1117;
}

.detail-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.detail-image-empty {
  color: #8b949e;
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
