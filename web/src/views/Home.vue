<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <h2 style="margin:0">{{ auth.schoolName }}</h2>
          <p class="small muted" style="margin:4px 0 0">
            本校专属图书库与论坛 · 数据严格按 school_id 隔离，你看不到其他学校的帖子与教材
          </p>
        </div>
        <div class="chips">
          <span class="chip">服务费 {{ feeText }}</span>
          <span class="chip">{{ school?.require_student_verification ? '需要学生认证' : '免认证' }}</span>
          <span class="chip" :class="{ active: school?.cross_school_enabled }">
            跨校专区：{{ school?.cross_school_enabled ? (school.cross_school_mode === 'mail' ? '仅邮寄' : '已开启') : '未开启' }}
          </span>
          <span class="chip">信誉分 {{ auth.user?.creditScore }}</span>
        </div>
      </div>

      <div class="chips mt12">
        <RouterLink class="btn btn-primary btn-sm" to="/books/new">＋ 发布教材</RouterLink>
        <RouterLink class="btn btn-sm" to="/threads/new">＋ 发帖求书 / 转让</RouterLink>
        <RouterLink class="btn btn-sm" to="/orders">我的订单</RouterLink>
        <RouterLink class="btn btn-sm" to="/wallet">钱包（¥{{ yuan(auth.wallet?.balanceCents) }}）</RouterLink>
        <RouterLink class="btn btn-sm" to="/support">客服中心</RouterLink>
      </div>

      <p v-if="auth.user?.verificationStatus !== 'approved'" class="notice notice-info mt12">
        你的学生认证状态：<b>{{ auth.user?.verificationStatus === 'pending' ? '审核中' : '未认证' }}</b>。
        认证通过前仅可浏览，不能发布与交易。
        <RouterLink to="/verification">去认证 →</RouterLink>
      </p>
    </div>

    <div class="card">
      <div class="row-between">
        <div class="bold">本校最新教材</div>
        <RouterLink class="small" to="/books">查看全部 →</RouterLink>
      </div>
      <div v-if="books.length" class="grid mt12">
        <RouterLink v-for="b in books" :key="b.id" class="card" style="padding:10px" :to="`/books/${b.id}`">
          <img v-if="b.cover_url" class="thumb" :src="imageUrl(b.cover_url)" :alt="b.title" />
          <div v-else class="thumb" style="display:flex;align-items:center;justify-content:center">📖</div>
          <div class="bold mt8" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ b.title }}</div>
          <div class="row-between mt8">
            <span class="price">¥{{ yuan(b.price_cents) }}</span>
            <span class="small muted">{{ b.seller_nickname }}</span>
          </div>
        </RouterLink>
      </div>
      <EmptyState v-else text="本校还没有教材，去发布第一本吧" icon="📚" />
    </div>

    <div class="card">
      <div class="row-between">
        <div class="bold">本校论坛热帖</div>
        <RouterLink class="small" to="/threads">查看全部 →</RouterLink>
      </div>
      <div v-if="threads.length" class="mt12">
        <div v-for="t in threads" :key="t.id" class="row-between" style="border-bottom:1px solid var(--border);padding:8px 0">
          <RouterLink :to="`/threads/${t.id}`">
            <StatusTag :map="THREAD_TYPE" :value="t.type" />
            {{ t.title }}
          </RouterLink>
          <span class="small muted">{{ t.reply_count }} 回复</span>
        </div>
      </div>
      <EmptyState v-else text="本校论坛还没有帖子" icon="💬" />
    </div>

    <div class="card">
      <div class="row-between">
        <div class="bold">我最近的订单</div>
        <RouterLink class="small" to="/orders">全部订单 →</RouterLink>
      </div>
      <div v-if="orders.length" class="mt12">
        <div v-for="o in orders" :key="o.id" class="row-between" style="border-bottom:1px solid var(--border);padding:8px 0">
          <RouterLink :to="`/orders/${o.id}`">{{ o.order_no }} · {{ o.book_title }}</RouterLink>
          <span class="row" style="gap:6px">
            <StatusTag :map="ORDER_STATUS" :value="o.status" />
            <span class="small">¥{{ yuan(o.amount_cents) }}</span>
          </span>
        </div>
      </div>
      <EmptyState v-else text="还没有订单" icon="🧾" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { bookApi, threadApi, orderApi } from '../api/index.js';
import { ORDER_STATUS, THREAD_TYPE, centsToYuan } from '../utils/format.js';
import { imageUrl } from '../utils/image.js';
import EmptyState from '../components/EmptyState.vue';
import StatusTag from '../components/StatusTag.vue';

const auth = useAuthStore();
const books = ref([]);
const threads = ref([]);
const orders = ref([]);
const school = computed(() => auth.school);
const feeText = computed(() => {
  const bps = Number(auth.school?.service_fee_bps ?? 0);
  return `${(bps / 100).toFixed(2)}%`;
});
const yuan = centsToYuan;

onMounted(async () => {
  try { books.value = (await bookApi.list({ pageSize: 8 })).list; } catch { books.value = []; }
  try { threads.value = (await threadApi.list({ pageSize: 5 })).list; } catch { threads.value = []; }
  try { orders.value = (await orderApi.list({ pageSize: 5, role: 'buyer' })).list; } catch { orders.value = []; }
});
</script>
