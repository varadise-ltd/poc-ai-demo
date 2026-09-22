<script setup lang="ts">
import { store, type TabId } from '../store'

const tabs: { id: TabId; label: string }[] = [
  { id: 'demo', label: 'AI Cam Live' },
  { id: 'people', label: 'People Counting' },
  { id: 'control', label: 'Control' },
  { id: 'config', label: 'Configuration' },
]
</script>

<template>
  <nav class="tabs">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: store.activeTab === tab.id }"
      @click="store.activeTab = tab.id"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>
