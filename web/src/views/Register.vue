<template>
  <div class="auth-wrap">
    <div class="card auth-card">
      <h2 style="margin:0 0 4px">{{ $t('注册学生账号') }}</h2>
      <p class="muted small" style="margin:0 0 8px">
        {{ $t('流程：选择学校（下拉，不可手填）→ 学号 → 手机号短信验证 → 设置密码 → 提交学生认证') }}
      </p>

      <SchoolSelect v-model="form.schoolId" allow-apply />

      <label>{{ $t('学号（同一学校内唯一，不同学校可重复）') }}</label>
      <input v-model.trim="form.studentNo" :placeholder="$t('如 2023010101')" />

      <label>{{ $t('手机号（全平台唯一）') }}</label>
      <input v-model.trim="form.phone" maxlength="11" :placeholder="$t('11 位手机号')" />
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="form.code" maxlength="6" :placeholder="$t('6 位短信验证码')" />
        <button class="btn" :disabled="smsCooldown > 0 || sendingSms" @click="sendSms">
          {{ smsCooldown > 0 ? `${$t('{0}s 后重发', [smsCooldown])}` : $t('获取验证码') }}
        </button>
      </div>

      <label>{{ $t('密码（8-32 位）') }}</label>
      <input v-model="form.password" type="password" />
      <label>{{ $t('真实姓名（用于认证与收款实名一致性校验，可选）') }}</label>
      <input v-model.trim="form.realName" />
      <label>{{ $t('昵称（可选）') }}</label>
      <input v-model.trim="form.nickname" />

      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>

      <button class="btn btn-primary btn-block mt12" :disabled="loading" @click="submit">
        {{ loading ? $t('提交中…') : $t('注册并登录') }}
      </button>
      <div class="row-between mt12 small">
        <RouterLink to="/login">{{ $t('已有账号，去登录') }}</RouterLink>
      </div>
      <p class="small muted mt8">
        {{ $t('注册成功后请在「学生认证」提交学生证照片或校园邮箱；认证通过前仅可浏览，不能发布与交易。') }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import SchoolSelect from '../components/SchoolSelect.vue';
import { authApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import { toastOk } from '../utils/toast.js';

const auth = useAuthStore();
const router = useRouter();
const form = reactive({ schoolId: null, studentNo: '', phone: '', code: '', password: '', realName: '', nickname: '' });
const loading = ref(false);
const sendingSms = ref(false);
const smsCooldown = ref(0);
const error = ref('');
let timer = null;

async function sendSms() {
  if (!/^1[3-9]\d{9}$/.test(form.phone)) { error.value = t('请先填写正确的手机号'); return; }
  sendingSms.value = true;
  try {
    await authApi.sendSms({ phone: form.phone, scene: 'register' });
    toastOk(t('验证码已发送（开发环境固定 123456）'));
    smsCooldown.value = 60;
    timer = setInterval(() => {
      smsCooldown.value -= 1;
      if (smsCooldown.value <= 0) clearInterval(timer);
    }, 1000);
  } catch (err) {
    error.value = err?.message || t('验证码发送失败');
  } finally {
    sendingSms.value = false;
  }
}

async function submit() {
  error.value = '';
  if (!form.schoolId) { error.value = t('请从下拉列表选择学校'); return; }
  if (form.studentNo.length < 4) { error.value = t('学号至少 4 位'); return; }
  if (!/^1[3-9]\d{9}$/.test(form.phone)) { error.value = t('手机号格式不正确'); return; }
  if (form.code.length !== 6) { error.value = t('请填写 6 位短信验证码'); return; }
  if (form.password.length < 8) { error.value = t('密码至少 8 位'); return; }
  loading.value = true;
  try {
    await auth.register({
      schoolId: Number(form.schoolId), studentNo: form.studentNo, phone: form.phone, code: form.code,
      password: form.password,
      nickname: form.nickname || undefined,
      realName: form.realName || undefined,
    });
    router.push('/verification');
  } catch (err) {
    error.value = err?.message || t('注册失败');
  } finally {
    loading.value = false;
  }
}

onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.auth-wrap { display: flex; justify-content: center; padding: 24px 16px; }
.auth-card { width: min(100%, 520px); }
</style>
