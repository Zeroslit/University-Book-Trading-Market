<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('客服工单队列') }}</div>
          <div class="small muted">{{ $t('普通工单 24 小时内响应，资金类工单 4 小时内响应；超时自动升级并通知用户已加急。') }}</div>
        </div>
        <div class="chips">
          <select v-model="filters.status" style="width:auto" @change="load">
            <option value="">{{ $t('全部状态') }}</option>
            <option value="pending">{{ $t('待受理') }}</option>
            <option value="processing">{{ $t('处理中') }}</option>
            <option value="resolved">{{ $t('已完成') }}</option>
            <option value="escalated">{{ $t('已升级') }}</option>
          </select>
          <select v-model="filters.priority" style="width:auto" @change="load">
            <option value="">{{ $t('全部优先级') }}</option>
            <option value="urgent">{{ $t('紧急') }}</option>
            <option value="high">{{ $t('高') }}</option>
            <option value="normal">{{ $t('普通') }}</option>
            <option value="low">{{ $t('低') }}</option>
          </select>
          <button class="btn btn-sm" @click="load">{{ $t('刷新队列') }}</button>
        </div>
      </div>
      <p class="small muted mt8">{{ $t('SLA 超时未处理：{0} 单', [stats?.overdue ?? 0]) }}</p>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>{{ $t('工单号') }}</th><th>{{ $t('来源') }}</th><th>{{ $t('类型') }}</th><th>{{ $t('优先级') }}</th><th>{{ $t('标题') }}</th><th>{{ $t('状态') }}</th><th>{{ $t('受理人') }}</th><th>{{ $t('首响时限') }}</th><th>{{ $t('操作') }}</th></tr></thead>
        <tbody>
          <tr v-for="t in list" :key="t.id">
            <td>{{ t.ticket_no }}</td>
            <td class="small">{{ t.source }}</td>
            <td class="small">{{ TICKET_TYPE[t.type] || t.type }}</td>
            <td><StatusTag :map="TICKET_PRIORITY" :value="t.priority" /></td>
            <td class="small">{{ t.subject }}</td>
            <td><StatusTag :map="TICKET_STATUS" :value="t.status" /></td>
            <td class="small">{{ t.assignee_id || $t('未接单') }}</td>
            <td class="small">{{ formatTime(t.first_response_due_at) }}</td>
            <td><button class="btn btn-sm" @click="open(t.id)">{{ $t('处理') }}</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="list.length === 0" :text="$t('暂无工单')" icon="🎫" />
    </div>

    <div v-if="detail" class="card">
      <div class="row-between wrap">
        <div class="bold">{{ $t('工单 #{0} {1}', [detail.ticket.id, detail.ticket.subject]) }}</div>
        <button class="btn btn-sm" @click="detail = null">{{ $t('关闭') }}</button>
      </div>
      <div class="small muted mt8">{{ $t('{0} · 来源 {1} · 状态 {2} · 创建 {3}', [TICKET_TYPE[detail.ticket.type] || detail.ticket.type, detail.ticket.source, detail.ticket.status, formatTime(detail.ticket.created_at)]) }}</div>
      <p class="small" style="white-space:pre-wrap">{{ detail.ticket.description }}</p>

      <div class="chips mt8">
        <button v-if="!detail.ticket.assignee_id" class="btn btn-sm btn-primary" @click="claim">{{ $t('抢单') }}</button>
        <button class="btn btn-sm" @click="resolve">{{ $t('处理完成') }}</button>
        <button class="btn btn-sm" @click="escalate">{{ $t('升级加急') }}</button>
      </div>

      <div class="grid mt12">
        <div v-if="detail.orderSnapshot" class="card">
          <div class="bold">{{ $t('订单快照') }}</div>
          <div class="small muted">{{ $t('订单 {0} ·', [detail.orderSnapshot.order.order_no]) }}<StatusTag :map="ORDER_STATUS" :value="detail.orderSnapshot.order.status" /> {{ $t('· ¥{0} · 托管 {1}', [yuan(detail.orderSnapshot.order.amount_cents), detail.orderSnapshot.order.escrow_status]) }}</div>
          <table class="table mt8">
            <thead><tr><th>{{ $t('时间') }}</th><th>{{ $t('流转') }}</th><th>{{ $t('原因') }}</th></tr></thead>
            <tbody>
              <tr v-for="l in detail.orderSnapshot.statusLogs" :key="l.created_at + l.action">
                <td class="small">{{ formatTime(l.created_at) }}</td>
                <td class="small">{{ l.from_status || '—' }} → {{ l.to_status }}</td>
                <td class="small">{{ l.reason }}</td>
              </tr>
            </tbody>
          </table>
          <table class="table mt8">
            <thead><tr><th>{{ $t('流水号') }}</th><th>{{ $t('账户') }}</th><th>{{ $t('金额') }}</th><th>{{ $t('业务') }}</th></tr></thead>
            <tbody>
              <tr v-for="t in detail.orderSnapshot.transactions" :key="t.tx_no">
                <td class="small">{{ t.tx_no }}</td>
                <td>{{ t.account }}/{{ t.direction === 'in' ? $t('入') : $t('出') }}</td>
                <td>¥{{ yuan(t.amount_cents) }}</td>
                <td class="small">{{ t.biz_type }}</td>
              </tr>
            </tbody>
          </table>
          <div class="chips mt8">
            <button class="btn btn-sm btn-primary" @click="arbitrate('release')">{{ $t('强制放款给卖家') }}</button>
            <button class="btn btn-sm btn-danger" @click="arbitrate('refund')">{{ $t('强制退款给买家') }}</button>
          </div>
        </div>

        <div v-if="detail.userRisk" class="card">
          <div class="bold">{{ $t('用户风控') }}</div>
          <div class="small muted">{{ $t('#{0} {1} · 信誉 {2} · 认证 {3}', [detail.userRisk.user.id, detail.userRisk.user.nickname, detail.userRisk.user.credit_score, detail.userRisk.user.verification_status]) }}</div>
          <div class="small muted mt8">{{ $t('生效处罚：{0} 条 · 累计成立违规 {1} 次', [detail.userRisk.penalties.length, detail.userRisk.violationCounter?.effectiveCount ?? '-']) }}</div>
          <table class="table mt8">
            <thead><tr><th>{{ $t('类型') }}</th><th>{{ $t('原因') }}</th><th>{{ $t('状态') }}</th><th>{{ $t('申诉') }}</th></tr></thead>
            <tbody>
              <tr v-for="p in detail.userRisk.penalties" :key="p.id">
                <td>{{ p.type }}</td><td class="small">{{ p.reason }}</td><td>{{ p.status }}</td><td>{{ p.appeal_status }}</td>
              </tr>
            </tbody>
          </table>
          <div class="chips mt8">
            <button class="btn btn-sm" @click="gotoUser(detail.ticket.related_user_id || detail.ticket.reporter_id)">{{ $t('打开风控一屏') }}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="bold">{{ $t('快捷回复') }}</div>
        <div class="chips mt8">
          <button v-for="q in QUICK_REPLIES" :key="q" class="chip" @click="replyText = q">{{ q }}</button>
        </div>
        <label>{{ $t('回复内容') }}</label>
        <textarea v-model.trim="replyText" maxlength="1000" />
        <button class="btn btn-primary btn-sm mt8" @click="reply">{{ $t('回复用户') }}</button>
      </div>

      <div class="card">
        <div class="bold">{{ $t('流转日志') }}</div>
        <table class="table mt8">
          <thead><tr><th>{{ $t('时间') }}</th><th>{{ $t('动作') }}</th><th>{{ $t('操作者') }}</th><th>{{ $t('状态变化') }}</th><th>{{ $t('备注') }}</th></tr></thead>
          <tbody>
            <tr v-for="l in detail.logs" :key="l.id">
              <td class="small">{{ formatTime(l.created_at) }}</td>
              <td>{{ l.action }}</td>
              <td class="small">{{ l.operator_type }}#{{ l.operator_id }}</td>
              <td class="small">{{ l.from_status || '—' }} → {{ l.to_status || '—' }}</td>
              <td class="small">{{ l.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { t } from '../../i18n/index.js';
import { onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ticketApi, orderApi } from '../../api/index.js';
import { ORDER_STATUS, TICKET_PRIORITY, TICKET_STATUS, TICKET_TYPE, centsToYuan, formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import StatusTag from '../../components/StatusTag.vue';

const QUICK_REPLIES = [
  t('已收到你的反馈，我们正在核实，请保持手机畅通。'),
  t('请补充订单号与问题截图，便于我们加快处理。'),
  t('该订单资金处于托管中，确认收货前不会放款给卖家。'),
  t('如对裁定结果有异议，可在 3 天申诉期内提交申诉。'),
];
const { schoolId, ready } = useScope();
const router = useRouter();
const list = ref([]);
const stats = ref(null);
const detail = ref(null);
const replyText = ref('');
const filters = reactive({ status: '', priority: '' });
const yuan = centsToYuan;

async function load() {
  if (!ready.value) { list.value = []; stats.value = null; return; }
  const data = await ticketApi.list({ status: filters.status || undefined, priority: filters.priority || undefined, pageSize: 30 }, schoolId.value);
  list.value = data.list;
  stats.value = await ticketApi.stats(schoolId.value);
}

async function open(id) {
  try {
    detail.value = await ticketApi.detail(id, schoolId.value);
  } catch (err) {
    toastError(err?.message || t('加载工单失败'));
  }
}

async function claim() {
  try {
    await ticketApi.claim(detail.value.ticket.id, schoolId.value);
    toastOk(t('接单成功'));
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || t('接单失败'));
  }
}

async function reply() {
  if (!replyText.value) { toastError(t('请填写回复内容')); return; }
  try {
    await ticketApi.reply(detail.value.ticket.id, { content: replyText.value }, schoolId.value);
    toastOk(t('已回复用户'));
    replyText.value = '';
    await open(detail.value.ticket.id);
  } catch (err) {
    toastError(err?.message || t('回复失败'));
  }
}

async function resolve() {
  const resolution = window.prompt(t('请填写处理结果（会通知用户）'));
  if (!resolution) return;
  try {
    await ticketApi.resolve(detail.value.ticket.id, { resolution }, schoolId.value);
    toastOk(t('工单已处理完成'));
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || t('处理失败'));
  }
}

async function escalate() {
  const note = window.prompt(t('升级说明')) || t('人工升级');
  try {
    await ticketApi.escalate(detail.value.ticket.id, { note }, schoolId.value);
    toastOk(t('工单已升级'));
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || t('升级失败'));
  }
}

async function arbitrate(action) {
  const reason = window.prompt(`${t('请填写{0}的裁定理由', [action === 'release' ? t('强制放款') : t('强制退款')])}`);
  if (!reason) return;
  try {
    await orderApi.arbitrate(detail.value.orderSnapshot.order.id, { action, reason }, schoolId.value);
    toastOk(t('仲裁完成，资金已按裁定处理'));
    await open(detail.value.ticket.id);
  } catch (err) {
    toastError(err?.message || t('仲裁失败'));
  }
}

function gotoUser(id) {
  router.push({ path: '/admin/users', query: { userId: id } });
}

watch(schoolId, () => { detail.value = null; load(); });
onMounted(load);
</script>
