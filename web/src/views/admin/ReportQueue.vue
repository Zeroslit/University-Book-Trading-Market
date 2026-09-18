<template>
  <div>
    <div class="card">
      <div class="bold">投诉裁定与申诉复审</div>
      <p class="small muted">
        链路：举报 → 受理（通知被投诉人 48 小时内举证）→ 裁定 → 处罚 + 扣分 → 通知双方 → 3 天申诉期 → 复审。
        只有「裁定成立」的投诉才计入违规次数。
      </p>
      <div class="chips">
        <select v-model="status" style="width:auto" @change="load">
          <option value="">全部状态</option>
          <option value="pending">待受理</option>
          <option value="accepted">已受理（举证中）</option>
          <option value="decided">已裁定</option>
          <option value="rejected">不予受理</option>
        </select>
        <span class="chip">裁定成立 {{ stats?.validReports ?? 0 }} 起</span>
        <span class="chip">生效处罚 {{ stats?.activePenalties ?? 0 }} 条</span>
      </div>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>编号</th><th>对象</th><th>原因</th><th>状态</th><th>严重度</th><th>裁定</th><th>举证截止</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td class="small">{{ r.report_no }}</td>
            <td class="small">{{ r.target_type }}#{{ r.target_id }}</td>
            <td class="small">{{ r.reason }}</td>
            <td><StatusTag :map="REPORT_STATUS" :value="r.status" /></td>
            <td class="small">{{ r.severity }}</td>
            <td class="small">{{ r.decision || '—' }}</td>
            <td class="small">{{ formatTime(r.proof_deadline_at) }}</td>
            <td><button class="btn btn-sm" @click="open(r.id)">查看 / 裁定</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="list.length === 0" text="暂无投诉" icon="🚨" />
    </div>

    <div v-if="detail" class="card">
      <div class="row-between">
        <div class="bold">投诉 {{ detail.report_no }}</div>
        <button class="btn btn-sm" @click="detail = null">关闭</button>
      </div>
      <div class="small muted mt8">
        举报人 #{{ detail.reporter_id }} · 被投诉人 #{{ detail.target_user_id }} ·
        {{ detail.target_type }}#{{ detail.target_id }} · {{ detail.reason }}
      </div>
      <p class="small" style="white-space:pre-wrap">{{ detail.description }}</p>
      <div v-if="detail.evidence?.length" class="chips mt8">
        <a v-for="(e, i) in detail.evidence" :key="i" :href="imageUrl(e)" target="_blank" class="chip">证据 {{ i + 1 }}</a>
      </div>

      <div class="chips mt12">
        <button v-if="detail.status === 'pending'" class="btn btn-sm btn-primary" @click="accept">受理投诉</button>
      </div>

      <div class="card mt12">
        <div class="bold">裁定</div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
          <div>
            <label>裁定结果</label>
            <select v-model="decideForm.decision">
              <option value="valid">成立</option>
              <option value="invalid">不成立</option>
            </select>
          </div>
          <div>
            <label>严重度</label>
            <select v-model="decideForm.severity">
              <option value="light">轻度</option>
              <option value="serious">较严重</option>
              <option value="severe">严重（一票）</option>
            </select>
          </div>
          <div>
            <label>处罚类型（留空则按累计次数自动梯度）</label>
            <select v-model="decideForm.type">
              <option value="">自动梯度</option>
              <option value="warning">站内警告</option>
              <option value="mute">禁言</option>
              <option value="trade_ban">禁止交易</option>
              <option value="login_ban">禁止登录</option>
              <option v-if="auth.isPlatformAdmin" value="permanent_ban">永久封禁</option>
            </select>
          </div>
          <div>
            <label>天数（可空）</label>
            <input v-model.trim="decideForm.days" type="number" min="0" />
          </div>
        </div>
        <label>裁定说明（会通知双方）</label>
        <textarea v-model.trim="decideForm.note" maxlength="500" />
        <button class="btn btn-primary btn-sm mt8" @click="decide">提交裁定</button>
      </div>
    </div>

    <div class="card">
      <div class="bold">申诉复审</div>
      <table class="table mt8">
        <thead><tr><th>申诉单号</th><th>用户</th><th>处罚 ID</th><th>理由</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in appeals" :key="a.id">
            <td class="small">{{ a.appeal_no }}</td>
            <td>{{ a.user_id }}</td>
            <td>{{ a.penalty_id }}</td>
            <td class="small">{{ a.reason }}</td>
            <td><StatusTag :map="APPEAL_STATUS" :value="a.status" /></td>
            <td>
              <template v-if="a.status === 'pending'">
                <button class="btn btn-sm btn-primary" @click="reviewAppeal(a, true)">通过并撤销处罚</button>
                <button class="btn btn-sm" @click="reviewAppeal(a, false)">驳回</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="appeals.length === 0" text="暂无申诉" icon="⚖️" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { reportApi } from '../../api/index.js';
import { APPEAL_STATUS, REPORT_STATUS, formatTime } from '../../utils/format.js';
import { imageUrl } from '../../utils/image.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import StatusTag from '../../components/StatusTag.vue';

const { auth, schoolId, ready } = useScope();
const list = ref([]);
const stats = ref(null);
const detail = ref(null);
const appeals = ref([]);
const status = ref('');
const decideForm = reactive({ decision: 'valid', severity: 'light', type: '', days: '', note: '' });

async function load() {
  if (!ready.value) { list.value = []; return; }
  const data = await reportApi.list({ status: status.value || undefined, pageSize: 30 });
  list.value = data.list;
  stats.value = await reportApi.stats();
  const appealData = await reportApi.appeals({ pageSize: 30 });
  appeals.value = appealData.list;
}

async function open(id) {
  try {
    detail.value = await reportApi.detail(id);
  } catch (err) {
    toastError(err?.message || '加载投诉失败');
  }
}

async function accept() {
  try {
    await reportApi.accept(detail.value.id, {});
    toastOk('已受理，已通知被投诉人举证');
    await open(detail.value.id);
    await load();
  } catch (err) {
    toastError(err?.message || '受理失败');
  }
}

async function decide() {
  if (decideForm.note.length < 2) { toastError('请填写裁定说明'); return; }
  try {
    await reportApi.decide(detail.value.id, {
      decision: decideForm.decision,
      severity: decideForm.severity,
      type: decideForm.type || undefined,
      days: decideForm.days === '' ? undefined : Number(decideForm.days),
      note: decideForm.note,
    });
    toastOk('已裁定并执行处罚');
    decideForm.note = '';
    await open(detail.value.id);
    await load();
  } catch (err) {
    toastError(err?.message || '裁定失败');
  }
}

async function reviewAppeal(appeal, approve) {
  const note = window.prompt(approve ? '复审通过说明' : '驳回说明');
  if (!note) return;
  try {
    await reportApi.reviewAppeal(appeal.id, { approve, note });
    toastOk(approve ? '已撤销处罚并回滚信誉分' : '已驳回申诉');
    await load();
  } catch (err) {
    toastError(err?.message || '复审失败');
  }
}

watch(schoolId, load);
onMounted(load);
</script>
