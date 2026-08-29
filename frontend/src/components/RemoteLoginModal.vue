<script setup lang="ts">
// 远程登录分步模态（原 index.html 远程登录模态移植）
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { apiFetch } from '../api/client';
import Icon from './Icon.vue';
import { useAccounts } from '../composables/useAccounts';

const { remoteLogin, submitRemoteInput, closeRemoteLogin, remoteStepIcon } = useAccounts();

function onUpdateShow(show: boolean): void {
  if (!show) closeRemoteLogin();
}

// 邮箱 / 密码字段的文案与输入属性（验证码走独立处理）
const fieldMeta = computed(() => {
  const kind = remoteLogin.value.step?.kind;
  if (kind === 'email') {
    return {
      label: '邮箱地址',
      hint: '输入该 Google 账号的完整邮箱，例如 name@gmail.com。',
      placeholder: 'name@gmail.com',
      inputmode: 'email' as const,
      autocomplete: 'username',
    };
  }
  if (kind === 'password') {
    return {
      label: '密码',
      hint: '输入该账号的登录密码，内容仅用于本次远程登录，不会被保存。',
      placeholder: '输入密码',
      inputmode: 'text' as const,
      autocomplete: 'current-password',
    };
  }
  return null;
});

const stepKind = computed(() => remoteLogin.value.step?.kind ?? '');
const isManualSelection = computed(
  () => stepKind.value === 'manual' && remoteLogin.value.step?.phase === 'selection',
);
const isVisualChallenge = computed(() => remoteLogin.value.step?.phase === 'recaptcha');
const remoteScreen = ref('');
const remoteScreenError = ref('');
const remoteScreenClicking = ref(false);
let remoteScreenTimer: ReturnType<typeof setTimeout> | null = null;

function stopRemoteScreen(): void {
  if (remoteScreenTimer) clearTimeout(remoteScreenTimer);
  remoteScreenTimer = null;
}

async function refreshRemoteScreen(): Promise<void> {
  stopRemoteScreen();
  if (!remoteLogin.value.open || !remoteLogin.value.sessionId || !isVisualChallenge.value) return;
  try {
    const response = await apiFetch(`/accounts/login/screenshot/${remoteLogin.value.sessionId}`);
    const body = await response.json().catch(() => ({})) as { image?: unknown; detail?: unknown };
    if (response.ok && typeof body.image === 'string') {
      remoteScreen.value = body.image;
      remoteScreenError.value = '';
    } else {
      remoteScreenError.value = typeof body.detail === 'string' ? body.detail : '浏览器画面暂不可用';
    }
  } catch {
    remoteScreenError.value = '浏览器画面连接失败';
  } finally {
    if (remoteLogin.value.open && isVisualChallenge.value) {
      remoteScreenTimer = setTimeout(() => { void refreshRemoteScreen(); }, 1200);
    }
  }
}

async function clickRemoteScreen(event: MouseEvent): Promise<void> {
  if (remoteScreenClicking.value || !remoteLogin.value.sessionId) return;
  const image = event.currentTarget as HTMLImageElement;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  remoteScreenClicking.value = true;
  try {
    const response = await apiFetch('/accounts/login/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: remoteLogin.value.sessionId,
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      }),
    });
    if (!response.ok) remoteScreenError.value = '点击未能发送到登录页面';
    setTimeout(() => { void refreshRemoteScreen(); }, 250);
  } catch {
    remoteScreenError.value = '点击发送失败';
  } finally {
    remoteScreenClicking.value = false;
  }
}

watch(
  () => [remoteLogin.value.open, remoteLogin.value.sessionId, remoteLogin.value.step?.phase] as const,
  ([open, _sessionId, phase]) => {
    remoteScreen.value = '';
    remoteScreenError.value = '';
    if (open && phase === 'recaptcha') void refreshRemoteScreen();
    else stopRemoteScreen();
  },
  { immediate: true },
);
onBeforeUnmount(stopRemoteScreen);
</script>

