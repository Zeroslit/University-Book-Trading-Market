<template>
  <div>
    <div class="card">
      <div class="bold">用户与风控</div>
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="keyword" placeholder="昵称 / 学号（掩码）" @keyup.enter="load" />
        <select v-model="verificationStatus" style="width:auto" @change="load">
          <option value="">全部认证状态</option>
          <option value="unverified">未认证</option>
          <option value="pending">审核中</option>
          <option value="approved">已认证</option>
          <option value="rejected">认证未通过</option>
        </select>
        <label class="row small" style="gap:6px;margin:0">
          <input type="checkbox" v-model="onlyBanned" style="width:auto" @change="load" /> 只看被封禁
        </label>
        <button class="btn btn-sm btn-primary" @click="load">查询</button>
      </div>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>用户</th><th>学号</th><th>认证</th><th>信誉分</th><th>限制</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in list" :key="u.id">
            <td>#{{ u.id }} {{ u.nickname }}<div class="small muted">{{ u.role }}</div></td>
            <td class="small">{{ u.student_no_mask }}</td>
            <td><StatusTag :map="VERIFICATION_STATUS" :value="u.verification_status" /></td>
            <td>{{ u.credit_score }}</td>
            <td class="small">
              <span v-if="u.banned_permanently" class="tag tag-danger">永久封禁</span>
              <span v-if="u.mute_until" class="tag tag-warning">禁言</span>
              <span v-if="u.trade_ban_until" class="tag tag-warning">禁交易</span>
              <span v-if="u.login_ban_until" class="tag tag-danger">禁登录</span>
            </td>
            <td><button class="btn btn-sm" @click="openRisk(u.id)">风控一屏</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="list.length === 0" text="没有匹配的用户" icon="👤" />
    </div>

    <div v-if="risk" class="card">
      <div class="row-between wrap">
        <div class="bold">风控一屏：#{{ risk.user.id }} {{ risk.user.nickname }}</div>
        <button class="btn btn-sm" @click="risk = null">关闭</button>
      </div>

      <div class="grid mt12">
        <div class="card">
          <div class="small muted">信誉分 / 档位</div>
          <div class="bold">{{ risk.permissions.score }}（{{ risk.permissions.tierLabel }}）</div>
          <div class="small muted">
            可发布 {{ risk.permissions.canPublish ? '是' : '否' }} · 可交易 {{ risk.permissions.canTrade ? '是' : '否' }} ·
            最多挂 {{ risk.permissions.maxBooks }} 本
          </div>
        </div>
        <div class="card">
          <div class="small muted">累计成立违规次数（滚动口径）</div>
          <div class="bold">{{ risk.violationCounter.effectiveCount }}</div>
          <div class="small muted">
            总 {{ risk.violationCounter.total }} · 生效 {{ risk.violationCounter.activeCount }} ·
            过期 {{ risk.violationCounter.expiredCount }} · 严重 {{ risk.violationCounter.severeCount }}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="bold">一键处罚</div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
          <div>
            <label>处罚类型</label>
            <select v-model="banForm.type">
              <option value="warning">站内警告</option>
              <option value="mute">禁言</option>
              <option value="trade_ban">禁止交易</option>
              <option value="login_ban">禁止登录</option>
              <option v-if="auth.isPlatformAdmin" value="permanent_ban">永久封禁（仅平台管理员）</option>
            </select>
          </div>
          <div>
            <label>天数（永久封禁可留空）</label>
            <input v-model.trim="banForm.days" type="number" min="0" />
          </div>
        </div>
        <label>处罚原因</label>
        <input v-model.trim="banForm.reason" />
        <div class="chips mt12">
          <button class="btn btn-sm btn-danger" @click="ban">执行处罚</button>
          <button class="btn btn-sm" @click="unban('mute')">解除禁言</button>
          <button class="btn btn-sm" @click="unban('trade_ban')">解除禁交易</button>
          <button class="btn btn-sm" @click="unban('login_ban')">解除禁登录</button>
          <button class="btn btn-sm" @click="unban('all')">全部解除</button>
        </div>
      </div>

      <div class="card">
        <div class="bold">违规 / 处罚记录</div>
        <table class="table mt8">
          <thead><tr><th>ID</th><th>类型</th><th>严重度</th><th>计入次数</th><th>原因</th><th>状态</th><th>申诉</th><th>起止</th></tr></thead>
          <tbody>
            <tr v-for="p in risk.penalties" :key="p.id">
              <td>{{ p.id }}</td><td>{{ p.type }}</td><td>{{ p.severity }}</td>
              <td>{{ p.effective_count }}</td><td class="small">{{ p.reason }}</td>
              <td>{{ p.status }}</td><td>{{ p.appeal_status }}</td>
              <td class="small">{{ formatTime(p.start_at) }} → {{ p.end_at ? formatTime(p.end_at) : '长期' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">信誉分变动</div>
        <table class="table mt8">
          <thead><tr><th>时间</th><th>变动</th><th>变动后</th><th>规则</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="c in risk.credits" :key="c.created_at + c.rule_key">
              <td class="small">{{ formatTime(c.created_at) }}</td>
              <td>{{ c.delta }}</td><td>{{ c.score_after }}</td>
              <td class="small">{{ c.rule_key }}</td><td class="small">{{ c.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">相关订单</div>
        <table class="table mt8">
          <thead><tr><th>订单号</th><th>状态</th><th>金额</th><th>创建时间</th></tr></thead>
          <tbody>
            <tr v-for="o in risk.orders" :key="o.id">
              <td><RouterLink :to="`/orders/${o.id}`">{{ o.order_no }}</RouterLink></td>
              <td><StatusTag :map="ORDER_STATUS" :value="o.status" /></td>
              <td>¥{{ yuan(o.amount_cents) }}</td>
              <td class="small">{{ formatTime(o.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">相关工单</div>
        <table class="table mt8">
          <thead><tr><th>工单号</th><th>类型</th><th>状态</th><th>标题</th></tr></thead>
          <tbody>
            <tr v-for="t in risk.tickets" :key="t.id">
              <td>{{ t.ticket_no }}</td><td>{{ t.type }}</td><td>{{ t.status }}</td><td class="small">{{ t.subject }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { adminApi } from '../../api/index.js';
import { ORDER_STATUS, VERIFICATION_STATUS, centsToYuan, formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import StatusTag from '../../components/StatusTag.vue';

const { auth, schoolId, ready } = useScope();
const list = ref([]);
const keyword = ref('');
const verificationStatus = ref('');
const onlyBanned = ref(false);
const risk = ref(null);
const banForm = reactive({ type: 'warning', days: 3, reason: '' });
const yuan = centsToYuan;

async function load() {
  if (!ready.value) { list.value = []; return; }
  const data = await adminApi.users({
    keyword: keyword.value || undefined,
    verificationStatus: verificationStatus.value || undefined,
    banned: onlyBanned.value ? 'true' : undefined,
    pageSize: 30,
  }, schoolId.value);
  list.value = data.list;
}

async function openRisk(id) {
  try {
    risk.value = await adminApi.userRisk(id, schoolId.value);
  } catch (err) {
    toastError(err?.message || '加载风控信息失败');
  }
}

async function ban() {
  if (banForm.reason.length < 2) { toastError('请填写处罚原因'); return; }
  try {
    const days = banForm.days === '' ? null : Number(banForm.days);
    await adminApi.banUser(risk.value.user.id, { type: banForm.type, days, reason: banForm.reason }, schoolId.value);
    toastOk('处罚已执行');
    banForm.reason = '';
    await openRisk(risk.value.user.id);
    await load();
  } catch (err) {
    toastError(err?.message || '处罚失败');
  }
}

async function unban(type) {
  const reason = window.prompt('解除原因（会通知用户）') || undefined;
  try {
    await adminApi.unbanUser(risk.value.user.id, { type, reason }, schoolId.value);
    toastOk('已解除限制');
    await openRisk(risk.value.user.id);
    await load();
  } catch (err) {
    toastError(err?.message || '解除失败');
  }
}

watch(schoolId, () => { risk.value = null; load(); });
onMounted(load);
</script>
