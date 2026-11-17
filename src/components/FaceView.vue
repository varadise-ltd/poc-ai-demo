<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { listOrganizations, type OrganizationRecord } from '../api'
import { loadFaces, setActiveOrgId, store } from '../store'
import FaceEditorModal from './modals/FaceEditorModal.vue'
import FaceDetailModal from './modals/FaceDetailModal.vue'
import DeleteFaceModal from './modals/DeleteFaceModal.vue'

const faceFilterOrgId = ref(store.activeOrgId)
const faceOrganizations = ref<OrganizationRecord[]>([])
const faceOrganizationsLoading = ref(false)
const faceFilterLoading = ref(false)
// 每次 Filter 都有可见反馈：即使结果与之前相同，也展示「已应用」的组织与条数，
// 否则「点了没变化」会被理解为「点击无反应」。
const appliedFilter = ref<{ orgLabel: string; count: number } | null>(null)

const activeOrgLabel = computed(() => {
  const org = faceOrganizations.value.find((o) => o.org_id === store.activeOrgId)
  return org?.org_name || store.activeOrgName || store.activeOrgId
})

async function loadFaceOrganizations(): Promise<void> {
  faceOrganizationsLoading.value = true
  try {
    // 后端 GET /api/orgs 默认已按 visible 过滤（隐藏组织不返回），
    // 下拉严格遵循后端可见集合，与 Organization 管理页的开关保持一致。
    faceOrganizations.value = (await listOrganizations()).filter((org) => org.status === 'active')
  } catch {
    faceOrganizations.value = []
  } finally {
    faceOrganizationsLoading.value = false
  }
  // 当前活动组织必须始终在下拉中：否则 select 显示空白、v-model 与所见不符，
  // 用户点 Filter 时实际提交的是一个「看不见的」组织 → 看起来毫无反应。
  if (!faceOrganizations.value.some((o) => o.org_id === store.activeOrgId)) {
    faceOrganizations.value.unshift({
      org_id: store.activeOrgId,
      org_name: store.activeOrgName || store.activeOrgId,
      source: 'local',
      status: 'active',
    })
  }
  // 下拉当前值若已不在可选集合（组织被隐藏/禁用），回落到活动组织。
  if (!faceOrganizations.value.some((o) => o.org_id === faceFilterOrgId.value)) {
    faceFilterOrgId.value = store.activeOrgId
  }
}

async function applyFaceFilter(): Promise<void> {
  if (faceFilterLoading.value) return
  faceFilterLoading.value = true
  appliedFilter.value = null
  try {
    if (faceFilterOrgId.value !== store.activeOrgId) {
      // 切换全局租户：setActiveOrgId 内部并行重载 scripts/cameras/faces/cameraAI。
      await setActiveOrgId(faceFilterOrgId.value)
    } else {
      // 同组织重查也要有 loading 反馈（非 quiet），让点击必然可见。
      await loadFaces()
    }
    if (store.faceError) {
      // loadFaces 把错误吞进 store.faceError；这里同时抛出给 alert，确保
      // Filter 失败不会被误认为「点了没反应」。
      throw new Error(store.faceError)
    }
    appliedFilter.value = { orgLabel: activeOrgLabel.value, count: store.faceData.length }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  } finally {
    faceFilterLoading.value = false
  }
}

async function resetFaceFilter(): Promise<void> {
  faceFilterOrgId.value = store.activeOrgId
  appliedFilter.value = null
  await loadFaces()
}

function addFace(): void {
  store.editingFaceId = null
  store.showFaceEditor = true
}

function editFace(id: number): void {
  store.editingFaceId = id
  store.showFaceEditor = true
}

function openDeleteFace(id: number): void {
  store.deletingFaceId = id
  store.showDeleteFace = true
}

onMounted(async () => {
  await Promise.all([loadFaces(), loadFaceOrganizations()])
})

// 點擊「Configuration → Face management」時即時刷新（quiet，不閃 loading）：
// 512d 向量在後台線程異步補算，回到本頁需重新拉取，讓列表上的
// 512d ✓/✗ 徽章反映最新狀態。本元件以 v-show 常駐掛載，onMounted 只跑一次，
// 故需監聽 (activeTab, configTab) 補一次刷新。
watch(
  () => [store.activeTab, store.configTab] as const,
  ([tab, configTab]) => {
    if (tab === 'config' && configTab === 'face') {
      loadFaces(true)
      // 同步 Organization 管理页最新的 visible 开关。
      void loadFaceOrganizations()
    }
  },
)

