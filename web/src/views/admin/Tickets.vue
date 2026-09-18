<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">客服工单队列</div>
          <div class="small muted">普通工单 24 小时内响应，资金类工单 4 小时内响应；超时自动升级并通知用户已加急。</div>
        </div>
        <div class="chips">
          <select v-model="filters.status" style="width:auto" @change="load">
            <option value="">全部状态</option>
            <option value="pending">待受理</option>
            <option value="processing">处理中</option>
            <option value="resolved">已完成</option>
            <option value="escalated">已升级</option>
          </select>
          <select v-model="filters.priority" style="width:auto" @change="load">
            <option value="">全部优先级</option>
            <option value="urgent">紧急</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
          <button class="btn btn-sm" @click="load">刷新队列</button>
        </div>
      </div>
      <p class="small muted mt8">SLA 超时未处理：{{ stats?.overdue ?? 0 }} 单</p>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>工单号</th><th>来源</th><th>类型</th><th>优先级</th><th>标题</th><th>状态</th><th>受理人</th><th>首响时限</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in list" :key="t.id">
            <td>{{ t.ticket_no }}</td>
            <td class="small">{{ t.source }}</td>
            <td class="small">{{ TICKET_TYPE[t.type] || t.type }}</td>
            <td><StatusTag :map="TICKET_PRIORITY" :value="t.priority" /></td>
            <td class="small">{{ t.subject }}</td>
            <td><StatusTag :map="TICKET_STATUS" :value="t.status" /></td>
            <td class="small">{{ t.assignee_id || '未接单' }}</td>
            <td class="small">{{ formatTime(t.first_response_due_at) }}</td>
            <td><button class="btn btn-sm" @click="open(t.id)">处理</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="list.length === 0" text="暂无工单" icon="🎫" />
    </div>

    <div v-if="detail" class="card">
      <div class="row-between wrap">
        <div class="bold">工单 #{{ detail.ticket.id }} {{ detail.ticket.subject }}</div>
        <button class="btn btn-sm" @click="detail = null">关闭</button>
      </div>
      <div class="small muted mt8">
        {{ TICKET_TYPE[detail.ticket.type] || detail.ticket.type }} · 来源 {{ detail.ticket.source }} ·
        状态 {{ detail.ticket.status }} · 创建 {{ formatTime(detail.ticket.created_at) }}
      </div>
      <p class="small" style="white-space:pre-wrap">{{ detail.ticket.description }}</p>

      <div class="chips mt8">
        <button v-if="!detail.ticket.assignee_id" class="btn btn-sm btn-primary" @click="claim">抢单</button>
        <button class="btn btn-sm" @click="resolve">处理完成</button>
        <button class="btn btn-sm" @click="escalate">升级加急</button>
      </div>

      <div class="grid mt12">
        <div v-if="detail.orderSnapshot" class="card">
          <div class="bold">订单快照</div>
          <div class="small muted">
            订单 {{ detail.orderSnapshot.order.order_no }} ·
            <StatusTag :map="ORDER_STATUS" :value="detail.orderSnapshot.order.status" /> ·
            ¥{{ yuan(detail.orderSnapshot.order.amount_cents) }} · 托管 {{ detail.orderSnapshot.order.escrow_status }}
          </div>
          <table class="table mt8">
            <thead><tr><th>时间</th><th>流转</th><th>原因</th></tr></thead>
            <tbody>
              <tr v-for="l in detail.orderSnapshot.statusLogs" :key="l.created_at + l.action">
                <td class="small">{{ formatTime(l.created_at) }}</td>
                <td class="small">{{ l.from_status || '—' }} → {{ l.to_status }}</td>
                <td class="small">{{ l.reason }}</td>
              </tr>
            </tbody>
          </table>
          <table class="table mt8">
            <thead><tr><th>流水号</th><th>账户</th><th>金额</th><th>业务</th></tr></thead>
            <tbody>
              <tr v-for="t in detail.orderSnapshot.transactions" :key="t.tx_no">
                <td class="small">{{ t.tx_no }}</td>
                <td>{{ t.account }}/{{ t.direction === 'in' ? '入' : '出' }}</td>
                <td>¥{{ yuan(t.amount_cents) }}</td>
                <td class="small">{{ t.biz_type }}</td>
              </tr>
            </tbody>
          </table>
          <div class="chips mt8">
            <button class="btn btn-sm btn-primary" @click="arbitrate('release')">强制放款给卖家</button>
            <button class="btn btn-sm btn-danger" @click="arbitrate('refund')">强制退款给买家</button>
          </div>
        </div>

        <div v-if="detail.userRisk" class="card">
          <div class="bold">用户风控</div>
          <div class="small muted">
            #{{ detail.userRisk.user.id }} {{ detail.userRisk.user.nickname }} ·
            信誉 {{ detail.userRisk.user.credit_score }} · 认证 {{ detail.userRisk.user.verification_status }}
          </div>
          <div class="small muted mt8">
            生效处罚：{{ detail.userRisk.penalties.length }} 条 · 累计成立违规 {{ detail.userRisk.violationCounter?.effectiveCount ?? '-' }} 次
          </div>
          <table class="table mt8">
            <thead><tr><th>类型</th><th>原因</th><th>状态</th><th>申诉</th></tr></thead>
            <tbody>
              <tr v-for="p in detail.userRisk.penalties" :key="p.id">
                <td>{{ p.type }}</td><td class="small">{{ p.reason }}</td><td>{{ p.status }}</td><td>{{ p.appeal_status }}</td>
              </tr>
            </tbody>
          </table>
          <div class="chips mt8">
            <button class="btn btn-sm" @click="gotoUser(detail.ticket.related_user_id || detail.ticket.reporter_id)">打开风控一屏</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="bold">快捷回复</div>
        <div class="chips mt8">
          <button v-for="q in QUICK_REPLIES" :key="q" class="chip" @click="replyText = q">{{ q }}</button>
        </div>
        <label>回复内容</label>
        <textarea v-model.trim="replyText" maxlength="1000" />
        <button class="btn btn-primary btn-sm mt8" @click="reply">回复用户</button>
      </div>

      <div class="card">
        <div class="bold">流转日志</div>
        <table class="table mt8">
          <thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>状态变化</th><th>备注</th></tr></thead>
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
import { onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ticketApi, orderApi } from '../../api/index.js';
import { ORDER_STATUS, TICKET_PRIORITY, TICKET_STATUS, TICKET_TYPE, centsToYuan, formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import StatusTag from '../../components/StatusTag.vue';

const QUICK_REPLIES = [
  '已收到你的反馈，我们正在核实，请保持手机畅通。',
  '请补充订单号与问题截图，便于我们加快处理。',
  '该订单资金处于托管中，确认收货前不会放款给卖家。',
  '如对裁定结果有异议，可在 3 天申诉期内提交申诉。',
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
    toastError(err?.message || '加载工单失败');
  }
}

