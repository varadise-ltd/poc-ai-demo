<script setup lang="ts">
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    document.documentElement.requestFullscreen()
  }
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"></span>
      <div>
        COSMOS
        <small>AI CAM POC CENTER</small>
      </div>
    </div>
    <div class="top-actions">
      <span class="status"><span class="dot"></span> System operational</span>
      <span>EN</span>
      <button class="top-btn" @click="toggleFullscreen">Fullscreen</button>
      <span>⋮</span>
    </div>
  </header>
</template>
