<script setup lang="ts">
import { computed, ref } from 'vue'
import { removeFaceRecord, store } from '../../store'

const face = computed(() => store.faceData.find((f) => f.id === store.deletingFaceId))

const deleting = ref(false)
const error = ref('')

async function confirmDelete(): Promise<void> {
  if (store.deletingFaceId === null) return
  deleting.value = true
  error.value = ''
  try {
    await removeFaceRecord(store.deletingFaceId)
    store.showDeleteFace = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showDeleteFace }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <h2>Delete face data?</h2>
        <button class="icon-btn" @click="store.showDeleteFace = false">×</button>
      </div>
      <div class="detail-body">
        <p class="subtitle">
          This will remove <strong>{{ face?.name }}</strong> from the face database. This action cannot be undone.
        </p>
        <p v-if="error" class="subtitle" style="color: var(--red)">{{ error }}</p>
        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="store.showDeleteFace = false">Cancel</button>
          <button
            class="btn"
            style="background: var(--red); border-color: var(--red); color: #fff"
            :disabled="deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
