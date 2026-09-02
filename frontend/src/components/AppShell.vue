<script setup lang="ts">
// 应用壳：左侧 rail 导航 + 顶栏 + 视图切换
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';
const ChatView = defineAsyncComponent(() => import('../views/ChatView.vue'));
const HistoryView = defineAsyncComponent(() => import('../views/HistoryView.vue'));
const AccountsView = defineAsyncComponent(() => import('../views/AccountsView.vue'));
const KeysView = defineAsyncComponent(() => import('../views/KeysView.vue'));
const DashboardView = defineAsyncComponent(() => import('../views/DashboardView.vue'));
const SettingsView = defineAsyncComponent(() => import('../views/SettingsView.vue'));
import { useView, VIEW_TITLES, type ViewKey } from '../composables/useView';
import { useAuth } from '../composables/useAuth';
import { useAccounts } from '../composables/useAccounts';
import { useModels } from '../composables/useModels';
import { useStats } from '../composables/useStats';
import { model } from '../composables/useCache';

const { view, go, runSettingsOpen } = useView();
const { checkAuth, logout } = useAuth();
const { activeAccount, loadAccounts, loadRotation } = useAccounts();
const { loadModels } = useModels();
const { loadStats } = useStats();

const navOpen = ref(false);

let modelRefreshTimer: ReturnType<typeof setInterval> | undefined;

onBeforeUnmount(() => {
  if (modelRefreshTimer !== undefined) clearInterval(modelRefreshTimer);
});

const NAV: { key: ViewKey; label: string; icon: string }[] = [
  { key: 'chat', label: '对话', icon: 'chat' },
  { key: 'history', label: '历史', icon: 'history' },
  { key: 'accounts', label: '账号', icon: 'users' },
  { key: 'keys', label: '密钥', icon: 'key' },
  { key: 'dashboard', label: '统计', icon: 'chart' },
  { key: 'settings', label: '设置', icon: 'cog' },
];

function nav(v: ViewKey): void {
  go(v);
  navOpen.value = false;
}

onMounted(async () => {
  await checkAuth();
  loadModels();
  modelRefreshTimer = setInterval(() => { void loadModels(); }, 15 * 60 * 1000);
  loadStats();
  loadAccounts();
  loadRotation();
});
</script>

<template>
  <div class="shell">
    <div v-if="navOpen" class="fixed inset-0 z-[80] bg-black/20 backdrop-blur-[2px]" @click="navOpen = false"></div>
    <nav class="rail" :class="{ open: navOpen }">
      <div class="rail-logo" title="aistudi-web-api"><Icon name="sparkle" :size="26" /></div>
      <button
        v-for="n in NAV" :key="n.key"
        class="rail-item" :class="{ active: view === n.key }"
        @click="nav(n.key)"
      >
        <Icon :name="n.icon" /><span>{{ n.label }}</span>
      </button>
      <div class="rail-spacer"></div>
      <button class="rail-item" title="退出登录" @click="logout()">
        <Icon name="logout" /><span>退出</span>
      </button>
    </nav>

    <div class="main">
      <header class="topbar">
        <button class="icon-btn nav-toggle" title="菜单" @click="navOpen = true">
          <Icon name="menu" />
        </button>
        <h1>{{ VIEW_TITLES[view] }}</h1>
        <button v-if="view === 'chat' && model" class="model-topbar-chip" title="运行设置" @click="runSettingsOpen = true">
          <span class="mtc-label">{{ model }}</span>
          <Icon name="chevronDown" :size="14" />
        </button>
        <div class="spacer"></div>
        <button v-if="view === 'chat'" class="icon-btn settings-toggle" title="运行设置" @click="runSettingsOpen = true">
          <Icon name="tune" />
        </button>
        <ThemeSwitcher />
        <v-menu location="bottom end">
          <template #activator="{ props }">
            <button class="account-chip" v-bind="props">
              <span class="dot" :class="{ off: !activeAccount.id }"></span>
              <span class="chip-label">{{ activeAccount.id ? (activeAccount.email || activeAccount.name || activeAccount.id) : '未登录账号' }}</span>
            </button>
          </template>
          <v-card rounded="xl" min-width="160">
            <v-card-text class="pa-2">
              <button class="acct-menu-item" @click="logout()">
                <Icon name="logout" :size="16" />退出登录
              </button>
            </v-card-text>
          </v-card>
        </v-menu>
      </header>

      <ChatView v-if="view === 'chat'" />
      <div v-else class="content">
        <HistoryView v-if="view === 'history'" />
        <AccountsView v-else-if="view === 'accounts'" />
        <KeysView v-else-if="view === 'keys'" />
        <DashboardView v-else-if="view === 'dashboard'" />
        <SettingsView v-else-if="view === 'settings'" />
      </div>

      <!-- 移动端底部导航（Material 3 Navigation Bar，桌面端隐藏） -->
      <nav class="bottom-nav">
        <button
          v-for="n in NAV" :key="n.key"
          class="bn-item" :class="{ active: view === n.key }"
          @click="go(n.key)"
        >
          <span class="bn-icon"><Icon :name="n.icon" :size="20" /></span>
          <span class="bn-label">{{ n.label }}</span>
        </button>
      </nav>
    </div>
  </div>
</template>
