# poc-ai-demo — AI Cam POC Center

基于 Vue 3 + TypeScript + Vite 实现的「COSMOS AI CAM POC CENTER」前端演示控制台。

本页面参考 `ai-demo/index.html` 的 UI/交互与 `ai-demo/1_facial.py` 等检测脚本的业务场景，使用 TypeScript + Vue 重构，内置演示数据，可直接运行。

## 功能一览

三个主标签页：

| 标签页 | 功能 |
|---|---|
| **AI Cam Live** | 脚本/摄像机选择、视频预览（ROI + 人员框标注）、Preview 启停、实时监测结果、检测历史记录弹窗 |
| **Control** | 分析脚本的 Run/Stop 控制、摄像机分配 |
| **Configuration** | 摄像机设置、脚本设置、人脸管理、ROI 绘制 |

内置 4 个演示脚本：Safety Helmet Detection、People Counting、Face Recognition、Traffic Counting。

## 技术栈

- Vue 3（`<script setup>` 组合式 API）
- TypeScript（严格模式）
- Vite 5
- 状态管理：模块级 `reactive` store（`src/store.ts`）

## 目录结构

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
    ├── types.ts          # 领域类型定义
    ├── data.ts           # 演示数据
    ├── store.ts          # 响应式状态与动作
    └── components/
        ├── TopBar.vue
        ├── TabNav.vue
        ├── DemoView.vue      # AI Cam Live
        ├── ControlView.vue   # Control
        ├── ConfigView.vue    # Configuration
        └── modals/           # 各类弹窗
            ├── ResultDetailModal.vue
            ├── HistoryModal.vue
            ├── ControlModal.vue
            ├── ScriptDetailModal.vue
            ├── CameraEditorModal.vue
            ├── FaceEditorModal.vue
            ├── FaceDetailModal.vue
            └── DeleteFaceModal.vue
```

## 运行

```bash
# 安装依赖
npm install

# 开发模式（默认 http://localhost:5173）
npm run dev

# 类型检查 + 生产构建
npm run build

# 预览生产构建
npm run preview
```

## 说明

- 本页面为**前端演示**，使用内置 mock 数据，不连接真实 RTSP/S3/Telemetry/MQTT 后端。
- 视频预览区为 CSS 绘制的示意画面（渐变网格 + ROI 框 + 人员检测框），非真实视频流。
- 人脸图片使用 `https://i.pravatar.cc` 占位头像。
