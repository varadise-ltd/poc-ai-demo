<script setup lang="ts">
import { computed, ref } from 'vue'
import { auth, login, loginWithPassword, logout } from '../auth'

const username = ref('')
const password = ref('')
const localError = ref('')

const title = computed(() => {
  if (auth.status === 'denied') return 'Access denied'
  if (auth.status === 'expired') return 'Session expired'
  if (auth.status === 'error') return 'Sign-in failed'
  return 'Sign in'
})

const failureGuidance = computed(() => {
  if (auth.status === 'denied') {
    return 'This account does not have access to this POC. Ask your Cosmos administrator to assign the cosmos-member or cosmos-admin role, then return to Cosmos and sign in with an authorized account.'
  }
  if (auth.status === 'error' || auth.status === 'expired') {
    return 'Your sign-in could not be completed. Return to the Cosmos sign-in page to try again. If the problem continues, contact your Cosmos administrator.'
  }
  return ''
})

async function submitPasswordLogin(): Promise<void> {
  if (!username.value.trim() || !password.value) return
  localError.value = ''
  const ok = await loginWithPassword(username.value.trim(), password.value)
  if (ok) {
    window.location.reload()
  } else {
    localError.value = auth.message || 'Sign-in failed'
  }
}
</script>

<template>
  <div class="login-page">
    <section class="login-card panel" aria-labelledby="login-title">
      <div class="brand login-brand">
        <img class="brand-logo" src="/cosmos-logo.svg" alt="Cosmos" />
        <div>
          COSMOS
          <small>AI CAM POC CENTER</small>
        </div>
      </div>

      <h1 id="login-title">{{ title }}</h1>
      <p class="subtitle">
        Sign in with your Cosmos account.
      </p>

      <form v-if="auth.passwordLogin && auth.status !== 'denied'" class="password-login" @submit.prevent="submitPasswordLogin">
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          placeholder="Username / Email"
          :disabled="auth.busy"
        />
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="Password"
          :disabled="auth.busy"
        />
        <button type="submit" class="btn primary login-btn" :disabled="auth.busy">
          {{ auth.busy ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>

      <p v-if="localError || auth.message" class="login-message" :class="auth.status" role="alert">
        {{ localError || auth.message }}
      </p>
      <p v-if="failureGuidance" class="login-guidance">
        {{ failureGuidance }}
      </p>

      <div v-if="auth.passwordLogin && auth.status !== 'denied'" class="login-divider"><span>or</span></div>

      <button
        class="btn login-btn"
        :class="auth.passwordLogin && auth.status !== 'denied' ? 'outline' : 'primary'"
        :disabled="auth.busy || !auth.ready"
        @click="login"
      >
        Continue on the Cosmos sign-in page
      </button>
      <p v-if="auth.inIframe" class="subtitle">
        A Cosmos sign-in window will open. If nothing happens, allow pop-ups for this site or
        <a href="/" target="_blank" rel="noopener">open POC in a new tab</a>.
      </p>
      <button v-else-if="auth.authenticated" class="btn outline login-btn" :disabled="auth.busy" @click="logout">
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
.login-guidance {
  margin: 0;
  color: var(--muted, #596579);
  font-size: 13px;
  line-height: 1.55;
}
.login-btn {
  width: 100%;
  padding: 12px;
  font-size: 15px;
}
.password-login {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.password-login input {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 14px;
}
.password-login input:focus {
  outline: none;
  border-color: var(--orange);
}
.login-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted, #8b98a9);
  font-size: 12px;
}
.login-divider::before,
.login-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}
.btn.outline {
  background: transparent;
  color: var(--navy);
  border: 1px solid var(--line);
}
</style>
