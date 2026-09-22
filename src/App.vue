<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import DemoView from './components/DemoView.vue'
import CameraView from './components/CameraView.vue'
import ControlView from './components/ControlView.vue'
import DashboardView from './components/DashboardView.vue'
import FaceView from './components/FaceView.vue'
import { store } from './store'
</script>

<template>
  <div class="app">
    <TopBar />
    <TabNav />
    <main>
      <DemoView v-show="store.activeTab === 'demo'" />
      <CameraView v-show="store.activeTab === 'camera'" />
      <ControlView v-show="store.activeTab === 'model'" />
      <DashboardView v-show="store.activeTab === 'dashboard'" />
      <FaceView v-show="store.activeTab === 'face'" />
    </main>
  </div>
</template>
