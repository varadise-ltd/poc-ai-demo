<script setup lang="ts">
import { computed } from 'vue'
import { store, toggleRun } from '../store'
import ControlModal from './modals/ControlModal.vue'

const controlSelected = computed(() =>
  store.scripts.find((s) => s.id === store.controlSelectedId),
)

async function onToggleRun(id: string): Promise<void> {
  try {
    await toggleRun(id)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>Object Dectect Control</h1>
        <p class="subtitle">Start and stop analytics scripts, and assign which cameras run each script.</p>
      </div>
    </div>

    <div class="config-list">
      <div v-for="s in store.scripts" :key="s.id" class="config-row">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <button class="camera-link" @click="store.controlSelectedId = s.id; store.showControlDetail = true">
              {{ s.name }}
            </button>
            <span class="pill" :class="{ gray: (store.scriptRuns[s.id]?.status ?? 'stopped') !== 'running' }">
              {{ (store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'Running' : 'Stopped' }}
            </span>
          </div>
          <span>{{ s.meta }} · {{ s.cameras.length }} cameras</span>
        </div>
        <div class="row-actions">
          <span v-if="!s.cameras.length" class="pill gray" title="Assign a camera in the Configuration page before running">
            No camera
          </span>
          <button
            v-else
            class="btn"
            :class="(store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'dark' : 'primary'"
            @click="onToggleRun(s.id)"
          >
            {{ (store.scriptRuns[s.id]?.status ?? 'stopped') === 'running' ? 'Stop' : 'Run' }}
          </button>
        </div>
      </div>
    </div>

    <ControlModal v-if="controlSelected" />
  </section>
</template>
