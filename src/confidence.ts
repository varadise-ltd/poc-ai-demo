/**
 * 人臉識別置信度「顯示值」提升。
 *
 * 後端回傳的是 ArcFace 的原始餘弦相似度（0~1），範圍偏保守（識別命中多在
 * 0.4~0.8）。為了讓前端展示更直觀，這裡做一個純展示用的單調映射，把數值
 * 「往 100% 拉近」，並封頂在 95%（max 不超過 95%），絕不超過 100%：
 *
 *   display = raw + BOOST * (1 - raw)，再 min(display, CAP)
 *
 * 例：raw 0.60 → 0.60 + 0.375×0.40 = 0.75（75%）。
 *
 * 注意：
 *   - 這是**純前端展示**轉換，不寫回後端；後端存的事件/統計仍保留原始值，
 *     因此不影響判重閾值、告警、Dashboard 匯總等任何業務邏輯。
 *   - 只套用在「人臉識別」的置信度顯示，不套用於 PPE / 計數等其他偵測。
 */

/** 提升係數：raw=0.60 → display=0.75。 */
const FACE_CONFIDENCE_BOOST = 0.375

/** 顯示值上限：無論 raw 多高，顯示值都不超過 95%。 */
const FACE_CONFIDENCE_CAP = 0.95

/**
 * 把原始餘弦相似度（0~1）映射為前端展示用的置信度（0~1，封頂 0.95）。
 * 對 null / NaN / 越界輸入做夾取，避免產生無意義的顯示。
 */
export function displayFaceConfidence(raw: number | null | undefined): number {
  if (raw == null || Number.isNaN(raw)) return 0
  const clamped = Math.max(0, Math.min(1, raw))
  const boosted = clamped + FACE_CONFIDENCE_BOOST * (1 - clamped)
  return Math.min(FACE_CONFIDENCE_CAP, boosted)
}

/**
 * 把原始餘弦相似度轉成帶 % 的顯示字串（例如 "75.0%"）。
 */
export function displayFaceConfidencePercent(raw: number | null | undefined, digits = 1): string {
  return `${(displayFaceConfidence(raw) * 100).toFixed(digits)}%`
}
