<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div class="bold">{{ $t('我的订单') }}</div>
        <div class="tabs" style="margin:0">
          <button class="tab" :class="{ active: role === 'buyer' }" @click="setRole('buyer')">{{ $t('我买到的') }}</button>
          <button class="tab" :class="{ active: role === 'seller' }" @click="setRole('seller')">{{ $t('我卖出的') }}</button>
        </div>
      </div>
      <div class="chips mt12">
        <button class="chip" :class="{ active: !status }" @click="setStatus('')">{{ $t('全部') }}</button>
        <button v-for="(item, key) in ORDER_STATUS" :key="key" class="chip" :class="{ active: status === key }" @click="setStatus(key)">
          {{ item.label }}
        </button>
      </div>
    </div>

    <div v-if="list.length" class="mt12">
      <div v-for="o in list" :key="o.id" class="card">
        <div class="row-between">
          <RouterLink :to="`/orders/${o.id}`" class="bold">{{ o.order_no }}</RouterLink>
          <StatusTag :map="ORDER_STATUS" :value="o.status" />
        </div>
        <div class="mt8">{{ o.book_title }}</div>
        <div class="small muted">{{ $t('金额 ¥{0} · 服务费 ¥{1} · {2} · {3}', [yuan(o.amount_cents), yuan(o.service_fee_cents), SHIP_MODE[o.ship_mode] || o.ship_mode, formatTime(o.created_at)]) }}</div>
        <div class="small muted">
          {{ role === 'buyer' ? `${$t('卖家：{0}', [o.seller_nickname])}` : `${$t('买家：{0}', [o.buyer_nickname])}` }}
          <span v-if="o.auto_confirm_at"> {{ $t('· 自动确认：{0}（{1}）', [formatTime(o.auto_confirm_at), countdownText(o.auto_confirm_at)]) }}</span>
        </div>
      </div>
    </div>
    <EmptyState v-else :text="$t('暂无订单')" icon="🧾" />

    <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="reload" />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { orderApi } from '../api/index.js';
import { ORDER_STATUS, SHIP_MODE, centsToYuan, countdownText, formatTime } from '../utils/format.js';
import EmptyState from '../components/EmptyState.vue';
import Pager from '../components/Pager.vue';
import StatusTag from '../components/StatusTag.vue';

const list = ref([]);
const role = ref('buyer');
const status = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const hasMore = ref(false);
const yuan = centsToYuan;

function setRole(next) { role.value = next; reload(1); }
function setStatus(next) { status.value = next; reload(1); }

async function reload(nextPage = page.value) {
  page.value = nextPage;
  const data = await orderApi.list({ role: role.value, status: status.value || undefined, page: page.value, pageSize });
  list.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

onMounted(() => reload(1));
</script>
