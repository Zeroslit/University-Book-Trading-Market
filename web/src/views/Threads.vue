<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('本校论坛') }}</div>
          <div class="small muted">{{ $t('{0} · 仅展示本校帖子', [auth.schoolName]) }}</div>
        </div>
        <RouterLink class="btn btn-primary btn-sm" to="/threads/new">{{ $t('＋ 发帖') }}</RouterLink>
      </div>

      <div class="tabs mt12">
        <button class="tab" :class="{ active: filters.type === '' }" @click="setType('')">{{ $t('全部') }}</button>
        <button class="tab" :class="{ active: filters.type === 'seek' }" @click="setType('seek')">{{ $t('求书帖') }}</button>
        <button class="tab" :class="{ active: filters.type === 'sell' }" @click="setType('sell')">{{ $t('转让帖') }}</button>
      </div>

      <div class="row" style="gap:8px">
        <input v-model.trim="filters.keyword" :placeholder="$t('搜索标题或内容')" @keyup.enter="reload(1)" />
        <button class="btn btn-sm" @click="reload(1)">{{ $t('搜索') }}</button>
      </div>
    </div>

    <div v-if="list.length" class="mt12">
      <div v-for="t in list" :key="t.id" class="card">
        <div class="row-between">
          <RouterLink :to="`/threads/${t.id}`" class="bold">{{ t.title }}</RouterLink>
          <StatusTag :map="THREAD_TYPE" :value="t.type" />
        </div>
        <div class="small muted mt8">{{ $t('{0} · 信誉 {1} · {2} · {3} 回复 · {4} 浏览', [t.author_nickname, t.author_credit, formatTime(t.created_at), t.reply_count, t.view_count]) }}</div>
      </div>
    </div>
    <EmptyState v-else :text="$t('暂无帖子')" icon="💬" />

    <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="reload" />
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { threadApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { THREAD_TYPE, formatTime } from '../utils/format.js';
import EmptyState from '../components/EmptyState.vue';
import Pager from '../components/Pager.vue';
import StatusTag from '../components/StatusTag.vue';

const auth = useAuthStore();
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const hasMore = ref(false);
const filters = reactive({ type: '', keyword: '' });

function setType(type) {
  filters.type = type;
  reload(1);
}

async function reload(nextPage = page.value) {
  page.value = nextPage;
  const data = await threadApi.list({
    page: page.value, pageSize,
    type: filters.type || undefined,
    keyword: filters.keyword || undefined,
  });
  list.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

onMounted(() => reload(1));
</script>
