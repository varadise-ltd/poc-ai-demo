# State and Types

## `store.ts` — a Module Singleton

State is a single module-level `reactive({...})` object exported as `store`. There is no Pinia.
Components `import { store }` and mutate it directly for simple UI flags; anything involving the
backend goes through an exported action function.

### State Fields

Navigation / selections
| Field | Type | Initial |
|---|---|---|
| `activeTab` | `TabId` | `'demo'` |
| `selectedScriptId` | `string` | `'helmet'` |
| `selectedCamera` | `string` | `'Site Entrance Camera'` |

Collections
| Field | Type | Initial |
|---|---|---|
| `scripts` | `Script[]` | copy of `data.ts` `scripts` |
| `events` | `EventItem[]` | copy of `data.ts` `events` |
| `historyEvents` | `HistoryEvent[]` | copy of `data.ts` `historyEvents` |
| `detectionEvents` | `EventItem[]` | `[]` (from `GET /api/alerts`) |
| `faceData` | `FaceData[]` | `[]` |
| `cameras` | `Camera[]` | `[]` |
| `cameraAI` | `CameraAI[]` | `[]` |

Loading / error pairs (one per backend domain)
| Fields | Domain |
|---|---|
| `scriptLoading`, `scriptError` | scripts |
| `cameraLoading`, `cameraError` | cameras |
| `faceLoading`, `faceError` | faces |

Runtime mirrors
| Field | Type | Notes |
|---|---|---|
| `scriptRuns` | `Record<string, ScriptRun>` | keyed by script id |
| `cameraRuns` | `Record<string, CameraModelRun>` | key `` `${scriptId}::${camera}` `` — per-camera run state from the backend |
| `cameraStatus` | `Record<string, 'online'\|'offline'>` | rebuilt by `syncCameraMaps()` |
| `cameraInputs` | `Record<string, string>` | name → rtmp, rebuilt from `cameras` |
| `deletedScripts` | `Script[]` | soft-deleted models (restore panel), filled by `loadDeletedScripts()` |
| `faceMeta` | `FaceMeta \| null` | active embedding dim |

There is **no** `cameraOutputs` map any more: the output stream is stored per relation row in
`camera_ai.output` and read back through `CameraModelRun.output` (see `scriptOutput()`).

Demo-view flags: `running`, `overlay`, `previewPaused`, `previewShowLabels`.

Modal visibility (booleans): `showResultDetail`, `showHistory`, `showControlDetail`,
`showScriptDetail`, `showCameraEditor`, `showFaceEditor`, `showFaceDetail`, `showDeleteFace`,
`showAiDetail`, `showAddAi`.

Modal working state: `controlSelectedId`, `currentScriptDetailId`, `selectedEvent`,
`cameraEditorId/Title/Name/Rtmp/Resolution/Rotate/Organization/OrgAdmin/Changed/Mode`,
`scriptDetailMode`, `newScriptName`, `newScriptDescription`, `aiDetailCamera`, `aiDetailScriptId`,
`aiDetailIid`, `deletingFaceId`, `editingFaceId`.

Face save feedback: `faceNotice` (`{ name, summary, messages } | null`) — the backend face-check
result, shown in the Face management list after the editor closes. The face editor always closes
on a successful save, so warnings must be surfaced here rather than inside the modal.

Pattern: **one modal per boolean**. A modal component is rendered with `v-if="store.showXxx"`
and closes itself by setting the flag to `false`.

### Computeds (exported)

| Name | Returns |
|---|---|
| `selectedScript` | `Script` — falls back to `scripts[0]` |
| `visibleEvents` | `EventItem[]` filtered by selected script **name** + camera |
| `liveEvents` | `detectionEvents` filtered the same way |
| `cameraList` | `string[]` — keys of `cameraInputs` |
| `loadedScripts` | `Script[]` where `loaded` |
| `selectedScriptRun` | `ScriptRun` — defaults to `{ status: 'stopped' }` |

