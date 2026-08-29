// 主界面入口：挂载 Vue 应用（Vuetify + UnoCSS）
import { createApp } from 'vue';
import './uno-entry';
import './plugins/vuetify';
import './styles/global.css';
import { vuetify } from './plugins/vuetify';
import App from './App.vue';

createApp(App).use(vuetify).mount('#app');
