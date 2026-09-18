<template>
  <div>
    <div class="card">
      <div class="bold">处罚申诉</div>
      <p class="small muted">
        每一笔处罚都可申诉：处罚后 3 天为申诉期，复审通过将撤销处罚并回滚信誉分。
        封禁期间进行中的订单仍可正常完成或退款，资金不会被锁死。
      </p>
      <p class="small muted">申诉次数口径：仅统计「裁定成立」的记录；轻度违规 12 个月滚动过期，连续 6 个月无违规可消除 1 次。</p>
    </div>

    <div class="card">
      <div class="bold">我的处罚记录</div>
      <div v-if="penaltyNotices.length === 0" class="small muted">暂无处罚记录 🎉</div>
      <div v-for="n in penaltyNotices" :key="n.id" class="card" style="margin-top:8px">
        <div class="row-between">
          <div class="bold">{{ n.title }}</div>
          <span class="small muted">{{ formatTime(n.sent_at) }}</span>
        </div>
        <div class="small" style="white-space:pre-wrap">{{ n.content }}</div>
        <label>申诉理由（不少于 5 个字）</label>
        <textarea v-model.trim="appealReasons[n.related_id]" maxlength="1500" />
        <button class="btn btn-sm btn-primary mt8" @click="submitAppeal(n.related_id)">提交申诉</button>
      </div>
    </div>

    <div class="card">
      <div class="bold">我的申诉记录</div>
      <table class="table mt8">
        <thead><tr><th>申诉单号</th><th>处罚 ID</th><th>理由</th><th>状态</th><th>复审说明</th><th>提交时间</th></tr></thead>
        <tbody>
          <tr v-for="a in appeals" :key="a.id">
            <td class="small">{{ a.appeal_no }}</td>
            <td>{{ a.penalty_id }}</td>
            <td class="small">{{ a.reason }}</td>
            <td><StatusTag :map="APPEAL_STATUS" :value="a.status" /></td>
            <td class="small">{{ a.review_note || '—' }}</td>
            <td class="small">{{ formatTime(a.created_at) }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="appeals.length === 0" text="还没有申诉记录" icon="⚖️" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { reportApi, notificationApi } from '../api/index.js';
import { APPEAL_STATUS, formatTime } from '../utils/format.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import StatusTag from '../components/StatusTag.vue';

const penaltyNotices = ref([]);
const appeals = ref([]);
const appealReasons = reactive({});

async function load() {
  const data = await notificationApi.list({ type: 'penalty', pageSize: 30 });
  penaltyNotices.value = data.list.filter((n) => n.related_type === 'penalty' && n.related_id);
  const appealData = await reportApi.appeals({ pageSize: 30 });
  appeals.value = appealData.list;
}

async function submitAppeal(penaltyId) {
  const reason = appealReasons[penaltyId];
  if (!reason || reason.length < 5) { toastError('申诉理由不少于 5 个字'); return; }
  try {
    await reportApi.appeal({ penaltyId: Number(penaltyId), reason });
    toastOk('申诉已提交，复审结果将通过站内信通知');
    appealReasons[penaltyId] = '';
    await load();
  } catch (err) {
    toastError(err?.message || '申诉提交失败');
  }
}

onMounted(load);
</script>
