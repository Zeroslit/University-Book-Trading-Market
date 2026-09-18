<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">本校教材图书库</div>
          <div class="small muted">仅在 {{ auth.schoolName }} 范围内检索（服务端强制注入 school_id）</div>
        </div>
        <RouterLink class="btn btn-primary btn-sm" to="/books/new">＋ 发布教材</RouterLink>
      </div>

      <div class="grid mt12" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
        <div>
          <label>关键词</label>
          <input v-model.trim="filters.keyword" placeholder="书名 / 作者 / ISBN / 课程" @keyup.enter="reload(1)" />
        </div>
        <div>
          <label>课程名</label>
          <input v-model.trim="filters.course" placeholder="如 高等数学" @keyup.enter="reload(1)" />
        </div>
        <div>
          <label>成色</label>
          <select v-model="filters.condition" @change="reload(1)">
            <option value="">全部</option>
            <option v-for="(label, key) in CONDITION_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div>
          <label>最低价（元）</label>
          <input v-model.trim="filters.minPrice" type="number" min="0" @keyup.enter="reload(1)" />
        </div>
        <div>
          <label>最高价（元）</label>
          <input v-model.trim="filters.maxPrice" type="number" min="0" @keyup.enter="reload(1)" />
        </div>
        <div>
          <label>排序</label>
          <select v-model="filters.sort" @change="reload(1)">
            <option value="createdAt:desc">最新发布</option>
            <option value="price:asc">价格从低到高</option>
            <option value="price:desc">价格从高到低</option>
            <option value="views:desc">最多浏览</option>
          </select>
        </div>
      </div>

      <div class="row mt12">
        <button class="btn btn-primary btn-sm" @click="reload(1)">搜索</button>
        <button class="btn btn-sm" @click="reset">重置</button>
        <label v-if="auth.school?.cross_school_enabled" class="row small" style="gap:6px;margin:0">
          <input type="checkbox" v-model="filters.crossSchool" style="width:auto" @change="reload(1)" />
          包含跨校专区（{{ auth.school.cross_school_mode === 'mail' ? '仅邮寄' : '可跨校' }}）
        </label>
      </div>
    </div>

    <div v-if="list.length" class="grid mt12">
      <RouterLink v-for="b in list" :key="b.id" class="card" style="padding:10px" :to="`/books/${b.id}`">
        <img v-if="b.cover_url" class="thumb" :src="imageUrl(b.cover_url)" :alt="b.title" />
        <div v-else class="thumb" style="display:flex;align-items:center;justify-content:center">📖</div>
        <div class="bold mt8" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ b.title }}</div>
        <div class="small muted">{{ b.course_name || b.author || '未填写课程' }}</div>
        <div class="row-between mt8">
          <span class="price">¥{{ yuan(b.price_cents) }}</span>
          <span class="small muted">{{ CONDITION_LABELS[b.condition_level] || b.condition_level }}</span>
        </div>
        <div class="small muted mt8">{{ b.seller_nickname }} · 信誉 {{ b.seller_credit }}</div>
      </RouterLink>
    </div>
    <EmptyState v-else text="没有符合条件的教材" icon="🔍" />

    <Pager :page="page" :page-size="pageSize" :total="total" :has-more="hasMore" @change="reload" />
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { bookApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { CONDITION_LABELS, centsToYuan } from '../utils/format.js';
import { imageUrl } from '../utils/image.js';
import EmptyState from '../components/EmptyState.vue';
import Pager from '../components/Pager.vue';

const auth = useAuthStore();
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const hasMore = ref(false);
const yuan = centsToYuan;
const filters = reactive({ keyword: '', course: '', condition: '', minPrice: '', maxPrice: '', sort: 'createdAt:desc', crossSchool: false });

async function reload(nextPage = page.value) {
  page.value = nextPage;
  const data = await bookApi.list({
    page: page.value, pageSize,
    keyword: filters.keyword || undefined,
    course: filters.course || undefined,
    condition: filters.condition || undefined,
    minPrice: filters.minPrice ? Number(filters.minPrice) * 100 : undefined,
    maxPrice: filters.maxPrice ? Number(filters.maxPrice) * 100 : undefined,
    sort: filters.sort,
    crossSchool: filters.crossSchool ? 'true' : undefined,
  });
  list.value = data.list;
  total.value = data.total;
  hasMore.value = data.hasMore;
}

function reset() {
  Object.assign(filters, { keyword: '', course: '', condition: '', minPrice: '', maxPrice: '', sort: 'createdAt:desc', crossSchool: false });
  reload(1);
}

onMounted(() => reload(1));
</script>
