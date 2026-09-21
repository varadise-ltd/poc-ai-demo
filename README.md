# poc-ai-demo — AI Cam POC Center

A frontend demo console for the "COSMOS AI CAM POC CENTER", built with Vue 3 + TypeScript + Vite.

This page mirrors the UI/interactions of `ai-demo/index.html` and the business scenarios of detection scripts such as `ai-demo/1_facial.py`, rebuilt with TypeScript + Vue. It ships with built-in demo data and runs out of the box.

## Features

Three main tabs:

| Tab | Function |
|---|---|
| **AI Cam Live** | Script/camera selection, video preview (ROI + person bounding boxes), Preview start/stop, real-time detection results, detection history modal |
| **Control** | Run/Stop control for analysis scripts, camera assignment |
| **Configuration** | Camera settings, script settings, face management, ROI drawing |

Four built-in demo scripts: Safety Helmet Detection, People Counting, Face Recognition, Traffic Counting.

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
    ├── style.css
    ├── types.ts          # Domain type definitions
    ├── data.ts           # Demo data
    ├── store.ts          # Reactive state and actions
    └── components/
        ├── TopBar.vue
        ├── TabNav.vue
        ├── DemoView.vue      # AI Cam Live
        ├── ControlView.vue   # Control
        ├── ConfigView.vue    # Configuration
        └── modals/           # Various modals
            ├── ResultDetailModal.vue
            ├── HistoryModal.vue
            ├── ControlModal.vue
            ├── ScriptDetailModal.vue
            ├── CameraEditorModal.vue
            ├── FaceEditorModal.vue
            ├── FaceDetailModal.vue
            └── DeleteFaceModal.vue
```

## Running

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

## Notes

- This page is a **frontend demo** that uses built-in mock data and does not connect to real RTSP/S3/Telemetry/MQTT backends.
- The video preview area is a CSS-rendered schematic (gradient grid + ROI box + person detection boxes), not a real video stream.
- Face images use `https://i.pravatar.cc` placeholder avatars.
