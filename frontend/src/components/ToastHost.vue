<script setup lang="ts">
// 全局 toast 宿主：渲染 useToast 队列（挂在 App / LoginPage 根部）
import { useToast } from '../composables/useToast';

const { toasts } = useToast();
</script>

<template>
  <v-snackbar
    v-for="t in toasts" :key="t.id"
    v-model="t.show"
    :color="t.color === 'info' ? 'surface' : t.color"
    :class="{ 'toast-info': t.color === 'info' }"
    location="top center"
    :timeout="-1"
    rounded="lg"
    class="toast-item"
  >
    {{ t.text }}
  </v-snackbar>
</template>

<style>
/* 非 scoped：v-snackbar 渲染在 body 下 */
.toast-item { margin-top: 12px; }
.toast-info .v-snackbar__content { color: var(--text); }
</style>
