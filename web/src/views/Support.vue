<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('客服中心') }}</div>
          <div class="small muted">
            {{ $t('AI 客服 7×24 小时在线；人工客服 9:00-21:00。AI 无权直接放款或退款，涉及资金只能查询与创建申请。') }}
          </div>
        </div>
        <div class="chips">
          <span class="chip">{{ $t('会话 {0}', [sessionId ? `#${sessionId}` : $t('未开始')]) }}</span>
          <span v-if="channel === 'human'" class="chip active">{{ $t('已转人工') }}</span>
        </div>
      </div>

      <div class="chat mt12" ref="chatBox">
        <div v-for="m in messages" :key="m.id" class="bubble" :class="{ mine: m.role === 'user' }">
          <span class="small muted">{{ roleLabel(m.role) }}</span>
          <div style="white-space:pre-wrap">{{ m.content }}</div>
          <div v-if="m.intent" class="small muted">{{ $t('意图：{0}（置信度 {1}）', [m.intent, m.confidence ?? '-']) }}</div>
        </div>
        <EmptyState v-if="messages.length === 0" :text="$t('点击下方「开始咨询」与 AI 客服对话')" icon="🤖" />
      </div>

      <div class="row mt12" style="gap:8px">
        <input v-model.trim="draft" :placeholder="$t('描述你的问题，如：我的订单到哪了？')" @keyup.enter="send" />
        <button class="btn btn-primary" :disabled="sending || !sessionId" @click="send">{{ $t('发送') }}</button>
      </div>
      <div class="chips mt8">
        <button v-if="!sessionId" class="btn btn-sm btn-primary" @click="start">{{ $t('开始咨询') }}</button>
        <button v-if="sessionId" class="btn btn-sm" @click="transfer">{{ $t('转人工客服') }}</button>
        <button v-if="sessionId" class="btn btn-sm" @click="start">{{ $t('开启新会话') }}</button>
      </div>
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <p v-if="ticketId" class="notice notice-info mt12">{{ $t('已生成工单 #{0}：普通工单 24 小时内响应，资金类 4 小时内响应，超时将自动升级并通知你。', [ticketId]) }}</p>
    </div>

    <div class="card">
      <div class="bold">{{ $t('知识库 FAQ') }}</div>
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="keyword" :placeholder="$t('搜索问题关键词')" @keyup.enter="searchKb" />
        <button class="btn btn-sm" @click="searchKb">{{ $t('搜索') }}</button>
      </div>
      <div v-for="a in articles" :key="a.id" style="border-bottom:1px solid var(--border);padding:10px 0">
        <div class="bold">{{ a.question }}</div>
        <div class="small muted" style="white-space:pre-wrap">{{ a.answer }}</div>
      </div>
      <EmptyState v-if="articles.length === 0" :text="$t('暂无知识条目')" icon="📖" />
    </div>

    <div class="card">
      <div class="bold">{{ $t('创建人工工单') }}</div>
      <label>{{ $t('工单类型') }}</label>
      <select v-model="ticketForm.type">
        <option value="order">{{ $t('订单问题') }}</option>
        <option value="refund">{{ $t('退款 / 资金') }}</option>
        <option value="account">{{ $t('账号问题') }}</option>
        <option value="content">{{ $t('内容违规') }}</option>
        <option value="other">{{ $t('其他') }}</option>
      </select>
      <label>{{ $t('标题') }}</label>
      <input v-model.trim="ticketForm.subject" maxlength="200" />
      <label>{{ $t('描述') }}</label>
      <textarea v-model.trim="ticketForm.description" maxlength="2000" />
      <label>{{ $t('关联订单号（可选，填订单 ID）') }}</label>
      <input v-model.trim="ticketForm.relatedOrderId" />
      <button class="btn btn-primary mt12" :disabled="creating" @click="createTicket">{{ $t('提交工单') }}</button>
      <p v-if="ticketCreated" class="notice notice-success mt12">{{ $t('工单 #{0} 已创建，可在「消息通知」跟踪进展。', [ticketCreated]) }}</p>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { nextTick, onMounted, reactive, ref } from 'vue';
import { chatApi, kbApi, ticketApi } from '../api/index.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';

const sessionId = ref(null);
const channel = ref('ai');
const messages = ref([]);
const draft = ref('');
const sending = ref(false);
const error = ref('');
const ticketId = ref(null);
const chatBox = ref(null);
const articles = ref([]);
const keyword = ref('');
const creating = ref(false);
const ticketCreated = ref(null);
const ticketForm = reactive({ type: 'other', subject: '', description: '', relatedOrderId: '' });

function roleLabel(role) {
  return { user: t('我'), ai: t('AI 客服'), human: t('人工客服'), system: t('系统') }[role] || role;
}

async function scrollToBottom() {
  await nextTick();
  if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
}

async function start() {
  error.value = '';
  try {
    const data = await chatApi.start();
    sessionId.value = data.sessionId;
    channel.value = data.channel;
    ticketId.value = null;
    await refresh();
  } catch (err) {
    error.value = err?.message || t('会话创建失败');
  }
}

async function refresh() {
  if (!sessionId.value) return;
  const data = await chatApi.session(sessionId.value);
  messages.value = data.messages;
  channel.value = data.session.channel;
  ticketId.value = data.session.ticket_id;
  await scrollToBottom();
}

async function send() {
  if (!draft.value) return;
  const content = draft.value;
  draft.value = '';
  sending.value = true;
  try {
    const result = await chatApi.send(sessionId.value, { content });
    if (result.ticketId) ticketId.value = result.ticketId;
    await refresh();
  } catch (err) {
    toastError(err?.message || t('发送失败'));
  } finally {
    sending.value = false;
  }
}

async function transfer() {
  try {
    const data = await chatApi.transfer(sessionId.value, { reason: t('用户主动要求转人工（页面按钮）') });
    ticketId.value = data.ticketId || ticketId.value;
    toastOk(t('已转人工客服，工作时间 9:00-21:00'));
    await refresh();
  } catch (err) {
    toastError(err?.message || t('转人工失败'));
  }
}

async function searchKb() {
  const data = await kbApi.articles({ keyword: keyword.value || undefined, pageSize: 20 });
  articles.value = data.list;
}

async function createTicket() {
  if (ticketForm.subject.length < 4) { toastError(t('标题至少 4 个字')); return; }
  creating.value = true;
  try {
    const data = await ticketApi.create({
      type: ticketForm.type, subject: ticketForm.subject,
      description: ticketForm.description || undefined,
      relatedOrderId: ticketForm.relatedOrderId ? Number(ticketForm.relatedOrderId) : undefined,
    });
    ticketCreated.value = data.ticketId;
    ticketForm.subject = ''; ticketForm.description = ''; ticketForm.relatedOrderId = '';
    toastOk(t('工单已创建'));
  } catch (err) {
    toastError(err?.message || t('工单创建失败'));
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  await searchKb();
});
</script>
