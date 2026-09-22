<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import DemoView from './components/DemoView.vue'
import ControlView from './components/ControlView.vue'
import ConfigView from './components/ConfigView.vue'
import PeopleCountingView from './components/PeopleCountingView.vue'
import { store } from './store'
</script>

<template>
  <div class="app">
    <TopBar />
    <TabNav />
    <main>
      <DemoView v-show="store.activeTab === 'demo'" />
      <PeopleCountingView v-show="store.activeTab === 'people'" />
      <ControlView v-show="store.activeTab === 'control'" />
      <ConfigView v-show="store.activeTab === 'config'" />
    </main>
  </div>
</template>
