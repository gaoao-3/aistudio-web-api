// 登录页入口
import { createApp } from 'vue';
import './uno-entry';
import './plugins/vuetify';
import './styles/global.css';
import { vuetify } from './plugins/vuetify';
import LoginPage from './LoginPage.vue';

createApp(LoginPage).use(vuetify).mount('#app');