Note `visibleEvents` / `liveEvents` match on `script.name`, not `script.id`. If a script is
renamed on the backend, event filtering breaks. Prefer id-based matching when touching this code.

### Actions

Scripts / runs
- `loadScripts()` — replaces `scripts` and `scriptRuns`, then corrects a stale `selectedScriptId`
- `updateScriptMetaRecord(id, fields)` — PATCH + local patch
- `toggleRun(id)` — start/stop via first assigned camera
- `startSelectedScript()` / `stopSelectedScript()` — demo-view preview controls
- `createScriptRecord(fields)` — `POST /api/scripts` (clones `baseScriptId`); followed by
  `loadScripts()` so the new model appears in the catalog
- `loadDeletedScripts()` — `GET /api/scripts?include_deleted=true`, filtered to `deleted`
- `removeScriptRecord(id)` — soft delete: the backend hides the model, then `loadScripts()` +
  `loadDeletedScripts()` refresh the catalog, and the model's `scriptRuns` / `cameraRuns`
  entries are dropped
- `restoreScriptRecord(id)` — the inverse: clears the flag and refreshes both lists
- `selectScript(id)` / `selectCamera(name)` — simple setters

Cameras
- `loadCameras()`, `addCameraRecord(...)`, `updateCameraRecord(id, fields)`, `removeCameraRecord(id)`
  — all call `syncCameraMaps()` afterwards to rebuild `cameraInputs` / `cameraStatus`
- `checkCameraStatus(name)` — probes via the backend and syncs `cameraStatus`
- `applyCameraStatus(name, status)` — local status sync

Per-camera AI cam output streams (edited inline on the **AI model** page, not in a modal)
- `scriptOutput(scriptId, cam)` — effective output URL (the stored `camera_ai.output`, else the
  computed default)
- `availableStreamCameras(scriptId)` — cameras not yet assigned to that script
- `addStreamCamera(scriptId, cam)` / `removeStreamCamera(scriptId, cam)` — **async and
  persisted**: they call `api.assignScriptCamera` / `api.unassignScriptCamera`, so callers must
  `await` them and handle errors. Removing confirms first because it stops the worker and clears
  the ROI. The Output stream column itself is read-only (derived from model + camera)
- `defaultOutput(scriptId, cam)` — the synthesized default RTMP URL; the Output stream
  column is **read-only** (derived from model + camera), so there is no setter

These take an explicit `scriptId`. They previously read `store.currentScriptDetailId`, which
only worked while the editor lived inside `ScriptDetailModal.vue`; the editor now lives in
`ControlView.vue`, where one page renders every script.

Faces
- `loadFaces()` (parallel `listFaces` + `getFaceMeta`), `addFaceRecord`, `updateFaceRecord`,
  `removeFaceRecord` — the add/update variants return `FaceValidation | undefined`

Per-camera AI
- `loadCameraAI()`, `addCameraAIRecord(fields)`, `updateCameraAIRecord(iid, fields)`,
  `removeCameraAIRecord(iid)`

Detection events
- `loadDetectionEvents()` — polls `/api/alerts` and maps via `alertToEvent()`. **Swallows
  errors on purpose** to keep polling through transient failures.
- `clearEvents()` — clears the local `events` array only

Per-camera run control (AI model page)
- `cameraRunKey(scriptId, camera)`, `cameraRun(scriptId, camera)` — one camera's run state
  (falls back to camera connectivity when unknown)
- `scriptHasRunningCamera(scriptId)` — drives the row's Running pill and Run all/Stop all
- `loadScriptCameraRuns(scriptId)` / `loadAllCameraRuns()` — per-camera state from the backend
- `toggleCameraRun(scriptId, camera)` / `toggleScriptCameras(scriptId)` — start/stop one camera
  or all togglable cameras. `ControlView.vue` polls `refreshExpandedCameraRuns()` every 3 s so a
  worker that exits on its own is reflected without a reload.

Utilities
- `statusDot(status)`, `defaultOutput(scriptId, cam)`

