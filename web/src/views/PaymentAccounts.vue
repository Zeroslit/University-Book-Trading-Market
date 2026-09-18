<template>
  <div>
    <div class="card">
      <div class="bold">收款方式绑定</div>
      <p class="small muted">
        仅保存脱敏信息（姓名掩码 + 卡号/账号后四位 + 盲索引哈希），平台绝不保存完整卡号、CVV 或支付密码。
        绑定与解绑均需短信二次验证；解绑后 24 小时内不可重新绑定。
      </p>
      <table class="table mt8">
        <thead><tr><th>类型</th><th>账户</th><th>户名</th><th>状态</th><th>绑定时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.id">
            <td>{{ TYPE_LABEL[a.type] || a.type }}</td>
            <td>****{{ a.accountNoLast4 }}{{ a.bankName ? `（${a.bankName}）` : '' }}</td>
            <td>{{ a.accountNameMask }}</td>
            <td>
              <span class="tag" :class="a.status === 'active' ? 'tag-success' : ''">{{ a.status === 'active' ? '生效中' : '已解绑' }}</span>
              <span v-if="a.isDefault" class="tag tag-info">默认</span>
            </td>
            <td class="small">{{ formatTime(a.boundAt) }}</td>
            <td>
              <button v-if="a.status === 'active' && !a.isDefault" class="btn btn-sm" @click="setDefault(a.id)">设为默认</button>
              <button v-if="a.status === 'active'" class="btn btn-sm" @click="startUnbind(a)">解绑</button>
              <span v-else class="small muted">冷却至 {{ formatTime(a.cooldownUntil) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="accounts.length === 0" text="还没有绑定收款方式" icon="💳" />
    </div>

    <div class="card">
      <div class="bold">新增绑定</div>
      <label>类型</label>
      <select v-model="form.type">
        <option value="wechat">微信</option>
        <option value="alipay">支付宝</option>
        <option value="bank">银行卡</option>
      </select>
      <label>账号 / 卡号（演示环境请勿填写真实卡号）</label>
      <input v-model.trim="form.accountNo" />
      <label>户名（必须与实名信息一致）</label>
      <input v-model.trim="form.accountName" />
      <label v-if="form.type === 'bank'">开户银行</label>
      <input v-if="form.type === 'bank'" v-model.trim="form.bankName" />
      <label>手机号</label>
      <input v-model.trim="form.phone" maxlength="11" />
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="form.smsCode" maxlength="6" placeholder="6 位短信验证码" />
        <button class="btn" :disabled="cooldown > 0" @click="sendCode">{{ cooldown > 0 ? `${cooldown}s` : '获取验证码' }}</button>
      </div>
      <label class="row" style="gap:6px">
        <input v-model="form.isDefault" type="checkbox" style="width:auto" /> 设为默认收款方式
      </label>
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
      <button class="btn btn-primary mt12" :disabled="submitting" @click="bind">确认绑定</button>
    </div>

    <div v-if="unbindTarget" class="card">
      <div class="bold">解绑二次验证</div>
      <p class="small muted">为防止账号被盗后转移资金，解绑需要短信验证码，且 24 小时内不可重新绑定。</p>
      <label>手机号</label>
      <input v-model.trim="unbindForm.phone" maxlength="11" />
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="unbindForm.smsCode" maxlength="6" placeholder="6 位短信验证码" />
        <button class="btn" :disabled="cooldown > 0" @click="sendCode">获取验证码</button>
      </div>
      <div class="row mt12">
        <button class="btn btn-danger btn-sm" @click="confirmUnbind">确认解绑</button>
        <button class="btn btn-sm" @click="unbindTarget = null">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { paymentAccountApi, authApi } from '../api/index.js';
import { formatTime } from '../utils/format.js';
import { toastError, toastOk } from '../utils/toast.js';
import EmptyState from '../components/EmptyState.vue';

const TYPE_LABEL = { wechat: '微信', alipay: '支付宝', bank: '银行卡' };
const accounts = ref([]);
const submitting = ref(false);
const error = ref('');
const cooldown = ref(0);
const unbindTarget = ref(null);
let timer = null;
const form = reactive({ type: 'wechat', accountNo: '', accountName: '', bankName: '', phone: '', smsCode: '', isDefault: true });
const unbindForm = reactive({ phone: '', smsCode: '' });

async function load() {
  accounts.value = await paymentAccountApi.list();
}

function startCooldown() {
  cooldown.value = 60;
  clearInterval(timer);
  timer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) clearInterval(timer);
  }, 1000);
}

async function sendCode() {
  const phone = unbindTarget.value ? unbindForm.phone : form.phone;
  if (!/^1[3-9]\d{9}$/.test(phone)) { toastError('请先填写正确的手机号'); return; }
  try {
    await authApi.sendSms({ phone, scene: unbindTarget.value ? 'unbind' : 'bind' });
    toastOk('验证码已发送（开发环境固定 123456）');
    startCooldown();
  } catch (err) {
    toastError(err?.message || '验证码发送失败');
  }
}

async function bind() {
  error.value = '';
  if (form.accountNo.length < 6) { error.value = '请填写正确的账号'; return; }
  if (form.accountName.length < 2) { error.value = '请填写户名'; return; }
  if (form.smsCode.length !== 6) { error.value = '请填写 6 位验证码'; return; }
  submitting.value = true;
  try {
    await paymentAccountApi.bind({
      type: form.type, accountNo: form.accountNo, accountName: form.accountName,
      bankName: form.type === 'bank' ? form.bankName : undefined,
      smsCode: form.smsCode, phone: form.phone, isDefault: form.isDefault,
    });
    toastOk('收款方式已绑定');
    form.accountNo = ''; form.accountName = ''; form.smsCode = '';
    await load();
  } catch (err) {
    error.value = err?.message || '绑定失败';
  } finally {
    submitting.value = false;
  }
}

async function startUnbind(account) {
  unbindTarget.value = account;
  unbindForm.phone = '';
  unbindForm.smsCode = '';
  try {
    await paymentAccountApi.unbindCode(account.id);
    toastOk('验证码已发送至绑定手机号（开发环境固定 123456）');
  } catch (err) {
    toastError(err?.message || '发送失败');
  }
}

async function confirmUnbind() {
  try {
    await paymentAccountApi.unbind(unbindTarget.value.id, { phone: unbindForm.phone, smsCode: unbindForm.smsCode });
    toastOk('已解绑，24 小时内不可重新绑定');
    unbindTarget.value = null;
    await load();
  } catch (err) {
    toastError(err?.message || '解绑失败');
  }
}

async function setDefault(id) {
  try {
    await paymentAccountApi.setDefault(id);
    toastOk('已设为默认收款方式');
    await load();
  } catch (err) {
    toastError(err?.message || '设置失败');
  }
}

onMounted(load);
onUnmounted(() => clearInterval(timer));
</script>
