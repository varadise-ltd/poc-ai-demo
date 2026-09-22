<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../../store'

const props = defineProps<{ camera: string }>()
const emit = defineEmits<{ confirm: [payload: { scriptId: string; name: string; enabled: boolean; output: string; params: Record<string, number | boolean> }] }>()

const scriptId = ref('')
const customName = ref('')
const enabled = ref(true)
const output = ref('')
const params = ref<Record<string, number | boolean>>({})

const selectedScript = computed(() => store.scripts.find((s) => s.id === scriptId.value) ?? null)

watch(
  () => store.scripts,
  (scripts) => {
    if (!scriptId.value && scripts.length) scriptId.value = scripts[0].id
  },
  { immediate: true },
)

watch(
  scriptId,
  (id) => {
    const s = store.scripts.find((x) => x.id === id)
    customName.value = s?.name ?? ''
    output.value = id ? defaultOutput(id, props.camera) : ''
    // 参数初始化为模型默认值（与 AI model setting 一致）
    const defaults: Record<string, number | boolean> = {}
    for (const p of s?.params ?? []) defaults[p.key] = p.value
    params.value = defaults
  },
  { immediate: true },
)

function defaultOutput(id: string, cam: string): string {
  return `rtmp://demo.cosmos.local/annotated/${id}/${cam.toLowerCase().replace(/\s+/g, '-')}`
}

// 参数格式化（与 AI model setting 的 ScriptDetailModal 一致）
function formatParamValue(value: number | boolean | undefined, type: string): string {
  if (value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (type === 'float') return value.toFixed(2)
  return String(value)
}

function setParam(key: string, value: number | boolean): void {
  params.value = { ...params.value, [key]: value }
}

function close(): void {
  store.showAddAi = false
}

function confirm(): void {
  if (!scriptId.value) return
  emit('confirm', {
    scriptId: scriptId.value,
    name: customName.value.trim() || selectedScript.value?.name || scriptId.value,
    enabled: enabled.value,
    output: output.value.trim() || defaultOutput(scriptId.value, props.camera),
    params: params.value,
  })
}
</script>

<template>
  <div class="detail-modal show" aria-hidden="false">
    <div class="detail-dialog panel" style="width: min(600px, 100%)">
      <div class="panel-title">
        <div>
          <h2>Add AI model</h2>
          <p class="subtitle">Add AI model · {{ camera }}</p>
        </div>
        <button class="icon-btn" @click="close">×</button>
      </div>
      <div class="detail-body">
        <div class="config-section">
          <h3>General</h3>
          <div class="form-grid">
            <div class="field full">
              <label>AI model</label>
              <select v-model="scriptId">
                <option v-for="s in store.scripts" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <div class="field full">
              <label>Custom name</label>
              <input v-model="customName" placeholder="Defaults to AI model name" />
            </div>
            <div class="field">
              <label>Enabled</label>
              <select v-model="enabled">
                <option :value="true">Enabled</option>
                <option :value="false">Disabled</option>
              </select>
            </div>
          </div>
        </div>
        <div class="config-section">
          <h3>Output stream</h3>
          <div class="form-grid">
            <div class="field full">
              <label>Output stream (AI cam)</label>
              <input v-model="output" placeholder="Defaults to the model output URL" />
            </div>
          </div>
        </div>
        <div class="config-section">
          <h3>🎛️ Detection Parameters</h3>
          <div v-if="selectedScript?.params?.length" class="form-grid">
            <div v-for="p in selectedScript.params" :key="p.key" class="field full">
              <label>{{ p.label }}</label>
              <template v-if="p.type === 'checkbox'">
                <div class="param-row checkbox-row">
                  <input
                    type="checkbox"
                    :checked="Boolean(params[p.key] ?? p.value)"
                    @change="setParam(p.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <strong class="param-value">{{ formatParamValue(params[p.key] ?? p.value, p.type) }}</strong>
                  <span class="subtitle">{{ p.description }}</span>
                </div>
              </template>
              <template v-else>
                <input
                  type="range"
                  :value="Number(params[p.key] ?? p.value)"
                  :min="p.min"
                  :max="p.max"
                  :step="p.step"
                  class="param-range"
                  @input="setParam(p.key, Number(($event.target as HTMLInputElement).value))"
                />
                <div class="param-row">
                  <strong class="param-value">{{ formatParamValue(params[p.key] ?? p.value, p.type) }}</strong>
                  <span class="subtitle">{{ p.description }}</span>
                </div>
              </template>
            </div>
          </div>
          <p v-else class="subtitle">This AI model has no configurable parameters.</p>
        </div>
        <div class="actions" style="justify-content: flex-end; margin-top: 22px">
          <button class="btn" @click="close">Cancel</button>
          <button class="btn primary" :disabled="!scriptId" @click="confirm">Add</button>
        </div>
      </div>
    </div>
  </div>
</template>
