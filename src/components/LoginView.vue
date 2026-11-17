<script setup lang="ts">
import { computed } from 'vue'
import { auth, login, logout } from '../auth'

const title = computed(() => {
  if (auth.status === 'denied') return 'Access denied'
  if (auth.status === 'expired') return 'Session expired'
  if (auth.status === 'error') return 'Sign-in failed'
  return 'Sign in'
})
</script>

<template>
  <div class="login-page">
    <section class="login-card panel" aria-labelledby="login-title">
      <div class="brand login-brand">
        <span class="brand-mark"></span>
        <div>
          COSMOS
          <small>AI CAM POC CENTER</small>
        </div>
      </div>

      <h1 id="login-title">{{ title }}</h1>
      <p class="subtitle">
        Use your Cosmos account. You will be redirected to the Cosmos sign-in page;
        this application never sees your password.
      </p>

      <p v-if="auth.message" class="login-message" :class="auth.status" role="alert">{{ auth.message }}</p>

      <button
        v-if="auth.status !== 'denied'"
        class="btn primary login-btn"
        :disabled="auth.busy || !auth.ready"
        @click="login"
      >
        {{ auth.busy || !auth.ready ? 'Redirecting…' : 'Sign in with Cosmos SSO' }}
      </button>
      <button v-else class="btn primary login-btn" :disabled="auth.busy" @click="logout">
        Sign out and use another account
      </button>
    </section>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: linear-gradient(160deg, var(--navy) 0%, var(--navy-2) 100%);
}
.login-card {
  width: 100%;
  max-width: 420px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.login-brand {
  color: var(--navy);
}
.login-card h1 {
  margin: 8px 0 0;
  font-size: 22px;
}
.login-message {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  font-size: 13px;
}
.login-message.denied,
.login-message.error {
  color: var(--red);
  border-color: var(--red);
}
.login-btn {
  width: 100%;
  padding: 12px;
  font-size: 15px;
}
</style>
