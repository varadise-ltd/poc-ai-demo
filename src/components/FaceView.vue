<script setup lang="ts">
import { onMounted } from 'vue'
import { loadFaces, store } from '../store'
import FaceEditorModal from './modals/FaceEditorModal.vue'
import FaceDetailModal from './modals/FaceDetailModal.vue'
import DeleteFaceModal from './modals/DeleteFaceModal.vue'

function addFace(): void {
  store.editingFaceId = null
  store.showFaceEditor = true
}

function editFace(id: number): void {
  store.editingFaceId = id
  store.showFaceEditor = true
}

function openDeleteFace(id: number): void {
  store.deletingFaceId = id
  store.showDeleteFace = true
}

onMounted(async () => {
  await loadFaces()
})
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>Face management</h1>
        <p class="subtitle">Manage face data used by configured recognition AI models.</p>
      </div>
    </div>

    <section class="panel config-content">
      <div class="config-head">
        <p class="subtitle">
          Add, edit and manage registered face data. Active embedding:
          <strong>{{ store.faceMeta?.active_dim ?? '—' }}-d</strong>
          <span v-if="store.faceMeta">
            (128-d: {{ store.faceMeta.available['128'] ? 'ready' : 'missing' }} ·
            512-d: {{ store.faceMeta.available['512'] ? 'ready' : 'missing' }})
          </span>
        </p>
        <button class="btn primary" @click="addFace">+ Add face data</button>
      </div>
      <div v-if="store.faceNotice" class="notice face-notice">
        <div>
          <strong>{{ store.faceNotice.name }} saved.</strong>
          <span class="subtitle" style="display: block">
            Face check: {{ store.faceNotice.summary }}
          </span>
          <ul v-if="store.faceNotice.messages.length" style="margin: 6px 0 0; padding-left: 18px; color: #b8860b">
            <li v-for="(message, i) in store.faceNotice.messages" :key="i">{{ message }}</li>
          </ul>
        </div>
        <button class="icon-btn" title="Dismiss" @click="store.faceNotice = null">×</button>
      </div>
      <div v-if="store.faceLoading" class="detail-empty">Loading face data…</div>
      <div v-else-if="store.faceError" class="detail-empty" style="color: var(--red)">{{ store.faceError }}</div>
      <div v-else class="config-list">
        <div v-for="face in store.faceData" :key="face.id" class="config-row face-row">
          <div class="face-identity">
            <img class="face-avatar" :src="face.image" :alt="`${face.name} avatar`" />
            <button class="face-link" @click="editFace(face.id)">{{ face.name }}</button>
            <span class="pill" :class="{ gray: !face.hasEmbedding }">128d{{ face.hasEmbedding ? ' ✓' : ' ✗' }}</span>
            <span class="pill" :class="{ gray: !face.hasEmbedding512 }">512d{{ face.hasEmbedding512 ? ' ✓' : ' ✗' }}</span>
            <span v-if="face.faceCount !== undefined" class="subtitle">{{ face.faceCount }} face(s) · {{ face.width }}×{{ face.height }}</span>
          </div>
          <div class="row-actions">
            <button class="btn" @click="editFace(face.id)">Edit</button>
            <button class="btn" @click="openDeleteFace(face.id)">Delete</button>
          </div>
        </div>
        <div v-if="!store.faceData.length" class="detail-empty">No face data available.</div>
      </div>
    </section>

    <FaceEditorModal />
    <FaceDetailModal />
    <DeleteFaceModal />
  </section>
</template>
