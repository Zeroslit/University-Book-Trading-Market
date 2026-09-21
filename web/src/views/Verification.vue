<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('学生身份认证') }}</div>
          <div class="small muted">
            {{ $t('当前状态：') }}<StatusTag :map="VERIFICATION_STATUS" :value="auth.user?.verificationStatus" />
          </div>
        </div>
      </div>
      <p class="small muted mt8">
        {{ $t('认证通过前仅可浏览，不能发布与交易；认证通过后可发布教材、下单与提现。材料仅用于身份核验，按保存期限脱敏存储。') }}
      </p>

      <label>{{ $t('认证方式') }}</label>
      <select v-model="form.method">
        <option value="student_card">{{ $t('上传学生证照片 + 人工审核') }}</option>
        <option value="campus_email">{{ $t('校园邮箱验证') }}</option>
      </select>

      <template v-if="form.method === 'student_card'">
        <label>{{ $t('学生证照片（长边自动压缩到 ≤1080px）') }}</label>
        <ImageUploader v-model="cardImages" :max="1" />
      </template>
      <template v-else>
        <label>{{ $t('校园邮箱') }}</label>
        <input v-model.trim="form.campusEmail" :placeholder="$t('如 2023010101@xx.edu.cn')" />
      </template>

      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <button class="btn btn-primary mt12" :disabled="submitting" @click="submit">
        {{ submitting ? $t('提交中…') : $t('提交认证') }}
      </button>
    </div>

    <div class="card">
      <div class="bold">{{ $t('我的认证记录') }}</div>
      <table class="table mt8">
        <thead><tr><th>{{ $t('提交时间') }}</th><th>{{ $t('方式') }}</th><th>{{ $t('状态') }}</th><th>{{ $t('审核说明') }}</th><th>{{ $t('审核时间') }}</th></tr></thead>
        <tbody>
          <tr v-for="v in records" :key="v.id">
            <td class="small">{{ formatTime(v.submitted_at) }}</td>
            <td>{{ v.method === 'student_card' ? $t('学生证') : $t('校园邮箱') }}</td>
            <td><StatusTag :map="VERIFICATION_STATUS" :value="v.status" /></td>
            <td class="small">{{ v.review_note || '—' }}</td>
            <td class="small">{{ formatTime(v.reviewed_at) }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="records.length === 0" :text="$t('还没有提交过认证')" icon="🎓" />
      <p class="small muted mt8">{{ $t('认证未通过可修改材料后重新提交。') }}</p>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { onMounted, reactive, ref } from 'vue';
import { verificationApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { VERIFICATION_STATUS, formatTime } from '../utils/format.js';
import { toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';
import ImageUploader from '../components/ImageUploader.vue';
import StatusTag from '../components/StatusTag.vue';

const auth = useAuthStore();
const records = ref([]);
const cardImages = ref([]);
const submitting = ref(false);
const error = ref('');
const form = reactive({ method: 'student_card', campusEmail: '' });

async function loadRecords() {
  records.value = await verificationApi.mine();
}

async function submit() {
  error.value = '';
  if (form.method === 'student_card' && cardImages.value.length === 0) { error.value = t('请上传学生证照片'); return; }
  if (form.method === 'campus_email' && !/^\S+@\S+\.\S+$/.test(form.campusEmail)) { error.value = t('请填写正确的校园邮箱'); return; }
  submitting.value = true;
  try {
    await verificationApi.submit(form.method === 'student_card'
      ? { method: 'student_card', studentCardImageUrl: cardImages.value[0] }
      : { method: 'campus_email', campusEmail: form.campusEmail });
    toastOk(t('认证材料已提交，审核结果将通过站内信通知'));
    cardImages.value = [];
    await auth.load(true);
    await loadRecords();
  } catch (err) {
    error.value = err?.message || t('提交失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(loadRecords);
</script>
