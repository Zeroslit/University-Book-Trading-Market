<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div class="bold">消息通知（未读 {{ unread }}）</div>
        <div class="chips">
          <button class="chip" :class="{ active: isRead === '' }" @click="setFilter('')">全部</button>
          <button class="chip" :class="{ active: isRead === 'false' }" @click="setFilter('false')">未读</button>
          <button class="chip" :class="{ active: isRead === 'true' }" @click="setFilter('true')">已读</button>
          <button class="btn btn-sm" @click="markAll">全部已读</button>
        </div>
      </div>
    </div>

    <div v-if="list.length" class="mt12">
      <div v-for="n in list" :key="n.id" class="card" :style="n.is_read ? '' : 'border-color: rgba(31,111,235,.5)'">
        <div class="row-between">
          <div class="bold">
            <span class="tag">{{ NOTIFICATION_TYPE[n.type] || n.type }}</span>
            {{ n.title }}
          </div>
          <span class="small muted">{{ formatTime(n.sent_at) }}</span>
        </div>
        <div class="mt8" style="white-space:pre-wrap">{{ n.content }}</div>
        <div class="row mt8">
          <RouterLink v-if="n.related_type === 'order'" class="btn btn-sm" :to="`/orders/${n.related_id}`">查看订单</RouterLink>
          <RouterLink v-if="n.related_type === 'penalty'" class="btn btn-sm" to="/appeals">查看处罚 / 申诉</RouterLink>
          <button v-if="!n.is_read" class="btn btn-sm" @click="markRead(n.id)">标记已读</button>
        </div>
      </div>
    </div>
    <EmptyState v-else text="暂无通知" icon="🔔" />

    <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="load" />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { notificationApi } from '../api/index.js';
import { NOTIFICATION_TYPE, formatTime } from '../utils/format.js';
import EmptyState from '../components/EmptyState.vue';
import Pager from '../components/Pager.vue';

const list = ref([]);
const unread = ref(0);
const isRead = ref('false');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const hasMore = ref(false);

function setFilter(value) { isRead.value = value; load(1); }

async function load(nextPage = page.value) {
  page.value = nextPage;
  const data = await notificationApi.list({ page: page.value, pageSize, isRead: isRead.value === '' ? undefined : isRead.value });
  list.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
  unread.value = (await notificationApi.unread()).unread;
}

async function markRead(id) {
  await notificationApi.markRead(id);
  await load();
}

async function markAll() {
  await notificationApi.markAllRead();
  await load();
}

onMounted(() => load(1));
</script>

