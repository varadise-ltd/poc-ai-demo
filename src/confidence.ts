/**
 * 全部 AI 模型共用的顯示信心值規則。
 *
 * 後端已將全部模型的原始分數加上 20 個百分點並封頂 95%。此模組保留相同
 * 規則給前端 fallback / demo data 使用，避免任何畫面另行套用不同公式。
 *
 *   display = min(0.95, raw + 0.20)
 *
 * 例：raw 0.60 → 0.80（80%）。
 *
 * 注意：
 *   - 即時 API 的分數已由後端正規化；應直接格式化，不可再加分。
 *   - 此函式僅供尚未正規化的本機 demo/fallback 資料使用。
 */

/** 提升係數：raw=0.60 → display=0.80。 */
const DISPLAY_CONFIDENCE_BOOST = 0.20

/** 顯示值上限：無論 raw 多高，顯示值都不超過 95%。 */
const DISPLAY_CONFIDENCE_CAP = 0.95

/**
 * 把原始餘弦相似度（0~1）映射為前端展示用的置信度（0~1，封頂 0.95）。
 * 對 null / NaN / 越界輸入做夾取，避免產生無意義的顯示。
 */
export function displayConfidenceFallback(raw: number | null | undefined): number {
  if (raw == null || Number.isNaN(raw)) return 0
  const clamped = Math.max(0, Math.min(1, raw))
  return Math.min(DISPLAY_CONFIDENCE_CAP, clamped + DISPLAY_CONFIDENCE_BOOST)
}

/**
 * 把原始餘弦相似度轉成帶 % 的顯示字串（例如 "75.0%"）。
 */
export function formatDisplayConfidence(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return '—'
  const clamped = Math.max(0, Math.min(DISPLAY_CONFIDENCE_CAP, value))
  return `${(clamped * 100).toFixed(digits)}%`
}
