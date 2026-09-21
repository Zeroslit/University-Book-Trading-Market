<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('内容审核队列') }}</div>
          <div class="small muted">{{ $t('本校范围内的教材 / 帖子 / 评论，可按 word_hit 命中情况优先处理。') }}</div>
        </div>
        <div class="tabs" style="margin:0">
          <button class="tab" :class="{ active: type === 'book' }" @click="setType('book')">{{ $t('教材') }}</button>
          <button class="tab" :class="{ active: type === 'thread' }" @click="setType('thread')">{{ $t('帖子') }}</button>
          <button class="tab" :class="{ active: type === 'reply' }" @click="setType('reply')">{{ $t('评论') }}</button>
        </div>
      </div>
    </div>

    <div v-if="list.length" class="mt12">
      <div v-for="row in list" :key="row.id" class="card">
        <div class="row-between wrap">
          <div class="bold">{{ row.title }}</div>
          <div class="chips">
            <span v-if="row.wordHit" class="tag tag-danger">{{ $t('命中 {0}：{1}', [row.wordHit.level, row.wordHit.word]) }}</span>
            <span class="tag">{{ row.status }}</span>
          </div>
        </div>
        <div class="small muted mt8">{{ $t('#{0} · 作者 {1} · {2}', [row.id, row.author_nickname || row.author_id, formatTime(row.created_at)]) }}</div>
        <p v-if="row.content" class="small" style="white-space:pre-wrap">{{ row.content }}</p>
        <div class="chips mt8">
          <button class="btn btn-sm" @click="review(row, 'approve')">{{ $t('通过 / 恢复') }}</button>
          <button class="btn btn-sm" @click="review(row, 'hide')">{{ $t('下架 / 隐藏') }}</button>
          <button class="btn btn-sm btn-danger" @click="review(row, 'delete')">{{ $t('删除') }}</button>
        </div>
      </div>
    </div>
    <EmptyState v-else :text="$t('暂无待审核内容')" icon="🧹" />
  </div>
</template>

<script setup>
import { t } from '../../i18n/index.js';
import { onMounted, ref, watch } from 'vue';
import { adminApi } from '../../api/index.js';
import { formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';

const { schoolId, ready } = useScope();
const type = ref('book');
const list = ref([]);

function setType(next) { type.value = next; load(); }

async function load() {
  if (!ready.value) { list.value = []; return; }
  const data = await adminApi.contents({ type: type.value, pageSize: 30 }, schoolId.value);
  list.value = data.list;
}

async function review(row, action) {
  let reason = '';
  if (action !== 'approve') {
    reason = window.prompt(t('请填写处理原因（会通知作者）')) || '';
    if (reason.length < 2) { toastError(t('请填写原因')); return; }
  }
  try {
    await adminApi.reviewContent(type.value, row.id, { action, reason: reason || undefined }, schoolId.value);
    toastOk(t('审核完成'));
    await load();
  } catch (err) {
    toastError(err?.message || t('审核失败'));
  }
}

watch(schoolId, load);
onMounted(load);
</script>