async function claim() {
  try {
    await ticketApi.claim(detail.value.ticket.id, schoolId.value);
    toastOk('接单成功');
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || '接单失败');
  }
}

async function reply() {
  if (!replyText.value) { toastError('请填写回复内容'); return; }
  try {
    await ticketApi.reply(detail.value.ticket.id, { content: replyText.value }, schoolId.value);
    toastOk('已回复用户');
    replyText.value = '';
    await open(detail.value.ticket.id);
  } catch (err) {
    toastError(err?.message || '回复失败');
  }
}

async function resolve() {
  const resolution = window.prompt('请填写处理结果（会通知用户）');
  if (!resolution) return;
  try {
    await ticketApi.resolve(detail.value.ticket.id, { resolution }, schoolId.value);
    toastOk('工单已处理完成');
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || '处理失败');
  }
}

async function escalate() {
  const note = window.prompt('升级说明') || '人工升级';
  try {
    await ticketApi.escalate(detail.value.ticket.id, { note }, schoolId.value);
    toastOk('工单已升级');
    await open(detail.value.ticket.id);
    await load();
  } catch (err) {
    toastError(err?.message || '升级失败');
  }
}

async function arbitrate(action) {
  const reason = window.prompt(`请填写${action === 'release' ? '强制放款' : '强制退款'}的裁定理由`);
  if (!reason) return;
  try {
    await orderApi.arbitrate(detail.value.orderSnapshot.order.id, { action, reason }, schoolId.value);
    toastOk('仲裁完成，资金已按裁定处理');
    await open(detail.value.ticket.id);
  } catch (err) {
    toastError(err?.message || '仲裁失败');
  }
}

function gotoUser(id) {
  router.push({ path: '/admin/users', query: { userId: id } });
}

watch(schoolId, () => { detail.value = null; load(); });
onMounted(load);
</script>
