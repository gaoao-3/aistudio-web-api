// Vuetify 初始化：Material 3 主题（浅色 + 深色），对齐全局 CSS 变量的色板。
// 图标用 @mdi/js 按需注册的 SVG iconset（只打包用到的路径，不引整套 MDI 字体）。
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { h } from 'vue';
import { createVuetify, type IconProps, type IconSet } from 'vuetify';
import { VSvgIcon } from 'vuetify/components';
import {
  mdiAlertCircleOutline,
  mdiCheck,
  mdiCheckCircle,
  mdiChevronDown,
  mdiChevronLeft,
  mdiChevronRight,
  mdiChevronUp,
  mdiClose,
  mdiCloseCircle,
  mdiEye,
  mdiEyeOff,
  mdiInformation,
  mdiLoading,
  mdiMenuDown,
  mdiMinus,
  mdiPlus,
} from '@mdi/js';

// Vuetify 内置别名 → MDI SVG path（仅覆盖本项目组件用到的）
const aliases = {
  complete: mdiCheck,
  cancel: mdiCloseCircle,
  close: mdiClose,
  delete: mdiCloseCircle,
  clear: mdiCloseCircle,
  success: mdiCheckCircle,
  info: mdiInformation,
  warning: mdiAlertCircleOutline,
  error: mdiCloseCircle,
  prev: mdiChevronLeft,
  next: mdiChevronRight,
  expand: mdiChevronDown,
  collapse: mdiChevronUp,
  menuDown: mdiMenuDown,
  dropdown: mdiMenuDown,
  show: mdiEye,
  showOff: mdiEyeOff,
  loading: mdiLoading,
  plus: mdiPlus,
  minus: mdiMinus,
};

const svgIconSet: IconSet = {
  // VSvgIcon 的 prop 类型与 h() 重载不完全兼容，这里按运行时行为断言
  component: (props: IconProps) => h(VSvgIcon as never, { icon: props.icon }),
};

export const vuetify = createVuetify({
  icons: {
    defaultSet: 'custom',
    aliases,
    sets: { custom: svgIconSet },
  },
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        dark: false,
        colors: {
          primary: '#0b57d0',
          background: '#fafafa',
          surface: '#ffffff',
          'surface-variant': '#f4f4f5',
          'on-surface': '#18181b',
          // Vuetify 的 bg-surface-variant 工具类会把文字色设为 on-surface-variant，必须配对成可读色
          'on-surface-variant': '#52525b',
          error: '#dc2626',
          success: '#16a34a',
          warning: '#b45309',
          info: '#52525b',
        },
      },
      // Material 3 深色：深灰底 + 浅色调 primary（运行时由 useTheme 覆盖为色板色）
      dark: {
        dark: true,
        colors: {
          primary: '#a8c7fa',
          background: '#131315',
          surface: '#1b1c1e',
          'surface-variant': '#26272a',
          'on-surface': '#e4e2e6',
          'on-surface-variant': '#c4c6cc',
          error: '#f2b8b5',
          success: '#7fc99a',
          warning: '#e0b270',
          info: '#c4c6cc',
        },
      },
    },
  },
  defaults: {
    VCard: { variant: 'outlined', flat: true, rounded: 'xl' },
    VBtn: { variant: 'flat', rounded: 'pill' },
    VAlert: { variant: 'tonal', density: 'compact', rounded: 'lg' },
    VTextField: { variant: 'solo-filled', density: 'comfortable', hideDetails: 'auto', flat: true, rounded: 'lg', bgColor: 'surface-variant' },
    VTextarea: { variant: 'solo-filled', flat: true, rounded: 'lg', bgColor: 'surface-variant' },
    VSelect: { variant: 'solo-filled', density: 'comfortable', hideDetails: 'auto', flat: true, rounded: 'lg', bgColor: 'surface-variant' },
    VSwitch: { color: 'primary', hideDetails: true, density: 'compact' },
    VSlider: { color: 'primary', hideDetails: true },
  },
});
