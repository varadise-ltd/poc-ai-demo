<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  addStreamCamera,
  cameraList,
  createScriptRecord,
  defaultOutput,
  removeStreamCamera,
  setCameraOutput,
  store,
  updateScriptMetaRecord,
} from '../../store'
import type { Script } from '../../types'

const isAddMode = computed(() => store.scriptDetailMode === 'add')

const script = computed(() => store.scripts.find((s) => s.id === store.currentScriptDetailId))

// Editable organization / scenario (persisted to backend scripts.db on save)
const organization = ref('')
const scenario = ref('')

watch(
  () => [store.showScriptDetail, script.value?.id],
  () => {
    organization.value = script.value?.organization ?? ''
    scenario.value = script.value?.scenario ?? ''
  },
  { immediate: true },
)

const assignedCameras = computed(() => script.value?.cameras ?? [])
const availableCameras = computed(() =>
  cameraList.value.filter((c) => !assignedCameras.value.includes(c)),
)

// Face Recognition uses per-script detection params (mirrors gui.py / 1_facial.py)
const hasParams = computed(() => !!script.value?.params?.length)

const description = computed(
  () => script.value?.description ?? 'Detect whether people are wearing safety helmets in configured areas.',
)

const title = computed(() => (isAddMode.value ? 'Add Script' : script.value?.name))

const subtitle = computed(() =>
  isAddMode.value ? 'Create a new analytics script.' : 'Configure this Script independently.',
)

// Editable name / description (add mode uses new-script state)
const editableName = computed({
  get: () => (isAddMode.value ? store.newScriptName : script.value?.name ?? ''),
  set: (value: string) => {
    if (isAddMode.value) store.newScriptName = value
  },
})

const editableDescription = computed({
  get: () => (isAddMode.value ? store.newScriptDescription : description.value),
  set: (value: string) => {
    if (isAddMode.value) store.newScriptDescription = value
  },
})

function outputOf(cam: string): string {
  const key = `${script.value?.id}::${cam}`
  return store.cameraOutputs[key] ?? defaultOutput(script.value?.id ?? '', cam)
}

function onOutputChange(cam: string, value: string): void {
  setCameraOutput(`${script.value?.id}::${cam}`, value)
}

function formatParamValue(value: number | boolean, type?: string): string {
  if (type === 'checkbox') return value ? 'Enabled' : 'Disabled'
  if (typeof value === 'number' && type === 'float') return value.toFixed(2)
  return String(value)
}

function saveScript(): void {
  if (isAddMode.value) {
    const name = store.newScriptName.trim()
    if (!name) return
    createScriptRecord({
      name,
      description: store.newScriptDescription,
      organization: organization.value.trim(),
      scenario: scenario.value.trim(),
    })
      .then((script) => {
        store.scriptDetailMode = 'edit'
        store.currentScriptDetailId = script.id
      })
      .catch((err) => alert(err instanceof Error ? err.message : String(err)))
  } else if (script.value?.id) {
    updateScriptMetaRecord(script.value.id, {
      organization: organization.value.trim(),
      scenario: scenario.value.trim(),
    }).catch((err) => alert(err instanceof Error ? err.message : String(err)))
  }
  store.showScriptDetail = false
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showScriptDetail }">
    <div class="detail-dialog panel" style="width: min(680px, 100%)">
      <div class="panel-title">
        <div>
          <h2>{{ title }}</h2>
          <p class="subtitle">{{ subtitle }}</p>
        </div>
        <button class="icon-btn" @click="store.showScriptDetail = false">×</button>
      </div>
      <div class="detail-body">
        <div class="config-section">
          <h3>Script overview</h3>
          <div class="form-grid">
            <div class="field full">
              <label>Name</label>
              <input v-model="editableName" :readonly="!isAddMode" placeholder="e.g. Safety Helmet Detection" />
            </div>
            <div class="field full">
              <label>Description</label>
              <input v-model="editableDescription" :readonly="!isAddMode" />
            </div>
            <div class="field">
              <label>Organization (owner tenant)</label>
              <input v-model="organization" :readonly="isAddMode" placeholder="e.g. Operations Dept." />
            </div>
            <div class="field">
              <label>Scenario (usage category)</label>
              <input v-model="scenario" :readonly="isAddMode" placeholder="e.g. Traffic & Vehicle" />
            </div>
          </div>
        </div>

        <!-- Per-script detection parameters (e.g. Face Recognition) -->
        <div v-if="hasParams" class="config-section">
          <h3>🎛️ Detection Parameters</h3>
          <div class="form-grid">
            <div v-for="param in script?.params" :key="param.key" class="field full">
              <label>{{ param.label }}</label>
              <template v-if="param.type === 'checkbox'">
                <div class="param-row checkbox-row">
                  <input type="checkbox" v-model="param.value" />
                  <strong class="param-value">{{ formatParamValue(param.value, param.type) }}</strong>
                  <span class="subtitle">{{ param.description }}</span>
                </div>
              </template>
              <template v-else>
                <input
                  type="range"
                  v-model.number="param.value"
                  :min="param.min"
                  :max="param.max"
                  :step="param.step"
                  class="param-range"
                />
                <div class="param-row">
                  <strong class="param-value">{{ formatParamValue(param.value, param.type) }}</strong>
                  <span class="subtitle">{{ param.description }}</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Stream configuration (Video Source + RTMP Output) removed — use Camera output streams below -->

        <!-- Camera output streams (edit mode only) -->
        <div v-if="!isAddMode" class="config-section">
          <h3>Camera output streams</h3>
          <p class="subtitle" style="margin-bottom: 12px">
            Each assigned camera ingests a raw stream and produces its own AI cam output stream. Set the output stream
            for each camera.
          </p>
          <div class="stream-map">
            <div class="stream-map-row head">
              <div>Camera</div>
              <div>Input stream (raw)</div>
              <div>Output stream (AI cam)</div>
              <div></div>
            </div>
            <div v-for="cam in assignedCameras" :key="cam" class="stream-map-row">
              <div class="stream-cam">{{ cam }}</div>
              <div class="stream-in">{{ store.cameraInputs[cam] ?? '—' }}</div>
              <div class="stream-out">
                <input :value="outputOf(cam)" @input="onOutputChange(cam, ($event.target as HTMLInputElement).value)" />
              </div>
              <button class="icon-btn stream-del" title="Remove camera" @click="removeStreamCamera(cam)">×</button>
            </div>
            <div v-if="availableCameras.length" class="stream-map-add">
              <button class="btn primary" @click="addStreamCamera">+ Add camera</button>
            </div>
            <div v-else class="subtitle" style="margin-top: 8px">All cameras are assigned to this script.</div>
          </div>
        </div>

        <div class="config-section">
          <h3>Technical configuration</h3>
          <div class="form-grid">
            <div class="field">
              <label>Pipeline</label>
              <input value="Running · AI analytics pipeline" />
            </div>
            <div class="field">
              <label>Process ID</label>
              <input value="PID 18424" />
            </div>
            <div class="field">
              <label>Auto restart</label>
              <select>
                <option>Enabled</option>
                <option>Disabled</option>
              </select>
            </div>
            <div class="field">
              <label>Kafka alerts</label>
              <input value="Connected" />
            </div>
          </div>
        </div>

        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="store.showScriptDetail = false">Cancel</button>
          <button class="btn primary" :disabled="isAddMode && !editableName.trim()" @click="saveScript">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>
