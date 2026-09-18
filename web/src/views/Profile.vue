<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <h3 style="margin:0">{{ profile?.nickname || auth.user?.nickname }}</h3>
          <div class="small muted">
            学号 {{ profile?.studentNoMask }} · 手机 {{ profile?.phoneMask }} · 角色 {{ roleLabel }}
          </div>
          <div class="chips mt8">
            <StatusTag :map="VERIFICATION_STATUS" :value="profile?.verification_status" />
            <span class="chip">信誉分 {{ profile?.credit_score }}</span>
            <span class="chip">{{ auth.schoolName }}</span>
          </div>
        </div>
        <div class="chips">
          <RouterLink class="btn btn-sm" to="/verification">学生认证</RouterLink>
          <RouterLink class="btn btn-sm" to="/payment-accounts">收款绑定</RouterLink>
          <RouterLink class="btn btn-sm" to="/credit">信誉分</RouterLink>
          <button class="btn btn-sm" @click="logout">退出登录</button>
        </div>
      </div>

      <p v-if="banNotice" class="notice notice-error mt12">{{ banNotice }}</p>
    </div>

    <div class="card">
      <div class="bold">编辑资料</div>
      <label>昵称</label>
      <input v-model.trim="form.nickname" maxlength="30" />
      <label>头像</label>
      <ImageUploader v-model="avatarList" :max="1" :camera="false" />
      <label>个人简介（会经过违禁词检测，L1 词会打码）</label>
      <textarea v-model.trim="form.bio" maxlength="200" />
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <button class="btn btn-primary mt12" :disabled="saving" @click="save">保存</button>
    </div>

    <div class="card">
      <div class="bold">快捷入口</div>
      <div class="chips mt8">
        <RouterLink class="chip" to="/orders">我的订单</RouterLink>
        <RouterLink class="chip" to="/wallet">我的钱包</RouterLink>
        <RouterLink class="chip" to="/messages">私信</RouterLink>
        <RouterLink class="chip" to="/notifications">消息通知</RouterLink>
        <RouterLink class="chip" to="/reports">举报与投诉</RouterLink>
        <RouterLink class="chip" to="/appeals">处罚申诉</RouterLink>
        <RouterLink class="chip" to="/support">客服中心</RouterLink>
        <RouterLink v-if="auth.isModerator" class="chip" to="/admin/dashboard">管理后台</RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { userApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { VERIFICATION_STATUS } from '../utils/format.js';
import { toastOk } from '../utils/toast.js';
import ImageUploader from '../components/ImageUploader.vue';
import StatusTag from '../components/StatusTag.vue';

const auth = useAuthStore();
const router = useRouter();
const profile = ref(null);
const avatarList = ref([]);
const saving = ref(false);
const error = ref('');
const form = reactive({ nickname: '', bio: '' });

const ROLE_LABEL = { student: '学生', school_admin: '学校管理员', support: '人工客服', platform_admin: '平台管理员' };
const roleLabel = computed(() => ROLE_LABEL[profile.value?.role] || profile.value?.role);

const banNotice = computed(() => {
  const user = profile.value;
  if (!user) return '';
  const parts = [];
  if (user.banned_permanently) parts.push('账号已被永久封禁');
  if (user.mute_until) parts.push(`禁言至 ${new Date(user.mute_until).toLocaleString('zh-CN')}`);
  if (user.trade_ban_until) parts.push(`限制交易至 ${new Date(user.trade_ban_until).toLocaleString('zh-CN')}`);
  if (user.login_ban_until) parts.push(`禁止登录至 ${new Date(user.login_ban_until).toLocaleString('zh-CN')}`);
  if (parts.length === 0) return '';
  return `${parts.join('；')}。封禁期间进行中的订单仍可正常完成或退款。可在「处罚申诉」提交申诉。`;
});

async function load() {
  profile.value = await userApi.profile();
  form.nickname = profile.value.nickname;
  form.bio = profile.value.bio || '';
  avatarList.value = profile.value.avatar_url ? [profile.value.avatar_url] : [];
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    await userApi.updateProfile({
      nickname: form.nickname || undefined,
      avatarUrl: avatarList.value[0] || undefined,
      bio: form.bio,
    });
    toastOk('资料已更新');
    await auth.load(true);
    await load();
  } catch (err) {
    error.value = err?.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await auth.logout();
  router.push('/login');
}

watch(avatarList, () => { /* 由保存按钮统一提交 */ });
onMounted(load);
</script>
