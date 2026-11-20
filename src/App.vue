<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import AICamLiveView from './components/AICamLiveView.vue'
import ConfigurationView from './components/ConfigurationView.vue'
import ChatbotWidget from './components/ChatbotWidget.vue'
import DashboardView from './components/DashboardView.vue'
import LoginView from './components/LoginView.vue'
import { computed } from 'vue'
import { auth, login, logout } from './auth'
import { store } from './store'

const accessMessage = computed(() => {
  switch (store.orgAccessError) {
    case 'not_member':
      return {
        title: 'No access to this organization',
        en: 'Your Cosmos account is not a member of the organization this page was opened for.',
        zh: '您的 Cosmos 账号不是该组织的成员，请在 Cosmos 中切换到您所属的组织，或联系管理员。',
        retry: false,
      }
    case 'membership_unavailable':
      return {
        title: 'Cannot verify access right now',
        en: 'Organization membership cannot be verified at the moment. Please try again shortly.',
        zh: '暂时无法校验组织成员关系，请稍后重试。',
        retry: true,
      }
    default:
      return {
        title: 'Organization not available',
        en: 'This organization is not available for your account.',
        zh: '当前账号无法访问该组织。',
        retry: true,
      }
  }
})

function reload(): void {
  window.location.reload()
}
</script>

<template>
  <LoginView v-if="auth.enabled && !auth.authenticated" />
  <!-- 后端要求登录，但本前端无法访问 /auth/*（部署没有反代 /auth/）。 -->
  <div v-else-if="auth.misconfigured" class="app no-org">
    <div class="no-org-panel" role="alert">
      <h2>Sign-in is not available</h2>
      <p>
        The backend requires a Cosmos sign-in, but this frontend cannot reach <code>/auth/*</code>.
        Deploy the frontend with the nginx image (<code>Dockerfile</code>) or a gateway that proxies
        <code>/auth/</code> to poc-ai-service.
      </p>
      <p class="no-org-zh">后端要求 Cosmos 登录，但当前前端部署没有反代 /auth/*，请改用 nginx 镜像部署。</p>
    </div>
  </div>
  <div v-else-if="store.orgAccessError" class="app no-org">
    <div class="no-org-panel" role="alert">
      <h2>{{ accessMessage.title }}</h2>
      <p>{{ accessMessage.en }}</p>
      <p class="no-org-zh">{{ accessMessage.zh }}</p>
      <div class="no-org-actions">
        <button v-if="accessMessage.retry" class="btn primary" @click="reload">Try again</button>
        <button
          v-if="auth.enabled && auth.authenticated && !auth.inIframe"
          class="btn primary"
          :disabled="auth.busy"
          @click="logout"
        >
          {{ auth.busy ? 'Signing out…' : 'Sign out and use another account' }}
        </button>
      </div>
    </div>
  </div>
  <div v-else-if="store.noOrgAvailable" class="app no-org">
    <div class="no-org-panel" role="alert">
      <h2>No organization available</h2>
      <p>
        Your account is not a member of any Cosmos organization enabled for POC, and the Varadise
        platform organization has not been enabled for it. Please open POC from Cosmos, or ask an
        administrator to enable access.
      </p>
      <p class="no-org-zh">您的账号不属于任何 Cosmos 组织，且尚未开通 Varadise，请从 Cosmos 进入或联系管理员。</p>

      <!-- 已启用 SSO：提供登录/换账号入口，避免无授权时被困在提示页。 -->
      <div v-if="auth.enabled" class="no-org-actions">
        <button
          v-if="auth.authenticated"
          class="btn primary"
          :disabled="auth.busy"
          @click="logout"
        >
          {{ auth.busy ? 'Signing out…' : 'Sign out and use another account' }}
        </button>
        <button
          v-else
          class="btn primary"
          :disabled="auth.busy || !auth.ready"
          @click="login"
        >
          {{ auth.busy || !auth.ready ? 'Signing in…' : 'Sign in with Cosmos' }}
        </button>
      </div>
      <!-- 未启用 SSO（后端未配置 COSMOS_SSO_CLIENT_SECRET 或 AUTH_MODE=off）：说明原因并指引如何开启登录。 -->
      <p v-else class="no-org-hint">
        SSO sign-in is not enabled on the backend. Open POC from Cosmos, or configure COSMOS_SSO_CLIENT_SECRET on poc-ai-service.
      </p>
    </div>
  </div>
  <div v-else class="app">
    <TopBar />
    <TabNav />
    <main class="app-main">
      <AICamLiveView v-show="store.activeTab === 'demo'" />
      <DashboardView v-show="store.activeTab === 'dashboard'" />
      <ConfigurationView v-show="store.activeTab === 'config'" />
   
    </main>
    <ChatbotWidget v-show="store.activeTab === 'demo'" />
  </div>
</template>

<style scoped>
.no-org {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.no-org-panel {
  max-width: 480px;
  padding: 32px;
  text-align: center;
}
.no-org-panel h2 {
  margin: 0 0 12px;
}
.no-org-zh {
  opacity: 0.8;
}
.no-org-actions {
  margin-top: 20px;
}
.no-org-actions .btn {
  width: 100%;
  padding: 12px;
  font-size: 15px;
}
.no-org-hint {
  margin-top: 16px;
  font-size: 12px;
  opacity: 0.65;
}
</style>
