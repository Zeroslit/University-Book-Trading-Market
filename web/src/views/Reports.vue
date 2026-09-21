<template>
  <div>
    <div class="card">
      <div class="bold">{{ $t('举报提交') }}</div>
      <p class="small muted">
        {{ $t('处理链路：举报 → 受理（通知被投诉人 48 小时内举证）→ 裁定 → 处罚并扣分 → 双方收到结果 → 3 天申诉期 → 复审。只有「裁定成立」的投诉才计入违规次数，恶意投诉不计。') }}
      </p>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        <div>
          <label>{{ $t('举报对象类型') }}</label>
          <select v-model="form.targetType">
            <option value="book">{{ $t('教材') }}</option>
            <option value="thread">{{ $t('帖子') }}</option>
            <option value="reply">{{ $t('评论') }}</option>
            <option value="message">{{ $t('私信') }}</option>
            <option value="user">{{ $t('用户') }}</option>
            <option value="order">{{ $t('订单') }}</option>
          </select>
        </div>
        <div>
          <label>{{ $t('对象 ID') }}</label>
          <input v-model.trim="form.targetId" :placeholder="$t('如 12')" />
        </div>
        <div>
          <label>{{ $t('举报原因') }}</label>
          <input v-model.trim="form.reason" maxlength="60" :placeholder="$t('如 描述不符 / 盗版 / 引流广告')" />
        </div>
      </div>
      <label>{{ $t('补充说明') }}</label>
      <textarea v-model.trim="form.description" maxlength="1000" />
      <label>{{ $t('证据图片（可选，仅管理员/客服可读，读取会留审计日志）') }}</label>
      <ImageUploader v-model="form.evidence" :max="9" />
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <button class="btn btn-primary mt12" :disabled="submitting" @click="submit">{{ $t('提交举报') }}</button>
      <p v-if="reportNo" class="notice notice-success mt12">{{ $t('举报已提交（编号 {0}），受理与被投诉人举证进展会通过站内信通知。你也可以直接在图书详情页 / 帖子详情页点击「举报」。', [reportNo]) }}</p>
    </div>

    <div class="card">
      <div class="bold">{{ $t('我是被投诉人：提交举证') }}</div>
      <p class="small muted">{{ $t('收到投诉通知后，请在 48 小时内提交证据与说明。') }}</p>
      <div v-if="proofTargets.length === 0" class="small muted">{{ $t('暂无需要你举证的投诉。') }}</div>
      <div v-for="n in proofTargets" :key="n.id" class="card" style="margin-top:8px">
        <div class="bold">{{ n.title }}</div>
        <div class="small muted">{{ n.content }}</div>
        <textarea v-model.trim="proofContent[n.related_id]" maxlength="1000" :placeholder="$t('填写你的说明与证据链接')" />
        <button class="btn btn-sm btn-primary mt8" @click="submitProof(n.related_id)">{{ $t('提交举证') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { onMounted, reactive, ref } from 'vue';
import { reportApi, notificationApi } from '../api/index.js';
import { toastError, toastOk } from '../utils/toast.js';
import ImageUploader from '../components/ImageUploader.vue';

const submitting = ref(false);
const error = ref('');
const reportNo = ref('');
const proofTargets = ref([]);
const proofContent = reactive({});
const form = reactive({ targetType: 'book', targetId: '', reason: '', description: '', evidence: [] });

async function submit() {
  error.value = '';
  if (!Number(form.targetId)) { error.value = t('请填写举报对象 ID'); return; }
  if (form.reason.length < 2) { error.value = t('请填写举报原因'); return; }
  submitting.value = true;
  try {
    const data = await reportApi.create({
      targetType: form.targetType, targetId: Number(form.targetId), reason: form.reason,
      description: form.description || undefined,
      evidence: form.evidence.length ? form.evidence : undefined,
    });
    reportNo.value = data.reportNo || data.report_no || '';
    form.targetId = ''; form.reason = ''; form.description = ''; form.evidence = [];
    toastOk(t('举报已提交'));
  } catch (err) {
    error.value = err?.message || t('举报提交失败');
  } finally {
    submitting.value = false;
  }
}

async function submitProof(reportId) {
  const content = proofContent[reportId];
  if (!content || content.length < 2) { toastError(t('请填写举证说明')); return; }
  try {
    await reportApi.proof(reportId, { content });
    toastOk(t('举证已提交'));
    proofContent[reportId] = '';
    await loadTargets();
  } catch (err) {
    toastError(err?.message || t('举证提交失败'));
  }
}

async function loadTargets() {
  const data = await notificationApi.list({ type: 'report', pageSize: 20 });
  proofTargets.value = data.list.filter((n) => n.related_type === 'report' && n.related_id);
}

onMounted(loadTargets);
</script>
