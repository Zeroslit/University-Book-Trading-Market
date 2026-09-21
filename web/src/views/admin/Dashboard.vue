<template>
  <div>
    <div class="card">
      <div class="bold">{{ $t('数据看板 {0}', [schoolName]) }}</div>
      <p class="small muted">{{ $t('仅统计当前学校（school_id 强制过滤）的数据。') }}</p>
      <p v-if="!ready" class="notice notice-error">{{ $t('请先在顶部选择要管理的学校') }}</p>
    </div>

    <template v-if="data">
      <div class="grid">
        <div class="card"><div class="small muted">{{ $t('在售教材') }}</div><div class="bold" style="font-size:22px">{{ data.onSaleBooks }}</div></div>
        <div class="card"><div class="small muted">{{ $t('论坛帖子') }}</div><div class="bold" style="font-size:22px">{{ data.publishedThreads }}</div></div>
        <div class="card"><div class="small muted">{{ $t('托管冻结资金') }}</div><div class="bold" style="font-size:22px">¥{{ yuan(data.escrowFrozenCents) }}</div></div>
        <div class="card"><div class="small muted">{{ $t('累计 GMV') }}</div><div class="bold" style="font-size:22px">¥{{ yuan(data.gmvCents) }}</div></div>
        <div class="card"><div class="small muted">{{ $t('平台服务费收入') }}</div><div class="bold" style="font-size:22px">¥{{ yuan(data.platformFeeCents) }}</div></div>
        <div class="card"><div class="small muted">{{ $t('生效中的处罚') }}</div><div class="bold" style="font-size:22px">{{ data.reports?.activePenalties ?? 0 }}</div></div>
      </div>

      <div class="card">
        <div class="bold">{{ $t('订单状态分布') }}</div>
        <table class="table mt8">
          <thead><tr><th>{{ $t('状态') }}</th><th>{{ $t('订单数') }}</th><th>{{ $t('金额') }}</th></tr></thead>
          <tbody>
            <tr v-for="o in data.orders" :key="o.status">
              <td><StatusTag :map="ORDER_STATUS" :value="o.status" /></td>
              <td>{{ o.total }}</td>
              <td>¥{{ yuan(o.amount) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">{{ $t('用户认证分布') }}</div>
        <table class="table mt8">
          <thead><tr><th>{{ $t('认证状态') }}</th><th>{{ $t('人数') }}</th></tr></thead>
          <tbody>
            <tr v-for="u in data.users" :key="u.verification_status">
              <td><StatusTag :map="VERIFICATION_STATUS" :value="u.verification_status" /></td>
              <td>{{ u.total }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">{{ $t('工单 SLA') }}</div>
        <p class="small muted">{{ $t('超时未处理：{0} 单', [data.tickets?.overdue ?? 0]) }}</p>
        <table class="table mt8">
          <thead><tr><th>{{ $t('状态') }}</th><th>{{ $t('优先级') }}</th><th>{{ $t('数量') }}</th><th>{{ $t('按时首响') }}</th><th>{{ $t('已升级') }}</th></tr></thead>
          <tbody>
            <tr v-for="t in data.tickets?.groups || []" :key="t.status + t.priority">
              <td>{{ t.status }}</td>
              <td>{{ t.priority }}</td>
              <td>{{ t.total }}</td>
              <td>{{ t.on_time }}</td>
              <td>{{ t.escalated }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="bold">{{ $t('投诉与处罚') }}</div>
        <table class="table mt8">
          <thead><tr><th>{{ $t('投诉状态') }}</th><th>{{ $t('严重度') }}</th><th>{{ $t('数量') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in data.reports?.byStatus || []" :key="r.status + r.severity">
              <td>{{ r.status }}</td>
              <td>{{ r.severity }}</td>
              <td>{{ r.total }}</td>
            </tr>
          </tbody>
        </table>
        <p class="small muted">{{ $t('裁定成立投诉：{0} 起', [data.reports?.validReports ?? 0]) }}</p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { adminApi } from '../../api/index.js';
import { ORDER_STATUS, VERIFICATION_STATUS, centsToYuan } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import StatusTag from '../../components/StatusTag.vue';

const { auth, schoolId, ready } = useScope();
const data = ref(null);
const yuan = centsToYuan;
const schoolName = computed(() => auth.schoolName);

async function load() {
  if (!ready.value) { data.value = null; return; }
  data.value = await adminApi.dashboard(schoolId.value);
}

watch(schoolId, load);
onMounted(load);
</script>
