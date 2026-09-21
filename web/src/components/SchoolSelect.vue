<template>
  <div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
      <div>
        <label>{{ $t('省份（可选）') }}</label>
        <select :value="province" @change="onProvince($event.target.value)">
          <option value="">{{ $t('全部省份') }}</option>
          <option v-for="p in provinces" :key="p.province" :value="p.province">{{ p.province }}</option>
        </select>
      </div>
      <div>
        <label>{{ $t('城市（可选）') }}</label>
        <select :value="city" :disabled="!cities.length" @change="onCity($event.target.value)">
          <option value="">{{ $t('全部城市') }}</option>
          <option v-for="c in cities" :key="c.city" :value="c.city">{{ c.city }}（{{ c.total }}）</option>
        </select>
      </div>
      <div>
        <label>{{ $t('学校名称关键词') }}</label>
        <input v-model.trim="keyword" :placeholder="$t('如：江南')" @keyup.enter="search" />
      </div>
    </div>

    <label>{{ $t('选择学校（必须从下拉选择，不支持手填）') }}</label>
    <select :value="modelValue || ''" @change="$emit('update:modelValue', Number($event.target.value) || null)">
      <option value="">{{ $t('请选择你的学校') }}</option>
      <option v-for="s in options" :key="s.id" :value="s.id">{{ s.name }}（{{ s.province }}{{ s.city }}）</option>
    </select>
    <div class="row-between mt8">
      <span class="small muted">{{ loading ? $t('加载中…') : `${$t('共 {0} 所已开通高校', [options.length])}` }}</span>
      <button type="button" class="btn btn-sm" @click="search">{{ $t('重新搜索') }}</button>
    </div>

    <p v-if="allowApply" class="small muted mt8">
      {{ $t('找不到自己的学校？') }}
      <a href="#" @click.prevent="showApply = !showApply">{{ $t('申请开通学校') }}</a>
    </p>

    <div v-if="allowApply && showApply" class="card mt8">
      <div class="bold">{{ $t('申请开通学校') }}</div>
      <p class="small muted">{{ $t('提交后由平台管理员审核，通过后自动生成该校论坛版块，你即可在注册页选择。') }}</p>
      <label>{{ $t('学校全称') }}</label>
      <input v-model.trim="applyForm.schoolName" />
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>{{ $t('省份') }}</label><input v-model.trim="applyForm.province" /></div>
        <div><label>{{ $t('城市') }}</label><input v-model.trim="applyForm.city" /></div>
      </div>
      <label>{{ $t('申请人姓名') }}</label>
      <input v-model.trim="applyForm.applicantName" />
      <label>{{ $t('手机号') }}</label>
      <input v-model.trim="applyForm.phone" maxlength="11" />
      <label>{{ $t('备注（可选）') }}</label>
      <textarea v-model.trim="applyForm.note" style="min-height:60px" />
      <button class="btn btn-primary mt12" :disabled="applying" @click="submitApply">
        {{ applying ? $t('提交中…') : $t('提交申请') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { computed, onMounted, reactive, ref } from 'vue';
import { schoolApi } from '../api/index.js';
import { toastError, toastOk } from '../utils/toast.js';

const props = defineProps({
  modelValue: { type: Number, default: null },
  allowApply: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const provinces = ref([]);
const options = ref([]);
const loading = ref(false);
const province = ref('');
const city = ref('');
const keyword = ref('');
const showApply = ref(false);
const applying = ref(false);
const applyForm = reactive({ schoolName: '', province: '', city: '', applicantName: '', phone: '', note: '' });

const cities = computed(() => provinces.value.find((p) => p.province === province.value)?.cities || []);

async function search() {
  loading.value = true;
  try {
    const data = await schoolApi.list({ keyword: keyword.value, province: province.value, city: city.value, pageSize: 50 });
    options.value = data.list || [];
  } catch (err) {
    toastError(err?.message || t('学校列表加载失败'));
  } finally {
    loading.value = false;
  }
}

function onProvince(value) {
  province.value = value;
  city.value = '';
  search();
}
function onCity(value) {
  city.value = value;
  search();
}

async function submitApply() {
  const form = applyForm;
  if (!form.schoolName || !form.province || !form.city || !form.applicantName || !/^1[3-9]\d{9}$/.test(form.phone)) {
    toastError(t('请完整填写学校全称、省市、姓名与正确的手机号'));
    return;
  }
  applying.value = true;
  try {
    const data = await schoolApi.apply({ ...form, note: form.note || undefined });
    toastOk(`${t('申请已提交（编号 {0}），审核结果将通过站内信通知', [data.applicationId])}`);
    showApply.value = false;
    applyForm.schoolName = ''; applyForm.applicantName = ''; applyForm.phone = ''; applyForm.note = '';
  } catch (err) {
    toastError(err?.message || t('提交失败'));
  } finally {
    applying.value = false;
  }
}

onMounted(async () => {
  try {
    provinces.value = await schoolApi.provinces();
  } catch { provinces.value = []; }
  await search();
});
</script>
