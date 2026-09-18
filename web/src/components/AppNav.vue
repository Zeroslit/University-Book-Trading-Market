<template>
  <header class="nav">
    <div class="nav-inner">
      <RouterLink class="nav-brand" to="/">📚 校园教材循环</RouterLink>
      <nav class="nav-links">
        <RouterLink class="nav-link" to="/">本校首页</RouterLink>
        <RouterLink class="nav-link" to="/books">图书库</RouterLink>
        <RouterLink class="nav-link" to="/threads">论坛</RouterLink>
        <RouterLink class="nav-link" to="/orders">订单</RouterLink>
        <RouterLink class="nav-link" to="/messages">私信</RouterLink>
        <RouterLink class="nav-link" to="/wallet">钱包</RouterLink>
        <RouterLink class="nav-link" to="/support">客服</RouterLink>
        <RouterLink v-if="auth.isModerator" class="nav-link" to="/admin/dashboard">管理后台</RouterLink>
      </nav>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <select
          v-if="auth.needSchoolPicker"
          class="btn btn-sm"
          style="width:auto"
          :value="school.currentId || ''"
          @change="onSchoolChange($event.target.value)"
        >
          <option value="">选择要管理的学校（必选）</option>
          <option v-for="s in school.options" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <span v-else class="tag tag-info">{{ auth.schoolName }}</span>
        <RouterLink class="nav-link" to="/notifications">消息<span v-if="unread" class="tag tag-danger">{{ unread }}</span></RouterLink>
        <RouterLink class="nav-link" to="/credit">信誉 {{ auth.user?.creditScore ?? '-' }}</RouterLink>
        <RouterLink class="nav-link" to="/profile">{{ auth.user?.nickname }}</RouterLink>
        <button class="btn btn-sm" @click="logout">退出</button>
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
