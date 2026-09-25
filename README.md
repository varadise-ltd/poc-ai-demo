# poc-ai-demo — AI Cam POC Center

A frontend demo console for the "COSMOS AI CAM POC CENTER", built with Vue 3 + TypeScript + Vite.

This page mirrors the UI/interactions of `ai-demo/index.html` and the business scenarios of detection scripts such as `ai-demo/1_facial.py`, rebuilt with TypeScript + Vue. All business data (cameras, AI models and their parameters/KPIs, faces, alerts, dashboard records) comes from the `poc-ai-service` backend over REST; only tab labels, layout and seed data for first paint are frontend-owned.

## Features

Five tabs:

| Tab | Function |
|---|---|
| **AI Cam Live** | Camera / AI-model selection, MJPEG preview with snapshot, real-time detection results, detection history modal |
| **Camera** | Camera setting: register/edit/delete raw cameras and per-camera AI model instances |
| **AI model** | AI-model catalog: run/stop (all or per camera), per-camera assignment, detection parameters, KPI facts, add/delete with a restore panel for soft-deleted models |
| **Dashboard** | Backend analytics dashboards (Face Recognition, In / Out, PPE detection, Object detection) |
| **Face management** | Registered face data with dual 128-d / 512-d embeddings |

The AI-model catalog (names, descriptions, parameters, KPI facts), cameras, faces, ROI regions,
gate/dashboard analytics and alerts all come from the backend service (`poc-ai-service`);
tab labels and layout are frontend-owned.

## Tech Stack

- Vue 3 (`<script setup>` Composition API)
- TypeScript (strict mode)
- Vite 5
- State management: module-level `reactive` store (`src/store.ts`)

## Project Structure

```
poc-ai-demo/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.ts
    ├── App.vue
    ├── style.css         # single global stylesheet (design tokens + all rules)
    ├── types.ts          # Domain type definitions
    ├── api.ts            # the only module that calls fetch (snake_case → camelCase mapping)
    ├── data.ts           # Static seed data used to initialise the store
    ├── store.ts          # Reactive state and actions
    └── components/
        ├── TopBar.vue
        ├── TabNav.vue
        ├── AICamLiveView.vue  # AI Cam Live
        ├── CameraView.vue     # Camera setting
        ├── ControlView.vue    # AI model
        ├── DashboardView.vue  # Dashboard
        ├── FaceView.vue       # Face management
        └── modals/            # Various modals
            ├── ResultDetailModal.vue
            ├── HistoryModal.vue
            ├── ControlModal.vue
            ├── ScriptDetailModal.vue
            ├── CameraEditorModal.vue
            ├── AiDetailModal.vue
            ├── AddAiModal.vue
            ├── FaceEditorModal.vue
            ├── FaceDetailModal.vue
            └── DeleteFaceModal.vue
```

## Running

The console needs the backend for its data. Start `poc-ai-service` first (it serves
`http://localhost:8000`), then:

```bash
# Install dependencies
npm install

# Development mode (default http://localhost:5173)
npm run dev

# Type-check + production build
npm run build

# Preview the production build
npm run preview
```

The API base URL comes from `VITE_API_BASE` (`src/api.ts`, build-time), defaulting to
`http://localhost:8000`. In Docker the value is `""` so the nginx reverse proxy serves `/api/`
same-origin (`docker compose up -d --build` in `poc-ai-service`, then http://localhost:8080).

## Notes

- Data is **backend-owned**. `src/data.ts` only seeds the store so the first paint is not empty;
  `loadScripts()` / `loadCameras()` / `loadFaces()` / `loadCameraAI()` replace it from the API.
- The video preview is a real MJPEG stream from `GET /api/stream` (`<img :src>`); Pause freezes
  it with `GET /api/stream/snapshot`. The synthetic gradient fallback is backend-side preview only.
- Face images are served from `GET /api/faces/{id}/image`. The `https://i.pravatar.cc` URLs in
  `data.ts` belong to `initialFaceData`, which is a dead export kept only as a fixture.
- `ROI` polygons are drawn in the AI-instance detail modal and persisted through `POST /api/roi`.
