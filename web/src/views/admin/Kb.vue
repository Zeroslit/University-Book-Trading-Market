<template>
  <div>
    <div class="card">
      <div class="bold">客服知识库（AI 客服 FAQ 数据源）</div>
      <p class="small muted">AI 客服第一层能力：知识库 FAQ 检索；命中意图后回答，涉及资金只能查询与创建申请。</p>
      <div class="grid mt12" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
        <div><label>分类</label><input v-model.trim="form.category" placeholder="如 订单 / 退款" /></div>
        <div><label>关键词（逗号分隔）</label><input v-model.trim="form.keywords" placeholder="退款,退货,钱" /></div>
      </div>
      <label>问题</label>
      <input v-model.trim="form.question" maxlength="300" />
      <label>答案</label>
      <textarea v-model.trim="form.answer" style="min-height:120px" />
      <button class="btn btn-primary mt12" @click="create">新增知识条目</button>
      <p class="small muted mt8">仅平台管理员可维护知识库（POST/PATCH 接口要求 platform_admin）。</p>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>ID</th><th>分类</th><th>问题</th><th>关键词</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in articles" :key="a.id">
            <td>{{ a.id }}</td>
            <td class="small">{{ a.category }}</td>
            <td>
              {{ a.question }}
              <div class="small muted" style="white-space:pre-wrap">{{ a.answer }}</div>
            </td>
            <td class="small">{{ a.keywords }}</td>
            <td><button class="btn btn-sm" @click="offline(a)">下线</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="articles.length === 0" text="知识库为空" icon="📖" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { kbApi } from '../../api/index.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';

const articles = ref([]);
const form = reactive({ category: '', question: '', answer: '', keywords: '' });

async function load() {
  const data = await kbApi.articles({ pageSize: 50 });
  articles.value = data.list;
}

async function create() {
  if (form.question.length < 4 || form.answer.length < 4) { toastError('问题与答案至少 4 个字'); return; }
  try {
    await kbApi.create({
      category: form.category || undefined, question: form.question, answer: form.answer,
      keywords: form.keywords || undefined,
    });
    toastOk('知识条目已创建');
    form.question = ''; form.answer = ''; form.keywords = '';
    await load();
  } catch (err) {
    toastError(err?.message || '创建失败');
  }
}

async function offline(a) {
  try {
    await kbApi.update(a.id, { status: 'offline' });
    toastOk('已下线');
    await load();
  } catch (err) {
    toastError(err?.message || '操作失败');
  }
}

onMounted(load);
</script>
