<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { addFaceRecord, store, updateFaceRecord } from '../../store'
import type { FaceValidation } from '../../types'

interface PendingImage {
  id: number
  file: File | null
  angle: string
  preview: string
  fileName: string
}

// 正脸（front）必填；其余角度可选。
const FRONT_ANGLE = 'front'
const EXTRA_ANGLES = [
  { value: 'left', label: 'Left profile' },
  { value: 'right', label: 'Right profile' },
  { value: 'down', label: 'Looking down' },
]

const isEditing = computed(() => store.editingFaceId !== null)

const name = ref('')
// 正脸（必填）：新增时必须选择；编辑时重新上传则整体替换全部角度。
const frontImage = ref<PendingImage | null>(null)
// 额外角度（可选）：left / right / down，动态增删。
const extraImages = ref<PendingImage[]>([])
const saving = ref(false)
const error = ref('')
const clientWarnings = ref<string[]>([])

let nextId = 1

const minResolution = computed(() => store.faceMeta?.min_resolution ?? 112)

// 已注册的角度照片（编辑模式下只读展示，让用户知道当前底库内容）。
const registeredImages = computed(() => {
  if (!isEditing.value) return []
  const face = store.faceData.find((f) => f.id === store.editingFaceId)
  return face?.embeddings ?? []
})

const hasNewFront = computed(() => frontImage.value?.file != null)
const hasNewExtra = computed(() => extraImages.value.some((e) => e.file != null))

// 客户端排重预检：姓名重复时立即提示，避免白跑一次请求。
const duplicateName = computed(() => {
  const trimmed = name.value.trim().toLowerCase()
  if (!trimmed) return null
  return store.faceData.find(
    (face) => face.id !== store.editingFaceId && face.name.trim().toLowerCase() === trimmed,
  ) ?? null
})

const canSave = computed(() => {
  const hasName = name.value.trim().length > 0
  if (!hasName || saving.value || duplicateName.value !== null) return false
  if (!isEditing.value) {
    // 新增：正脸必填。
    return hasNewFront.value
  }
  // 编辑：选了额外角度却没选正脸时禁止（正脸必填）；其余（改图或仅改名）允许。
  if (hasNewExtra.value && !hasNewFront.value) return false
  return true
})

const frontHint = computed(() => {
  if (isEditing.value && hasNewExtra.value && !hasNewFront.value) {
    return 'A front-facing photo is required when adding profile photos.'
  }
  return ''
})

function angleLabel(angle: string): string {
  if (angle === FRONT_ANGLE) return 'Front'
  return EXTRA_ANGLES.find((a) => a.value === angle)?.label ?? angle
}

watch(
  () => store.showFaceEditor,
  (show) => {
    if (!show) return
    error.value = ''
    clientWarnings.value = []
    store.faceNotice = null
    frontImage.value = null
    extraImages.value = []
    nextId = 1
    if (store.editingFaceId !== null) {
      const face = store.faceData.find((f) => f.id === store.editingFaceId)
      if (face) name.value = face.name
    } else {
      name.value = ''
    }
  },
)

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

async function checkResolution(file: File): Promise<void> {
  const size = await readImageSize(file)
  if (size && Math.min(size.width, size.height) < minResolution.value) {
    clientWarnings.value.push(
      `${file.name}: resolution ${size.width}×${size.height} is below the recommended minimum of ${minResolution.value}px.`,
    )
  }
}

function onFrontChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    error.value = 'Please choose an image smaller than 5 MB.'
    input.value = ''
    return
  }
  error.value = ''
  frontImage.value = {
    id: nextId++,
    file,
    angle: FRONT_ANGLE,
    preview: URL.createObjectURL(file),
    fileName: file.name,
  }
  void checkResolution(file)
  input.value = ''
}

function addExtra(): void {
  extraImages.value.push({
    id: nextId++,
    file: null,
    angle: EXTRA_ANGLES[0].value,
    preview: '',
    fileName: '',
  })
}

function onExtraChange(item: PendingImage, event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    error.value = 'Please choose an image smaller than 5 MB.'
    input.value = ''
    return
  }
  error.value = ''
  item.file = file
  item.preview = URL.createObjectURL(file)
  item.fileName = file.name
  void checkResolution(file)
  input.value = ''
}

function setExtraAngle(item: PendingImage, angle: string): void {
  item.angle = angle
}

function removeExtra(id: number): void {
  const idx = extraImages.value.findIndex((e) => e.id === id)
  if (idx >= 0) extraImages.value.splice(idx, 1)
}

function buildImages(): { file: File; angle: string }[] {
  const images: { file: File; angle: string }[] = []
  if (frontImage.value?.file) images.push({ file: frontImage.value.file, angle: FRONT_ANGLE })
  for (const e of extraImages.value) {
    if (e.file) images.push({ file: e.file, angle: e.angle })
  }
  return images
}

