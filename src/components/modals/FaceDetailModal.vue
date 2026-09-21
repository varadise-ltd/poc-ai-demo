<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../../store'

const face = computed(() => store.faceData.find((f) => f.id === store.editingFaceId))
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showFaceDetail }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <div>
          <h2>{{ face?.name }}</h2>
          <p class="subtitle">Face data record</p>
        </div>
        <button class="icon-btn" @click="store.showFaceDetail = false">×</button>
      </div>
      <div class="detail-body">
        <div style="display: flex; gap: 18px; align-items: center; margin: 16px 0">
          <img class="face-avatar" :src="face?.image" style="width: 72px; height: 72px" alt="Face avatar" />
          <div>
            <h3>{{ face?.name }}</h3>
            <p class="subtitle">{{ face?.imageName }}</p>
          </div>
        </div>
        <ul class="detail-list">
          <li><span>Status</span><strong>Active</strong></li>
          <li><span>Used by</span><strong>Face Recognition</strong></li>
          <li><span>Image quality</span><strong>Good</strong></li>
        </ul>
        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="store.showFaceDetail = false">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
