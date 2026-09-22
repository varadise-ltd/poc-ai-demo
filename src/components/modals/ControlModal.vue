<script setup lang="ts">
import { computed, reactive } from 'vue'
import { probeCamera } from '../../api'
import { checkCameraStatus, defaultOutput, store, toggleRun as toggleRunScript } from '../../store'

const script = computed(() => store.scripts.find((s) => s.id === store.controlSelectedId))
const running = computed(() => (store.scriptRuns[script.value?.id ?? '']?.status ?? 'stopped') === 'running')
const hasCameras = computed(() => (script.value?.cameras.length ?? 0) > 0)

// 每个 URL 的「检测视频流」结果：key = `${camera}::${kind}`
const checks = reactive<Record<string, { status: 'checking' | 'ok' | 'fail'; message: string }>>({})

function inputUrl(cam: string): string {
  return store.cameraInputs[cam] ?? store.cameras.find((c) => c.name === cam)?.rtmp ?? '—'
}

function outputUrl(cam: string): string {
  const id = script.value?.id ?? ''
  return store.cameraOutputs[`${id}::${cam}`] ?? defaultOutput(id, cam)
}

function checkState(cam: string, kind: 'input' | 'output') {
  return checks[`${cam}::${kind}`]
}

function formatProbe(r: { width?: number; height?: number; fps?: number }): string {
  const meta = [r.width, r.height].filter((v) => v !== undefined).join('×')
  const fps = r.fps !== undefined ? ` @ ${r.fps} fps` : ''
  return `Valid stream${meta ? ` · ${meta}${fps}` : ''}`
}

async function checkUrl(cam: string, kind: 'input' | 'output'): Promise<void> {
  const key = `${cam}::${kind}`
  const url = kind === 'input' ? inputUrl(cam) : outputUrl(cam)
  if (!url || url === '—') {
    checks[key] = { status: 'fail', message: 'No URL configured' }
    return
  }
  checks[key] = { status: 'checking', message: 'Checking…' }
  try {
    if (kind === 'input') {
      // 输入流探测：同时把 online/offline 状态持久化到后端与数据库
      const r = await checkCameraStatus(cam)
      checks[key] = r.probe.stream_ok
        ? { status: 'ok', message: formatProbe(r.probe) }
        : { status: 'fail', message: r.probe.message || 'Stream not available' }
    } else {
      // 输出流仅做探测展示，不改动摄像机状态
      const r = await probeCamera(url)
      checks[key] = r.stream_ok
        ? { status: 'ok', message: formatProbe(r) }
        : { status: 'fail', message: r.message || 'Stream not available' }
    }
  } catch (err) {
    checks[key] = { status: 'fail', message: err instanceof Error ? err.message : String(err) }
  }
}

async function toggleRun(): Promise<void> {
  if (!script.value) return
  try {
    await toggleRunScript(script.value.id)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showControlDetail }">
    <div class="detail-dialog panel" style="width: min(600px, 100%)">
      <div class="control-detail-head">
        <div class="control-detail-title">
          <h2>{{ script?.name }}</h2>
          <span class="pill" :class="{ gray: !running }">{{ running ? 'Running' : 'Stopped' }}</span>
        </div>
        <button class="icon-btn" @click="store.showControlDetail = false">×</button>
      </div>
      <div class="control-body">
        <div class="control-block">
          <div class="control-block-head">
            <h3>Execution</h3>
            <span class="subtitle">{{ running ? 'Currently running.' : hasCameras ? 'Currently stopped.' : 'Assign a camera before running.' }}</span>
          </div>
          <span v-if="!hasCameras" class="pill gray" title="Assign a camera in the AI model page before running">No camera</span>
          <button v-else class="btn" :class="running ? 'dark' : 'primary'" @click="toggleRun">
            {{ running ? 'Stop' : 'Run' }}
          </button>
        </div>
        <div class="control-block">
          <div class="control-block-head">
            <h3>Cameras</h3>
            <span class="subtitle">Each camera's online/offline status reflects its input video stream health. Use Check to verify and update the status.</span>
          </div>
        </div>
        <div class="config-list control-camera-list">
          <div v-for="c in script?.cameras" :key="c" class="config-row control-camera-row">
            <div class="control-camera">
              <div>
                <strong>{{ c }}</strong>
              </div>
            </div>
            <span class="pill" :class="{ gray: store.cameraStatus[c] !== 'online' }">
              {{ store.cameraStatus[c] === 'online' ? 'Online' : 'Offline' }}
            </span>
            <div class="control-camera-urls">
              <div class="control-url-row">
                <span class="control-url-label">Input</span>
                <code class="control-url-value">{{ inputUrl(c) }}</code>
                <div class="control-url-actions">
                  <button
                    class="btn check-btn"
                    :disabled="checkState(c, 'input')?.status === 'checking'"
                    title="Check whether the input video stream is available"
                    @click="checkUrl(c, 'input')"
                  >
                    {{ checkState(c, 'input')?.status === 'checking' ? 'Checking…' : 'Check' }}
                  </button>
                </div>
              </div>
              <div v-if="checkState(c, 'input')" class="control-url-status" :class="checkState(c, 'input')?.status">
                {{ checkState(c, 'input')?.message }}
              </div>

              <div class="control-url-row">
                <span class="control-url-label">Output</span>
                <code class="control-url-value">{{ outputUrl(c) }}</code>
                <div class="control-url-actions">
                  <button
                    class="btn check-btn"
                    :disabled="checkState(c, 'output')?.status === 'checking'"
                    title="Check whether the output video stream is available"
                    @click="checkUrl(c, 'output')"
                  >
                    {{ checkState(c, 'output')?.status === 'checking' ? 'Checking…' : 'Check' }}
                  </button>
                </div>
              </div>
              <div v-if="checkState(c, 'output')" class="control-url-status" :class="checkState(c, 'output')?.status">
                {{ checkState(c, 'output')?.message }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
