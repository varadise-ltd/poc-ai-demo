<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import AICamLiveView from './components/AICamLiveView.vue'
import ConfigurationView from './components/ConfigurationView.vue'
import DashboardView from './components/DashboardView.vue'
import { store } from './store'
</script>

<template>
  <div class="app">
    <TopBar />
    <TabNav />
    <main class="app-main">
      <AICamLiveView v-show="store.activeTab === 'demo'" />
      <DashboardView v-show="store.activeTab === 'dashboard'" />
      <ConfigurationView v-show="store.activeTab === 'config'" />
   
    </main>
  </div>
</template>
