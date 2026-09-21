<template>
  <header class="nav">
    <div class="nav-inner">
      <RouterLink class="nav-brand" to="/">{{ $t('📚 校园教材循环') }}</RouterLink>
      <nav class="nav-links">
        <RouterLink class="nav-link" to="/">{{ $t('本校首页') }}</RouterLink>
        <RouterLink class="nav-link" to="/books">{{ $t('图书库') }}</RouterLink>
        <RouterLink class="nav-link" to="/threads">{{ $t('论坛') }}</RouterLink>
        <RouterLink class="nav-link" to="/orders">{{ $t('订单') }}</RouterLink>
        <RouterLink class="nav-link" to="/messages">{{ $t('私信') }}</RouterLink>
        <RouterLink class="nav-link" to="/wallet">{{ $t('钱包') }}</RouterLink>
        <RouterLink class="nav-link" to="/support">{{ $t('客服') }}</RouterLink>
        <RouterLink v-if="auth.isModerator" class="nav-link" to="/admin/dashboard">{{ $t('管理后台') }}</RouterLink>
      </nav>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <select
          v-if="auth.needSchoolPicker"
          class="btn btn-sm"
          style="width:auto"
          :value="school.currentId || ''"
          @change="onSchoolChange($event.target.value)"
        >
          <option value="">{{ $t('选择要管理的学校（必选）') }}</option>
          <option v-for="s in school.options" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <span v-else class="tag tag-info">{{ auth.schoolName }}</span>
        <RouterLink class="nav-link" to="/notifications">{{ $t('消息') }}<span v-if="unread" class="tag tag-danger">{{ unread }}</span></RouterLink>
        <RouterLink class="nav-link" to="/credit">{{ $t('信誉 {0}', [auth.user?.creditScore ?? '-']) }}</RouterLink>
        <RouterLink class="nav-link" to="/profile">{{ auth.user?.nickname }}</RouterLink>
        <button class="btn btn-sm" title="Switch language" @click="toggleLocale">{{ locale === 'en' ? $t('中文') : 'EN' }}</button>
        <button class="btn btn-sm" @click="logout">{{ $t('退出') }}</button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useSchoolStore } from '../stores/school.js';
import { notificationApi } from '../api/index.js';

const auth = useAuthStore();
const school = useSchoolStore();
const router = useRouter();
const unread = ref(0);
let timer = null;

async function loadUnread() {
  try {
    const data = await notificationApi.unread();
    unread.value = data.unread || 0;
  } catch { /* 未登录或网络异常时静默 */ }
}

function onSchoolChange(value) {
  school.setCurrent(value);
  // 切换学校后重新加载当前页数据
  router.go(0);
}

async function logout() {
  await auth.logout();
  router.push('/login');
}

onMounted(async () => {
  await loadUnread();
  timer = setInterval(loadUnread, 60000);
  if (auth.needSchoolPicker && school.options.length === 0) {
    await school.search();
    if (!school.currentId && school.options.length > 0) school.setCurrent(school.options[0].id);
  }
});
onUnmounted(() => clearInterval(timer));
</script>
