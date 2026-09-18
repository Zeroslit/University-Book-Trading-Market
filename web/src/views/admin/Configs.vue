<template>
  <div>
    <div class="card">
      <div class="bold">规则阈值配置（全部配置化，禁止写死）</div>
      <p class="small muted">
        覆盖信誉分档位与加减分规则、处罚次数梯度、违禁词处置与扣分、SLA 时限、服务费比例、订单状态机、自动确认天数等。
        平台级配置对所有学校生效，学校级配置覆盖平台默认值。
      </p>
      <div class="row mt8" style="gap:8px">
        <input v-model.trim="keyword" placeholder="按 key 过滤，如 credit / ticket / order" />
        <button class="btn btn-sm" @click="load">刷新</button>
      </div>
    </div>

    <div class="card">
      <div class="bold">新增 / 覆盖配置</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
        <div><label>配置 key</label><input v-model.trim="form.key" placeholder="如 credit.rules" /></div>
        <div><label>作用域</label>
          <select v-model="form.scope"><option value="platform">平台级</option><option value="school">学校级</option></select>
        </div>
        <div v-if="form.scope === 'school'"><label>学校 ID</label><input v-model.trim="form.schoolId" type="number" /></div>
      </div>
      <label>配置值（JSON）</label>
      <textarea v-model.trim="form.value" style="min-height:120px" />
      <label>说明</label>
      <input v-model.trim="form.description" />
      <button class="btn btn-primary btn-sm mt12" @click="save">保存配置</button>
      <p v-if="error" class="notice notice-error mt12">{{ error }}</p>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>Key</th><th>作用域</th><th>学校</th><th>版本</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.key + c.scope + c.schoolId">
            <td>
              {{ c.key }}
              <div class="small muted">{{ c.description }}</div>
            </td>
            <td>{{ c.scope === 'platform' ? '平台' : '学校' }}</td>
            <td>{{ c.schoolId ?? '—' }}</td>
            <td>{{ c.version }}</td>
            <td class="small">{{ formatTime(c.updatedAt) }}</td>
            <td><button class="btn btn-sm" @click="pick(c)">编辑</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="filtered.length === 0" text="没有匹配的配置项" icon="⚙️" />
    </div>

    <div v-if="picked" class="card">
      <div class="row-between">
        <div class="bold">编辑 {{ picked.key }}（{{ picked.scope }}）</div>
        <button class="btn btn-sm" @click="picked = null">关闭</button>
      </div>
      <label>配置值（JSON）</label>
      <textarea v-model.trim="pickedText" style="min-height:220px" />
      <label>说明</label>
      <input v-model.trim="pickedDescription" />
      <button class="btn btn-primary btn-sm mt12" @click="savePicked">保存</button>
      <p class="small muted mt8">修改后会写入审计日志（config.update）并可回查。</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { adminApi } from '../../api/index.js';
import { formatTime } from '../../utils/format.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';

const configs = ref([]);
const keyword = ref('');
const error = ref('');
const picked = ref(null);
const pickedText = ref('');
const pickedDescription = ref('');
const form = reactive({ key: '', scope: 'platform', schoolId: '', value: '{}', description: '' });

const filtered = computed(() => {
  const kw = keyword.value.toLowerCase();
  if (!kw) return configs.value;
  return configs.value.filter((c) => c.key.toLowerCase().includes(kw));
});

async function load() {
  configs.value = await adminApi.configs();
}

function pick(c) {
  picked.value = c;
  pickedText.value = JSON.stringify(c.value, null, 2);
  pickedDescription.value = c.description || '';
}

async function save() {
  error.value = '';
  let value;
  try { value = JSON.parse(form.value); } catch { error.value = '配置值不是合法 JSON'; return; }
  try {
    await adminApi.setConfig(form.key, {
      value, scope: form.scope,
      schoolId: form.scope === 'school' ? Number(form.schoolId) : null,
      description: form.description || undefined,
    });
    toastOk('配置已保存');
    form.key = ''; form.description = '';
    await load();
  } catch (err) {
    error.value = err?.message || '保存失败';
  }
}

async function savePicked() {
  let value;
  try { value = JSON.parse(pickedText.value); } catch { toastError('配置值不是合法 JSON'); return; }
  try {
    await adminApi.setConfig(picked.value.key, {
      value, scope: picked.value.scope, schoolId: picked.value.schoolId,
      description: pickedDescription.value || undefined,
      version: picked.value.version,
    });
    toastOk('配置已保存');
    picked.value = null;
    await load();
  } catch (err) {
    toastError(err?.message || '保存失败');
  }
}

onMounted(load);
</script>
