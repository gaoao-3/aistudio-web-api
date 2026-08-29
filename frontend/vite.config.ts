import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import vuetify from 'vite-plugin-vuetify';

// 构建产物直接输出到 Fastify 挂载的 static/ 目录（MPA 双入口）：
//   static/index.html — 主界面（/ 重定向至此）
//   static/login.html — 登录页（/login 重定向至此）
// static/ 只存放前端构建产物，构建时清理旧 hash 文件，避免历史资源持续累积。
export default defineConfig({
  // Fastify 把 static/ 挂载在 /static/ 前缀下，资源 URL 必须带此前缀
  base: '/static/',
  plugins: [vue(), UnoCSS(), vuetify({ autoImport: true })],
  build: {
    outDir: resolve(__dirname, '../static'),
    emptyOutDir: true,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
      },
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\', '/');
          if (normalized.includes('/node_modules/echarts/')) return 'echarts-vendor';
          if (normalized.includes('/node_modules/zrender/')) return 'zrender-vendor';
          if (normalized.includes('/node_modules/vuetify/')) return 'vuetify-vendor';
          return undefined;
        },
      },
    },
  },
});
