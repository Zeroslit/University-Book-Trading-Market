<template>
  <div v-if="total > pageSize" class="row-between mt12">
    <span class="small muted">共 {{ total }} 条 · 第 {{ page }} / {{ maxPage }} 页</span>
    <span class="row">
      <button class="btn btn-sm" :disabled="page <= 1" @click="go(page - 1)">上一页</button>
      <button class="btn btn-sm" :disabled="!hasMore" @click="go(page + 1)">下一页</button>
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  total: { type: Number, default: 0 },
  hasMore: { type: Boolean, default: false },
});
const emit = defineEmits(['change']);
const maxPage = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
function go(next) {
  if (next < 1 || next > maxPage.value) return;
  emit('change', next);
}
</script>