### Error-Handling Convention

Two patterns, chosen deliberately:

- **Loading actions** catch and write `store.<domain>Error`, then clear the loading flag in
  `finally`. Used where the view can render an inline error.
- **Mutation actions** let the error propagate so the calling component can
  `alert(err instanceof Error ? err.message : String(err))`.

Match the surrounding action's style when adding a new one.

## `types.ts` — Type Inventory

```ts
export type Kpi = [label: string, value: string, change: string]
```
A **3-tuple**, not an object. `toScript()` in `api.ts` maps the backend `kpis` array into it, so
KPI tiles on the **AI model** tab are backend-owned.

| Interface | Fields |
|---|---|
| `ScriptParam` | `key, label, value: number \| boolean, min, max, step, type: 'float'\|'number'\|'checkbox', description` (all required) |
| `Script` | `id, name, meta, loaded, cameras: string[], kpis: Kpi[], description?, params?: ScriptParam[], organization?, scenario?, videoSource?, rtmpOutput?` |
| `EventItem` | `time, camera, script, name, meta, confidence, ok: boolean` |
| `HistoryEvent` | extends `EventItem` + `date` |
| `FaceData` | `id, name, imageName, image, hasEmbedding?, hasEmbedding512?, width?, height?, faceCount?, createdAt?, updatedAt?` |
| `FaceValidation` | `width, height, face_count, detector, warnings: string[], ok` — `face_count` is **snake_case** (pass-through) |
| `FaceMeta` | `active_dim: 128 \| 512, min_resolution, available: Record<'128'\|'512', boolean>` |
| `CameraStatus` | `'online' \| 'offline'` |
| `Camera` | `id, name, rtmp, status: CameraStatus, resolution?, rotate?, organization?, org_admin?, createdAt?, updatedAt?` — `org_admin` is **snake_case** |
| `ScriptRun` | `status: 'running'\|'stopped', camera?, pid?: number \| null` |
| `Alert` | `timestamp, script, message, image_url?, severity, camera?, confidence?, event_id?, event_type?, mode?, received_time?` |
| `CameraAI` | `iid, camera, scriptId, name, enabled, output?, params?: Record<string, number \| boolean>` |
| `DashboardDefinition` | `id: 'face'\|'inout'\|'ppe'\|'object', title, subtitle` |
| `DashboardRecord` | `record_id, category, event_time, camera_id, script_id, person_name, recognized, status, violation, violations, zone, direction, gate_id, confidence, message, snapshot_url, mode` |
| `DashboardStat` | `label, value: number, tone` |
| `DashboardQueryResult` | `dashboard_id, total, stats: DashboardStat[], records: DashboardRecord[]` |

### camelCase vs snake_case

Mixed on purpose:

- **camelCase** for fields the UI reads and writes routinely (`imageName`, `faceCount`,
  `createdAt`, `orgAdmin`, `scriptId`).
- **snake_case** where the value is a backend filter/payload passed through unchanged
  (`FaceValidation.face_count`, `Camera.org_admin`, `DashboardRecord.camera_id`,
  `DashboardStat`'s backend `stats` payload).

When adding a type, prefer camelCase unless the object is a near-verbatim backend payload — then
staying identical to the wire format avoids a lossy mapping.

## `data.ts` — Seed Data

Exports: `scripts`, `events`, `historyEvents`, `initialFaceData`, `cameraStatus`, `cameraInputs`.

`store.ts` imports `scripts`, `events`, `historyEvents`, `cameraStatus`, `cameraInputs` to
initialize state. `loadScripts()` / `loadCameras()` / `loadFaces()` replace them from the
backend, but `events` and `historyEvents` are **never replaced** — `loadDetectionEvents()` writes
to the separate `detectionEvents` field. So `visibleEvents` (seed) and `liveEvents` (polled) are
different data sets by design.

`initialFaceData` is exported but **never imported anywhere** — a dead export. Either wire it up
or delete it.
