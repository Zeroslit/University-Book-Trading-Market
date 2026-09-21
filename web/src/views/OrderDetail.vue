<template>
  <div v-if="order">
    <div class="card">
      <div class="row-between wrap">
        <div>
          <h3 style="margin:0">{{ $t('订单 {0}', [order.order_no]) }}</h3>
          <div class="small muted">{{ order.book_title }}</div>
        </div>
        <div class="chips">
          <StatusTag :map="ORDER_STATUS" :value="order.status" />
          <StatusTag :map="ESCROW_STATUS" :value="order.escrow_status" />
        </div>
      </div>

      <table class="table mt12">
        <tbody>
          <tr><th>{{ $t('订单金额') }}</th><td>¥{{ yuan(order.amount_cents) }}</td></tr>
          <tr><th>{{ $t('平台服务费') }}</th><td>{{ $t('¥{0}（{1}%，按学校配置）', [yuan(order.service_fee_cents), (order.service_fee_bps / 100).toFixed(2)]) }}</td></tr>
          <tr><th>{{ $t('卖家实收') }}</th><td>¥{{ yuan(order.seller_income_cents) }}</td></tr>
          <tr><th>{{ $t('交付方式') }}</th><td>{{ SHIP_MODE[order.ship_mode] || order.ship_mode }}</td></tr>
          <tr><th>{{ $t('创建时间') }}</th><td>{{ formatTime(order.created_at) }}</td></tr>
          <tr v-if="order.auto_confirm_at"><th>{{ $t('自动确认收货') }}</th><td>{{ formatTime(order.auto_confirm_at) }}（{{ countdownText(order.auto_confirm_at) }}）</td></tr>
          <tr v-if="order.dispute_reason"><th>{{ $t('争议原因') }}</th><td>{{ order.dispute_reason }}</td></tr>
        </tbody>
      </table>

      <div v-if="isBuyer || isSeller" class="chips mt12">
        <button v-if="isBuyer && order.status === 'pending_payment'" class="btn btn-primary btn-sm" @click="act('pay')">{{ $t('支付（模拟托管）') }}</button>
        <button v-if="isBuyer && order.status === 'pending_payment'" class="btn btn-sm" @click="act('cancel')">{{ $t('取消订单') }}</button>
        <button v-if="isSeller && order.status === 'paid'" class="btn btn-primary btn-sm" @click="showShip = !showShip">{{ $t('发货') }}</button>
        <button v-if="isBuyer && order.status === 'shipped'" class="btn btn-primary btn-sm" @click="act('confirm')">{{ $t('确认收货（放款）') }}</button>
        <button v-if="isBuyer && order.status === 'paid'" class="btn btn-sm" @click="promptReason('refundRequest')">{{ $t('申请退款') }}</button>
        <button v-if="isBuyer && order.status === 'shipped'" class="btn btn-sm" @click="promptReason('returnRequest')">{{ $t('申请退货退款') }}</button>
        <button v-if="isSeller && (order.status === 'refund_requested' || order.status === 'return_requested')" class="btn btn-primary btn-sm" @click="act('agreeRefund')">{{ $t('同意退款') }}</button>
        <button v-if="isSeller && (order.status === 'refund_requested' || order.status === 'return_requested')" class="btn btn-sm" @click="promptReason('rejectRefund')">{{ $t('拒绝退款') }}</button>
        <button v-if="['paid', 'shipped', 'refund_requested', 'return_requested'].includes(order.status)" class="btn btn-danger btn-sm" @click="promptReason('dispute')">
          {{ $t('发起争议（冻结放款）') }}
        </button>
        <RouterLink class="btn btn-sm" to="/support">{{ $t('联系客服') }}</RouterLink>
      </div>

      <div v-if="showShip" class="card mt12">
        <div class="bold">{{ $t('填写发货信息') }}</div>
        <label>{{ $t('快递公司（邮寄必填）') }}</label>
        <input v-model.trim="shipForm.expressCompany" />
        <label>{{ $t('运单号（邮寄必填）') }}</label>
        <input v-model.trim="shipForm.expressNo" />
        <button class="btn btn-primary btn-sm mt12" @click="act('ship')">{{ $t('确认发货') }}</button>
      </div>
    </div>

    <div class="card">
      <div class="bold">{{ $t('订单状态流转') }}</div>
      <table class="table mt8">
        <thead><tr><th>{{ $t('时间') }}</th><th>{{ $t('状态变化') }}</th><th>{{ $t('动作') }}</th><th>{{ $t('原因') }}</th></tr></thead>
        <tbody>
          <tr v-for="l in logs" :key="l.created_at + l.action">
            <td>{{ formatTime(l.created_at) }}</td>
            <td>{{ l.from_status || '—' }} → {{ l.to_status }}</td>
            <td>{{ l.action }}</td>
            <td class="small">{{ l.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="bold">{{ $t('资金流水（可追溯到每一笔钱的去向）') }}</div>
      <table class="table mt8">
        <thead><tr><th>{{ $t('流水号') }}</th><th>{{ $t('账户') }}</th><th>{{ $t('方向') }}</th><th>{{ $t('金额') }}</th><th>{{ $t('业务') }}</th><th>{{ $t('状态') }}</th></tr></thead>
        <tbody>
          <tr v-for="t in transactions" :key="t.tx_no">
            <td class="small">{{ t.tx_no }}</td>
            <td>{{ t.account }}</td>
            <td>{{ t.direction === 'in' ? $t('入账') : $t('出账') }}</td>
            <td>¥{{ yuan(t.amount_cents) }}</td>
            <td>{{ t.biz_type }}</td>
            <td>{{ t.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <EmptyState v-else :text="$t('订单不存在或无权查看')" icon="🧾" />
</template>

<script setup>
import { t } from '../i18n/index.js';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { orderApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { ESCROW_STATUS, ORDER_STATUS, SHIP_MODE, centsToYuan, countdownText, formatTime } from '../utils/format.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import StatusTag from '../components/StatusTag.vue';

const route = useRoute();
const auth = useAuthStore();
const order = ref(null);
const logs = ref([]);
const transactions = ref([]);
const showShip = ref(false);
const shipForm = reactive({ expressCompany: '', expressNo: '' });
const yuan = centsToYuan;

const isBuyer = computed(() => Number(order.value?.buyer_id) === Number(auth.user?.id));
const isSeller = computed(() => Number(order.value?.seller_id) === Number(auth.user?.id));

async function load() {
  try {
    const data = await orderApi.detail(route.params.id);
    order.value = data.order;
    logs.value = data.logs;
    transactions.value = data.transactions;
  } catch {
    order.value = null;
  }
}

const ACTIONS = {
  pay: (id) => orderApi.pay(id),
  cancel: (id) => orderApi.cancel(id, { get reason() { return t('买家取消订单') } }),
  confirm: (id) => orderApi.confirm(id),
  agreeRefund: (id) => orderApi.agreeRefund(id, { get reason() { return t('卖家同意退款') } }),
  ship: (id) => orderApi.ship(id, { expressCompany: shipForm.expressCompany || undefined, expressNo: shipForm.expressNo || undefined }),
};

async function act(name) {
  try {
    await ACTIONS[name](order.value.id);
    toastOk(t('操作成功'));
    showShip.value = false;
    await load();
    await auth.refreshWallet();
  } catch (err) {
    toastError(err?.message || t('操作失败'));
  }
}

async function promptReason(kind) {
  const reason = window.prompt(kind === 'dispute' ? t('请说明争议原因（客服会介入仲裁）') : t('请填写申请原因'));
  if (!reason) return;
  try {
    if (kind === 'refundRequest') await orderApi.refundRequest(order.value.id, { reason });
    if (kind === 'returnRequest') await orderApi.returnRequest(order.value.id, { reason });
    if (kind === 'rejectRefund') await orderApi.rejectRefund(order.value.id, { reason });
    if (kind === 'dispute') await orderApi.dispute(order.value.id, { reason });
    toastOk(t('已提交'));
    await load();
  } catch (err) {
    toastError(err?.message || t('提交失败'));
  }
}

watch(() => route.params.id, load);
onMounted(load);
</script>
