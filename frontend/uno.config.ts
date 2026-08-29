import { defineConfig, presetWind3 } from 'unocss';

// 主题色与 styles/global.css 的 CSS 变量保持一致（运行时跟随色板/明暗切换）。
// 注意：这些工具类（text-primary 等）也会命中 Vuetify 组件内部的同名 class，
// 必须用 var() 引用，不能写死颜色值，否则 Vuetify 组件颜色会错乱。
export default defineConfig({
  presets: [presetWind3()],
  theme: {
    colors: {
      bg: 'var(--bg)',
      surface: 'var(--surface)',
      'surface-2': 'var(--surface-2)',
      'surface-3': 'var(--surface-3)',
      border: 'var(--border)',
      'border-soft': 'var(--border-soft)',
      text: 'var(--text)',
      'text-2': 'var(--text-2)',
      muted: 'var(--muted)',
      primary: 'var(--primary)',
      'primary-bright': 'var(--primary-bright)',
      'accent-1': 'var(--accent-1)',
      'accent-2': 'var(--accent-2)',
      'accent-3': 'var(--accent-3)',
      danger: 'var(--danger)',
      ok: 'var(--ok)',
      warn: 'var(--warn)',
    },
  },
});