watch(
  () => store.activeOrgId,
  (orgId) => {
    faceFilterOrgId.value = orgId
    appliedFilter.value = null
  },
)
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>Face management</h1>
        <p class="subtitle">Manage face data used by configured recognition AI models.</p>
      </div>
    </div>

    <section class="panel config-content">
      <div class="config-head">
        <p class="subtitle">
          Add, edit and manage registered face data. Active embedding:
          <strong>{{ store.faceMeta?.active_dim ?? '—' }}-d</strong>
        </p>
        <button class="btn primary" @click="addFace">+ Add face data</button>
      </div>
      <div class="filter-bar">
        <div class="field">
          <label>Organization</label>
          <select v-model="faceFilterOrgId" :disabled="faceOrganizationsLoading || faceFilterLoading">
            <option v-for="org in faceOrganizations" :key="org.org_id" :value="org.org_id">
              {{ org.org_name || org.org_id }}
            </option>
          </select>
        </div>
        <div class="filter-actions">
          <button class="btn primary" :disabled="faceFilterLoading" @click="applyFaceFilter">
            {{ faceFilterLoading ? 'Filtering…' : 'Filter' }}
          </button>
          <button class="btn" :disabled="faceFilterLoading" @click="resetFaceFilter">Reset</button>
        </div>
      </div>
      <!-- 每次 Filter 的可见结果反馈：组织 + 条数（0 条也是明确的「已应用」） -->
      <p v-if="appliedFilter" class="subtitle" style="margin: 4px 0 8px">
        Showing <strong>{{ appliedFilter.count }}</strong> record(s) in
        <strong>{{ appliedFilter.orgLabel }}</strong>.
        <template v-if="appliedFilter.count === 0">This organization has no registered faces yet — use “+ Add face data” to register one.</template>
      </p>
      <div v-if="store.faceNotice" class="notice face-notice">
        <div>
          <strong>{{ store.faceNotice.name }} saved.</strong>
          <span class="subtitle" style="display: block">
            Face check: {{ store.faceNotice.summary }}
          </span>
          <ul v-if="store.faceNotice.messages.length" style="margin: 6px 0 0; padding-left: 18px; color: #b8860b">
            <li v-for="(message, i) in store.faceNotice.messages" :key="i">{{ message }}</li>
          </ul>
        </div>
        <button class="icon-btn" title="Dismiss" @click="store.faceNotice = null">×</button>
      </div>
      <div v-if="store.faceLoading" class="detail-empty">Loading face data…</div>
      <div v-else-if="store.faceError" class="detail-empty" style="color: var(--red)">{{ store.faceError }}</div>
      <div v-else class="config-list">
        <div v-for="face in store.faceData" :key="face.id" class="config-row face-row">
          <div class="face-identity">
            <img class="face-avatar" :src="face.thumbnail || face.image" :alt="`${face.name} avatar`" />
            <button class="face-link" @click="editFace(face.id)">{{ face.name }}</button>
            <span class="pill" :class="{ gray: !face.hasEmbedding512 }">512d{{ face.hasEmbedding512 ? ' ✓' : ' ✗' }}</span>
            <span v-if="face.embeddings && face.embeddings.length" class="pill">{{ face.embeddings.length }} angle{{ face.embeddings.length > 1 ? 's' : '' }}</span>
            <span v-if="face.faceCount !== undefined" class="subtitle">{{ face.faceCount }} face(s) · {{ face.width }}×{{ face.height }}</span>
          </div>
          <div class="row-actions">
            <button class="btn" @click="editFace(face.id)">Edit</button>
            <button class="btn" @click="openDeleteFace(face.id)">Delete</button>
          </div>
        </div>
        <div v-if="!store.faceData.length" class="detail-empty">No face data available.</div>
      </div>
    </section>

    <FaceEditorModal />
    <FaceDetailModal />
    <DeleteFaceModal />
  </section>
</template>
