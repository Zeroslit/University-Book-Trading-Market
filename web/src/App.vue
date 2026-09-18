<template>
  <div class="app-shell">
    <AppNav v-if="showNav" />
    <div v-if="isDemo && showNav" class="demo-bar">
      <div class="demo-bar-inner">
        <span>🧪 演示环境：数据保存在你的浏览器本地（可随时重置），支付 / 短信 / 微信授权均为模拟实现，请勿填写真实银行卡号或密码。</span>
        <span class="row" style="gap:8px">
          <button class="btn btn-sm" @click="resetDemo">重置演示数据</button>
        </span>
      </div>
    </div>
    <main class="app-main">
      <RouterView />
    </main>
    <footer class="app-footer">
      高校教材循环平台 · 一期演示环境（短信验证码、支付与微信授权均为模拟实现，请勿填写真实银行卡信息或密码）
    </footer>
    <ToastHost />
  </div>
</template>

<script setup>
// 根组件：登录页/注册页不显示导航；演示模式额外显示说明条与「重置演示数据」
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppNav from './components/AppNav.vue';
import ToastHost from './components/ToastHost.vue';
import { IS_DEMO, clearTokens } from './api/client.js';
import { showToast } from './utils/toast.js';

const route = useRoute();
const router = useRouter();
const showNav = computed(() => !route.meta?.public && route.name !== 'not-found');
const isDemo = IS_DEMO;

async function resetDemo() {
  const confirmed = window.confirm('重置演示数据会清空你刚才的操作（发布的教材、订单、消息等），确定继续吗？');
  if (!confirmed) return;
  const { resetDemoData } = await import('./demo/store.js');
  resetDemoData();
  clearTokens();
  showToast('演示数据已重置，请重新登录', 'success');
  router.push('/login');
}
</script>

<style scoped>
.demo-bar { background: #fff8e6; border-bottom: 1px solid #f0d9a0; color: #7a5b13; }
.demo-bar-inner {
  max-width: 1120px; margin: 0 auto; padding: 8px 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  font-size: 13px; line-height: 1.5;
}
</style>
