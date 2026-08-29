// ---------- 主题系统（色板 + 明暗模式，localStorage 持久化） ----------
import { computed, watch } from 'vue';
import { useLocalStorage, usePreferredDark } from '@vueuse/core';
import { vuetify } from '../plugins/vuetify';

export interface ThemePreset {
  key: string;
  label: string;
  /** 浅色模式主色 */
  primary: string;
  /** 深色变体（hover / 强调文字） */
  primaryBright: string;
  /** 浅底色（active 背景、徽标） */
  primaryContainer: string;
  /** 深色模式主色（MD3 浅色调，深底上可读） */
  darkPrimary: string;
  /** 品牌强调三色 */
  accents: [string, string, string];
}

export const THEME_PRESETS: ThemePreset[] = [
  { key: 'google-blue', label: 'Google 蓝', primary: '#0b57d0', primaryBright: '#0842a0', primaryContainer: 'rgba(11,87,208,0.10)', darkPrimary: '#a8c7fa', accents: ['#0b57d0', '#6b93d6', '#a8c7fa'] },
  { key: 'ink', label: '墨黑', primary: '#18181b', primaryBright: '#000000', primaryContainer: 'rgba(24,24,27,0.06)', darkPrimary: '#e4e4e7', accents: ['#18181b', '#52525b', '#a1a1aa'] },
  { key: 'violet', label: '薰衣草紫', primary: '#6c5bd4', primaryBright: '#5748bf', primaryContainer: 'rgba(117,100,223,0.10)', darkPrimary: '#c9bfff', accents: ['#7564df', '#9b89ed', '#ffb096'] },
  { key: 'blue', label: '宝石蓝', primary: '#3b82f6', primaryBright: '#2563eb', primaryContainer: 'rgba(59,130,246,0.10)', darkPrimary: '#93c5fd', accents: ['#3b82f6', '#60a5fa', '#93c5fd'] },
  { key: 'cyan', label: '青瓷', primary: '#0891b2', primaryBright: '#0e7490', primaryContainer: 'rgba(8,145,178,0.10)', darkPrimary: '#67e8f9', accents: ['#0891b2', '#22d3ee', '#7dd3fc'] },
  { key: 'green', label: '竹绿', primary: '#059669', primaryBright: '#047857', primaryContainer: 'rgba(5,150,105,0.10)', darkPrimary: '#6ee7b7', accents: ['#059669', '#34d399', '#6ee7b7'] },
  { key: 'orange', label: '暖橙', primary: '#e0692f', primaryBright: '#c2551f', primaryContainer: 'rgba(224,105,47,0.10)', darkPrimary: '#fdba74', accents: ['#e0692f', '#f59e0b', '#fbbf24'] },
  { key: 'pink', label: '桃粉', primary: '#d6336c', primaryBright: '#be2560', primaryContainer: 'rgba(214,51,108,0.10)', darkPrimary: '#f9a8d4', accents: ['#d6336c', '#f472b6', '#f9a8d4'] },
  { key: 'graphite', label: '石墨', primary: '#52525b', primaryBright: '#3f3f46', primaryContainer: 'rgba(82,82,91,0.10)', darkPrimary: '#d4d4d8', accents: ['#52525b', '#71717a', '#a1a1aa'] },
];

export type ThemeMode = 'light' | 'dark' | 'system';

const themeKey = useLocalStorage('asp_theme_color', 'google-blue');
const modeKey = useLocalStorage<ThemeMode>('asp_theme_mode', 'light');
const preferredDark = usePreferredDark();

export const currentPreset = computed<ThemePreset>(() =>
  THEME_PRESETS.find(p => p.key === themeKey.value) || THEME_PRESETS[0],
);

export const currentMode = computed<ThemeMode>(() => modeKey.value);

/** 「跟随系统」解析后的实际明暗 */
export const effectiveMode = computed<'light' | 'dark'>(() =>
  modeKey.value === 'system' ? (preferredDark.value ? 'dark' : 'light') : modeKey.value,
);

// 系统明暗变化时实时跟随
watch(preferredDark, () => {
  if (modeKey.value === 'system') applyPresetToCssVars();
});

/** 把当前色板 + 明暗模式写入 CSS 变量和 Vuetify 主题（global.css 默认值作首屏兜底） */
export function applyPresetToCssVars(): void {
  const p = currentPreset.value;
  const mode = effectiveMode.value;
  const dark = mode === 'dark';
  const root = document.documentElement.style;
  const primary = dark ? p.darkPrimary : p.primary;
  root.setProperty('--primary', primary);
  root.setProperty('--primary-bright', dark ? p.darkPrimary : p.primaryBright);
  // 深色模式下 primary-container 用略强的底色，保证选中态可读
  root.setProperty('--primary-container', dark ? 'rgba(255,255,255,0.10)' : p.primaryContainer);
  root.setProperty('--on-primary', dark ? '#1a1a1c' : '#ffffff');
  root.setProperty('--accent-1', p.accents[0]);
  root.setProperty('--accent-2', p.accents[1]);
  root.setProperty('--accent-3', p.accents[2]);
  root.setProperty('--grad-brand', `linear-gradient(135deg, ${primary} 0%, ${primary} 100%)`);
  root.setProperty('--bg-grad', 'none');
  document.documentElement.dataset.theme = mode;
  // Vuetify 组件（按钮/开关等）跟随色板与明暗
  vuetify.theme.global.name.value = mode;
  vuetify.theme.themes.value.light.colors.primary = p.primary;
  vuetify.theme.themes.value.dark.colors.primary = p.darkPrimary;
}

export function useTheme() {
  function setTheme(key: string): void {
    themeKey.value = key;
    applyPresetToCssVars();
  }
  function setMode(mode: ThemeMode): void {
    modeKey.value = mode;
    applyPresetToCssVars();
  }
  function toggleMode(): void {
    setMode(effectiveMode.value === 'dark' ? 'light' : 'dark');
  }
  return { themeKey, modeKey, currentPreset, currentMode, effectiveMode, setTheme, setMode, toggleMode, applyPresetToCssVars };
}
