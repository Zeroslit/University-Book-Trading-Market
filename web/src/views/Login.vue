<template>
  <div class="auth-wrap">
    <div class="card auth-card">
      <h2 style="margin:0 0 4px">校园教材循环</h2>
      <p class="muted small" style="margin:0 0 12px">登录后直接进入你所在学校的图书库与论坛</p>

      <label>手机号</label>
      <input v-model.trim="form.phone" maxlength="11" placeholder="11 位手机号" autocomplete="username" />
      <label>密码</label>
      <input v-model="form.password" type="password" placeholder="至少 8 位" autocomplete="current-password" @keyup.enter="submit" />

      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>

      <button class="btn btn-primary btn-block mt12" :disabled="loading" @click="submit">
        {{ loading ? '登录中…' : '登录' }}
      </button>
      <button class="btn btn-block mt8" :disabled="loading" @click="wechatLogin">微信一键登录（模拟）</button>

      <div class="row-between mt12 small">
        <RouterLink to="/register">注册新账号</RouterLink>
        <span class="muted">忘记密码请联系人工客服</span>
      </div>

      <div class="notice notice-info mt16 small">
        <div class="bold">种子账号（统一密码 Test@123456）</div>
        <div>学生：13800000001 / 13800000002 / 13800000003（三所高校各 3 名）</div>
        <div>校管：13900000001 · 客服：13900000002 · 平台管理员：13900000003</div>
        <div>开发环境短信验证码固定为 123456</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';
import { setTokens } from '../api/client.js';
import { toastError } from '../utils/toast.js';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const form = reactive({ phone: '13800000001', password: 'Test@123456' });
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  if (!/^1[3-9]\d{9}$/.test(form.phone)) { error.value = '手机号格式不正确'; return; }
  if (form.password.length < 8) { error.value = '密码至少 8 位'; return; }
  loading.value = true;
  try {
    await auth.login({ phone: form.phone, password: form.password });
    router.push(route.query.redirect || '/');
  } catch (err) {
    error.value = err?.details?.until
      ? `${err.message}（可前往「处罚申诉」提交申诉）`
      : (err?.message || '登录失败');
  } finally {
    loading.value = false;
  }
}

async function wechatLogin() {
  loading.value = true;
  try {
    const data = await authApi.loginWechat({ code: 'demo-code' });
    setTokens(data);
    await auth.load(true);
    router.push('/');
  } catch (err) {
    toastError(err?.message || '微信登录失败（一期为模拟实现，需先绑定微信）');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-wrap { display: flex; justify-content: center; padding: 40px 16px; }
.auth-card { width: min(100%, 420px); }
</style>
