// 应用入口：Pinia + 路由 + 全局样式 + 全局错误提示
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index.js';
import { showToast } from './utils/toast.js';
import './styles/main.css';

const app = createApp(App);

// 组件内未捕获异常：控制台记录 + 顶部提示，避免用户只看到空白页
app.config.errorHandler = (err, instance, info) => {
  console.error('[Vue error]', info, err);
  showToast(err?.message || '页面发生错误，请刷新重试', 'error');
};

// 接口异常等未处理的 Promise 拒绝：同样给出可见提示（相同文案做去重）
let lastMessage = '';
let lastAt = 0;
window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || '请求失败，请稍后重试';
  const now = Date.now();
  if (message === lastMessage && now - lastAt < 3000) return;
  lastMessage = message;
  lastAt = now;
  console.error('[unhandledrejection]', event.reason);
  showToast(message, 'error');
});

app.use(createPinia());
app.use(router);
app.mount('#app');
