<template>
  <div class="card">
    <h3 style="margin-top:0">发布闲置教材</h3>
    <p class="small muted">发布内容会经过违禁词检测；L2 及以上会被拦截，请勿填写微信/QQ/外部链接等引流信息。</p>

    <ImageUploader v-model="form.images" :max="9" />

    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
      <div><label>书名 *</label><input v-model.trim="form.title" maxlength="200" /></div>
      <div><label>作者</label><input v-model.trim="form.author" /></div>
      <div><label>出版社</label><input v-model.trim="form.publisher" /></div>
      <div><label>ISBN</label><input v-model.trim="form.isbn" maxlength="20" /></div>
      <div><label>课程名</label><input v-model.trim="form.courseName" placeholder="如 高等数学（上）" /></div>
      <div>
        <label>成色 *</label>
        <select v-model="form.conditionLevel">
          <option v-for="(label, key) in CONDITION_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
      </div>
      <div><label>原价（元）*</label><input v-model.trim="form.originalPrice" type="number" min="0" step="0.01" /></div>
      <div><label>售价（元）*</label><input v-model.trim="form.price" type="number" min="0.01" step="0.01" /></div>
    </div>

    <label>备注（划线笔记、缺页等）</label>
    <textarea v-model.trim="form.remark" maxlength="1000" />

    <label v-if="auth.school?.cross_school_enabled" class="row" style="gap:6px">
      <input type="checkbox" v-model="form.crossSchool" style="width:auto" />
      允许跨校出售（{{ auth.school.cross_school_mode === 'mail' ? '仅支持邮寄' : '可跨校交易' }}）
    </label>

    <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
    <div v-if="maskedHits.length" class="notice notice-info mt12">
      L1 提示词已打码：{{ maskedHits.map((h) => h.word).join('、') }}
    </div>

    <button class="btn btn-primary mt12" :disabled="submitting" @click="submit">
      {{ submitting ? '发布中…' : '发布教材' }}
    </button>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import ImageUploader from '../components/ImageUploader.vue';
import { bookApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { CONDITION_LABELS, yuanToCents } from '../utils/format.js';
import { toastOk } from '../utils/toast.js';

const auth = useAuthStore();
const router = useRouter();
const submitting = ref(false);
const error = ref('');
const maskedHits = ref([]);
const form = reactive({
  images: [], title: '', author: '', publisher: '', isbn: '', courseName: '',
  conditionLevel: 'good', originalPrice: '', price: '', remark: '', crossSchool: false,
});

async function submit() {
  error.value = '';
  maskedHits.value = [];
  if (form.images.length === 0) { error.value = '请至少上传 1 张实拍图'; return; }
  if (form.title.length < 2) { error.value = '书名至少 2 个字'; return; }
  const original = yuanToCents(form.originalPrice);
  const price = yuanToCents(form.price);
  if (!Number.isFinite(original)) { error.value = '请填写正确的原价'; return; }
  if (!Number.isFinite(price) || price < 1) { error.value = '请填写正确的售价'; return; }

  submitting.value = true;
  try {
    const data = await bookApi.create({
      title: form.title, author: form.author || undefined, publisher: form.publisher || undefined,
      isbn: form.isbn || undefined, courseName: form.courseName || undefined,
      conditionLevel: form.conditionLevel, originalPriceCents: original, priceCents: price,
      remark: form.remark || undefined, crossSchool: form.crossSchool, images: form.images,
    });
    maskedHits.value = (data.wordHits || []).filter((h) => h.level === 'L1');
    toastOk('发布成功');
    router.push(`/books/${data.bookId}`);
  } catch (err) {
    error.value = err?.message || '发布失败';
    if (err?.details?.hits) maskedHits.value = err.details.hits;
  } finally {
    submitting.value = false;
  }
}
</script>