<template>
  <v-dialog
    :model-value="remoteLogin.open" max-width="480" persistent
    @update:model-value="onUpdateShow"
  >
    <v-card rounded="xl" class="rm-modal">
      <v-card-item>
        <v-card-title class="text-[15px]">远程登录 Google 账号</v-card-title>
        <template #append>
          <span class="modal-badge"><Icon name="devices" :size="22" /></span>
        </template>
      </v-card-item>
      <v-card-text>
        <v-alert v-if="remoteLogin.error" type="error" class="rm-alert">{{ remoteLogin.error }}</v-alert>

        <div v-if="!remoteLogin.step && !remoteLogin.error" class="rm-waiting">
          <Icon name="loader" :size="18" class="spin" />
          <span>等待登录页加载…</span>
        </div>

        <div v-if="remoteLogin.step" class="rm-step">
          <div class="rm-prompt">
            <span class="rm-step-icon"><Icon :name="remoteStepIcon(stepKind)" :size="20" /></span>
            <p>{{ remoteLogin.step.prompt }}</p>
          </div>

          <!-- 邮箱 / 密码输入 -->
          <form
            v-if="fieldMeta"
            class="rm-form"
            @submit.prevent="submitRemoteInput(remoteLogin.input)"
          >
            <label class="rm-field">
              <span class="rm-label">{{ fieldMeta.label }}</span>
              <v-text-field
                v-model="remoteLogin.input"
                :type="remoteLogin.step.sensitive ? 'password' : 'text'"
                :placeholder="fieldMeta.placeholder"
                :inputmode="fieldMeta.inputmode"
                :autocomplete="fieldMeta.autocomplete"
                autocapitalize="off"
                spellcheck="false"
                :disabled="remoteLogin.submitting"
                autofocus
              />
              <span class="rm-hint">{{ fieldMeta.hint }}</span>
            </label>
            <div class="rm-actions">
              <v-btn
                color="primary" type="submit"
                :loading="remoteLogin.submitting" :disabled="!remoteLogin.input.trim() || remoteLogin.submitting"
              >继续</v-btn>
            </div>
          </form>

          <!-- 验证码输入（独立的大字号等宽体验） -->
          <form
            v-else-if="stepKind === 'otp'"
            class="rm-otp"
            @submit.prevent="submitRemoteInput(remoteLogin.input)"
          >
            <label class="rm-otp-field">
              <span class="rm-label">验证码</span>
              <v-text-field
                v-model="remoteLogin.input"
                class="rm-otp-input"
                placeholder="••••••"
                maxlength="8"
                inputmode="numeric"
                pattern="[0-9]*"
                autocomplete="one-time-code"
                autocapitalize="off"
                spellcheck="false"
                aria-label="验证码"
                :disabled="remoteLogin.submitting"
                autofocus
              />
              <span class="rm-hint rm-hint-center">
                输入身份验证器或短信收到的 6–8 位数字验证码，无需空格。
              </span>
            </label>
            <div class="rm-otp-actions">
              <v-btn
                color="primary" block type="submit"
                :loading="remoteLogin.submitting" :disabled="!remoteLogin.input.trim() || remoteLogin.submitting"
              >验证</v-btn>
              <v-btn
                variant="text" size="small"
                :loading="remoteLogin.submitting" :disabled="remoteLogin.submitting"
                @click="submitRemoteInput('')"
              >换个方式验证</v-btn>
            </div>
          </form>

          <!-- 选择登录方式 -->
          <div v-else-if="stepKind === 'selection'" class="rm-options">
            <button
              v-for="(opt, i) in remoteLogin.step.options || []" :key="i"
              type="button" class="rm-option" :disabled="remoteLogin.submitting"
              @click="submitRemoteInput(String(i + 1))"
            >
              <span class="rm-option-num">{{ i + 1 }}</span>
              <span class="rm-option-text">{{ opt }}</span>
              <Icon name="chevronRight" :size="16" class="rm-option-chevron" />
            </button>
          </div>

          <!-- Google 可视化人机验证：由用户本人远程操作浏览器画面 -->
          <div v-else-if="isVisualChallenge" class="rm-visual">
            <p class="rm-visual-hint">点击下面的实时浏览器画面，手动完成 Google 人机验证。画面仅在本次登录期间传输，不会保存。</p>
            <v-alert v-if="remoteScreenError" type="warning">{{ remoteScreenError }}</v-alert>
            <div class="rm-screen-wrap">
              <img
                v-if="remoteScreen"
                :src="remoteScreen"
                class="rm-screen"
                alt="远程 Google 登录浏览器画面"
                draggable="false"
                @click="clickRemoteScreen"
              >
              <div v-else class="rm-screen-loading">
                <Icon name="loader" :size="18" class="spin" />
                正在获取浏览器画面…
              </div>
            </div>
            <p class="rm-visual-tip">若点击后页面发生变化，画面会自动刷新。</p>
          </div>

          <!-- 手机确认 -->
          <div v-else-if="stepKind === 'manual'" class="rm-manual">
            <span class="rm-phone-pulse"><Icon name="phone" :size="24" /></span>
            <div class="rm-manual-text">
              <p class="rm-manual-title">{{ isManualSelection ? '需要切换验证方式' : '等待设备确认' }}</p>
              <p class="rm-manual-hint">
                {{ isManualSelection
                  ? '当前 Google 页面没有返回可操作的验证选项，请切换到其他验证方式。'
                  : '请在手机或安全设备上完成确认，完成后会自动继续。' }}
              </p>
            </div>
            <span v-if="!isManualSelection" class="rm-status">
              <Icon name="loader" :size="14" class="spin" />
              正在等待确认结果…
            </span>
            <v-btn
              variant="text" size="small"
              :loading="remoteLogin.submitting" :disabled="remoteLogin.submitting"
              @click="submitRemoteInput('')"
            >换个登录方式</v-btn>
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <div class="rm-footer w-full">
          <v-btn variant="text" size="small" @click="closeRemoteLogin()">取消</v-btn>
        </div>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.rm-visual { display: grid; gap: 12px; }
.rm-visual-hint, .rm-visual-tip { margin: 0; color: var(--muted); line-height: 1.6; }
.rm-visual-tip { font-size: 12px; text-align: center; }
.rm-screen-wrap { overflow: hidden; min-height: 180px; border: 1px solid rgba(128, 128, 128, .25); border-radius: 12px; background: #111; }
.rm-screen { display: block; width: 100%; height: auto; cursor: crosshair; touch-action: manipulation; user-select: none; }
.rm-screen-loading { min-height: 180px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #ddd; }
</style>
