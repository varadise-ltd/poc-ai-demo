<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiBaseUrl, probeCamera, type CameraProbeResult } from '../../api'
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

// 最近一次「Check stream」成功且對應的 URL；save 時若 URL 未變可直接沿用，
// 避免再次開啟串流做重複探測。
const lastProbedUrl = ref('')

// 串流 URL 校验状态（支持 RTSP/RTMP/HTTP(S)，带或不带用户名密码）
const rtmpError = ref('')
const rtmpProbe = ref<CameraProbeResult | null>(null)
const checking = ref(false)

// 各关键字段的前端校验提示（即时显示，无需请求后端）
const nameError = ref('')
const resolutionError = ref('')
const rotateError = ref('')
const organizationError = ref('')
const orgAdminError = ref('')

// 「Check stream」成功标志：仅当「当前 URL」已探测成功才为 true。
// save 依此决定是否跳过重复探测，保证保存接口的高效。
const streamValidated = computed(
  () => lastProbedUrl.value === rtmp.value.trim() && rtmpProbe.value?.stream_ok === true,
)

watch(
  () => store.showCameraEditor,
  (show) => {
    if (!show) return
    error.value = ''
    rtmpError.value = ''
    rtmpProbe.value = null
    lastProbedUrl.value = ''
    nameError.value = ''
    resolutionError.value = ''
    rotateError.value = ''
    organizationError.value = ''
    orgAdminError.value = ''
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

const CREDENTIAL_HINT =
  ' If the username/password contains special characters (such as : / # ? @), percent-encode them (e.g. / -> %2F, # -> %23).'

// 前端 URL 格式校验（快速、无需请求后端）。
// 与后端 camera_io.validate_stream_url 保持一致：支持带/不带 user:password@
// 的 rtsp/rtmp/http(s) URL；不用 new URL()，因为未转义密码会使其抛异常。
function validateUrlFormat(url: string): string | null {
  const value = url.trim()
  if (!value) return 'Input URL is required.'
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (!schemeMatch) return 'URL must start with a scheme, e.g. rtsp:// or rtmp://.'
  const scheme = schemeMatch[1].toLowerCase()
  const allowed = ['rtmp', 'rtmps', 'rtsp', 'rtsps', 'http', 'https']
  if (!allowed.includes(scheme)) {
    return `Unsupported scheme "${scheme}". Use rtsp/rtmp/http(s).`
  }
  // 去掉可选的 user:password@（密码允许任意字符，以最后一个 @ 为界）
  const rest = value.slice(schemeMatch[0].length)
  const at = rest.lastIndexOf('@')
  const authorityAndPath = at >= 0 ? rest.slice(at + 1) : rest
  const authority = authorityAndPath.split(/[/?#]/)[0]
  const hostPort = authority.replace(/^\[.*\]/, (m) => m) // IPv6 字面量保持原样
  if (!hostPort) return 'URL has no host.' + CREDENTIAL_HINT
  const portMatch = hostPort.match(/:(\d*)$/)
  if (portMatch && portMatch[1]) {
    const port = Number(portMatch[1])
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return `Port "${portMatch[1]}" is not valid (1-65535).` + CREDENTIAL_HINT
    }
  } else if (portMatch) {
    // 空端口（如 host:/path）：交给后端判断，这里不阻断
  }
  return null
}

// ---------------------------------------------------------------------------
// 前端关键字段校验（不请求后端，即时给提示）
// ---------------------------------------------------------------------------
const NAME_MAX = 128
const ORG_MAX = 100

function validateName(value: string): string | null {
  const v = value.trim()
  if (!v) return 'Camera name is required.'
  if (v.length > NAME_MAX) return `Camera name must be ${NAME_MAX} characters or fewer.`
  return null
}

function validateResolution(value: string): string | null {
  if (!value) return 'Resolution is required.'
  const allowed = ['1920 × 1080', '1280 × 720']
  return allowed.includes(value) ? null : 'Resolution is not a valid option.'
}

function validateRotate(value: string): string | null {
  if (!value) return 'Frame rotate is required.'
  const allowed = ['0°', '90°', '180°']
  return allowed.includes(value) ? null : 'Frame rotate is not a valid option.'
}

function validateOrganization(value: string): string | null {
  if (value.length > ORG_MAX) return `Organization must be ${ORG_MAX} characters or fewer.`
  return null
}

function validateOrgAdmin(value: string): string | null {
  if (value.length > ORG_MAX) return `Organization admin must be ${ORG_MAX} characters or fewer.`
  return null
}

// 后端探测：host 可达性 + 能否打开为视频流（读取一帧）
async function validateStream(): Promise<boolean> {
  checking.value = true
  rtmpProbe.value = null
  rtmpError.value = ''
  console.log('[Camera] check stream (probe) requested')
  try {
    const res = await probeCamera(rtmp.value.trim())
    rtmpProbe.value = res
    console.log(`[Camera] check stream result: valid=${res.valid} reachable=${res.reachable} stream_ok=${res.stream_ok} ${res.width ? `${res.width}x${res.height}` : ''}`)
    if (!res.stream_ok) {
      rtmpError.value = res.message || 'Stream is not a valid video stream.'
      return false
    }
    rtmpError.value = ''
    lastProbedUrl.value = rtmp.value.trim()
    return true
  } catch (err) {
    console.error('[Camera] check stream failed', err)
    // A network failure (backend down / unreachable host) is not a stream
    // problem, so say so instead of leaving the user thinking the URL failed
    // video validation.
    rtmpError.value = err instanceof TypeError
      ? `Cannot reach the backend at ${apiBaseUrl()} — start the service, then click Check stream again. The stream URL was not validated.`
      : err instanceof Error ? err.message : String(err)
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

function onRtmpInput(): void {
  rtmpError.value = ''
  // 改動 URL 後，先前針對舊 URL 的探測結果即失效，必須重新 Check stream。
  rtmpProbe.value = null
  lastProbedUrl.value = ''
}

function onNameBlur(): void {
  nameError.value = validateName(name.value) ?? ''
}

function onNameInput(): void {
  if (nameError.value) nameError.value = validateName(name.value) ?? ''
}

function onOrganizationInput(): void {
  if (organizationError.value) organizationError.value = validateOrganization(organization.value) ?? ''
}

function onOrgAdminInput(): void {
  if (orgAdminError.value) orgAdminError.value = validateOrgAdmin(orgAdmin.value) ?? ''
}

async function save(): Promise<void> {
  error.value = ''

  // 1) 前端关键字段校验：每个字段就地给出提示，全部通过才继续。
  nameError.value = validateName(name.value) ?? ''
  resolutionError.value = validateResolution(resolution.value) ?? ''
  rotateError.value = validateRotate(rotate.value) ?? ''
  organizationError.value = validateOrganization(organization.value) ?? ''
  orgAdminError.value = validateOrgAdmin(orgAdmin.value) ?? ''
  if (
    nameError.value ||
    resolutionError.value ||
    rotateError.value ||
    organizationError.value ||
    orgAdminError.value
  ) {
    return
  }

  // 2) 前端 URL 格式校验
  const fmtErr = validateUrlFormat(rtmp.value)
  if (fmtErr) {
    rtmpError.value = fmtErr
    return
  }

  // 3) 串流探测：仅当「当前 URL 尚未成功 Check stream」时才真正探测；
  //    否则直接沿用已成功的结果（streamValidated），避免重复开流、拖慢 save。
  if (!streamValidated.value) {
    const streamOk = await validateStream()
    if (!streamOk) {
      return
    }
  }

  const trimmed = name.value.trim()
  saving.value = true
  try {
    console.log(`[Camera] save camera name=${trimmed} mode=${isAddMode.value ? 'add' : 'edit'}`)
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
    console.error('[Camera] save camera failed', err)
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
          Paste the stream address (RTSP / RTMP / HTTP(S)) assigned by CCTV Hub to register this raw camera.
          URLs with embedded credentials (e.g. rtsp://user:pass@host:554/…) are supported.
        </p>
        <div class="form-grid">
          <div class="field full">
            <label>Camera name</label>
            <input
              v-model="name"
              :class="{ invalid: !!nameError }"
              @blur="onNameBlur"
              @input="onNameInput"
            />
            <div v-if="nameError" class="rtmp-hint" style="color: var(--red)">{{ nameError }}</div>
          </div>
          <div class="field full">
            <label>Stream input URL (RTSP / RTMP)</label>
            <div class="rtmp-row">
              <input
                v-model="rtmp"
                :class="{ invalid: !!rtmpError }"
                placeholder="rtsp://user:pass@host:1025/cam/realmonitor?channel=1&subtype=0"
                spellcheck="false"
                @blur="onRtmpBlur"
                @input="onRtmpInput"
              />
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
            <div v-if="resolutionError" class="rtmp-hint" style="color: var(--red)">{{ resolutionError }}</div>
          </div>
          <div class="field">
            <label>Frame rotate</label>
            <select v-model="rotate">
              <option>0°</option>
              <option>90°</option>
              <option>180°</option>
            </select>
            <div v-if="rotateError" class="rtmp-hint" style="color: var(--red)">{{ rotateError }}</div>
          </div>
          <div class="field full">
            <label>Organization (owner tenant)</label>
            <input
              v-model="organization"
              :class="{ invalid: !!organizationError }"
              placeholder="e.g. Operations Dept."
              @input="onOrganizationInput"
            />
            <div v-if="organizationError" class="rtmp-hint" style="color: var(--red)">{{ organizationError }}</div>
          </div>
          <div class="field full">
            <label>Organization admin</label>
            <input
              v-model="orgAdmin"
              :class="{ invalid: !!orgAdminError }"
              placeholder="e.g. Zhang San"
              @input="onOrgAdminInput"
            />
            <div v-if="orgAdminError" class="rtmp-hint" style="color: var(--red)">{{ orgAdminError }}</div>
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
