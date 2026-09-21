<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('审计日志') }}</div>
          <div class="small muted">{{ $t('跨校访问、敏感数据读取、处罚、配置变更等全部留痕，可反查证据链。') }}</div>
        </div>
        <div class="row" style="gap:8px">
          <input v-model.trim="action" :placeholder="$t('按 action 过滤，如 cross_school_access')" />
          <button class="btn btn-sm" @click="load">{{ $t('查询') }}</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>{{ $t('时间') }}</th><th>{{ $t('学校') }}</th><th>{{ $t('操作者') }}</th><th>{{ $t('角色') }}</th><th>{{ $t('动作') }}</th><th>{{ $t('对象') }}</th><th>IP</th><th>{{ $t('明细') }}</th></tr></thead>
        <tbody>
          <tr v-for="l in list" :key="l.id">
            <td class="small">{{ formatTime(l.created_at) }}</td>
            <td>{{ l.school_id ?? $t('平台') }}</td>
            <td>{{ l.actor_id ?? $t('系统') }}</td>
            <td class="small">{{ l.actor_role }}</td>
            <td class="small">{{ l.action }}</td>
            <td class="small">{{ l.target_type }}#{{ l.target_id }}</td>
            <td class="small">{{ l.ip }}</td>
            <td class="small" style="max-width:280px;word-break:break-all">{{ l.detail }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="list.length === 0" :text="$t('暂无日志')" icon="📜" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { adminApi } from '../../api/index.js';
import { formatTime } from '../../utils/format.js';
import EmptyState from '../../components/EmptyState.vue';

const list = ref([]);
const action = ref('');

async function load() {
  const data = await adminApi.auditLogs({ action: action.value || undefined, pageSize: 50 });
  list.value = data.list;
}

onMounted(load);
</script>
