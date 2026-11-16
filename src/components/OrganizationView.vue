<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listOrganizations, setOrgsVisible, type OrganizationRecord } from '../api'
import { store } from '../store'

const allOrgs = ref<OrganizationRecord[]>([])
const loading = ref(false)
const saving = ref(false)
const dropdownOpen = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)
// 选中的 org = 展示（visible）；未选中的 = 隐藏。
const selectedOrgIds = ref<string[]>([])
// 上次已保存的集合快照，用于判断是否有未提交改动。
const lastSaved = ref<string[]>([])

const visibleCount = computed(() => selectedOrgIds.value.length)
const hiddenCount = computed(() => allOrgs.value.length - selectedOrgIds.value.length)

const selectedSummary = computed(() => {
  if (!selectedOrgIds.value.length) return 'No organizations shown'
  const names = selectedOrgIds.value
    .map((id) => allOrgs.value.find((o) => o.org_id === id)?.org_name || '')
    .filter(Boolean)
  if (!names.length) return `${selectedOrgIds.value.length} selected`
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
})

const dirty = computed(() => {
  const a = [...selectedOrgIds.value].sort().join('|')
  const b = [...lastSaved.value].sort().join('|')
  return a !== b
})

async function loadOrganizations(): Promise<void> {
  loading.value = true
  try {
    // include_hidden=true：管理页需要看到全部组织（含已隐藏的），才能重新勾选。
    const orgs = await listOrganizations(true)
    allOrgs.value = orgs
    const visible = orgs.filter((o) => o.visible !== false).map((o) => o.org_id)
    selectedOrgIds.value = visible
    lastSaved.value = [...visible]
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

function toggleDropdown(): void {
  dropdownOpen.value = !dropdownOpen.value
}

// 点击下拉框以外的任意位置 → 收起下拉框（不影响已勾选的选择，仍可点 Confirm 提交）。
function handleClickOutside(event: MouseEvent): void {
  if (!dropdownOpen.value) return
  const el = dropdownRef.value
  if (el && !el.contains(event.target as Node)) {
    dropdownOpen.value = false
  }
}

function toggleOrg(orgId: string): void {
  const idx = selectedOrgIds.value.indexOf(orgId)
  if (idx >= 0) selectedOrgIds.value.splice(idx, 1)
  else selectedOrgIds.value.push(orgId)
}

function toggleAll(): void {
  if (selectedOrgIds.value.length === allOrgs.value.length) selectedOrgIds.value = []
  else selectedOrgIds.value = allOrgs.value.map((o) => o.org_id)
}

async function apply(): Promise<void> {
  saving.value = true
  try {
    // 批量写后端 visible：选中的置展示，其余置隐藏。
    await setOrgsVisible(selectedOrgIds.value)
    dropdownOpen.value = false
    await loadOrganizations()
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  void loadOrganizations()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})

// v-show 常驻挂载，onMounted 只跑一次；切回本 tab 时刷新，反映后端最新值。
watch(
  () => [store.activeTab, store.configTab] as const,
  ([tab, configTab]) => {
    if (tab === 'config' && configTab === 'org') void loadOrganizations()
  },
)
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>Organization</h1>
        <p class="subtitle">
          Choose which organizations appear in the organization lists across the app.
        </p>
      </div>
    </div>

    <section class="panel config-content">
      <div class="config-head">
        <p class="subtitle">
          <strong>{{ visibleCount }}</strong> shown · <strong>{{ hiddenCount }}</strong> hidden.
          Hidden organizations keep their cameras, AI models and data — they are just removed from the lists.
        </p>
      </div>

      <div class="org-control">
        <label>Organizations shown in lists</label>
        <div ref="dropdownRef" class="org-multi-dropdown" :class="{ open: dropdownOpen }">
          <button
            type="button"
            class="org-dropdown-trigger"
            :disabled="loading || !allOrgs.length"
            @click="toggleDropdown"
          >
            <span class="org-dropdown-label">{{ loading ? 'Loading…' : selectedSummary }}</span>
            <span class="org-dropdown-chevron">▾</span>
          </button>
          <div v-if="dropdownOpen" class="org-dropdown-panel">
            <label class="org-multi-option org-select-all">
              <input
                type="checkbox"
                :checked="selectedOrgIds.length === allOrgs.length && allOrgs.length > 0"
                @change="toggleAll"
              />
              <span>Select all</span>
            </label>
            <label v-for="org in allOrgs" :key="org.org_id" class="org-multi-option">
              <input
                type="checkbox"
                :checked="selectedOrgIds.includes(org.org_id)"
                @change="toggleOrg(org.org_id)"
              />
              <span>{{ org.org_name || org.org_id }}</span>
            </label>
            <span v-if="!allOrgs.length" class="subtitle">No organizations available</span>
          </div>
        </div>
        <span class="subtitle">
          Tick an organization to show it in lists; untick to hide it. Changes apply only after you confirm.
        </span>
      </div>

      <div class="org-actions">
        <button
          class="btn primary"
          :disabled="saving || loading || !dirty"
          @click="apply"
        >
          {{ saving ? 'Saving…' : 'Confirm' }}
        </button>
        <button class="btn" :disabled="loading || !dirty" @click="loadOrganizations">Reset</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.org-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.org-control > label {
  font-weight: 650;
  font-size: 13px;
  color: var(--ink);
}

.org-multi-dropdown {
  position: relative;
  max-width: 480px;
}

.org-dropdown-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
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
  max-height: 240px;
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

.org-select-all {
  border-bottom: 1px solid var(--line, #e5e9ee);
  margin-bottom: 4px;
  font-weight: 650;
}

.org-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}
</style>
