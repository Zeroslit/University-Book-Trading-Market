<template>
  <div v-if="thread">
    <div class="card">
      <div class="row-between wrap">
        <h2 style="margin:0">{{ thread.title }}</h2>
        <StatusTag :map="THREAD_TYPE" :value="thread.type" />
      </div>
      <div class="small muted mt8">
        {{ thread.author_nickname }} · 信誉 {{ thread.author_credit }} · {{ formatTime(thread.created_at) }} · {{ thread.view_count }} 浏览
      </div>
      <p style="white-space:pre-wrap">{{ thread.content }}</p>
      <div v-if="thread.images?.length" class="row" style="gap:8px;flex-wrap:wrap">
        <img
          v-for="(img, i) in thread.images" :key="i" :src="imageUrl(img.url)"
          style="width:160px;height:160px;object-fit:cover;border-radius:8px;border:1px solid var(--border)" :alt="`配图${i + 1}`"
        />
      </div>
      <div class="row mt12">
        <button v-if="!thread.isMine" class="btn" @click="contact">私信作者</button>
        <button class="btn btn-sm" @click="showReport = !showReport">举报</button>
      </div>
    </div>

    <div v-if="showReport" class="card">
      <div class="bold">举报该帖子</div>
      <label>举报原因</label>
      <input v-model.trim="reportForm.reason" maxlength="60" />
      <label>补充说明</label>
      <textarea v-model.trim="reportForm.description" maxlength="1000" />
      <button class="btn btn-danger btn-sm mt12" @click="submitReport">提交举报</button>
    </div>

    <div class="card">
      <div class="bold">评论（{{ thread.replies.length }}）</div>
      <div v-if="thread.replies.length" class="mt12">
        <div v-for="r in thread.replies" :key="r.id" style="border-bottom:1px solid var(--border);padding:8px 0">
          <div class="small muted">
            {{ r.floor_no }} 楼 · {{ r.author_nickname }} · 信誉 {{ r.author_credit }} · {{ formatTime(r.created_at) }}
          </div>
          <div style="white-space:pre-wrap">{{ r.content }}</div>
          <div class="chips mt8">
            <button class="chip" @click="replyTo = r">回复</button>
            <button v-if="r.author_id === auth.user?.id" class="chip" @click="removeReply(r.id)">删除</button>
          </div>
        </div>
      </div>
      <EmptyState v-else text="还没有评论，来抢沙发" icon="💬" />

      <div class="mt12">
        <div v-if="replyTo" class="small muted">
          回复 {{ replyTo.floor_no }} 楼 {{ replyTo.author_nickname }}
          <button class="btn btn-sm" @click="replyTo = null">取消</button>
        </div>
        <label>发表评论（会经过违禁词检测，发布前请勿留电话/微信等联系方式）</label>
        <textarea v-model.trim="replyContent" maxlength="2000" style="min-height:80px" />
        <button class="btn btn-primary mt8" :disabled="replying" @click="submitReply">
          {{ replying ? '提交中…' : '发表' }}
        </button>
      </div>
    </div>
  </div>
  <EmptyState v-else text="帖子不存在或不属于本校" icon="🔍" />
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { threadApi, messageApi, reportApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { THREAD_TYPE, formatTime } from '../utils/format.js';
import { imageUrl } from '../utils/image.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import StatusTag from '../components/StatusTag.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const thread = ref(null);
const replyContent = ref('');
const replyTo = ref(null);
const replying = ref(false);
const showReport = ref(false);
const reportForm = reactive({ reason: '', description: '' });

async function load() {
  try {
    thread.value = await threadApi.detail(route.params.id);
  } catch {
    thread.value = null;
  }
}

async function contact() {
  try {
    const data = await messageApi.open({ threadId: thread.value.id });
    router.push({ path: '/messages', query: { conversationId: data.conversationId } });
  } catch (err) {
    toastError(err?.message || '发起会话失败');
  }
}

async function submitReply() {
  if (replyContent.value.length < 1) { toastError('请输入评论内容'); return; }
  replying.value = true;
  try {
    await threadApi.reply(thread.value.id, { content: replyContent.value, parentId: replyTo.value?.id });
    toastOk('评论成功');
    replyContent.value = '';
    replyTo.value = null;
    await load();
  } catch (err) {
    toastError(err?.message || '评论失败');
  } finally {
    replying.value = false;
  }
}

async function removeReply(id) {
  try {
    await threadApi.removeReply(id);
    toastOk('已删除');
    await load();
  } catch (err) {
    toastError(err?.message || '删除失败');
  }
}

async function submitReport() {
  if (reportForm.reason.length < 2) { toastError('请填写举报原因'); return; }
  try {
    await reportApi.create({
      targetType: 'thread', targetId: thread.value.id,
      reason: reportForm.reason, description: reportForm.description || undefined,
    });
    toastOk('举报已提交');
    showReport.value = false;
    reportForm.reason = ''; reportForm.description = '';
  } catch (err) {
    toastError(err?.message || '举报失败');
  }
}

watch(() => route.params.id, load);
onMounted(load);
</script>