async function save(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) return

  saving.value = true
  error.value = ''
  try {
    let validation: FaceValidation | undefined
    if (store.editingFaceId !== null) {
      if (hasNewFront.value) {
        // 重新上传正脸 → 整体替换全部角度（正脸 + 已选额外角度）。
        validation = await updateFaceRecord(store.editingFaceId, trimmed, buildImages())
      } else {
        // 无新照片 → 仅改名（正脸与角度保持不变）。
        validation = await updateFaceRecord(store.editingFaceId, trimmed)
      }
    } else {
      if (!frontImage.value?.file) {
        error.value = 'Please choose a front-facing photo.'
        return
      }
      validation = await addFaceRecord(trimmed, buildImages())
    }
    // 保存成功后立即关闭弹窗；后端校验告警改在 Face management 列表中提示，
    // 避免用户以为保存失败而重复提交。
    store.faceNotice = validation
      ? {
          name: trimmed,
          summary: `${validation.width}×${validation.height} · ${validation.face_count} face(s) · detector: ${validation.detector}`,
          messages: validation.warnings,
        }
      : null
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
          <p class="subtitle">A front-facing photo is required; additional angles are optional and improve accuracy.</p>
        </div>
        <button class="icon-btn" @click="store.showFaceEditor = false">×</button>
      </div>
      <div class="detail-body">
        <div class="form-grid">
          <div class="field full">
            <label>Name</label>
            <input v-model="name" placeholder="e.g. Alex Chen" @input="error = ''" />
            <small v-if="duplicateName" class="dup-warning">
              “{{ duplicateName.name }}” is already registered (id={{ duplicateName.id }}).
              Edit that record instead of adding a duplicate.
            </small>
            <small v-else class="subtitle">Each person can be registered once.</small>
          </div>

          <!-- 已注册角度（编辑模式只读参考） -->
          <div v-if="isEditing && registeredImages.length" class="field full">
            <label>Currently registered</label>
            <ul class="face-angle-list">
              <li v-for="img in registeredImages" :key="img.id" class="face-angle-item">
                <img class="face-avatar face-avatar-preview" :src="img.thumbnail || img.image" :alt="img.angle" />
                <div class="face-angle-meta">
                  <span class="subtitle">{{ angleLabel(img.angle) }}</span>
                  <span class="pill">registered</span>
                </div>
              </li>
            </ul>
            <small class="subtitle" style="color: #b8860b">
              Uploading new photos replaces all registered angles.
            </small>
          </div>

          <!-- 正脸（必填） -->
          <div class="field full">
            <label>Front photo <span style="color: var(--red)">*</span></label>
            <input type="file" accept="image/*" @change="onFrontChange" />
            <small class="subtitle">Required. A clear, front-facing photo is mandatory for reliable matching.</small>
            <div v-if="frontImage" class="face-angle-item">
              <img class="face-avatar face-avatar-preview" :src="frontImage.preview" :alt="frontImage.fileName" />
              <div class="face-angle-meta">
                <span class="subtitle">{{ frontImage.fileName }}</span>
                <span class="pill">front</span>
              </div>
              <button class="icon-btn" title="Remove" @click="frontImage = null">×</button>
            </div>
          </div>

          <!-- 额外角度（可选） -->
          <div class="field full">
            <label>Additional angles <span class="subtitle">(optional)</span></label>
            <small class="subtitle">
              Left / right / down photos improve accuracy on profile or tilted faces. JPG or PNG, max 5 MB each.
            </small>
            <ul v-if="extraImages.length" class="face-angle-list">
              <li v-for="item in extraImages" :key="item.id" class="face-angle-item">
                <img
                  v-if="item.preview"
                  class="face-avatar face-avatar-preview"
                  :src="item.preview"
                  :alt="item.fileName"
                />
                <div v-else class="face-avatar face-avatar-preview face-angle-empty"></div>
                <div class="face-angle-meta">
                  <select :value="item.angle" @change="setExtraAngle(item, ($event.target as HTMLSelectElement).value)">
                    <option v-for="opt in EXTRA_ANGLES" :key="opt.value" :value="opt.value">
                      {{ opt.label }}
                    </option>
                  </select>
                  <input type="file" accept="image/*" @change="onExtraChange(item, $event)" />
                </div>
                <button class="icon-btn" title="Remove" @click="removeExtra(item.id)">×</button>
              </li>
            </ul>
            <button class="btn" @click="addExtra">+ Add angle</button>
          </div>

          <div v-if="clientWarnings.length" class="field full">
            <ul style="margin: 0; padding-left: 18px; color: #b8860b">
              <li v-for="(w, i) in clientWarnings" :key="i">{{ w }}</li>
            </ul>
          </div>
          <div v-if="frontHint || error" class="field full">
            <p class="form-error">{{ frontHint || error }}</p>
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
  </div>
</template>
