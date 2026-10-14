<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { selectedScript, store, loadHistoryEvents } from '../../store'
import { assetUrl, countHistoryEvents } from '../../api'

const PAGE_SIZES = [20, 50, 100]
const pageSize = ref(20)

/** Default window: the last 7 days, so real detections are visible on search. */
function defaultRange(): { start: string; end: string } {
  const now = new Date()
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const local = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { start: local(from), end: local(now) }
}

const initial = defaultRange()
const start = ref(initial.start)
const end = ref(initial.end)
const cam = ref('all')
const loading = ref(false)
const page = ref(1)
const total = ref(0)
// 是否已執行過搜尋：初始化為空（不自動載入），點擊 Search 後才顯示結果。
const searched = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

/**
 * The date range is sent as a UTC ISO window because the backend stores
 * ``event_time`` in UTC; the ``datetime-local`` inputs are local wall-clock.
 */
function currentFilters(): {
  scriptId: string
  cameraId: string
  start?: string
  end?: string
} {
  return {
    scriptId: store.selectedScriptId,
    cameraId: cam.value,
    start: start.value ? new Date(start.value).toISOString() : undefined,
    end: end.value ? new Date(end.value).toISOString() : undefined,
  }
}

/** Load one page (offset/limit) + the total count for the pagination indicator. */
async function fetchPage(): Promise<void> {
  loading.value = true
  try {
    const offset = (page.value - 1) * pageSize.value
    await loadHistoryEvents({ ...currentFilters(), limit: pageSize.value, offset })
    total.value = await countHistoryEvents(currentFilters())
  } catch {
    // Keep the previous rows / count on a transient failure.
  } finally {
    loading.value = false
  }
}

/** Search resets to page 1 and applies the current filter inputs. */
function search(): void {
  page.value = 1
  searched.value = true
  void fetchPage()
}

function prevPage(): void {
  if (page.value <= 1) return
  page.value -= 1
  void fetchPage()
}

function nextPage(): void {
  if (page.value >= totalPages.value) return
  page.value += 1
  void fetchPage()
}

// 切換每頁筆數：回到第 1 頁，若已搜尋過則立即重新載入。
watch(pageSize, () => {
  page.value = 1
  if (searched.value) void fetchPage()
})

watch(
  () => store.showHistory,
  (show) => {
    if (show) {
      // Returning from Result detail: preserve the existing searched rows,
      // filters, selected page and page size exactly as the user left them.
      if (store.resultDetailFromHistory) {
        store.resultDetailFromHistory = false
        return
      }
      const range = defaultRange()
      start.value = range.start
      end.value = range.end
      cam.value = 'all'
      page.value = 1
      pageSize.value = 20
      total.value = 0
      searched.value = false
      // 初始化為空：清空舊結果，等待使用者點擊 Search。
      store.historyEvents = []
    }
  },
)

function showDetail(e: (typeof store.historyEvents)[number]): void {
  store.selectedEvent = e
  store.resultDetailFromHistory = true
  store.showHistory = false
  store.showResultDetail = true
}
</script>

<template>
  <div class="detail-modal" :class="{ show: store.showHistory }">
    <div class="detail-dialog panel" style="width: min(780px, 100%)">
      <div class="panel-title">
        <div>
          <h2>{{ selectedScript.name }}</h2>
          <p class="subtitle">Detection history</p>
        </div>
        <button class="icon-btn" @click="store.showHistory = false">×</button>
      </div>
      <div class="detail-body">
        <div class="history-filter-row">
          <div class="field history-filter-field">
            <label>START</label>
            <input v-model="start" type="datetime-local" />
          </div>
          <div class="field history-filter-field">
            <label>END</label>
            <input v-model="end" type="datetime-local" />
          </div>
          <div class="field history-filter-field history-filter-camera">
            <label>CAMERA</label>
            <select v-model="cam">
              <option value="all">All cameras</option>
              <option v-for="c in selectedScript.cameras" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <button class="btn primary history-search-btn" :disabled="loading" @click="search">
            {{ loading ? 'Searching…' : '🔍 Search' }}
          </button>
        </div>

        <div class="history-results-head">
          <div class="history-results-title-wrap">
            <strong class="history-results-title">Results</strong>
            <span class="history-results-count">{{ searched ? total : 0 }} results found</span>
          </div>
          <label class="history-page-size">
            <span>Per page</span>
            <select v-model.number="pageSize">
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
        </div>

        <div class="history-results">
          <template v-if="store.historyEvents.length">
            <div v-for="(e, i) in store.historyEvents" :key="e.eventId ?? i" class="history-result" @click="showDetail(e)">
              <img v-if="e.imageUrl" class="history-result-thumb" :src="assetUrl(e.imageUrl)" alt="" />
              <div v-else class="history-result-thumb history-result-thumb-empty"></div>
              <div class="history-result-body">
                <div class="history-result-line1">
                  <span class="history-result-name">{{ e.name }}</span>
                  <span class="history-result-time">{{ e.date }} {{ e.time }}</span>
                </div>
                <div class="history-result-meta">{{ e.camera }}</div>
              </div>
              <div class="history-result-right">
                <span class="history-result-confidence">Confidence {{ e.confidence }}</span>
                <span class="history-result-status" :class="{ review: !e.ok }">{{ e.ok ? 'Detected' : 'Needs review' }}</span>
              </div>
            </div>
          </template>
          <div v-else class="detail-empty">
            {{ searched ? 'No history for the selected range and camera.' : 'Set the date range and camera, then click Search.' }}
          </div>
        </div>

        <div v-if="total > pageSize" class="history-pagination">
          <button class="btn" :disabled="page <= 1" @click="prevPage">← Previous</button>
          <span class="history-pagination-count">Page {{ page }} / {{ totalPages }}</span>
          <button class="btn" :disabled="page >= totalPages" @click="nextPage">Next →</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 過濾列：START / END / CAMERA / Search 單行橫排。 */
.history-filter-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.history-filter-field {
  flex: 1;
  min-width: 0;
}

.history-filter-camera {
  flex: 1.1;
}

.history-search-btn {
  flex: none;
  height: 36px;
  padding: 0 18px;
}

/* Results 標題列：Results + N results found（左），每頁筆數（右）。 */
.history-results-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 20px 0 10px;
}

.history-results-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.history-results-title {
  font-size: 15px;
  font-weight: 750;
  color: var(--ink);
}

.history-results-count {
  color: var(--muted);
  font-size: 12px;
}

.history-page-size {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}

.history-page-size select {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}

/* 結果列：縮圖 + 標題/meta + 右側 confidence/status。 */
.history-results {
  display: flex;
  flex-direction: column;
}

.history-result {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}

.history-result:last-child {
  border-bottom: 0;
}

.history-result:hover {
  background: #fffaf6;
}

.history-result-thumb {
  width: 150px;
  height: 70px;
  border-radius: 6px;
  object-fit: cover;
  background: #0d1117;
  flex: none;
}

.history-result-thumb-empty {
  border: 1px dashed #30363d;
}

.history-result-body {
  flex: 1;
  min-width: 0;
}

.history-result-line1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.history-result-name {
  font-weight: 700;
  font-size: 14px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-result-time {
  color: var(--muted);
  font-size: 12px;
  flex: none;
}

.history-result-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 5px;
}

.history-result-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: none;
}

.history-result-confidence {
  color: var(--muted);
  font-size: 12px;
}

.history-result-status {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: #1a7f37;
  background: #e6f4ea;
}

.history-result-status.review {
  color: #b35900;
  background: #fff1e0;
}

.history-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.history-pagination-count {
  color: var(--muted);
  font-size: 12px;
}
</style>
