<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  createScriptRecord,
  store,
  updateScriptMetaRecord,
} from '../../store'
import type { Script } from '../../types'

const isAddMode = computed(() => store.scriptDetailMode === 'add')

const script = computed(() => store.scripts.find((s) => s.id === store.currentScriptDetailId))

// Face Recognition uses per-script detection params (mirrors gui.py / 1_facial.py)
const hasParams = computed(() => !!script.value?.params?.length)

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

const title = computed(() => (isAddMode.value ? 'Add AI Model' : script.value?.name))

// 新建 AI model 必须基于一个内置场景：检测器接线（detector_type/model/classes/params）
// 是代码定义而非数据，后端会直接复制基座场景的接线。
const baseOptions = computed(() => store.scripts.filter((s) => !s.custom))

const baseScriptId = computed({
  get: () => {
    if (store.newScriptBaseId) return store.newScriptBaseId
    return baseOptions.value[0]?.id ?? ''
  },
  set: (value: string) => {
    store.newScriptBaseId = value
  },
})

const canSave = computed(() => {
  if (!isAddMode.value) return true
  return !!store.newScriptName.trim() && !!baseScriptId.value
})

const description = computed(
  () => script.value?.description ?? 'Detect whether people are wearing safety helmets in configured areas.',
)

const subtitle = computed(() =>
  isAddMode.value ? 'Create a new AI Model.' : 'Configure this Model independently.',
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

function formatParamValue(value: number | boolean, type?: string): string {
  if (type === 'checkbox') return value ? 'Enabled' : 'Disabled'
  if (typeof value === 'number' && type === 'float') return value.toFixed(2)
  return String(value)
}

function saveScript(): void {
  if (isAddMode.value) {
    const name = store.newScriptName.trim()
    if (!name || !baseScriptId.value) return
    createScriptRecord({
      name,
      baseScriptId: baseScriptId.value,
      description: store.newScriptDescription,
      organization: organization.value.trim(),
      scenario: scenario.value.trim(),
    })
      .then((script) => {
        store.scriptDetailMode = 'edit'
        store.currentScriptDetailId = script.id
        store.showScriptDetail = false
      })
      .catch((err) => alert(err instanceof Error ? err.message : String(err)))
    return
  }
  if (script.value?.id) {
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
          <h3>AI Model overview</h3>
          <div class="form-grid">
            <div class="field full">
              <label>Name</label>
              <input v-model="editableName" :readonly="!isAddMode" placeholder="e.g. Safety Helmet Detection" />
            </div>
            <div class="field full">
              <label>Description</label>
              <input v-model="editableDescription" :readonly="!isAddMode" />
            </div>
            <div v-if="isAddMode" class="field full">
              <label>Base AI model (detector wiring to clone)</label>
              <select v-model="baseScriptId">
                <option v-for="base in baseOptions" :key="base.id" :value="base.id">
                  {{ base.name }}
                </option>
              </select>
              <span class="subtitle">
                Detector type, model, classes and detection parameters are inherited from this built-in AI model.
              </span>
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

        <!-- Camera output streams are managed on the AI model page (expand a row);
             keeping the editor out of this modal avoids two sources of truth. -->

        <div class="config-section">
          <h3>Technical configuration</h3>
          <div class="form-grid">
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
          <button class="btn primary" :disabled="!canSave" @click="saveScript">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>
