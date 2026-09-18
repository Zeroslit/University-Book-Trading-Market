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

      <div v-if="isDemo" class="card mt16" style="text-align:left">
        <div class="bold">演示环境 · 一键切换角色</div>
        <p class="small muted" style="margin:6px 0">
          这是纯静态演示版：界面与真实平台一致，但数据只保存在你的浏览器本地，支付、短信、微信授权均为模拟实现，
          请勿填写真实银行卡号或密码。可在任意页面顶部「重置演示数据」恢复初始状态。
        </p>
        <div class="chips">
          <button
            v-for="account in demoAccounts"
            :key="account.phone"
            class="chip"
            :disabled="loading"
            @click="quickLogin(account)"
          >{{ account.label }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';
import { setTokens, IS_DEMO } from '../api/client.js';
import { toastError } from '../utils/toast.js';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const form = reactive({ phone: '13800000001', password: 'Test@123456' });
const loading = ref(false);
const error = ref('');
const isDemo = IS_DEMO;

// 演示环境快捷登录：与种子数据一一对应，点击即进入对应角色的学校视图
const demoAccounts = [
  { label: '林晓 · 江南大学（已认证，卖家）', phone: '13800000001' },
  { label: '陈默 · 江南大学（有托管中订单）', phone: '13800000002' },
  { label: '王雨 · 江南大学（认证待审核）', phone: '13800000003' },
  { label: '孙晴 · 郑州轻工业大学（信誉 90）', phone: '13800000005' },
  { label: '郑一 · 成都理工大学（信誉 72）', phone: '13800000008' },
  { label: '江南大学校园大使（校管）', phone: '13900000001' },
  { label: '人工客服小助手（客服）', phone: '13900000002' },
  { label: '平台运营（平台管理员）', phone: '13900000003' },
];

async function quickLogin(account) {
  form.phone = account.phone;
  form.password = 'Test@123456';
  await submit();
}

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

// 演示环境支持分享链接直接进入某个角色：/login?demo=13800000001
onMounted(async () => {
  const phone = String(route.query.demo || '');
  if (!isDemo || !/^1[3-9]\d{9}$/.test(phone)) return;
  const account = demoAccounts.find((a) => a.phone === phone) || { phone, label: phone };
  await quickLogin(account);
});

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
.auth-card { width: min(100%, 460px); }
</style>
