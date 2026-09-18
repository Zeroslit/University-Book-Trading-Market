<template>
  <div>
    <div class="card">
      <div class="bold">学校开通与管理（平台管理员）</div>
      <p class="small muted">学校是平台最底层维度：图书库、论坛、订单、举报全部按 school_id 归属；学生只能看到本校数据。</p>

      <div class="grid mt12" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
        <div><label>学校全称</label><input v-model.trim="createForm.name" /></div>
        <div><label>省份</label><input v-model.trim="createForm.province" /></div>
        <div><label>城市</label><input v-model.trim="createForm.city" /></div>
        <div><label>学校编码</label><input v-model.trim="createForm.code" /></div>
        <div><label>服务费（基点，200 = 2%）</label><input v-model.trim="createForm.serviceFeeBps" type="number" min="0" max="2000" /></div>
        <div><label>跨校专区</label>
          <select v-model="createForm.crossSchoolMode"><option value="off">关闭</option><option value="mail">仅邮寄</option></select>
        </div>
      </div>
      <label class="row" style="gap:6px">
        <input v-model="createForm.requireStudentVerification" type="checkbox" style="width:auto" /> 需要学生认证才能发布与交易
      </label>
      <button class="btn btn-primary mt12" @click="create">开通学校</button>
    </div>

    <div class="card">
      <div class="bold">已开通学校</div>
      <table class="table mt8">
        <thead><tr><th>ID</th><th>学校</th><th>省市</th><th>编码</th><th>状态</th><th>服务费</th><th>认证</th><th>跨校</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in schools" :key="s.id">
            <td>{{ s.id }}</td>
            <td>{{ s.name }}</td>
            <td class="small">{{ s.province }} {{ s.city }}</td>
            <td class="small">{{ s.code }}</td>
            <td>{{ s.status }}</td>
            <td>{{ (s.service_fee_bps / 100).toFixed(2) }}%</td>
            <td>{{ s.require_student_verification ? '需要' : '不需要' }}</td>
            <td class="small">{{ s.cross_school_enabled ? (s.cross_school_mode === 'mail' ? '仅邮寄' : '开启') : '关闭' }}</td>
            <td><button class="btn btn-sm" @click="edit(s)">编辑</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="editing" class="card">
      <div class="row-between">
        <div class="bold">编辑：{{ editing.name }}</div>
        <button class="btn btn-sm" @click="editing = null">关闭</button>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
        <div><label>状态</label>
          <select v-model="editForm.status"><option value="active">已开通</option><option value="pending">待开通</option><option value="disabled">停用</option></select>
        </div>
        <div><label>服务费（基点）</label><input v-model.trim="editForm.serviceFeeBps" type="number" min="0" max="2000" /></div>
        <div><label>跨校模式</label>
          <select v-model="editForm.crossSchoolMode"><option value="off">关闭</option><option value="mail">仅邮寄</option></select>
        </div>
      </div>
      <label class="row" style="gap:6px">
        <input v-model="editForm.requireStudentVerification" type="checkbox" style="width:auto" /> 需要学生认证
      </label>
      <label class="row" style="gap:6px">
        <input v-model="editForm.crossSchoolEnabled" type="checkbox" style="width:auto" /> 开启跨校专区
      </label>
      <label>论坛版块配置（JSON 数组）</label>
      <textarea v-model.trim="editForm.forumSections" style="min-height:70px" />
      <button class="btn btn-primary btn-sm mt12" @click="save">保存配置</button>
    </div>

    <div class="card">
      <div class="bold">学校开通申请</div>
      <table class="table mt8">
        <thead><tr><th>ID</th><th>学校</th><th>省市</th><th>申请人</th><th>手机</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in applications" :key="a.id">
            <td>{{ a.id }}</td>
            <td>{{ a.school_name }}</td>
            <td class="small">{{ a.province }} {{ a.city }}</td>
            <td>{{ a.applicant_name }}</td>
            <td class="small">{{ a.applicant_phone_last4 }}</td>
            <td>{{ a.status }}</td>
            <td>
              <template v-if="a.status === 'pending'">
                <button class="btn btn-sm btn-primary" @click="review(a, true)">通过并开通</button>
                <button class="btn btn-sm" @click="review(a, false)">驳回</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="applications.length === 0" text="暂无学校申请" icon="🏫" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { adminApi, schoolApi } from '../../api/index.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';

const schools = ref([]);
const applications = ref([]);
const editing = ref(null);
const createForm = reactive({
  name: '', province: '', city: '', code: '', serviceFeeBps: 200,
  requireStudentVerification: true, crossSchoolEnabled: false, crossSchoolMode: 'off',
});
const editForm = reactive({ status: 'active', serviceFeeBps: 200, requireStudentVerification: true, crossSchoolEnabled: false, crossSchoolMode: 'off', forumSections: '[]' });

async function load() {
  schools.value = await adminApi.schools();
  const data = await schoolApi.applications({ pageSize: 30 });
  applications.value = Array.isArray(data) ? data : (data.list || []);
}

async function create() {
  if (!createForm.name || !createForm.province || !createForm.city || !createForm.code) {
    toastError('请完整填写学校名称、省市与编码'); return;
  }
  try {
    await adminApi.createSchool({
      name: createForm.name, province: createForm.province, city: createForm.city, code: createForm.code,
      serviceFeeBps: Number(createForm.serviceFeeBps),
      requireStudentVerification: createForm.requireStudentVerification,
      crossSchoolEnabled: createForm.crossSchoolEnabled,
      crossSchoolMode: createForm.crossSchoolMode,
    });
    toastOk('学校已开通，并自动生成论坛版块');
    createForm.name = ''; createForm.code = '';
    await load();
  } catch (err) {
    toastError(err?.message || '开通失败');
  }
}

function edit(school) {
  editing.value = school;
  editForm.status = school.status;
  editForm.serviceFeeBps = school.service_fee_bps;
  editForm.requireStudentVerification = Boolean(school.require_student_verification);
  editForm.crossSchoolEnabled = Boolean(school.cross_school_enabled);
  editForm.crossSchoolMode = school.cross_school_mode || 'off';
  editForm.forumSections = JSON.stringify(school.forum_sections || [], null, 2);
}

async function save() {
  try {
    let sections;
    try { sections = JSON.parse(editForm.forumSections); } catch { toastError('论坛版块配置不是合法 JSON'); return; }
    await adminApi.updateSchool(editing.value.id, {
      status: editForm.status,
      serviceFeeBps: Number(editForm.serviceFeeBps),
      requireStudentVerification: editForm.requireStudentVerification,
      crossSchoolEnabled: editForm.crossSchoolEnabled,
      crossSchoolMode: editForm.crossSchoolMode,
      forumSections: sections,
    });
    toastOk('学校配置已更新');
    editing.value = null;
    await load();
  } catch (err) {
    toastError(err?.message || '保存失败');
  }
}

async function review(application, approve) {
  const note = window.prompt(approve ? '审核备注（可选）' : '驳回原因') || undefined;
  try {
    await schoolApi.reviewApplication(application.id, { approve, note });
    toastOk(approve ? '已开通学校并生成论坛版块' : '已驳回申请');
    await load();
  } catch (err) {
    toastError(err?.message || '审核失败');
  }
}

onMounted(load);
</script>

