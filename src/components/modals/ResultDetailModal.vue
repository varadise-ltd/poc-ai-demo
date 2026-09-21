<script setup lang="ts">
import { store } from '../../store'
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
          <div class="detail-image"></div>
          <h3>{{ store.selectedEvent.name }}</h3>
          <ul class="detail-list">
            <li><span>Time</span><strong>{{ store.selectedEvent.time }}</strong></li>
            <li><span>Script</span><strong>{{ store.selectedEvent.script }}</strong></li>
            <li><span>Camera</span><strong>{{ store.selectedEvent.camera }}</strong></li>
            <li><span>Confidence</span><strong>{{ store.selectedEvent.confidence }}</strong></li>
            <li><span>Status</span><strong>{{ store.selectedEvent.ok ? 'Detected' : 'Needs review' }}</strong></li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
