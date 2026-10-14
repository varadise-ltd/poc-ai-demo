<script setup lang="ts">
import { store, type ConfigTabId } from '../store'
import CameraView from './CameraView.vue'
import ControlView from './ControlView.vue'
import FaceView from './FaceView.vue'

const sections: { id: ConfigTabId; label: string; icon: string }[] = [
  { id: 'camera', label: 'Camera', icon: '📷' },
  { id: 'model', label: 'AI model', icon: '🤖' },
  { id: 'face', label: 'Face management', icon: '🧑' },
]
</script>

<template>
  <div class="config-layout">
    <aside class="config-sidebar">
      <button
        v-for="s in sections"
        :key="s.id"
        class="config-nav-item"
        :class="{ active: store.configTab === s.id }"
        @click="store.configTab = s.id"
      >
        <span class="config-nav-icon">{{ s.icon }}</span>
        <span class="config-nav-label">{{ s.label }}</span>
      </button>
    </aside>
    <div class="config-content">
      <CameraView v-show="store.configTab === 'camera'" />
      <ControlView v-show="store.configTab === 'model'" />
      <FaceView v-show="store.configTab === 'face'" />
    </div>
  </div>
</template>

<style scoped>
.config-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.config-sidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  position: sticky;
  top: 76px;
}

.config-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-weight: 650;
  font-size: 14px;
  text-align: left;
  padding: 12px 14px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.config-nav-item:hover {
  background: #fff7f0;
  color: var(--ink);
}

.config-nav-item.active {
  background: #fff1e4;
  color: var(--orange);
}

.config-nav-icon {
  font-size: 16px;
  line-height: 1;
  width: 20px;
  text-align: center;
}

.config-nav-label {
  flex: 1;
  white-space: nowrap;
}

.config-content {
  min-width: 0;
}
</style>
