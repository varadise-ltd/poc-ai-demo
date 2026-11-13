<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  createScriptRecord,
  store,
  updateScriptMetaRecord,
} from '../../store'
import { getOrganization, listCameras, listOrganizations, type OrganizationRecord } from '../../api'
import type { Camera, Script } from '../../types'

const isAddMode = computed(() => store.scriptDetailMode === 'add')

const script = computed(() => store.scripts.find((s) => s.id === store.currentScriptDetailId))

// Face Recognition uses per-script detection params (mirrors gui.py / 1_facial.py)
const hasParams = computed(() => !!script.value?.params?.length)

// Editable organization / scenario (persisted to backend scripts.db on save)
const organizationName = ref('')
const scenario = ref('')

// ADD 模式：一个 AI model 可同时归属多个组织（多选），并可指派到一台摄像机。
const organizations = ref<OrganizationRecord[]>([])
const selectedOrgIds = ref<string[]>([])
const cameras = ref<Camera[]>([])
const camerasLoading = ref(false)
const selectedCamera = ref('')
const orgDropdownOpen = ref(false)

async function loadOrganizations(): Promise<void> {
  try {
    organizations.value = (await listOrganizations()).filter((org) => org.status === 'active')
  } catch {
    organizations.value = []
  }
}

async function loadCamerasForSelectedOrgs(): Promise<void> {
  camerasLoading.value = true
  try {
    if (!selectedOrgIds.value.length) {
      cameras.value = []
      return
    }
    // 合并所有选中组织下的摄像机（camera 只属于一个 org）。
    const results = await Promise.all(selectedOrgIds.value.map((orgId) => listCameras(undefined, orgId)))
    const seen = new Map<string, Camera>()
    for (const batch of results) {
      for (const cam of batch) seen.set(cam.id, cam)
    }
    cameras.value = [...seen.values()]
  } catch {
    cameras.value = []
  } finally {
    camerasLoading.value = false
  }
}

// 已选组织摘要（下拉触发框上显示明文名，超出截断）。
const selectedOrgSummary = computed(() => {
  if (!selectedOrgIds.value.length) return 'Select organizations…'
  const names = selectedOrgIds.value
    .map((id) => organizations.value.find((o) => o.org_id === id)?.org_name || '')
    .filter(Boolean)
  if (!names.length) return `${selectedOrgIds.value.length} selected`
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
})

function toggleOrgDropdown(): void {
  orgDropdownOpen.value = !orgDropdownOpen.value
}

function toggleOrg(orgId: string): void {
  const idx = selectedOrgIds.value.indexOf(orgId)
  if (idx >= 0) selectedOrgIds.value.splice(idx, 1)
  else selectedOrgIds.value.push(orgId)
  selectedCamera.value = ''
  void loadCamerasForSelectedOrgs()
}

watch(
  () => [store.showScriptDetail, script.value?.id],
  () => {
    organizationName.value = ''
    if (store.activeOrgId) {
      getOrganization(store.activeOrgId).then((org) => { organizationName.value = org.org_name }).catch(() => {})
    }
    scenario.value = script.value?.scenario ?? ''
    if (isAddMode.value) {
      selectedOrgIds.value = store.activeOrgId ? [store.activeOrgId] : []
      selectedCamera.value = ''
      void loadOrganizations().then(loadCamerasForSelectedOrgs)
    }
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
      scenario: scenario.value.trim(),
      orgIds: selectedOrgIds.value,
      camera: selectedCamera.value || undefined,
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
            <div v-if="isAddMode" class="field full">
              <label>Organizations (multi-select, one model → many orgs)</label>
              <div class="org-multi-dropdown" :class="{ open: orgDropdownOpen }">
                <button
                  type="button"
                  class="org-dropdown-trigger"
                  :disabled="!organizations.length"
                  @click="toggleOrgDropdown"
                >
                  <span class="org-dropdown-label">{{ selectedOrgSummary }}</span>
                  <span class="org-dropdown-chevron">▾</span>
                </button>
                <div v-if="orgDropdownOpen" class="org-dropdown-panel">
                  <label v-for="org in organizations" :key="org.org_id" class="org-multi-option">
                    <input
                      type="checkbox"
                      :checked="selectedOrgIds.includes(org.org_id)"
                      @change="toggleOrg(org.org_id)"
                    />
                    <span>{{ org.org_name || org.org_id }}</span>
                  </label>
                  <span v-if="!organizations.length" class="subtitle">No organizations available</span>
                </div>
              </div>
              <span class="subtitle">An AI model may belong to multiple organizations; each camera belongs to exactly one.</span>
            </div>
            <div v-else class="field">
              <label>Organization (owner tenant)</label>
              <input :value="organizationName || ''" readonly />
            </div>
            <div v-if="isAddMode" class="field full">
              <label>Assign to camera (optional)</label>
              <select v-model="selectedCamera" :disabled="camerasLoading || !cameras.length">
                <option value="">No camera (assign later)</option>
                <option v-for="cam in cameras" :key="cam.id" :value="cam.name">
                  {{ cam.name }} · {{ cam.status }}
                </option>
              </select>
              <span v-if="!cameras.length && selectedOrgIds.length" class="subtitle">
                No cameras in the selected organization(s).
              </span>
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

<style scoped>
/* 组织多选下拉：触发框 + 可滚动复选面板（相对定位，不撑破 modal 布局） */
.org-multi-dropdown {
  position: relative;
}
.org-dropdown-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border, #d0d5dd);
  border-radius: 6px;
  background: var(--surface, #fff);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.org-dropdown-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.org-dropdown-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-dropdown-chevron {
  color: var(--muted, #667085);
  font-size: 11px;
  transition: transform 0.15s ease;
}
.org-multi-dropdown.open .org-dropdown-chevron {
  transform: rotate(180deg);
}
.org-dropdown-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 220px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border, #d0d5dd);
  border-radius: 6px;
  background: var(--surface, #fff);
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
}
.org-multi-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.org-multi-option:hover {
  background: var(--surface-hover, #f2f4f7);
}
.org-multi-option input[type='checkbox'] {
  flex: 0 0 auto;
  cursor: pointer;
}
.org-multi-option span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
