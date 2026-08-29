<script setup lang="ts">
// 主题切换器：顶栏色板按钮 + 色点/明暗模式弹层
import Icon from './Icon.vue';
import { THEME_PRESETS, useTheme } from '../composables/useTheme';

const { themeKey, modeKey, setTheme, setMode } = useTheme();
</script>

<template>
  <v-menu location="bottom end" :close-on-content-click="false">
    <template #activator="{ props }">
      <button class="icon-btn" title="主题" v-bind="props">
        <Icon name="palette" />
      </button>
    </template>
    <v-card class="pa-3" rounded="xl">
      <div class="flex items-center gap-2">
        <button
          v-for="p in THEME_PRESETS" :key="p.key"
          class="theme-dot" :class="{ active: themeKey === p.key }"
          :style="{ background: p.primary }"
          :title="p.label"
          @click="setTheme(p.key)"
        ></button>
      </div>
      <div class="mode-row">
        <button
          class="mode-btn" :class="{ active: modeKey === 'light' }"
          @click="setMode('light')"
        ><Icon name="sun" :size="15" />浅色</button>
        <button
          class="mode-btn" :class="{ active: modeKey === 'dark' }"
          @click="setMode('dark')"
        ><Icon name="moon" :size="15" />深色</button>
        <button
          class="mode-btn" :class="{ active: modeKey === 'system' }"
          @click="setMode('system')"
        ><Icon name="devices" :size="15" />跟随系统</button>
      </div>
    </v-card>
  </v-menu>
</template>

<style scoped>
.theme-dot {
  width: 22px; height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform .15s, box-shadow .15s;
}
.theme-dot:hover { transform: scale(1.12); }
.theme-dot.active {
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px currentColor;
  border-color: var(--surface);
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.mode-row {
  display: flex; gap: 6px;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px solid var(--border-soft);
}
.mode-btn {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 0;
  border: none; border-radius: 999px;
  background: none; color: var(--muted);
  font-family: inherit; font-size: 12px;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.mode-btn:hover { background: var(--surface-2); color: var(--text); }
.mode-btn.active { background: var(--primary-container); color: var(--primary-bright); }
</style>
