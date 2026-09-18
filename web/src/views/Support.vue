<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">客服中心</div>
          <div class="small muted">
            AI 客服 7×24 小时在线；人工客服 9:00-21:00。AI 无权直接放款或退款，涉及资金只能查询与创建申请。
          </div>
        </div>
        <div class="chips">
          <span class="chip">会话 {{ sessionId ? `#${sessionId}` : '未开始' }}</span>
          <span v-if="channel === 'human'" class="chip active">已转人工</span>
        </div>
      </div>

      <div class="chat mt12" ref="chatBox">
        <div v-for="m in messages" :key="m.id" class="bubble" :class="{ mine: m.role === 'user' }">
          <span class="small muted">{{ roleLabel(m.role) }}</span>
          <div style="white-space:pre-wrap">{{ m.content }}</div>
          <div v-if="m.intent" class="small muted">意图：{{ m.intent }}（置信度 {{ m.confidence ?? '-' }}）</div>
        </div>
        <EmptyState v-if="messages.length === 0" text="点击下方「开始咨询」与 AI 客服对话" icon="🤖" />
      </div>

      <div class="row mt12" style="gap:8px">
        <input v-model.trim="draft" placeholder="描述你的问题，如：我的订单到哪了？" @keyup.enter="send" />
        <button class="btn btn-primary" :disabled="sending || !sessionId" @click="send">发送</button>
      </div>
      <div class="chips mt8">
        <button v-if="!sessionId" class="btn btn-sm btn-primary" @click="start">开始咨询</button>
        <button v-if="sessionId" class="btn btn-sm" @click="transfer">转人工客服</button>
        <button v-if="sessionId" class="btn btn-sm" @click="start">开启新会话</button>
      </div>
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <p v-if="ticketId" class="notice notice-info mt12">
        已生成工单 #{{ ticketId }}：普通工单 24 小时内响应，资金类 4 小时内响应，超时将自动升级并通知你。
      </p>
    </div>

    <div class="card">
      <div class="bold">知识库 FAQ</div>
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="keyword" placeholder="搜索问题关键词" @keyup.enter="searchKb" />
        <button class="btn btn-sm" @click="searchKb">搜索</button>
      </div>
      <div v-for="a in articles" :key="a.id" style="border-bottom:1px solid var(--border);padding:10px 0">
        <div class="bold">{{ a.question }}</div>
        <div class="small muted" style="white-space:pre-wrap">{{ a.answer }}</div>
      </div>
      <EmptyState v-if="articles.length === 0" text="暂无知识条目" icon="📖" />
    </div>

    <div class="card">
      <div class="bold">创建人工工单</div>
      <label>工单类型</label>
      <select v-model="ticketForm.type">
        <option value="order">订单问题</option>
        <option value="refund">退款 / 资金</option>
        <option value="account">账号问题</option>
        <option value="content">内容违规</option>
        <option value="other">其他</option>
      </select>
      <label>标题</label>
      <input v-model.trim="ticketForm.subject" maxlength="200" />
      <label>描述</label>
      <textarea v-model.trim="ticketForm.description" maxlength="2000" />
      <label>关联订单号（可选，填订单 ID）</label>
      <input v-model.trim="ticketForm.relatedOrderId" />
      <button class="btn btn-primary mt12" :disabled="creating" @click="createTicket">提交工单</button>
      <p v-if="ticketCreated" class="notice notice-success mt12">工单 #{{ ticketCreated }} 已创建，可在「消息通知」跟踪进展。</p>
    </div>
  </div>
</template>

<script setup>
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
  return { user: '我', ai: 'AI 客服', human: '人工客服', system: '系统' }[role] || role;
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
    error.value = err?.message || '会话创建失败';
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
    toastError(err?.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

async function transfer() {
  try {
    const data = await chatApi.transfer(sessionId.value, { reason: '用户主动要求转人工（页面按钮）' });
    ticketId.value = data.ticketId || ticketId.value;
    toastOk('已转人工客服，工作时间 9:00-21:00');
    await refresh();
  } catch (err) {
    toastError(err?.message || '转人工失败');
  }
}

async function searchKb() {
  const data = await kbApi.articles({ keyword: keyword.value || undefined, pageSize: 20 });
  articles.value = data.list;
}

async function createTicket() {
  if (ticketForm.subject.length < 4) { toastError('标题至少 4 个字'); return; }
  creating.value = true;
  try {
    const data = await ticketApi.create({
      type: ticketForm.type, subject: ticketForm.subject,
      description: ticketForm.description || undefined,
      relatedOrderId: ticketForm.relatedOrderId ? Number(ticketForm.relatedOrderId) : undefined,
    });
    ticketCreated.value = data.ticketId;
    ticketForm.subject = ''; ticketForm.description = ''; ticketForm.relatedOrderId = '';
    toastOk('工单已创建');
  } catch (err) {
    toastError(err?.message || '工单创建失败');
  } finally {
    creating.value = false;
  }
}

onMounted(async () => {
  await searchKb();
});
</script>
