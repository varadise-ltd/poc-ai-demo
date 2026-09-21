<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { probeCamera, type CameraProbeResult } from '../../api'
import { addCameraRecord, store, updateCameraRecord } from '../../store'

const isAddMode = computed(() => store.cameraEditorMode === 'add')

const title = computed(() => (isAddMode.value ? 'Add camera' : 'Camera setting'))

const subtitle = computed(() => (isAddMode.value ? 'Register a new raw camera source.' : store.cameraEditorTitle))

const name = ref('')
const rtmp = ref('')
const resolution = ref('1920 × 1080')
const rotate = ref('0°')
const organization = ref('')
const orgAdmin = ref('')
const saving = ref(false)
const error = ref('')

// RTMP URL 校验状态
const rtmpError = ref('')
const rtmpProbe = ref<CameraProbeResult | null>(null)
const checking = ref(false)

watch(
  () => store.showCameraEditor,
  (show) => {
    if (!show) return
    error.value = ''
    rtmpError.value = ''
    rtmpProbe.value = null
    name.value = store.cameraEditorName
    rtmp.value = store.cameraEditorRtmp
    resolution.value = store.cameraEditorResolution
    rotate.value = store.cameraEditorRotate
    organization.value = store.cameraEditorOrganization
    orgAdmin.value = store.cameraEditorOrgAdmin
  },
)

const canSave = computed(() => {
  const hasName = name.value.trim().length > 0
  return hasName && !saving.value && !checking.value
})

// 前端 URL 格式校验（快速、无需请求后端）
function validateUrlFormat(url: string): string | null {
  const value = url.trim()
  if (!value) return 'RTMP input URL is required.'
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (!schemeMatch) return 'URL must start with a scheme, e.g. rtmp://.'
  const scheme = schemeMatch[1].toLowerCase()
  const allowed = ['rtmp', 'rtmps', 'rtsp', 'rtsps', 'http', 'https']
  if (!allowed.includes(scheme)) {
    return `Unsupported scheme "${scheme}". Use rtmp/rtsp/http(s).`
  }
  try {
    const parsed = new URL(value)
    if (!parsed.hostname) return 'URL has no host.'
  } catch {
    return 'Invalid URL format.'
  }
  return null
}

// 后端探测：host 可达性 + 能否打开为视频流（读取一帧）
async function validateStream(): Promise<boolean> {
  checking.value = true
  rtmpProbe.value = null
  rtmpError.value = ''
  try {
    const res = await probeCamera(rtmp.value.trim())
    rtmpProbe.value = res
    if (!res.stream_ok) {
      rtmpError.value = res.message || 'Stream is not a valid video stream.'
      return false
    }
    rtmpError.value = ''
    return true
  } catch (err) {
    rtmpError.value = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    checking.value = false
  }
}

function onRtmpBlur(): void {
  const fmtErr = validateUrlFormat(rtmp.value)
  if (fmtErr) {
    rtmpError.value = fmtErr
    rtmpProbe.value = null
  }
}

async function save(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) return

  error.value = ''

  // 1) 前端 URL 格式校验
  const fmtErr = validateUrlFormat(rtmp.value)
  if (fmtErr) {
    rtmpError.value = fmtErr
    return
  }

  // 2) 后端探测确认为有效视频流
  const streamOk = await validateStream()
  if (!streamOk) {
    return
  }

  saving.value = true
  try {
    if (isAddMode.value) {
      await addCameraRecord(
        trimmed,
        rtmp.value.trim(),
        'online',
        resolution.value,
        rotate.value,
        organization.value.trim(),
        orgAdmin.value.trim(),
      )
    } else if (store.cameraEditorId !== null) {
      await updateCameraRecord(store.cameraEditorId, {
        name: trimmed,
        rtmp: rtmp.value.trim(),
        resolution: resolution.value,
        rotate: rotate.value,
        organization: organization.value.trim(),
        org_admin: orgAdmin.value.trim(),
      })
    }
    store.showCameraEditor = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showCameraEditor }">
    <div class="detail-dialog panel">
      <div class="panel-title">
        <div>
          <h2>{{ title }}</h2>
          <p class="subtitle">{{ subtitle }}</p>
        </div>
        <button class="icon-btn" @click="store.showCameraEditor = false">×</button>
      </div>
      <div class="detail-body">
        <p class="subtitle" style="margin-bottom: 16px">
          Paste the RTMP address assigned by CCTV Hub to register this raw camera.
        </p>
        <div class="form-grid">
          <div class="field full">
            <label>Camera name</label>
            <input v-model="name" />
          </div>
          <div class="field full">
            <label>RTMP input URL</label>
            <div class="rtmp-row">
              <input v-model="rtmp" :class="{ invalid: !!rtmpError }" @blur="onRtmpBlur" @input="rtmpError = ''" />
              <button class="btn" :disabled="checking || !rtmp.trim()" @click="validateStream">
                {{ checking ? 'Checking…' : 'Check stream' }}
              </button>
            </div>
            <div v-if="rtmpError" class="rtmp-hint" style="color: var(--red)">{{ rtmpError }}</div>
            <div v-else-if="rtmpProbe?.stream_ok" class="rtmp-hint" style="color: var(--green)">
              ✓ Valid video stream{{ rtmpProbe.width ? ` · ${rtmpProbe.width}×${rtmpProbe.height}` : '' }}{{ rtmpProbe.fps ? ` · ${rtmpProbe.fps} fps` : '' }}
            </div>
          </div>
          <div class="field">
            <label>Resolution</label>
            <select v-model="resolution">
              <option>1920 × 1080</option>
              <option>1280 × 720</option>
            </select>
          </div>
          <div class="field">
            <label>Frame rotate</label>
            <select v-model="rotate">
              <option>0°</option>
              <option>90°</option>
              <option>180°</option>
            </select>
          </div>
          <div class="field full">
            <label>Organization (owner tenant)</label>
            <input v-model="organization" placeholder="e.g. Operations Dept." />
          </div>
          <div class="field full">
            <label>Organization admin</label>
            <input v-model="orgAdmin" placeholder="e.g. Zhang San" />
          </div>
          <div v-if="error" class="field full">
            <span style="color: var(--red)">{{ error }}</span>
          </div>
        </div>
        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="store.showCameraEditor = false">Cancel</button>
          <button class="btn primary" :disabled="!canSave" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
