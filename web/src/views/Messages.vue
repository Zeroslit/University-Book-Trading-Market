<template>
  <div class="card">
    <div class="row-between">
      <div class="bold">{{ $t('私信') }}</div>
      <span class="small muted">{{ $t('消息内容同样经过违禁词检测（L2 及以上会被拦截）') }}</span>
    </div>

    <div class="msg-layout mt12">
      <div class="conv-list">
        <div v-if="conversations.length === 0" class="small muted" style="padding:12px">{{ $t('还没有会话') }}</div>
        <button
          v-for="c in conversations" :key="c.id" class="conv-item" :class="{ active: c.id === currentId }"
          @click="openConversation(c.id)"
        >
          <div class="row-between">
            <span class="bold">{{ c.peer_nickname }}</span>
            <span v-if="c.unread" class="tag tag-danger">{{ c.unread }}</span>
          </div>
          <div class="small muted">{{ c.last_message_preview || $t('（暂无消息）') }}</div>
          <div class="small muted">{{ c.book_id ? `${$t('关联图书 #{0}', [c.book_id])}` : c.thread_id ? `${$t('关联帖子 #{0}', [c.thread_id])}` : $t('普通会话') }}</div>
        </button>
      </div>

      <div class="chat-panel">
        <div v-if="currentId" class="chat" ref="chatBox">
          <div v-for="m in messages" :key="m.id" class="bubble" :class="{ mine: m.sender_id === auth.user?.id }">
            {{ m.content || $t('[图片]') }}
            <div v-if="m.image_url" class="mt8">
              <img :src="imageUrl(m.image_url)" style="max-width:180px;border-radius:8px" :alt="$t('聊天图片')" />
            </div>
          </div>
        </div>
        <EmptyState v-else :text="$t('选择左侧会话开始聊天')" icon="✉️" />

        <div v-if="currentId" class="mt12">
          <div class="row">
            <input v-model.trim="draft" :placeholder="$t('输入消息…')" @keyup.enter="send" />
            <button class="btn btn-primary" :disabled="sending" @click="send">{{ $t('发送') }}</button>
          </div>
          <div class="mt8"><ImageUploader v-model="pendingImages" :max="1" :camera="false" /></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { messageApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { imageUrl } from '../utils/image.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import ImageUploader from '../components/ImageUploader.vue';

const route = useRoute();
const auth = useAuthStore();
const conversations = ref([]);
const messages = ref([]);
const currentId = ref(null);
const draft = ref('');
const pendingImages = ref([]);
const sending = ref(false);
const chatBox = ref(null);
let timer = null;

async function loadConversations() {
  try {
    conversations.value = (await messageApi.conversations({ pageSize: 50 })).list;
  } catch { /* 忽略 */ }
}

async function openConversation(id) {
  currentId.value = Number(id);
  const data = await messageApi.messages(id, { pageSize: 100 });
  messages.value = data.list || [];
  await scrollToBottom();
  await loadConversations();
}

async function scrollToBottom() {
  await nextTick();
  if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
}

async function send() {
  const text = draft.value;
  const imageUrlValue = pendingImages.value[0];
  if (!text && !imageUrlValue) return;
  sending.value = true;
  try {
    await messageApi.send(currentId.value, { content: text || undefined, imageUrl: imageUrlValue || undefined });
    draft.value = '';
    pendingImages.value = [];
    await openConversation(currentId.value);
  } catch (err) {
    toastError(err?.message || t('发送失败'));
  } finally {
    sending.value = false;
  }
}

onMounted(async () => {
  await loadConversations();
  if (route.query.conversationId) await openConversation(route.query.conversationId);
  timer = setInterval(async () => {
    await loadConversations();
    if (currentId.value) {
      const polled = await messageApi.messages(currentId.value, { pageSize: 100 });
      const latest = polled.list || [];
      if (latest.length !== messages.value.length) { messages.value = latest; await scrollToBottom(); }
    }
  }, 8000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.msg-layout { display: grid; grid-template-columns: 260px 1fr; gap: 12px; }
.conv-list { border-right: 1px solid var(--border); max-height: 560px; overflow-y: auto; }
.conv-item { display: block; width: 100%; text-align: left; padding: 10px; border: none; border-bottom: 1px solid var(--border); background: #fff; cursor: pointer; }
.conv-item.active { background: rgba(31,111,235,.08); }
.chat-panel { min-width: 0; }
@media (max-width: 720px) { .msg-layout { grid-template-columns: 1fr; } .conv-list { border-right: none; max-height: 220px; } }
</style>

