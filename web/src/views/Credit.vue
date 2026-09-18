<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="small muted">当前信誉分</div>
          <div class="price" style="font-size:32px">{{ permissions?.score ?? auth.user?.creditScore }}</div>
          <div class="small muted">档位：{{ permissions?.tierLabel }}（{{ permissions?.tier }}）</div>
        </div>
        <div class="chips">
          <span class="chip" :class="{ active: permissions?.canPublish }">发布：{{ permissions?.canPublish ? '允许' : '禁止' }}</span>
          <span class="chip" :class="{ active: permissions?.canTrade }">交易：{{ permissions?.canTrade ? '允许' : '禁止' }}</span>
          <span class="chip">同时最多挂 {{ permissions?.maxBooks }} 本书</span>
          <span class="chip">提现{{ permissions?.withdrawDelayHours ? `延迟 ${permissions.withdrawDelayHours}h` : '即时到账' }}</span>
        </div>
      </div>
      <p class="small muted mt8">
        信誉分规则（阈值全部存于 configs 表，可按学校配置）：初始 100 分；
        90-100 优秀、70-89 良好、50-69 受限、30-49 高风险、低于 30 禁止交易。
      </p>
    </div>

    <div class="card">
      <div class="bold">加分 / 扣分规则</div>
      <table class="table mt8">
        <thead><tr><th>规则</th><th>分值</th></tr></thead>
        <tbody>
          <tr><td>按时发货</td><td>+2</td></tr>
          <tr><td>完成好评</td><td>+1</td></tr>
          <tr><td>连续 10 单无纠纷</td><td>+5</td></tr>
          <tr><td>逾期未发货</td><td>−5</td></tr>
          <tr><td>描述不符成立</td><td>−10</td></tr>
          <tr><td>投诉成立（轻）</td><td>−5</td></tr>
          <tr><td>发布违禁词</td><td>−3</td></tr>
          <tr><td>刷单虚假交易</td><td>−30 并封禁</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="bold">信誉分明细流水（可追溯）</div>
      <table class="table mt8">
        <thead><tr><th>时间</th><th>变动</th><th>变动后</th><th>规则</th><th>原因</th><th>过期时间</th></tr></thead>
        <tbody>
          <tr v-for="l in logs" :key="l.id">
            <td class="small">{{ formatTime(l.created_at) }}</td>
            <td :style="l.delta >= 0 ? 'color:var(--success)' : 'color:var(--danger)'">{{ l.delta > 0 ? `+${l.delta}` : l.delta }}</td>
            <td>{{ l.score_after }}</td>
            <td class="small">{{ l.rule_key }}</td>
            <td class="small">{{ l.reason }}</td>
            <td class="small">{{ l.expires_at ? formatTime(l.expires_at) : '长期' }}</td>
          </tr>
        </tbody>
      </table>
      <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="loadLogs" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { userApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { formatTime } from '../utils/format.js';
import Pager from '../components/Pager.vue';

const auth = useAuthStore();
const permissions = ref(null);
const logs = ref([]);
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const hasMore = ref(false);

async function loadLogs(nextPage = page.value) {
  page.value = nextPage;
  const data = await userApi.creditLogs({ page: page.value, pageSize });
  logs.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

onMounted(async () => {
  permissions.value = await userApi.credit();
  await loadLogs(1);
});
</script>
