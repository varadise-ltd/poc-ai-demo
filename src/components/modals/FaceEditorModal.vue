<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { addFaceRecord, store, updateFaceRecord } from '../../store'
import type { FaceValidation } from '../../types'

const isEditing = computed(() => store.editingFaceId !== null)

const name = ref('')
const fileName = ref('')
const preview = ref('')
const showPreview = ref(false)
const pendingFile = ref<File | null>(null)
const saving = ref(false)
const error = ref('')
const clientWarnings = ref<string[]>([])
const serverValidation = ref<FaceValidation | null>(null)

// 双击预览图后按原始尺寸放大查看
const zoomed = ref(false)
const naturalSize = ref<{ width: number; height: number } | null>(null)

function closeZoom(): void {
  zoomed.value = false
}

function onZoomKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeZoom()
  }
}

watch(zoomed, (open) => {
  if (open) {
    window.addEventListener('keydown', onZoomKeydown, true)
  } else {
    window.removeEventListener('keydown', onZoomKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onZoomKeydown, true)
})

const minResolution = computed(() => store.faceMeta?.min_resolution ?? 112)

watch(
  () => store.showFaceEditor,
  (show) => {
    if (!show) return
    error.value = ''
    clientWarnings.value = []
    serverValidation.value = null
    pendingFile.value = null
    zoomed.value = false
    if (store.editingFaceId !== null) {
      const face = store.faceData.find((f) => f.id === store.editingFaceId)
      if (face) {
        name.value = face.name
        fileName.value = face.imageName
        preview.value = face.image
        showPreview.value = true
      }
    } else {
      name.value = ''
      fileName.value = ''
      preview.value = ''
      showPreview.value = false
    }
  },
)

const canSave = computed(() => {
  const hasName = name.value.trim().length > 0
  const hasImage = store.editingFaceId !== null || pendingFile.value !== null
  return hasName && hasImage && !saving.value
})

async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

function onPreviewLoad(event: Event): void {
  const img = event.target as HTMLImageElement
  naturalSize.value = { width: img.naturalWidth, height: img.naturalHeight }
}

function openZoom(): void {
  if (!preview.value) return
  zoomed.value = true
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    error.value = 'Please choose an image smaller than 5 MB.'
    input.value = ''
    return
  }
  error.value = ''
  clientWarnings.value = []
  serverValidation.value = null
  pendingFile.value = file
  preview.value = URL.createObjectURL(file)
  showPreview.value = true
  fileName.value = file.name
  naturalSize.value = null
  zoomed.value = false

  // 初步前端校验：分辨率
  const size = await readImageSize(file)
  if (size) {
    if (Math.min(size.width, size.height) < minResolution.value) {
      clientWarnings.value.push(
        `Resolution ${size.width}×${size.height} is below the recommended minimum of ${minResolution.value}px.`,
      )
    }
  }
}

async function save(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) return

  saving.value = true
  error.value = ''
  try {
    let validation: FaceValidation | undefined
    if (store.editingFaceId !== null) {
      validation = await updateFaceRecord(store.editingFaceId, trimmed, pendingFile.value ?? undefined)
    } else {
      if (!pendingFile.value) {
        error.value = 'Please choose an image.'
        return
      }
      validation = await addFaceRecord(trimmed, pendingFile.value)
    }
    serverValidation.value = validation ?? null
    if (validation && validation.warnings.length > 0) {
      // 有告警但仍保存成功，展示给用户，不关闭弹窗以便查看
      error.value = ''
      return
    }
    store.showFaceEditor = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showFaceEditor }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <div>
          <h2>{{ isEditing ? 'Edit face data' : 'Add face data' }}</h2>
          <p class="subtitle">The image is vectorized on the backend and stored in SQLite for fast matching.</p>
        </div>
        <button class="icon-btn" @click="store.showFaceEditor = false">×</button>
      </div>
      <div class="detail-body">
        <div class="form-grid">
          <div class="field full">
            <label>Name</label>
            <input v-model="name" placeholder="e.g. Alex Chen" />
          </div>
          <div class="field full">
            <label>Image</label>
            <input type="file" accept="image/*" @change="onFileChange" />
            <small class="subtitle">Use one clear front-facing image. JPG or PNG, maximum 5 MB.</small>
          </div>
          <div v-if="showPreview" class="field full" style="align-items: center; gap: 12px">
            <img
              class="face-avatar face-avatar-preview"
              :src="preview"
              alt="Face preview"
              title="Double-click to view original size"
              @dblclick="openZoom"
              @load="onPreviewLoad"
            />
            <span class="subtitle">{{ fileName }}</span>
          </div>
          <div v-if="clientWarnings.length" class="field full">
            <ul style="margin: 0; padding-left: 18px; color: #b8860b">
              <li v-for="(w, i) in clientWarnings" :key="i">{{ w }}</li>
            </ul>
          </div>
          <div v-if="serverValidation" class="field full">
            <p class="subtitle" style="margin: 0 0 4px">
              Face check: {{ serverValidation.width }}×{{ serverValidation.height }} ·
              {{ serverValidation.face_count }} face(s) · detector: {{ serverValidation.detector }}
            </p>
            <ul v-if="serverValidation.warnings.length" style="margin: 0; padding-left: 18px; color: #b8860b">
              <li v-for="(w, i) in serverValidation.warnings" :key="i">{{ w }}</li>
            </ul>
          </div>
          <div v-if="error" class="field full">
            <span style="color: var(--red)">{{ error }}</span>
          </div>
        </div>
        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="store.showFaceEditor = false">Cancel</button>
          <button class="btn primary" :disabled="!canSave" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="zoomed" class="face-zoom-overlay" @click="closeZoom">
        <div class="face-zoom-panel" @click.stop>
          <div class="face-zoom-head">
            <span class="subtitle">
              {{ fileName }}<template v-if="naturalSize"> · {{ naturalSize.width }}×{{ naturalSize.height }}</template>
            </span>
            <button class="icon-btn" @click="closeZoom">×</button>
          </div>
          <div class="face-zoom-body" @dblclick="closeZoom">
            <img :src="preview" alt="Face preview at original size" />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
