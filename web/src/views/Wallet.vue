<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="small muted">{{ $t('可用余额') }}</div>
          <div class="price" style="font-size:26px">¥{{ yuan(account?.balanceCents) }}</div>
          <div class="small muted">{{ $t('冻结金额 ¥{0} · 信誉档位 {1} · 提现{2}', [yuan(account?.frozenCents), account?.creditTier, account?.withdrawInstant ? $t('即时到账') : `${$t('延迟 {0} 小时', [account?.withdrawDelayHours])}`]) }}</div>
        </div>
        <div class="chips">
          <button class="btn btn-sm" @click="showRecharge = !showRecharge">{{ $t('模拟充值') }}</button>
          <button class="btn btn-sm btn-primary" @click="showWithdraw = !showWithdraw">{{ $t('提现') }}</button>
          <RouterLink class="btn btn-sm" to="/payment-accounts">{{ $t('收款绑定') }}</RouterLink>
        </div>
      </div>

      <div v-if="showRecharge" class="card mt12">
        <div class="bold">{{ $t('模拟充值（一期不接入真实支付）') }}</div>
        <label>{{ $t('金额（元）') }}</label>
        <input v-model.trim="rechargeAmount" type="number" min="1" max="5000" step="0.01" />
        <button class="btn btn-primary btn-sm mt12" :disabled="busy" @click="recharge">{{ $t('确认充值') }}</button>
      </div>

      <div v-if="showWithdraw" class="card mt12">
        <div class="bold">{{ $t('提现（必须已绑定收款方式且通过学生认证）') }}</div>
        <label>{{ $t('金额（元）') }}</label>
        <input v-model.trim="withdrawAmount" type="number" min="1" step="0.01" />
        <label>{{ $t('收款方式') }}</label>
        <select v-model="withdrawAccountId">
          <option value="">{{ $t('请选择已绑定的收款方式') }}</option>
          <option v-for="a in paymentAccounts" :key="a.id" :value="a.id">
            {{ a.typeLabel }} {{ a.accountMask }}{{ a.isDefault ? $t('（默认）') : '' }}
          </option>
        </select>
        <button class="btn btn-primary btn-sm mt12" :disabled="busy" @click="withdraw">{{ $t('提交提现') }}</button>
        <p class="small muted mt8">{{ $t('资金流向会写入流水表，可按订单号追溯。') }}</p>
      </div>
    </div>

    <div class="card">
      <div class="bold">{{ $t('提现记录') }}</div>
      <table class="table mt8">
        <thead><tr><th>{{ $t('提现单号') }}</th><th>{{ $t('金额') }}</th><th>{{ $t('状态') }}</th><th>{{ $t('到账方式') }}</th><th>{{ $t('预计到账') }}</th><th>{{ $t('申请时间') }}</th></tr></thead>
        <tbody>
          <tr v-for="w in withdrawals" :key="w.id">
            <td class="small">{{ w.withdraw_no }}</td>
            <td>¥{{ yuan(w.amount_cents) }}</td>
            <td>{{ w.status }}</td>
            <td>{{ w.arrival_type === 'instant' ? $t('即时') : $t('延迟') }}</td>
            <td class="small">{{ formatTime(w.expect_at) }}</td>
            <td class="small">{{ formatTime(w.created_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="row-between">
        <div class="bold">{{ $t('资金明细（全部留痕）') }}</div>
        <select v-model="bizType" style="width:auto" @change="loadTransactions(1)">
          <option value="">{{ $t('全部业务类型') }}</option>
          <option value="recharge">{{ $t('充值') }}</option>
          <option value="order_hold">{{ $t('下单托管') }}</option>
          <option value="order_release">{{ $t('放款') }}</option>
          <option value="refund">{{ $t('退款') }}</option>
          <option value="fee">{{ $t('服务费') }}</option>
          <option value="withdraw">{{ $t('提现') }}</option>
        </select>
      </div>
      <table class="table mt8">
        <thead><tr><th>{{ $t('流水号') }}</th><th>{{ $t('账户') }}</th><th>{{ $t('方向') }}</th><th>{{ $t('金额') }}</th><th>{{ $t('业务') }}</th><th>{{ $t('余额') }}</th><th>{{ $t('时间') }}</th></tr></thead>
        <tbody>
          <tr v-for="t in transactions" :key="t.id">
            <td class="small">{{ t.tx_no }}</td>
            <td>{{ t.account }}</td>
            <td>{{ t.direction === 'in' ? $t('入账') : $t('出账') }}</td>
            <td>¥{{ yuan(t.amount_cents) }}</td>
            <td>{{ t.biz_type }}</td>
            <td>{{ yuan(t.balance_after_cents) }}</td>
            <td class="small">{{ formatTime(t.created_at) }}</td>
          </tr>
        </tbody>
      </table>
      <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="loadTransactions" />
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { onMounted, ref } from 'vue';
import { walletApi, paymentAccountApi } from '../api/index.js';
import { centsToYuan, formatTime, yuanToCents } from '../utils/format.js';
import { toastError, toastOk } from '../utils/toast.js';
import { useAuthStore } from '../stores/auth.js';
import Pager from '../components/Pager.vue';

const auth = useAuthStore();
const account = ref(null);
const transactions = ref([]);
const withdrawals = ref([]);
const paymentAccounts = ref([]);
const showRecharge = ref(false);
const showWithdraw = ref(false);
const rechargeAmount = ref('100');
const withdrawAmount = ref('');
const withdrawAccountId = ref('');
const bizType = ref('');
const busy = ref(false);
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const hasMore = ref(false);
const yuan = centsToYuan;

async function loadAll() {
  account.value = await walletApi.account();
  withdrawals.value = (await walletApi.withdrawals({ pageSize: 10 })).list;
  paymentAccounts.value = await paymentAccountApi.list();
  await loadTransactions(1);
}

async function loadTransactions(nextPage = page.value) {
  page.value = nextPage;
  const data = await walletApi.transactions({ page: page.value, pageSize, bizType: bizType.value || undefined });
  transactions.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

async function recharge() {
  const amountCents = yuanToCents(rechargeAmount.value);
  if (!Number.isFinite(amountCents) || amountCents < 100) { toastError(t('充值金额至少 1 元')); return; }
  busy.value = true;
  try {
    await walletApi.recharge({ amountCents });
    toastOk(t('充值成功（模拟）'));
    showRecharge.value = false;
    await loadAll();
    await auth.refreshWallet();
  } catch (err) {
    toastError(err?.message || t('充值失败'));
  } finally {
    busy.value = false;
  }
}

async function withdraw() {
  const amountCents = yuanToCents(withdrawAmount.value);
  if (!Number.isFinite(amountCents) || amountCents < 100) { toastError(t('提现金额至少 1 元')); return; }
  if (!withdrawAccountId.value) { toastError(t('请选择收款方式')); return; }
  busy.value = true;
  try {
    const data = await walletApi.withdraw({ amountCents, paymentAccountId: Number(withdrawAccountId.value) });
    toastOk(data.arrivalType === 'instant' ? t('提现申请已提交，预计即时到账') : t('提现申请已提交，将延迟到账'));
    showWithdraw.value = false;
    await loadAll();
    await auth.refreshWallet();
  } catch (err) {
    toastError(err?.message || t('提现失败'));
  } finally {
    busy.value = false;
  }
}

onMounted(loadAll);
</script>
