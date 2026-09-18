<template>
  <div class="app-shell">
    <AppNav v-if="showNav" />
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
// 根组件：登录页/注册页不显示导航
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppNav from './components/AppNav.vue';
import ToastHost from './components/ToastHost.vue';

const route = useRoute();
const showNav = computed(() => !route.meta?.public && route.name !== 'not-found');
</script>
