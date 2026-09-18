<template>
  <div v-if="book">
    <div class="card">
      <div class="row-between wrap">
        <div>
          <h2 style="margin:0">{{ book.title }}</h2>
          <div class="small muted">
            {{ book.author || '未填作者' }} · {{ book.publisher || '未填出版社' }}
            <span v-if="book.isbn"> · ISBN {{ book.isbn }}</span>
            <span v-if="book.course_name"> · 课程 {{ book.course_name }}</span>
          </div>
        </div>
        <StatusTag :map="BOOK_STATUS" :value="book.status" />
      </div>

      <div class="row mt12" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex:1 1 320px">
          <div v-if="book.images?.length" class="row" style="gap:8px;flex-wrap:wrap">
            <img
              v-for="(img, i) in book.images" :key="i" :src="imageUrl(img.url)" :alt="`实拍图 ${i + 1}`"
              style="width:150px;height:150px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"
            />
          </div>
          <div v-else class="thumb" style="display:flex;align-items:center;justify-content:center">📖</div>
        </div>
        <div style="flex:1 1 260px">
          <div class="price" style="font-size:24px">¥{{ yuan(book.price_cents) }}</div>
          <div class="small muted">原价 ¥{{ yuan(book.original_price_cents) }} · 成色 {{ CONDITION_LABELS[book.condition_level] }}</div>
          <div class="mt8">
            <span class="tag">卖家 {{ book.seller_nickname }}</span>
            <span class="tag tag-info">信誉 {{ book.seller.creditScore }}（{{ book.seller.creditTier.label }}）</span>
            <span class="tag tag-success">历史成交 {{ book.seller.soldCount }} 单</span>
            <span v-if="book.seller.verified" class="tag tag-success">已认证学生</span>
          </div>
          <div v-if="book.remark" class="notice mt12 small">{{ book.remark }}</div>

          <div v-if="book.isMine" class="notice notice-info mt12">
            这是你发布的教材。
            <RouterLink to="/orders?role=seller">查看作为卖家的订单 →</RouterLink>
          </div>
          <div v-else-if="book.activeOrder" class="notice notice-info mt12">
            该教材已有进行中的订单（<StatusTag :map="ORDER_STATUS" :value="book.activeOrder.status" />），暂时无法下单。
          </div>

          <div class="row mt12" style="flex-wrap:wrap">
            <button v-if="book.canOrder" class="btn btn-primary" :disabled="ordering" @click="buy">
              {{ ordering ? '处理中…' : '立即购买（资金托管）' }}
            </button>
            <button class="btn" @click="contact">联系卖家</button>
            <button class="btn btn-sm" @click="showReport = !showReport">举报</button>
          </div>
          <p class="small muted mt8">下单后货款由平台托管，你确认收货前不会放款给卖家。</p>
        </div>
      </div>
    </div>

    <div v-if="showReport" class="card">
      <div class="bold">举报该教材</div>
      <label>举报原因</label>
      <input v-model.trim="reportForm.reason" maxlength="60" placeholder="如：描述不符 / 盗版 / 引流广告" />
      <label>补充说明</label>
      <textarea v-model.trim="reportForm.description" maxlength="1000" />
      <button class="btn btn-danger btn-sm mt12" @click="submitReport">提交举报</button>
    </div>

    <div v-if="payOrder" class="card">
      <div class="bold">订单已创建，请在 30 分钟内完成支付（模拟）</div>
      <p class="small muted">
        订单号 {{ payOrder.orderNo }} · 金额 ¥{{ yuan(payOrder.amountCents) }} ·
        平台服务费 ¥{{ yuan(payOrder.serviceFeeCents) }}
      </p>
      <div class="row">
        <button class="btn btn-primary btn-sm" :disabled="paying" @click="pay">确认支付（模拟托管）</button>
        <button class="btn btn-sm" @click="goOrder">查看订单</button>
      </div>
    </div>
  </div>
  <EmptyState v-else text="教材不存在或不属于本校" icon="🔍" />
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { bookApi, orderApi, messageApi, reportApi } from '../api/index.js';
import { BOOK_STATUS, CONDITION_LABELS, ORDER_STATUS, centsToYuan } from '../utils/format.js';
import { imageUrl } from '../utils/image.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import StatusTag from '../components/StatusTag.vue';

const route = useRoute();
const router = useRouter();
const book = ref(null);
const ordering = ref(false);
const paying = ref(false);
const showReport = ref(false);
const payOrder = ref(null);
const reportForm = reactive({ reason: '', description: '' });
const yuan = centsToYuan;

async function load() {
  try {
    book.value = await bookApi.detail(route.params.id);
  } catch {
    book.value = null;
  }
}

async function contact() {
  try {
    const data = await messageApi.open({ bookId: book.value.id });
    toastOk(data.reused ? '已打开既有会话' : '会话已创建');
    router.push({ path: '/messages', query: { conversationId: data.conversationId } });
  } catch (err) {
    toastError(err?.message || '发起会话失败');
  }
}

async function buy() {
  ordering.value = true;
  try {
    payOrder.value = await orderApi.create({ bookId: book.value.id, shipMode: 'meetup' });
    toastOk('下单成功，请完成支付（模拟）');
    await load();
  } catch (err) {
    toastError(err?.message || '下单失败');
  } finally {
    ordering.value = false;
  }
}

async function pay() {
  paying.value = true;
  try {
    await orderApi.pay(payOrder.value.id);
    toastOk('支付成功（模拟），资金已进入托管');
    router.push(`/orders/${payOrder.value.id}`);
  } catch (err) {
    toastError(err?.message || '支付失败');
  } finally {
    paying.value = false;
  }
}

function goOrder() {
  router.push(`/orders/${payOrder.value.id}`);
}

async function submitReport() {
  if (reportForm.reason.length < 2) { toastError('请填写举报原因'); return; }
  try {
    await reportApi.create({
      targetType: 'book', targetId: Number(route.params.id),
      reason: reportForm.reason, description: reportForm.description || undefined,
    });
    toastOk('举报已提交，可在「举报与投诉」查看进展');
    showReport.value = false;
    reportForm.reason = ''; reportForm.description = '';
  } catch (err) {
    toastError(err?.message || '举报提交失败');
  }
}

onMounted(load);
</script>

