<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">订单仲裁</div>
          <div class="small muted">
            争议中的订单会立即冻结放款并暂停自动确认倒计时，客服裁定后按结果放款或退款；所有资金变动均写入流水表。
          </div>
        </div>
        <div class="chips">
          <select v-model="status" style="width:auto" @change="load">
            <option value="disputed">仅争议中</option>
            <option value="">全部订单</option>
            <option value="paid">已付款（托管中）</option>
            <option value="shipped">已发货</option>
            <option value="refund_requested">退款申请中</option>
            <option value="return_requested">退货退款中</option>
            <option value="completed">已完成</option>
          </select>
          <input v-model.trim="orderNo" placeholder="按订单号精确查询" style="width:auto" @keyup.enter="load" />
          <button class="btn btn-sm" @click="load">查询</button>
        </div>
      </div>
    </div>

    <div v-if="list.length" class="mt12">
      <div v-for="o in list" :key="o.id" class="card">
        <div class="row-between wrap">
          <RouterLink :to="`/orders/${o.id}`" class="bold">{{ o.order_no }} · {{ o.book_title }}</RouterLink>
          <div class="chips">
            <StatusTag :map="ORDER_STATUS" :value="o.status" />
            <StatusTag :map="ESCROW_STATUS" :value="o.escrow_status" />
          </div>
        </div>
        <div class="small muted mt8">
          买家 {{ o.buyer_nickname }} · 卖家 {{ o.seller_nickname }} · ¥{{ yuan(o.amount_cents) }} ·
          服务费 ¥{{ yuan(o.service_fee_cents) }} · {{ SHIP_MODE[o.ship_mode] || o.ship_mode }}
        </div>
        <div v-if="o.dispute_reason" class="notice notice-error mt8">
          争议原因：{{ o.dispute_reason }}（{{ formatTime(o.dispute_at) }}）
        </div>
        <div v-if="o.arbitration_result" class="notice notice-info mt8">
          仲裁结果：{{ o.arbitration_result === 'release' ? '强制放款卖家' : '强制退款买家' }}
        </div>
        <div class="chips mt8">
          <button class="btn btn-sm" @click="openDetail(o.id)">查看订单快照</button>
          <button class="btn btn-sm btn-primary" @click="arbitrate(o, 'release')">强制放款给卖家</button>
          <button class="btn btn-sm btn-danger" @click="arbitrate(o, 'refund')">强制退款给买家</button>
        </div>
      </div>
    </div>
    <EmptyState v-else text="没有需要仲裁的订单" icon="⚖️" />

    <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="load" />

    <div v-if="snapshot" class="card">
      <div class="row-between">
        <div class="bold">订单 {{ snapshot.order.order_no }} 资金与流转</div>
        <button class="btn btn-sm" @click="snapshot = null">关闭</button>
      </div>
      <table class="table mt8">
        <thead><tr><th>时间</th><th>流转</th><th>动作</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="l in snapshot.logs" :key="l.created_at + l.action">
            <td class="small">{{ formatTime(l.created_at) }}</td>
            <td class="small">{{ l.from_status || '—' }} → {{ l.to_status }}</td>
            <td class="small">{{ l.action }}</td>
            <td class="small">{{ l.reason }}</td>
          </tr>
        </tbody>
      </table>
      <table class="table mt8">
        <thead><tr><th>流水号</th><th>用户</th><th>账户</th><th>金额</th><th>业务</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="t in snapshot.transactions" :key="t.tx_no">
            <td class="small">{{ t.tx_no }}</td>
            <td>{{ t.user_id }}</td>
            <td>{{ t.account }}/{{ t.direction === 'in' ? '入' : '出' }}</td>
            <td>¥{{ yuan(t.amount_cents) }}</td>
            <td class="small">{{ t.biz_type }}</td>
            <td>{{ t.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { adminApi, orderApi } from '../../api/index.js';
import { ESCROW_STATUS, ORDER_STATUS, SHIP_MODE, centsToYuan, formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import Pager from '../../components/Pager.vue';
import StatusTag from '../../components/StatusTag.vue';

const { schoolId, ready } = useScope();
const list = ref([]);
const status = ref('disputed');
const orderNo = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const hasMore = ref(false);
const snapshot = ref(null);
const yuan = centsToYuan;

async function load(nextPage = 1) {
  if (!ready.value) { list.value = []; return; }
  page.value = nextPage;
  const data = await adminApi.orders({ status: status.value || undefined, orderNo: orderNo.value || undefined, page: page.value, pageSize }, schoolId.value);
  list.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

async function openDetail(id) {
  try {
    snapshot.value = await orderApi.detail(id);
  } catch (err) {
    toastError(err?.message || '加载订单失败');
  }
}

async function arbitrate(order, action) {
  const reason = window.prompt(`请填写${action === 'release' ? '强制放款' : '强制退款'}的裁定理由（不少于 2 字）`);
  if (!reason) return;
  try {
    await orderApi.arbitrate(order.id, { action, reason }, schoolId.value);
    toastOk('仲裁完成，资金已按裁定处理');
    await load(page.value);
  } catch (err) {
    toastError(err?.message || '仲裁失败');
  }
}

watch(schoolId, () => { snapshot.value = null; load(1); });
onMounted(() => load(1));
</script>
