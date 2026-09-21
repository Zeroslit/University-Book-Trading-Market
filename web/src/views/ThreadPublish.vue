<template>
  <div class="card">
    <h3 style="margin-top:0">{{ $t('发布帖子') }}</h3>
    <p class="small muted">{{ $t('标题与正文都会经过违禁词归一化检测（去空格符号、全角半角、繁简、拼音谐音）。') }}</p>

    <label>{{ $t('帖子类型') }}</label>
    <select v-model="form.type">
      <option value="seek">{{ $t('求书帖（我想买某本书）') }}</option>
      <option value="sell">{{ $t('转让帖（我要转让教材）') }}</option>
    </select>

    <label>{{ $t('标题 *') }}</label>
    <input v-model.trim="form.title" maxlength="200" :placeholder="$t('如：求《数据结构（C 语言版）》一本')" />

    <label>{{ $t('分类（可选）') }}</label>
    <input v-model.trim="form.category" maxlength="40" :placeholder="$t('如 教材 / 考研 / 考证')" />

    <label>{{ $t('正文 *') }}</label>
    <textarea v-model.trim="form.content" maxlength="5000" style="min-height:140px" />

    <label>{{ $t('配图（可选）') }}</label>
    <ImageUploader v-model="form.images" :max="9" />

    <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
    <div v-if="maskedHits.length" class="notice notice-info mt12">{{ $t('L1 提示词已打码：{0}', [maskedHits.map((h) => h.word).join('、')]) }}</div>

    <button class="btn btn-primary mt12" :disabled="submitting" @click="submit">
      {{ submitting ? $t('发布中…') : $t('发布') }}
    </button>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import ImageUploader from '../components/ImageUploader.vue';
import { threadApi } from '../api/index.js';
import { toastOk } from '../utils/toast.js';

const router = useRouter();
const submitting = ref(false);
const error = ref('');
const maskedHits = ref([]);
const form = reactive({ type: 'seek', title: '', content: '', category: '', images: [] });

async function submit() {
  error.value = '';
  maskedHits.value = [];
  if (form.title.length < 4) { error.value = t('标题至少 4 个字'); return; }
  if (form.content.length < 4) { error.value = t('正文至少 4 个字'); return; }
  submitting.value = true;
  try {
    const data = await threadApi.create({
      type: form.type, title: form.title, content: form.content,
      category: form.category || undefined, images: form.images.length ? form.images : undefined,
    });
    maskedHits.value = (data.wordHits || []).filter((h) => h.level === 'L1');
    toastOk(t('发布成功'));
    router.push(`/threads/${data.threadId}`);
  } catch (err) {
    error.value = err?.message || t('发布失败');
    if (err?.details?.hits) maskedHits.value = err.details.hits;
  } finally {
    submitting.value = false;
  }
}
</script>
