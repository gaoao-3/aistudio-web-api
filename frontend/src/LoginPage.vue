<script setup lang="ts">
// 登录页（原 login.ts 移植）
import { onMounted, ref } from 'vue';
import { applyPresetToCssVars } from './composables/useTheme';
import Icon from './components/Icon.vue';
import ToastHost from './components/ToastHost.vue';

const token = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin(): Promise<void> {
  const t = token.value.trim();
  if (!t) return;

  error.value = '';
  loading.value = true;

  try {
    const res = await fetch('/auth/verify', {
      headers: { Authorization: `Bearer ${t}` },
    });

    if (res.ok) {
      localStorage.setItem('asp_api_token', t);
      window.location.href = '/';
    } else if (res.status === 401) {
      error.value = 'Token 无效，请检查后重试';
    } else {
      error.value = `验证失败 (${res.status})，请稍后重试`;
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  applyPresetToCssVars();
  const savedToken = localStorage.getItem('asp_api_token');
  if (savedToken) {
    token.value = savedToken;
    handleLogin();
  }
});
</script>

<template>
  <v-app class="h-full">
    <div class="h-full flex items-center justify-center overflow-y-auto">
      <div class="w-full max-w-[400px] bg-surface border border-border-soft rounded-[16px] px-10 py-11 animate-[fade-up_.3s_ease]">
        <div class="flex items-center gap-2 mb-7">
          <span class="text-primary"><Icon name="sparkle" :size="32" /></span>
          <span class="text-[15px] text-text-2">aistudi-web-api</span>
        </div>
        <h1 class="text-[24px] font-[650] text-text mb-2">欢迎回来</h1>
        <p class="text-muted text-[14px] mb-8">输入服务 Token，继续使用你的 AI Studio 工作台</p>

        <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>

        <form @submit.prevent="handleLogin()">
          <div class="mb-6">
            <div class="field-label"><span>服务 Token</span></div>
            <v-text-field
              v-model="token" type="password"
              placeholder="粘贴 API Token" autofocus autocomplete="current-password"
            />
          </div>
          <v-btn
            color="primary" type="submit" block size="large"
            :loading="loading" :disabled="!token.trim()"
          >
            {{ loading ? '验证中…' : '登录' }}
          </v-btn>
        </form>

        <p class="text-center mt-6 text-[12px] text-muted">Token 由服务端配置，仅保存在当前浏览器</p>
      </div>
    </div>
    <ToastHost />
  </v-app>
</template>
